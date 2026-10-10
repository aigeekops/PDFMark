import type { Mark } from '../types';
import { COLOR_LABEL, KIND_LABEL } from '../types';
import type { ExportTemplates, TemplateVars } from './templates';
import { DEFAULT_TEMPLATES, renderTemplate } from './templates';

export interface ExportInput {
  docName: string;
  pageCount: number;
  marks: Mark[];
  /** Lazily resolved so exporting never pays for pages nobody marked. */
  getPageText: (page: number) => Promise<string>;
}

export type PackageScope = 'marks' | 'markedPages' | 'fullDoc';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function quoteBlock(text: string): string {
  const clean = (text || '').trim();
  if (!clean) return '> _(无文字内容，可能是图片或图表区域)_';
  return clean
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…（本页内容过长，已截断至 ${limit} 字）`;
}

function markVars(mark: Mark, index: number): TemplateVars {
  const note = mark.note.trim();
  const quote = (mark.quote || '').trim();
  return {
    index: String(index),
    page: String(mark.page),
    quote,
    quoteLines: quoteBlock(quote),
    note,
    noteBlock: note ? `**批注：** ${note}` : `_（${KIND_LABEL[mark.kind]}，无批注）_`,
    noteLine: note ? `- 我的批注：${note}` : `- （${KIND_LABEL[mark.kind]}，无批注）`,
    kind: KIND_LABEL[mark.kind],
    color: COLOR_LABEL[mark.color],
  };
}

/* ------------------------------------------------------------- notes export */

/** Just the highlights and comments — the "what I thought" document. */
export function buildNotesMarkdown(
  input: ExportInput,
  templates: ExportTemplates = DEFAULT_TEMPLATES,
): string {
  const { docName, marks } = input;
  const commented = marks.filter((m) => m.note.trim()).length;

  if (!marks.length) {
    return `# 《${docName}》划线与批注\n\n_还没有任何标注。_`;
  }

  const body = marks.map((mark, i) => renderTemplate(templates.notesMark, markVars(mark, i + 1))).join('\n\n');

  return renderTemplate(templates.notesDoc, {
    docName,
    pageCount: String(input.pageCount),
    markCount: String(marks.length),
    commentCount: String(commented),
    date: stamp(),
    marks: body,
  });
}

/* ------------------------------------------------------------ package for AI */

const SYSTEM_PROMPT = `你是一位严谨的阅读助理。下面是一份 PDF 的阅读标注包，包含：读者划线的原文片段、读者自己写的批注，以及（可选）相关页的全文。
请严格基于这些内容作答：
1. 先用 5-8 条要点概括重点，每条一句话，附「第 N 页」出处；
2. 单独列出「读者重点关注」：从批注里提炼读者的主张、疑问和待办；
3. 给出 3 个值得进一步追问的问题；
4. 如果材料不足以支撑某个结论，明确说「材料未涉及」，不要编造。
输出中文，Markdown 格式，不要复述我的指令。`;

export interface PackageOptions {
  scope: PackageScope;
  /** Per-page character cap for the appendix; 0 means no cap. */
  pageCharLimit: number;
}

export const DEFAULT_PACKAGE_OPTIONS: PackageOptions = {
  scope: 'markedPages',
  pageCharLimit: 4000,
};

/** Which pages the appendix would cover for a given scope. */
export function appendixPagesFor(input: ExportInput, options: PackageOptions): number[] {
  if (options.scope === 'marks') return [];
  if (options.scope === 'markedPages') {
    return [...new Set(input.marks.map((m) => m.page))].sort((a, b) => a - b);
  }
  return Array.from({ length: input.pageCount }, (_, i) => i + 1);
}

export interface PackageChunk {
  index: number;
  from: number;
  to: number;
  pages: number[];
}

/**
 * Split the appendix into page ranges. Each chunk is meant to be pasted on its
 * own, so it carries only the marks on the pages it covers — otherwise every
 * chunk would repeat the whole annotation list and defeat the purpose.
 */
