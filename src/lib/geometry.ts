import type { Rect } from '../types';

/** Clamp-free rect normaliser: drag can end above/left of where it started. */
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Vertical overlap ratio between a selection box and a text span.
 * Highlights are horizontal by nature, so a lenient vertical test with a
 * stricter horizontal one keeps adjacent lines from bleeding into each other.
 */
export function spanHitRatio(sel: Rect, span: Rect): number {
  if (!rectsIntersect(sel, span)) return 0;
  const overlapW = Math.min(sel.x + sel.w, span.x + span.w) - Math.max(sel.x, span.x);
  const overlapH = Math.min(sel.y + sel.h, span.y + span.h) - Math.max(sel.y, span.y);
  if (overlapW <= 0 || overlapH <= 0) return 0;
  const coveredW = overlapW / Math.max(span.w, 0.001);
  const coveredH = overlapH / Math.max(span.h, 0.001);
  return coveredW * Math.min(1, coveredH * 2);
}

/** Merge a run of boxes that sit on the same baseline into one wider box. */
export function mergeRectsOnSameLine(rects: Rect[], tolerance: number): Rect[] {
  if (rects.length <= 1) return rects.slice();
  const sorted = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  let current: Rect | null = null;
  for (const r of sorted) {
    if (current && Math.abs(r.y - current.y) <= tolerance && Math.abs(r.h - current.h) <= tolerance) {
      const x = Math.min(current.x, r.x);
      const right = Math.max(current.x + current.w, r.x + r.w);
      current = { x, y: Math.min(current.y, r.y), w: right - x, h: Math.max(current.h, r.h) };
    } else {
      if (current) out.push(current);
      current = { ...r };
    }
  }
  if (current) out.push(current);
  return out;
}

/** Grow a box by `pad` on every side — used to give thin underlines a hit area. */
export function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}
