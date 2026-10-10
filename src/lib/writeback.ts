import { PDFDocument, PDFHexString } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import type { Mark, Rect } from '../types';
import { COLOR_HEX } from './theme';

/**
 * Write annotations back into the PDF itself, so Acrobat, Preview, Chrome and
 * every other reader sees them.
 *
 * Two coordinate systems meet here. PDFMark stores marks in *page space*
 * (PDF points, origin top-left, y grows downward) because that is what the
 * screen uses. The PDF annotation dictionary wants *user space* (origin
 * bottom-left, y grows upward). Every y below is flipped through the page
 * height — the one conversion that matters.
 */

const AUTHOR = 'PDFMark';

/** Highlight / underline / strikeout are all "text markup" annotations. */
const TEXT_MARKUP: Record<string, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'StrikeOut',
};

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

/** PDF date string: `D:YYYYMMDDHHmmSS+HH'mm'` — the format viewers expect. */
function pdfDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
  );
}

function annotationRect(rect: Rect, pageHeight: number): Rect {
  return {
    x: rect.x,
    y: pageHeight - (rect.y + rect.h),
    w: rect.w,
    h: rect.h,
  };
}

/**
 * QuadPoints are four corners per covered box, in user space, ordered
 * upper-left, upper-right, lower-left, lower-right. One quad per text run is
 * what makes the highlight hug the glyphs instead of covering the whole line.
 */
function quadPoints(rects: Rect[], pageHeight: number): number[] {
  const out: number[] = [];
  for (const rect of rects) {
    const bottom = pageHeight - (rect.y + rect.h);
    const top = pageHeight - rect.y;
    const right = rect.x + rect.w;
    out.push(rect.x, top, right, top, rect.x, bottom, right, bottom);
  }
  return out;
}

function boundingBox(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function addTextMarkup(
  doc: PDFDocument,
  page: PDFPage,
  mark: Mark,
  subtype: string,
): void {
  const height = page.getHeight();
  const box = annotationRect(boundingBox(mark.rects), height);
  const [r, g, b] = hexToRgb(COLOR_HEX[mark.color]);

  const dict = doc.context.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: [box.x, box.y, box.x + box.w, box.y + box.h],
    QuadPoints: quadPoints(mark.rects, height),
    C: [r, g, b],
    CA: mark.kind === 'highlight' ? 0.34 : 1,
    T: PDFHexString.fromText(AUTHOR),
    Contents: PDFHexString.fromText(mark.note.trim() || mark.quote || ''),
    M: PDFHexString.fromText(pdfDate(mark.updatedAt || mark.createdAt)),
    F: 4, // Print — the annotation rides along when the file is printed.
  });
  page.node.addAnnot(doc.context.register(dict));
}

function addSquare(doc: PDFDocument, page: PDFPage, mark: Mark): void {
  const height = page.getHeight();
  const box = annotationRect(boundingBox(mark.rects), height);
  const [r, g, b] = hexToRgb(COLOR_HEX[mark.color]);

  const dict = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [box.x, box.y, box.x + box.w, box.y + box.h],
    C: [r, g, b],
    T: PDFHexString.fromText(AUTHOR),
    Contents: PDFHexString.fromText(mark.note.trim() || mark.quote || ''),
    M: PDFHexString.fromText(pdfDate(mark.updatedAt || mark.createdAt)),
    F: 4,
    BS: { W: 1.5, S: 'S' },
  });
  page.node.addAnnot(doc.context.register(dict));
}

export interface WritebackResult {
  bytes: Uint8Array;
  written: number;
  skipped: number;
}

/**
 * Returns a *new* PDF: the original bytes in IndexedDB are never modified, so
 * a failed export can never corrupt the reader's copy.
 */
export async function writeMarksToPdf(source: ArrayBuffer, marks: Mark[]): Promise<WritebackResult> {
  // pdf-lib takes ownership of the buffer, so hand it a copy.
  const doc = await PDFDocument.load(source.slice(0), { updateMetadata: false });
  let written = 0;
  let skipped = 0;

  for (const mark of marks) {
    if (!mark.rects.length) {
      skipped += 1;
      continue;
    }
    const page = doc.getPage(mark.page - 1);
    if (!page) {
      skipped += 1;
      continue;
    }
    const subtype = TEXT_MARKUP[mark.kind];
    if (subtype) addTextMarkup(doc, page, mark, subtype);
    else addSquare(doc, page, mark);
    written += 1;
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, written, skipped };
}

export function pdfFilename(name: string, suffix = '-已标注'): string {
  const base = name.replace(/\.pdf$/i, '');
  return `${base}${suffix}.pdf`;
}

/** True when a value can be handed to `URL.createObjectURL` as a PDF. */
export function isNonEmptyPdf(bytes: Uint8Array): boolean {
  return bytes.length > 100;
}