export function planChunks(pages: number[], chunkSize: number): PackageChunk[] {
  if (!pages.length) return [];
  if (chunkSize <= 0) {
    return [{ index: 0, from: pages[0], to: pages[pages.length - 1], pages }];
  }
  const chunks: PackageChunk[] = [];
  for (let i = 0; i < pages.length; i += chunkSize) {
    const slice = pages.slice(i, i + chunkSize);
    chunks.push({
      index: chunks.length,
      from: slice[0],
      to: slice[slice.length - 1],
      pages: slice,
    });
  }
  return chunks;
}

/**
 * The thing you paste into a chat window: quotes, comments, and enough original
 * text for the model to actually reason about them.
 *
 * `chunk` narrows both the marks and the appendix to a page range; omit it for
 * the whole document.
 */
export async function buildAiPackage(
  input: ExportInput,
  options: PackageOptions,
  templates: ExportTemplates = DEFAULT_TEMPLATES,
  chunk?: PackageChunk,
): Promise<string> {
  const { docName, pageCount } = input;
  const inChunk = (m: Mark) => !chunk || chunk.pages.includes(m.page);
  const marks = chunk ? input.marks.filter(inChunk) : input.marks;
  const commented = marks.filter((m) => m.note.trim()).length;

  const appendixPages = chunk ? chunk.pages : appendixPagesFor(input, options);

  let appendix = '';
  if (appendixPages.length) {
    const sections: string[] = ['', '## 二、附：相关页原文', ''];
    for (const page of appendixPages) {
      const raw = await input.getPageText(page);
      const body = options.pageCharLimit ? truncate(raw, options.pageCharLimit) : raw;
      sections.push(`### 第 ${page} 页`, '', body.trim() || '_（本页无可提取文本，可能是扫描件或纯图片）_', '');
    }
    appendix = sections.join('\n');
  }

  const marksBody = marks.length
    ? marks.map((mark, i) => renderTemplate(templates.packageMark, markVars(mark, i + 1))).join('\n\n')
    : '_（还没有标注。先在 PDF 上划几段再导出。）_';

  const chunkInfo = chunk
    ? `> 本片是第 ${chunk.index + 1} 片（共 ${chunk.from}–${chunk.to} 页）。如果还有其他片，请分别处理后再合并。`
    : '';

  return renderTemplate(templates.packageDoc, {
    docName,
    pageCount: String(pageCount),
    markCount: String(marks.length),
    commentCount: String(commented),
    date: stamp(),
    scope: {
      marks: '仅划线片段',
      markedPages: '划线所在页全文',
      fullDoc: '全文',
    }[options.scope],
    marks: marksBody,
    appendix,
    chunkInfo,
  });
}

/** Prompt text shown next to the package, ready to copy on its own. */
export function buildSummaryPrompt(docName: string): string {
  return `${SYSTEM_PROMPT}\n\n（文档：《${docName}》，标注包见下方）`;
}

export function packageInstructions(docName: string): string {
  return [
    `把下面这份「阅读标注包」整段粘给任意 AI 对话窗口，再附上这段指令：`,
    '',
    '```',
    SYSTEM_PROMPT,
    '```',
    '',
    `也可以点「生成摘要」直接用已配置的模型处理《${docName}》。`,
  ].join('\n');
}

/* ---------------------------------------------------------------- backup io */

export interface BackupFile {
  format: 'pdfmark-backup';
  version: 1;
  exportedAt: string;
  doc: { name: string; pageCount: number; id: string };
  marks: Mark[];
}

export function buildBackup(input: ExportInput): string {
  const payload: BackupFile = {
    format: 'pdfmark-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    doc: { name: input.docName, pageCount: input.pageCount, id: '' },
    marks: input.marks,
  };
  return JSON.stringify(payload, null, 2);
}

export function parseBackup(text: string): Mark[] {
  const data = JSON.parse(text) as BackupFile | Mark[];
  if (Array.isArray(data)) return data;
  if (data?.format !== 'pdfmark-backup') throw new Error('不是 PDFMark 备份文件');
  return data.marks ?? [];
}

/* ------------------------------------------------------------------ helpers */

export function downloadFile(filename: string, content: string, mime = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBytes(filename: string, bytes: Uint8Array, mime: string): void {
  // Copy: the caller's buffer may be a view into a larger one.
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Rough, deliberately pessimistic: mixed CJK/ASCII text averages ~1.6 chars/token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.6);
}
