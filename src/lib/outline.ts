import type { PDFDocumentProxy } from './pdf';

export interface OutlineNode {
  title: string;
  /** 1-based page number, or null when the destination cannot be resolved. */
  page: number | null;
  bold: boolean;
  italic: boolean;
  children: OutlineNode[];
}

/**
 * Bookmark destinations come in two shapes: a named destination (string) that
 * needs a lookup, or an explicit array whose first element is either a page
 * reference or a literal page index.
 */
async function resolvePage(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    const index =
      typeof ref === 'object' && ref !== null ? await pdf.getPageIndex(ref as never) : Number(ref);
    return Number.isFinite(index) && index >= 0 ? index + 1 : null;
  } catch {
    // Broken destinations are common in the wild; a bookmark without a target
    // is still worth showing.
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawItem = {
  title?: string;
  dest?: unknown;
  items?: RawItem[];
  bold?: boolean;
  italic?: boolean;
};

export async function loadOutline(pdf: PDFDocumentProxy): Promise<OutlineNode[]> {
  let raw: RawItem[] | null;
  try {
    raw = (await pdf.getOutline()) as RawItem[] | null;
  } catch {
    return [];
  }
  if (!raw?.length) return [];

  const build = async (items: RawItem[]): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const item of items) {
      out.push({
        title: (item.title ?? '').trim() || '(无标题)',
        page: item.dest ? await resolvePage(pdf, item.dest) : null,
        bold: Boolean(item.bold),
        italic: Boolean(item.italic),
        children: item.items?.length ? await build(item.items) : [],
      });
    }
    return out;
  };

  return build(raw);
}

/** Depth-first flatten, so the tree can render as one scrollable list. */
export function flattenOutline(
  nodes: OutlineNode[],
  depth = 0,
  out: { node: OutlineNode; depth: number }[] = [],
): { node: OutlineNode; depth: number }[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children.length) flattenOutline(node.children, depth + 1, out);
  }
  return out;
}
