/**
 * Export templates.
 *
 * The Markdown this app emits is opinionated, and every reader has a different
 * opinion — so the shapes are data, not code. Two levels: one document-level
 * template per export kind, and one per-mark template that gets repeated into
 * `{{marks}}`.
 *
 * Unknown placeholders are left alone rather than blanked, so a typo in a
 * template shows up in the output instead of silently eating content.
 */

export interface ExportTemplates {
  /** Whole notes document. */
  notesDoc: string;
  /** One entry inside the notes document. */
  notesMark: string;
  /** Whole annotation package. */
  packageDoc: string;
  /** One entry inside the annotation package. */
  packageMark: string;
}

export interface TemplateVars {
  [key: string]: string;
}

export const TEMPLATE_VARIABLES: { name: string; scope: 'doc' | 'mark'; desc: string }[] = [
  { name: 'docName', scope: 'doc', desc: '文件名（不含 .pdf）' },
  { name: 'pageCount', scope: 'doc', desc: '总页数' },
  { name: 'markCount', scope: 'doc', desc: '标注条数' },
  { name: 'commentCount', scope: 'doc', desc: '带批注的条数' },
  { name: 'date', scope: 'doc', desc: '导出时间' },
  { name: 'scope', scope: 'doc', desc: '原文范围（仅标注包）' },
  { name: 'marks', scope: 'doc', desc: '所有条目渲染后的结果' },
  { name: 'appendix', scope: 'doc', desc: '附：相关页原文（仅标注包）' },
  { name: 'chunkInfo', scope: 'doc', desc: '分片说明（仅分片导出时）' },
  { name: 'index', scope: 'mark', desc: '第几条（从 1 开始）' },
  { name: 'page', scope: 'mark', desc: '页码' },
  { name: 'quote', scope: 'mark', desc: '划线的原文' },
  { name: 'quoteLines', scope: 'mark', desc: '原文，每行带 > 引用前缀' },
  { name: 'note', scope: 'mark', desc: '批注原文（没有则为空）' },
  { name: 'noteBlock', scope: 'mark', desc: '批注块，无批注时给占位说明' },
  { name: 'noteLine', scope: 'mark', desc: '列表项形式的批注' },
  { name: 'kind', scope: 'mark', desc: '标注类型（高亮/下划线/…）' },
  { name: 'color', scope: 'mark', desc: '颜色名' },
];

export const DEFAULT_TEMPLATES: ExportTemplates = {
  notesDoc: `# 《{{docName}}》划线与批注

- 标注 {{markCount}} 条，其中带批注 {{commentCount}} 条
- 导出时间：{{date}}
- 工具：PDFMark

{{marks}}`,

  notesMark: `## 第 {{page}} 页

{{quoteLines}}

{{noteBlock}}`,

  packageDoc: `# 阅读标注包：《{{docName}}》
{{chunkInfo}}

| 项目 | 值 |
| --- | --- |
| 文件 | {{docName}} |
| 页数 | {{pageCount}} |
| 标注数 | {{markCount}}（带批注 {{commentCount}} 条） |
| 导出时间 | {{date}} |
| 原文范围 | {{scope}} |

## 一、我的标注与批注

{{marks}}
{{appendix}}`,

  packageMark: `### 第 {{page}} 页

{{quoteLines}}

{{noteLine}}`,
};

const STORAGE_KEY = 'pdfmark.templates';

export function loadTemplates(): ExportTemplates {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TEMPLATES };
    const parsed = JSON.parse(raw) as Partial<ExportTemplates>;
    return {
      notesDoc: parsed.notesDoc ?? DEFAULT_TEMPLATES.notesDoc,
      notesMark: parsed.notesMark ?? DEFAULT_TEMPLATES.notesMark,
      packageDoc: parsed.packageDoc ?? DEFAULT_TEMPLATES.packageDoc,
      packageMark: parsed.packageMark ?? DEFAULT_TEMPLATES.packageMark,
    };
  } catch {
    return { ...DEFAULT_TEMPLATES };
  }
}

export function saveTemplates(templates: ExportTemplates): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

export function resetTemplates(): ExportTemplates {
  localStorage.removeItem(STORAGE_KEY);
  return { ...DEFAULT_TEMPLATES };
}

/**
 * Replace `{{name}}` with the value. Missing keys are kept verbatim — easier to
 * debug than an empty hole.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    const value = vars[key];
    return value === undefined ? whole : value;
  });
}
