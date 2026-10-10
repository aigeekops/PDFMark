import { useSyncExternalStore } from 'react';
import type { DocMeta, LlmConfig, Mark, MarkColor, MarkKind } from '../types';
import { extractPageText } from '../lib/pdf';
import type { ExportInput } from '../lib/export';
import type { PDFDocumentProxy, PageText } from '../lib/pdf';
import { searchDocument } from '../lib/search';
import type { SearchHit } from '../lib/search';
import * as db from '../lib/db';

export type Sidebar = 'notes' | 'summary' | 'search';

export interface SearchState {
  open: boolean;
  query: string;
  running: boolean;
  hits: SearchHit[];
  /** -1 when there is nothing to show. */
  activeIndex: number;
  truncated: boolean;
  progress: string;
}

const EMPTY_SEARCH: SearchState = {
  open: false,
  query: '',
  running: false,
  hits: [],
  activeIndex: -1,
  truncated: false,
  progress: '',
};

/**
 * `annotate` — dragging draws a mark.
 * `select`   — dragging selects real text so you can copy it.
 * They fight over the same mouse events, so only one is live at a time.
 */
export type ReadingMode = 'annotate' | 'select';

export interface AppState {
  ready: boolean;
  doc: DocMeta | null;
  pdf: PDFDocumentProxy | null;
  marks: Mark[];
  tool: MarkKind;
  color: MarkColor;
  mode: ReadingMode;
  scale: number;
  /** Page nearest the top of the viewport — drives the outline highlight. */
  currentPage: number;
  /**
   * Page to land on when this document opens, taken from the stored reading
   * progress. Set by the open path, read once by the viewer.
   */
  restorePage: number | null;
  selectedId: string | null;
  /** Mark that was just drawn by hand — jumping the viewport for it would be jarring. */
  noScrollId: string | null;
  sidebar: Sidebar;
  /** Marks created but not yet commented — drives the "commented / total" counter. */
  status: string;
  search: SearchState;
}

type Listener = () => void;

function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const DEFAULT_LLM: LlmConfig = { baseUrl: '', apiKey: '', model: '' };

export const store = createStore<AppState>({
  ready: false,
  doc: null,
  pdf: null,
  marks: [],
  tool: 'highlight',
  color: 'yellow',
  mode: 'annotate',
  scale: 1.2,
  currentPage: 1,
  restorePage: null,
  selectedId: null,
  noScrollId: null,
  sidebar: 'notes',
  status: '',
  search: EMPTY_SEARCH,
});

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function newId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** In-memory text cache. Kept outside the store: it never drives rendering. */
const pageTextCache = new Map<string, PageText>();

export function getCachedPageText(docId: string, page: number): PageText | undefined {
  return pageTextCache.get(`${docId}:${page}`);
}

export function setCachedPageText(docId: string, page: number, text: PageText): void {
  pageTextCache.set(`${docId}:${page}`, text);
}

export function clearPageTextCache(docId?: string): void {
  if (!docId) {
    pageTextCache.clear();
    return;
  }
  for (const key of pageTextCache.keys()) {
    if (key.startsWith(`${docId}:`)) pageTextCache.delete(key);
  }
}

/* ------------------------------------------------------------------ actions */

export async function addMark(mark: Mark): Promise<void> {
  await db.putMark(mark);
  store.set((s) => ({
    marks: [...s.marks, mark].sort(sortMarks),
    selectedId: mark.id,
    noScrollId: mark.id,
    sidebar: 'notes',
  }));
}

export async function updateMark(id: string, patch: Partial<Mark>): Promise<void> {
  let updated: Mark | undefined;
  store.set((s) => {
    const marks = s.marks.map((m) => {
      if (m.id !== id) return m;
      updated = { ...m, ...patch, updatedAt: Date.now() };
      return updated;
    });
    return { marks };
  });
  if (updated) await db.putMark(updated);
}

export async function removeMark(id: string): Promise<void> {
  await db.deleteMark(id);
  store.set((s) => ({
    marks: s.marks.filter((m) => m.id !== id),
    selectedId: s.selectedId === id ? null : s.selectedId,
  }));
}

export async function importMarks(docId: string, marks: Mark[]): Promise<void> {
  await db.replaceMarks(docId, marks);
  store.set({ marks: marks.slice().sort(sortMarks) });
}

