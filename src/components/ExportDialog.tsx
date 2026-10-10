import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportInput, PackageScope } from '../lib/export';
import {
  DEFAULT_PACKAGE_OPTIONS,
  appendixPagesFor,
  buildAiPackage,
  buildBackup,
  buildNotesMarkdown,
  copyToClipboard,
  downloadBytes,
  downloadFile,
  estimateTokens,
  packageInstructions,
  parseBackup,
  planChunks,
} from '../lib/export';
import { importMarks, setStatus, useApp } from '../store/app';
import { loadTemplates } from '../lib/templates';
import * as db from '../lib/db';
import { pdfFilename, writeMarksToPdf } from '../lib/writeback';

type Tab = 'notes' | 'package' | 'pdf' | 'backup';

interface Props {
  input: ExportInput;
  onClose: () => void;
}

const SCOPE_LABEL: Record<PackageScope, string> = {
  marks: '只给划线片段',
  markedPages: '划线 + 所在页全文',
  fullDoc: '划线 + 全文',
};

/** 0 means "one chunk" — the default, and the pre-chunking behaviour. */
const CHUNK_SIZES = [0, 10, 20, 50];

export default function ExportDialog({ input, onClose }: Props) {
  const { doc } = useApp();
  const [tab, setTab] = useState<Tab>('package');
  const [scope, setScope] = useState<PackageScope>(DEFAULT_PACKAGE_OPTIONS.scope);
  const [chunkSize, setChunkSize] = useState(0);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const templates = useMemo(() => loadTemplates(), []);

  const isPackage = tab === 'package';

  const chunks = useMemo(() => {
    const pages = appendixPagesFor(input, { ...DEFAULT_PACKAGE_OPTIONS, scope });
    return planChunks(pages, chunkSize);
  }, [input, scope, chunkSize]);

  const activeChunk = chunkSize > 0 && chunks.length ? chunks[Math.min(chunkIndex, chunks.length - 1)] : undefined;

  useEffect(() => {
    if (chunkIndex > chunks.length - 1 && chunks.length) setChunkIndex(0);
  }, [chunks.length, chunkIndex]);

  useEffect(() => {
    if (tab === 'pdf') return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const text =
        tab === 'notes'
          ? buildNotesMarkdown(input, templates)
          : tab === 'backup'
            ? buildBackup(input)
            : await buildAiPackage(input, { ...DEFAULT_PACKAGE_OPTIONS, scope }, templates, activeChunk);
      if (!cancelled) {
        setContent(text);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, scope, input, templates, activeChunk]);

  const base = (doc?.name ?? 'document').replace(/\.pdf$/i, '');
  const chunkTag = activeChunk ? `-第${activeChunk.index + 1}片` : '';
  const suffix: Record<Tab, string> = {
    notes: '-笔记.md',
    package: `${chunkTag}-标注包.md`,
    pdf: '-已标注.pdf',
    backup: '-备份.json',
  };
  const mime = tab === 'backup' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8';

  const handleImport = async (file: File) => {
    if (!doc) return;
    try {
      const marks = parseBackup(await file.text()).map((m) => ({ ...m, docId: doc.id }));
      await importMarks(doc.id, marks);
      setStatus(`已导入 ${marks.length} 条标注`);
      onClose();
    } catch (err) {
      setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePdfExport = async () => {
    if (!doc) return;
    setPdfBusy(true);
    try {
      const stored = await db.getDoc(doc.id);
      if (!stored) throw new Error('找不到原文，请重新打开这个 PDF');
      const { bytes, written, skipped } = await writeMarksToPdf(stored.data, input.marks);
      downloadBytes(pdfFilename(doc.name), bytes, 'application/pdf');
      setStatus(`已导出 ${written} 条标注${skipped ? `（跳过 ${skipped} 条）` : ''}`);
    } catch (err) {
      setStatus(`导出 PDF 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="mask" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <div className="tabs" style={{ border: 'none', padding: 0 }}>
            <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
              笔记 Markdown
            </button>
            <button className={tab === 'package' ? 'on' : ''} onClick={() => setTab('package')}>
              AI 标注包
            </button>
            <button className={tab === 'pdf' ? 'on' : ''} onClick={() => setTab('pdf')}>
              带标注的 PDF
            </button>
            <button className={tab === 'backup' ? 'on' : ''} onClick={() => setTab('backup')}>
              备份 / 导入
            </button>
          </div>
        </header>

        <div className="content">
          {isPackage && (
            <div className="field">
              <label>原文范围</label>
              <select value={scope} onChange={(e) => setScope(e.target.value as PackageScope)}>
                {(Object.keys(SCOPE_LABEL) as PackageScope[]).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABEL[s]}
                  </option>
                ))}
              </select>
              <div className="hint">
                整段粘给任意 AI 即可。约 {estimateTokens(content).toLocaleString()} tokens。
              </div>
            </div>
          )}

          {isPackage && (
            <div className="field">
              <label>分片</label>
              <div className="row">
                <select value={chunkSize} onChange={(e) => setChunkSize(Number(e.target.value))}>
                  {CHUNK_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? '不分片' : `每片 ${n} 页`}
                    </option>
                  ))}
                </select>
                {chunks.length > 1 && (
                  <span className="row" style={{ gap: 4 }}>
                    <button onClick={() => setChunkIndex((i) => Math.max(0, i - 1))}>←</button>
                    <span className="hint" style={{ minWidth: 92, textAlign: 'center' }}>
                      第 {activeChunk ? activeChunk.index + 1 : 1} / {chunks.length} 片
                      <br />
                      {activeChunk ? `${activeChunk.from}–${activeChunk.to} 页` : ''}
                    </span>
                    <button onClick={() => setChunkIndex((i) => Math.min(chunks.length - 1, i + 1))}>→</button>
                  </span>
                )}
              </div>
              <div className="hint">
                {chunks.length > 1
                  ? '每片只带本片页范围内的标注和原文，可以分别喂给模型再合并结果。'
                  : '长文档建议分片，避免一次塞爆上下文。'}
              </div>
            </div>
          )}

          {isPackage && (
            <div className="field">
              <label>怎么用</label>
              <pre className="output" style={{ maxHeight: 140 }}>
                {packageInstructions(input.docName)}
              </pre>
            </div>
          )}

          {tab === 'pdf' && (
            <div className="field">
              <label>把标注写回 PDF 文件</label>
              <div className="hint" style={{ marginBottom: 8 }}>
                生成一份新 PDF，标注会变成标准的 PDF 批注，Acrobat、Preview、Chrome
                都能看到和编辑。原文不会被改动，导出的始终是副本。
              </div>
              <div className="row">
                <button className="primary" onClick={() => void handlePdfExport()} disabled={pdfBusy || !input.marks.length}>
                  {pdfBusy ? '正在生成…' : `导出 ${input.marks.length} 条标注`}
                </button>
                {!input.marks.length && <span className="hint">还没有标注可写。</span>}
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                区域框会写成方形批注，其余三类写成文字标记批注（带 QuadPoints，贴着字形）。
                批注内容会写进批注的注释字段。
              </div>
            </div>
          )}

          {tab === 'backup' && (
            <div className="field">
              <label>导入备份</label>
              <div className="row">
                <button onClick={() => fileRef.current?.click()}>选择 JSON 备份…</button>
                <span className="hint">导入会覆盖当前文档的标注。</span>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImport(file);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          {tab !== 'pdf' && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label>预览</label>
              {loading ? (
                <pre className="output">
                  <span className="spin" />
                  正在整理…
                </pre>
              ) : (
                <pre className="output">{content}</pre>
              )}
            </div>
          )}
        </div>

        <footer>
          <button onClick={onClose}>关闭</button>
          {tab !== 'pdf' && (
            <button
              onClick={() => {
                void copyToClipboard(content).then((ok) => {
                  setStatus(ok ? '已复制到剪贴板' : '复制失败，请手动选中');
                });
              }}
            >
              复制
            </button>
          )}
          {tab !== 'pdf' && (
            <button className="primary" onClick={() => downloadFile(`${base}${suffix[tab]}`, content, mime)}>
              下载
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
