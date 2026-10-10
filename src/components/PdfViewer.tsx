import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PageView from './PageView';
import type { Mark, Rect } from '../types';
import { addMark, newId, selectMark, setCurrentPage, store, useApp } from '../store/app';

const EMPTY: Mark[] = [];
const EMPTY_HITS: { rects: Rect[]; active: boolean }[] = [];

export default function PdfViewer() {
  const { pdf, doc, scale, marks, tool, color, selectedId, mode, search } = useApp();
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1, 2, 3]));
  const ioRef = useRef<IntersectionObserver | null>(null);
  const nodes = useRef(new Map<number, HTMLElement>());
  const viewerRef = useRef<HTMLDivElement>(null);
  const docId = doc?.id ?? '';

  if (!ioRef.current && typeof IntersectionObserver !== 'undefined') {
    ioRef.current = new IntersectionObserver(
      (entries) => {
        let topPage = 0;
        let topEdge = Number.POSITIVE_INFINITY;
        setVisible((prev) => {
          let touched = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.page);
            if (!entry.isIntersecting) continue;
            if (!next.has(page)) {
              next.add(page);
              touched = true;
            }
            if (entry.boundingClientRect.top < topEdge) {
              topEdge = entry.boundingClientRect.top;
              topPage = page;
            }
          }
          return touched ? next : prev;
        });
        if (topPage) setCurrentPage(topPage);
      },
      { rootMargin: '800px 0px' },
    );
  }

  useEffect(() => {
    const io = ioRef.current;
    return () => io?.disconnect();
  }, []);

  /**
   * A different document is a different page tree. The visibility set may hold
   * page numbers that no longer exist, and the old scroll offset points at a
   * page that is gone — both would leave the new document blank until the user
   * scrolled. Reset them so page 1 paints straight away.
   */
  useEffect(() => {
    if (!docId) return;
    setVisible(new Set([1, 2, 3]));
    setCurrentPage(1);
    viewerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [docId]);

  const onObserve = useCallback((el: HTMLElement | null, page: number) => {
    const io = ioRef.current;
    if (!io) return;
    const previous = nodes.current.get(page);
    if (previous) io.unobserve(previous);
    if (el) {
      el.dataset.page = String(page);
      nodes.current.set(page, el);
      io.observe(el);
    } else {
      nodes.current.delete(page);
    }
  }, []);

  const byPage = useMemo(() => {
    const map = new Map<number, Mark[]>();
    for (const mark of marks) {
      const list = map.get(mark.page);
      if (list) list.push(mark);
      else map.set(mark.page, [mark]);
    }
    return map;
  }, [marks]);

  /** Search matches grouped by page, with the active one flagged for painting. */
  const hitsByPage = useMemo(() => {
    const map = new Map<number, { rects: Rect[]; active: boolean }[]>();
    if (!search.hits.length) return map;
    for (let i = 0; i < search.hits.length; i += 1) {
      const hit = search.hits[i];
      const list = map.get(hit.page) ?? [];
      list.push({ rects: hit.rects, active: i === search.activeIndex });
      map.set(hit.page, list);
    }
    return map;
  }, [search.hits, search.activeIndex]);

  const handleCreate = useCallback(
    async (input: { page: number; rects: Rect[]; quote: string }) => {
      if (!doc) return;
      const now = Date.now();
      await addMark({
        id: newId(),
        docId: doc.id,
        page: input.page,
        kind: tool,
        color,
        rects: input.rects,
        quote: input.quote,
        note: '',
        createdAt: now,
        updatedAt: now,
      });
    },
    [doc, tool, color],
  );

  // Jump to the page of the selected note, but never yank the viewport right
  // after the reader drew that note themselves.
  useEffect(() => {
    if (!selectedId) return;
    if (selectedId === store.get().noScrollId) {
      store.set({ noScrollId: null });
      return;
    }
    const mark = marks.find((m) => m.id === selectedId);
    if (!mark) return;
    document.getElementById(`page-${mark.page}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selectedId, marks]);

  if (!pdf || !doc) return null;

  return (
    <div
      className="viewer"
      ref={viewerRef}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) selectMark(null);
      }}
    >
      {Array.from({ length: doc.pageCount }, (_, i) => i + 1).map((pageNumber) => (
        <PageView
          // Keyed by document too: without it React reuses these instances when
          // the file changes and the old page state (canvas, spans) survives.
          key={`${doc.id}:${pageNumber}`}
          pdf={pdf}
          docId={doc.id}
          pageNumber={pageNumber}
          scale={scale}
          marks={byPage.get(pageNumber) ?? EMPTY}
          selectedId={selectedId}
          mode={mode}
          active={visible.has(pageNumber)}
          onSelect={selectMark}
          onCreate={handleCreate}
          onObserve={onObserve}
          searchHits={hitsByPage.get(pageNumber) ?? EMPTY_HITS}
        />
      ))}
    </div>
  );
}