/**
 * The one place that answers "what text is on this page".
 *
 * Memory cache first, then the PDF's own text layer. Every consumer — search,
 * export, highlighting — goes through here.
 */
export async function resolvePageText(docId: string, page: number, pdf: PDFDocumentProxy): Promise<PageText> {
  const cached = getCachedPageText(docId, page);
  if (cached) return cached;

  const pageProxy = await pdf.getPage(page);
  const text = await extractPageText(pageProxy);
  setCachedPageText(docId, page, text);
  return text;
}

/** Bundle everything the exporters need, with lazy per-page text extraction. */
export function makeExportInput(doc: DocMeta, pdf: PDFDocumentProxy, marks: Mark[]): ExportInput {
  return {
    docName: doc.name,
    pageCount: doc.pageCount,
    marks,
    getPageText: async (page: number): Promise<string> => (await resolvePageText(doc.id, page, pdf)).text,
  };
}

/* ------------------------------------------------------------------- search */

let searchSignal: { cancelled: boolean } | null = null;

export function setSearchOpen(open: boolean): void {
  if (open) {
    store.set((s) => ({ sidebar: 'search', search: { ...s.search, open: true } }));
  } else {
    store.set({ search: EMPTY_SEARCH });
  }
}

export function clearSearch(): void {
  if (searchSignal) searchSignal.cancelled = true;
  store.set((s) => ({ search: { ...EMPTY_SEARCH, open: s.search.open } }));
}

export function setSearchActive(index: number): void {
  store.set((s) => ({ search: { ...s.search, activeIndex: index } }));
}

export async function runSearch(query: string): Promise<void> {
  const { pdf, doc } = store.get();
  if (!pdf || !doc) return;

  if (searchSignal) searchSignal.cancelled = true;
  const signal = { cancelled: false };
  searchSignal = signal;

  const needle = query.trim();
  if (!needle) {
    store.set((s) => ({ search: { ...EMPTY_SEARCH, open: s.search.open, query } }));
    return;
  }

  store.set((s) => ({ search: { ...s.search, query, running: true, progress: '0/' + doc.pageCount } }));

  const outcome = await searchDocument({
    query: needle,
    pageCount: doc.pageCount,
    getPageText: (page) => resolvePageText(doc.id, page, pdf),
    signal,
    onProgress: (done, total) => {
      if (!signal.cancelled) {
        store.set((s) => ({ search: { ...s.search, progress: `${done}/${total}` } }));
      }
    },
  });

  if (signal.cancelled) return;
  store.set({
    search: {
      open: true,
      query,
      running: false,
      hits: outcome.hits,
      activeIndex: outcome.hits.length ? 0 : -1,
      truncated: outcome.truncated,
      progress: '',
    },
  });
  setStatus(
    outcome.hits.length
      ? `${outcome.hits.length} 处匹配${outcome.truncated ? '（已截断）' : ''}`
      : '没有找到匹配',
  );
}

/** Scroll the reader to a hit and make it the active one. */
export function focusSearchHit(index: number): void {
  const { search } = store.get();
  const hit = search.hits[index];
  if (!hit) return;
  store.set({ search: { ...search, activeIndex: index } });
  document.getElementById(`page-${hit.page}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function sortMarks(a: Mark, b: Mark): number {
  return a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0) || a.createdAt - b.createdAt;
}

export function setTool(tool: MarkKind): void {
  store.set({ tool });
}

export function setColor(color: MarkColor): void {
  store.set({ color });
}

export function setMode(mode: ReadingMode): void {
  store.set({ mode });
}

export function setScale(scale: number): void {
  store.set({ scale: Math.min(3, Math.max(0.5, Number(scale.toFixed(2)))) });
}

export function selectMark(id: string | null): void {
  store.set({ selectedId: id });
}

export function setCurrentPage(page: number): void {
  if (store.get().currentPage !== page) store.set({ currentPage: page });
}

export function setSidebar(sidebar: Sidebar): void {
  store.set({ sidebar });
}

export function setStatus(status: string): void {
  store.set({ status });
}

/* ------------------------------------------------------------------- config */

const LLM_KEY = 'pdfmark.llm';

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(LLM_KEY);
    if (!raw) return { ...DEFAULT_LLM };
    return { ...DEFAULT_LLM, ...(JSON.parse(raw) as Partial<LlmConfig>) };
  } catch {
    return { ...DEFAULT_LLM };
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  localStorage.setItem(LLM_KEY, JSON.stringify(config));
}
