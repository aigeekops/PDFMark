import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextLine, TextSpan } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy, PDFPageProxy };

/**
 * pdf.js text items carry a PDF-space matrix whose origin is bottom-left.
 * Everything downstream in PDFMark uses top-left origin instead, so the
 * conversion happens once, here, at extraction time.
 */
const ASCENT_RATIO = 0.82;
const DESCENT_RATIO = 0.22;

/** How much taller a span box is than the nominal font size. */
export const SPAN_LINE_RATIO = ASCENT_RATIO + DESCENT_RATIO;

/** Multiply two pdf.js 2D matrices ([a, b, c, d, e, f]). */
function mul(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // Copy the buffer: pdf.js takes ownership and detaches it, which would break
  // re-opening the same file from our own cache.
  return pdfjsLib.getDocument({ data: data.slice(0) }).promise;
}

export interface PageRender {
  done: Promise<void>;
  /** Must be called when the component unmounts or re-renders — pdf.js refuses
   *  to start a second render on a canvas that still has one in flight. */
  cancel: () => void;
}

export function startPageRender(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number): PageRender {
  const viewport = page.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { done: Promise.resolve(), cancel: () => {} };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  const task = page.render({ canvasContext: ctx, viewport });
  return { done: task.promise, cancel: () => task.cancel() };
}

export interface PageText {
  spans: TextSpan[];
  lines: TextLine[];
  /** Plain text of the page, paragraph breaks preserved where the layout shows them. */
  text: string;
  /** Page size in PDF points, top-left origin. */
  width: number;
  height: number;
}

/** Extract positioned text runs from a page, normalised to 1x page space. */
export async function extractPageText(page: PDFPageProxy): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const m = viewport.transform;
  const spans: TextSpan[] = [];

  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str) continue;
    const item = raw as { str: string; transform: number[]; width: number; height: number; dir?: string };
    const t = mul(m, item.transform);
    // `scaleY` is the font size as seen through the viewport; pdf.js already
    // reports `item.width` in PDF user units, so it must NOT be scaled again.
    const scaleY = Math.hypot(t[2], t[3]) || 1;
    const angle = Math.atan2(t[1], t[0]);
    const rotated = Math.abs(Math.abs(angle) - Math.PI / 2) < 0.2;

    // Screen-space geometry: y already points down after the viewport transform.
    const x = t[4];
    const baseline = t[5];
    const w = rotated ? scaleY : item.width;
    const h = rotated ? item.width : scaleY;
    const y = baseline - scaleY * ASCENT_RATIO;
    spans.push({ str: item.str, x, y, w, h: h * (ASCENT_RATIO + DESCENT_RATIO) });
  }

  const lines = groupSpansIntoLines(spans);
  return {
    spans,
    lines,
    text: linesToText(lines),
    width: viewport.width,
    height: viewport.height,
  };
}

/** Turn whatever spans a selection caught back into readable, line-broken text. */
export function spansToQuote(spans: TextSpan[]): string {
  const lines = groupSpansIntoLines(spans);
  return lines
    .map((l) => l.text)
    .filter(Boolean)
    .join('\n')
    .trim();
}

function groupSpansIntoLines(spans: TextSpan[]): TextLine[] {
  const sorted = spans.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextLine[] = [];
  let current: TextLine | null = null;

  for (const span of sorted) {
    const tolerance = Math.max(span.h, current?.h ?? span.h) * 0.6;
    if (current && Math.abs(span.y - current.y) <= tolerance) {
      current.spans.push(span);
      current.y = Math.min(current.y, span.y);
      current.h = Math.max(current.h, span.h);
    } else {
      if (current) lines.push(current);
      current = { y: span.y, h: span.h, spans: [span], text: '' };
    }
  }
  if (current) lines.push(current);

  for (const line of lines) {
    line.spans.sort((a, b) => a.x - b.x);
    line.text = joinSpans(line.spans);
  }
  return lines;
}

/**
 * pdf.js splits a visual word into several runs with no leading whitespace, so
 * a gap wider than ~30% of the glyph height is treated as a real word space.
 */
function joinSpans(spans: TextSpan[]): string {
  let out = '';
  let prev: TextSpan | null = null;
  for (const span of spans) {
    if (prev) {
      const gap = span.x - (prev.x + prev.w);
      if (gap > prev.h * 0.3) out += ' ';
    }
    out += span.str;
    prev = span;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function linesToText(lines: TextLine[]): string {
  let out = '';
  let prev: TextLine | null = null;
  for (const line of lines) {
    if (!line.text) continue;
    if (prev) {
      const gap = line.y - (prev.y + prev.h);
      // A gap larger than the line itself usually means a new paragraph.
      out += gap > prev.h * 0.9 ? '\n\n' : '\n';
    }
    out += line.text;
    prev = line;
  }
  return out.trim();
}
