import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PageView from './PageView';
import type { Mark, Rect } from '../types';
import { addMark, newId, selectMark, setCurrentPage, store, useApp } from '../store/app';
import * as db from '../lib/db';

const EMPTY: Mark[] = [];
const EMPTY_HITS: { rects: Rect[]; active: boolean }[] = [];

export default function PdfViewer() {
  const { pdf, doc, scale, marks, tool, color, selectedId, mode, search, currentPage } = useApp();
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1, 2, 3]));
  const ioRef = useRef<IntersectionObserver | null>(null);
  const nodes = useRef(new Map<number, HTMLElement>());
  const viewerRef = useRef<HTMLDivElement>(null);
  /** Progress writes stay quiet until this timestamp — see the restore effect. */
  const resumeUntil = useRef(0);
  const docId = doc?.id ?? '';

  if (!ioRef.current && typeof IntersectionObserver !== 'undefined') {
    ioRef.current = new IntersectionObserver(
      (entries) => {
        // The page being read is the one the top of the viewport sits in — not
        // the topmost *observed* one, since the observer also reports neighbours
        // that are merely inside the root margin.
        let reading = 0;
        let readingTop = Number.NEGATIVE_INFINITY;
        let highest = 0;
        let highestTop = Number.POSITIVE_INFINITY;
        const onScreen: number[] = [];

        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number((entry.target as HTMLElement).dataset.page);
          const top = entry.boundingClientRect.top;
          onScreen.push(page);
          if (top <= 0 && top > readingTop) {
            readingTop = top;
            reading = page;
          }
          if (top < highestTop) {
            highestTop = top;
            highest = page;
          }
        }

        if (onScreen.length) {
          setVisible((prev) => {
            let touched = false;
            const next = new Set(prev);
            for (const page of onScreen) {
              if (!next.has(page)) {
                next.add(page);
                touched = true;
              }
            }
            return touched ? next : prev;
          });
        }

        // Nothing above the fold yet (the very top of the document) — fall back
        // to whichever page is highest on screen.
        const topPage = reading || highest;
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
   * page numbers that no longer exist and the old scroll offset points at a page
   * that is gone — both would leave the new document blank until the reader
   * scrolled. Reset them, then land on the page they stopped at last time.
   */
  useEffect(() => {
    if (!docId) return;
    setVisible(new Set([1, 2, 3]));

    const target = Math.min(Math.max(store.get().restorePage ?? 1, 1), doc?.pageCount ?? 1);
    setCurrentPage(target);

    const box = viewerRef.current;
    const align = () => {
      const el = document.getElementById(`page-${target}`);
      if (!box || !el) return;
      // Measured as a rect delta rather than offsetTop: the page box sits
      // inside a scrolling column that itself is offset in the page, and only
      // the delta is meaningful for a scrollTop.
      const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTo({ top: box.scrollTop + delta, behavior: 'instant' });
    };
    align();

    // Page geometry arrives asynchronously, so the offset above is only an
    // estimate on the first frame. Keep re-aligning until the layout settles —
    // a document that is not A4-sized drifts a long way otherwise.
    let frames = 0;
    let raf = requestAnimationFrame(function tick() {
      align();
      frames += 1;
      if (frames < 12) raf = requestAnimationFrame(tick);
    });

    // The observer needs a moment to report the page we just scrolled to;
    // without this the first frame would be recorded as the wrong page.
    resumeUntil.current = Date.now() + 1200;

    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /**
   * Remember where the reader stopped. Debounced, because a fast scroll fires
   * the observer dozens of times and only the resting page is worth keeping.
   */
  useEffect(() => {
    if (!docId) return;
    const wait = Math.max(700, resumeUntil.current - Date.now());
    const id = window.setTimeout(() => {
      void db.putProgress({ docId, page: currentPage, updatedAt: Date.now() });
    }, wait);
    return () => window.clearTimeout(id);
  }, [docId, currentPage]);

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
