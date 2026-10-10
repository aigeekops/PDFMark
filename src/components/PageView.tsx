import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Mark, MarkColor, MarkKind, Rect, TextSpan } from '../types';

import { startPageRender, spansToQuote, SPAN_LINE_RATIO } from '../lib/pdf';
import type { PDFDocumentProxy, PageRender } from '../lib/pdf';
import { getCachedPageText, setCachedPageText, resolvePageText } from '../store/app';
import type { ReadingMode } from '../store/app';
import { mergeRectsOnSameLine, normalizeRect, spanHitRatio } from '../lib/geometry';
import { COLOR_HEX } from '../lib/theme';

interface Props {
  pdf: PDFDocumentProxy;
  docId: string;
  pageNumber: number;
  scale: number;
  marks: Mark[];
  selectedId: string | null;
  mode: ReadingMode;
  /** False while the page is far off-screen — skips the expensive canvas draw. */
  active: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (input: { page: number; rects: Rect[]; quote: string }) => void;
  onObserve: (el: HTMLElement | null, page: number) => void;
  /** Search matches on this page, painted under the marks. */
  searchHits: { rects: Rect[]; active: boolean }[];
}

const MIN_DRAG = 3; // page-space points; filters out accidental clicks

export default function PageView({
  pdf,
  docId,
  pageNumber,
  scale,
  marks,
  selectedId,
  mode,
  active,
  onSelect,
  onCreate,
  onObserve,
  searchHits,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const spansRef = useRef<TextSpan[]>([]);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [spans, setSpans] = useState<TextSpan[]>([]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);

  /**
   * What the canvas currently shows. It has to carry the document identity, not
   * just the zoom: switching files reuses this component instance, so a bare
   * scale value would compare equal and leave the previous PDF's pixels on
   * screen until a manual reload.
   */
  const pageKey = `${docId}:${pageNumber}`;
  const [drawn, setDrawn] = useState<{ key: string; scale: number } | null>(null);

  // Page geometry, measured once at scale 1.
  useEffect(() => {
    let cancelled = false;
    pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale: 1 });
      setSize({ w: vp.width, h: vp.height });
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber]);

  // Canvas paint. Re-runs when the zoom changes, or when this slot shows a
  // different page than before; pdf.js cancels any job still in flight when a
  // new one starts.
  useEffect(() => {
    if (!size || !active) return;
    if (drawn && drawn.key === pageKey && drawn.scale === scale) return;

    // Same page, new zoom: pdf.js repaints over the old pixels. Another page or
    // another document: wipe first, so the foreign image never lingers while the
    // new one is being fetched.
    const samePage = drawn?.key === pageKey;
    const canvas = canvasRef.current;
    if (!samePage && canvas) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    }

    let cancelled = false;
    let render: PageRender | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      const target = canvasRef.current;
      if (cancelled || !target) return;
      render = startPageRender(page, target, scale);
      try {
        await render.done;
        if (!cancelled) setDrawn({ key: pageKey, scale });
      } catch {
        // Superseded by a newer render — ignore.
      }
    })();
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, pageKey, pageNumber, scale, size, active, drawn]);

  useEffect(() => {
    onObserve(wrapRef.current, pageNumber);
    return () => onObserve(null, pageNumber);
  }, [onObserve, pageNumber]);

  // Text extraction, cached across renders and reused by the exporter.
  useEffect(() => {
    let cancelled = false;
    const cached = getCachedPageText(docId, pageNumber);
    if (cached) {
      spansRef.current = cached.spans;
      setSpans(cached.spans);
      return;
    }
    (async () => {
      const text = await resolvePageText(docId, pageNumber, pdf);
      if (cancelled) return;
      setCachedPageText(docId, pageNumber, text);
      spansRef.current = text.spans;
      setSpans(text.spans);
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, docId, pageNumber]);

  /**
   * PDF glyph widths rarely match what a browser font produces, so each span
   * gets squeezed/stretched to its real width. Without this the selection
   * highlight drifts away from the words underneath it.
   */
  useLayoutEffect(() => {
    const layer = textLayerRef.current;
    if (!layer || mode !== 'select' || !spans.length) return;
    const nodes = layer.children;
    for (let i = 0; i < spans.length && i < nodes.length; i++) {
      const node = nodes[i] as HTMLElement;
      const natural = node.offsetWidth;
      const target = spans[i].w * scale;
      node.style.transform =
        natural > 0 && Math.abs(target - natural) > 0.5 ? `scaleX(${target / natural})` : '';
    }
  }, [spans, scale, mode]);

  const toPageSpace = useCallback(
    (clientX: number, clientY: number) => {
      const el = overlayRef.current;
      if (!el || !size) return { x: 0, y: 0 };
      const box = el.getBoundingClientRect();
      const x = Math.min(Math.max((clientX - box.left) / scale, 0), size.w);
      const y = Math.min(Math.max((clientY - box.top) / scale, 0), size.h);
      return { x, y };
    },
    [scale, size],
  );

  /** Which text runs the dragged box covers, and the boxes that hug them. */
  const resolveSelection = useCallback((sel: Rect) => {
    const hits = spansRef.current.filter((span) => spanHitRatio(sel, span) > 0.14);
    if (!hits.length) return null;
    const rects = mergeRectsOnSameLine(
      hits.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
      Math.max(...hits.map((s) => s.h)) * 0.4,
    );
    return { rects, quote: spansToQuote(hits) };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const { x, y } = toPageSpace(e.clientX, e.clientY);
    dragRef.current = { x, y };
    setDraft({ x, y, w: 0, h: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const start = dragRef.current;
    if (!start) return;
    const { x, y } = toPageSpace(e.clientX, e.clientY);
    setDraft(normalizeRect(start.x, start.y, x, y));
  };

  const finishDrag = () => {
    const start = dragRef.current;
    dragRef.current = null;
    const sel = draft;
    setDraft(null);
    if (!start || !sel) return;
    if (sel.w < MIN_DRAG && sel.h < MIN_DRAG) return;

    const resolved = resolveSelection(sel);
    const rects = resolved?.rects ?? [sel];
    onCreate({ page: pageNumber, rects, quote: resolved?.quote ?? '' });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = toPageSpace(e.clientX, e.clientY);
    const hit = spansRef.current.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
    if (!hit) return;
    onCreate({
      page: pageNumber,
      rects: [{ x: hit.x, y: hit.y, w: hit.w, h: hit.h }],
      quote: hit.str.trim(),
    });
  };

  const w = (size?.w ?? 595) * scale;
  const h = (size?.h ?? 842) * scale;

  return (
    <div
      className="page-wrap"
      id={`page-${pageNumber}`}
      style={{ width: w }}
      ref={wrapRef}
    >
      <canvas ref={canvasRef} className="page-canvas" style={{ width: w, height: h }} />
      <svg
        ref={overlayRef}
        className="page-overlay"
        width={w}
        height={h}
        style={{ cursor: 'crosshair' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={finishDrag}
        onMouseLeave={finishDrag}
        onDoubleClick={handleDoubleClick}
      >
        {/* In select mode this stays out of the way so the text layer above can
            own the drag; existing marks stay clickable in both modes. */}
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          fill="transparent"
          pointerEvents={mode === 'select' ? 'none' : 'auto'}
        />

        {/* Search matches sit under the marks: they are transient, so they must
            never intercept the clicks that select a mark. */}
        {searchHits.map((hit, hi) =>
          hit.rects.map((r, i) => (
            <rect
              key={`s${hi}-${i}`}
              x={r.x * scale}
              y={r.y * scale}
              width={r.w * scale}
              height={r.h * scale}
              fill={hit.active ? '#c45a1d' : '#f0b429'}
              fillOpacity={hit.active ? 0.6 : 0.42}
              pointerEvents="none"
            />
          )),
        )}

        {marks.map((mark) =>
          mark.rects.map((r, i) => (
            <MarkShape
              key={`${mark.id}-${i}`}
              rect={r}
              kind={mark.kind}
              color={mark.color}
              scale={scale}
              selected={mark.id === selectedId}
              onSelect={() => onSelect(mark.id)}
            />
          )),
        )}

        {draft && (
          <rect
            className="draft"
            x={draft.x * scale}
            y={draft.y * scale}
            width={draft.w * scale}
            height={draft.h * scale}
            fill="rgba(196, 90, 29, 0.10)"
            stroke="#c45a1d"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}
      </svg>

      {mode === 'select' && spans.length > 0 && (
        <div ref={textLayerRef} className="text-layer">
          {spans.map((span, i) => (
            <span
              key={i}
              style={{
                left: span.x * scale,
                top: span.y * scale,
                fontSize: (span.h / SPAN_LINE_RATIO) * scale,
                lineHeight: 1.04,
              }}
            >
              {span.str}
            </span>
          ))}
        </div>
      )}

      <span className="page-label">{pageNumber}</span>
    </div>
  );
}

interface ShapeProps {
  rect: Rect;
  kind: MarkKind;
  color: MarkColor;
  scale: number;
  selected: boolean;
  onSelect: () => void;
}

function MarkShape({ rect, kind, color, scale, selected, onSelect }: ShapeProps) {
  const hex = COLOR_HEX[color];
  const x = rect.x * scale;
  const y = rect.y * scale;
  const w = rect.w * scale;
  const h = rect.h * scale;
  const common = {
    onMouseDown: (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect();
    },
  };

  if (kind === 'highlight') {
    return (
      <g {...common} style={{ cursor: 'pointer' }}>
        <rect x={x} y={y} width={w} height={h} fill={hex} fillOpacity={0.34} />
        {selected && <rect x={x} y={y} width={w} height={h} fill="none" stroke="#c45a1d" strokeWidth={1.5} />}
      </g>
    );
  }
  if (kind === 'underline') {
    return (
      <g {...common} style={{ cursor: 'pointer' }}>
        <rect x={x} y={y + h - 2} width={w} height={2} fill={hex} />
        {selected && <rect x={x} y={y + h - 3} width={w} height={4} fill="none" stroke="#c45a1d" strokeWidth={1} />}
      </g>
    );
  }
  if (kind === 'strike') {
    return (
      <g {...common} style={{ cursor: 'pointer' }}>
        <rect x={x} y={y + h * 0.55} width={w} height={2} fill={hex} />
        {selected && <rect x={x} y={y + h * 0.55 - 2} width={w} height={5} fill="none" stroke="#c45a1d" strokeWidth={1} />}
      </g>
    );
  }
  return (
    <g {...common} style={{ cursor: 'pointer' }}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={hex}
        fillOpacity={0.12}
        stroke={hex}
        strokeWidth={selected ? 2 : 1.5}
      />
      {selected && <rect x={x} y={y} width={w} height={h} fill="none" stroke="#c45a1d" strokeWidth={1.5} />}
    </g>
  );
}
