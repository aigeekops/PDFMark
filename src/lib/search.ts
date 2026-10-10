import type { Rect, TextSpan } from '../types';
import { mergeRectsOnSameLine } from './geometry';

/**
 * In-document search.
 *
 * Matches run against the concatenation of a page's text runs, while a parallel
 * array records which run each character came from — so a hit can be turned
 * straight back into rectangles on the page.
 *
 * Whitespace in the query matches *optionally*: PDF text is split into runs at
 * arbitrary points, so "the quick" has to be able to match a run boundary
 * without a space character in between.
 */

export interface SearchHit {
  /** Stable across re-runs so React keys and the active hit stay put. */
  id: string;
  page: number;
  /** The matched text, verbatim. */
  match: string;
  /** A little surrounding text so the result list is readable. */
  context: string;
  /** Boxes to paint, in page space. */
  rects: Rect[];
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** True when the per-page or global cap was reached. */
  truncated: boolean;
  pagesSearched: number;
}

const MAX_PER_PAGE = 50;
const MAX_TOTAL = 500;
const CONTEXT_CHARS = 28;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the searchable string for a page plus the run index of every
 * character. `str` may be an empty string for runs carrying only whitespace —
 * those still occupy a slot so indices stay aligned.
 */
function flatten(spans: TextSpan[]): { text: string; owner: number[] } {
  let text = '';
  const owner: number[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    const str = spans[i].str;
    // Word spaces are not glyphs and own no box, but they have to appear in the
    // haystack or the result snippet comes out as one long glued word. A gap
    // wider than ~30% of the glyph height is a space (same rule as joinSpans).
    if (i > 0) {
      const prev = spans[i - 1];
      if (spans[i].x - (prev.x + prev.w) > prev.h * 0.3) {
        text += ' ';
        owner.push(i);
      }
    }
    for (let c = 0; c < str.length; c += 1) {
      text += str[c];
      owner.push(i);
    }
  }
  return { text, owner };
}

export function searchPage(page: number, spans: TextSpan[], query: string): SearchHit[] {
  const needle = query.trim();
  if (needle.length < 1 || !spans.length) return [];

  const { text, owner } = flatten(spans);
  const pattern = new RegExp(escapeRegExp(needle).replace(/\s+/g, '\\s*'), 'gi');
  const hits: SearchHit[] = [];

  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    const from = m.index;
    const to = from + m[0].length;

    const runIds = new Set<number>();
    for (let i = from; i < to && i < owner.length; i += 1) runIds.add(owner[i]);
    const covered = [...runIds].sort((a, b) => a - b).map((i) => spans[i]);
    if (!covered.length) continue;

    const rects = mergeRectsOnSameLine(
      covered.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
      Math.max(...covered.map((s) => s.h)) * 0.4,
    );

    hits.push({
      id: `p${page}-${from}`,
      page,
      match: m[0],
      context: [
        text.slice(Math.max(0, from - CONTEXT_CHARS), from),
        m[0],
        text.slice(to, to + CONTEXT_CHARS),
      ]
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
      rects,
    });

    if (hits.length >= MAX_PER_PAGE) break;
  }
  return hits;
}

export interface SearchRequest {
  query: string;
  pageCount: number;
  /** Resolves the text of one page, from cache or the PDF's embedded layer. */
  getPageText: (page: number) => Promise<{ spans: TextSpan[] }>;
  signal: { cancelled: boolean };
  onProgress?: (done: number, total: number) => void;
}

export async function searchDocument({
  query,
  pageCount,
  getPageText,
  signal,
  onProgress,
}: SearchRequest): Promise<SearchOutcome> {
  const hits: SearchHit[] = [];
  let truncated = false;
  let pagesSearched = 0;

  for (let page = 1; page <= pageCount; page += 1) {
    if (signal.cancelled) break;
    const text = await getPageText(page);
    if (signal.cancelled) break;
    pagesSearched += 1;
    const found = searchPage(page, text.spans, query);
    if (found.length) hits.push(...found);
    if (hits.length >= MAX_TOTAL) {
      truncated = true;
      break;
    }
    onProgress?.(pagesSearched, pageCount);
    // Yield so a long search never freezes the scroll or the input.
    await new Promise((r) => setTimeout(r, 0));
  }

  return { hits, truncated, pagesSearched };
}

export const SEARCH_LIMITS = { MAX_PER_PAGE, MAX_TOTAL };
