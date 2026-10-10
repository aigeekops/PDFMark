/** Shared data model for PDFMark. */

/** How a mark is painted on the page. */
export type MarkKind = 'highlight' | 'underline' | 'strike' | 'box';

/** Palette named in the UI; hex lives in `theme.ts` so exports stay human-readable. */
export type MarkColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

/**
 * Axis-aligned box in *page space*: PDF points, origin top-left, y grows
 * downward (the screen convention). Kept independent of zoom so marks survive
 * any re-render scale.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Mark {
  id: string;
  docId: string;
  /** 1-based page number, matching what the reader sees. */
  page: number;
  kind: MarkKind;
  color: MarkColor;
  /** One rect per text run covered by the mark, so highlights hug the glyphs. */
  rects: Rect[];
  /** Verbatim text recovered from the PDF under those rects. */
  quote: string;
  /** The reader's own margin note. Empty string means "highlighted, no comment". */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocMeta {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  addedAt: number;
}

/** A positioned run of text extracted from a page, in page space. */
export interface TextSpan {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Spans sharing a baseline, already sorted left-to-right. */
export interface TextLine {
  y: number;
  h: number;
  spans: TextSpan[];
  text: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const MARK_KINDS: MarkKind[] = ['highlight', 'underline', 'strike', 'box'];
export const MARK_COLORS: MarkColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

export const KIND_LABEL: Record<MarkKind, string> = {
  highlight: '高亮',
  underline: '下划线',
  strike: '删除线',
  box: '区域框',
};

export const COLOR_LABEL: Record<MarkColor, string> = {
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  pink: '粉',
  purple: '紫',
};
