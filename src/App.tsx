import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PdfViewer from './components/PdfViewer';
import NotePanel from './components/NotePanel';
import SummaryPanel from './components/SummaryPanel';
import SearchPanel from './components/SearchPanel';
import SettingsDialog from './components/SettingsDialog';
import ExportDialog from './components/ExportDialog';
import OutlinePanel from './components/OutlinePanel';
import type { DocMeta } from './types';
import { loadOutline } from './lib/outline';
import type { OutlineNode } from './lib/outline';
import { KIND_LABEL, MARK_COLORS, MARK_KINDS, COLOR_LABEL } from './types';
import { COLOR_HEX } from './lib/theme';
import { loadPdf } from './lib/pdf';
import * as db from './lib/db';
import {
  clearPageTextCache,
  clearSearch,
  makeExportInput,
  removeMark,
  setColor,
  setMode,
  setScale,
  setSearchOpen,
  setSidebar,
  setStatus,
  setTool,
  store,
  useApp,
} from './store/app';

export default function App() {
  const app = useApp();
  const { doc, pdf, marks, scale, tool, color, mode, sidebar, status, selectedId } = app;

  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [hot, setHot] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /* ------------------------------------------------------------ plumbing */

  useEffect(() => {
    const onToast = (e: Event) => setToast(String((e as CustomEvent<string>).detail ?? ''));
    const onSettings = () => setSettingsOpen(true);
    window.addEventListener('pdfmark:toast', onToast);
    window.addEventListener('pdfmark:settings', onSettings);
    return () => {
      window.removeEventListener('pdfmark:toast', onToast);
      window.removeEventListener('pdfmark:settings', onSettings);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!status) return;
    setToast(status);
    const t = window.setTimeout(() => setStatus(''), 2200);
    return () => window.clearTimeout(t);
  }, [status]);

  // Resume reading on load — the whole point of local storage. The document the
  // reader touched last wins over the one added last.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [docs, progress] = await Promise.all([db.listDocs(), db.latestProgress()]);
        if (cancelled || !docs.length) return;
        const resumeId = progress && docs.some((d) => d.id === progress.docId) ? progress.docId : docs[0].id;
        await openDocById(resumeId);
      } finally {
        if (!cancelled) store.set({ ready: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDocById = useCallback(async (id: string) => {
    const stored = await db.getDoc(id);
    if (!stored) return;
    setBusy('正在打开…');
    try {
      const pdfDoc = await loadPdf(stored.data);
      const meta: DocMeta = {
        id: stored.id,
        name: stored.name,
        size: stored.size,
        pageCount: stored.pageCount || pdfDoc.numPages,
        addedAt: stored.addedAt,
      };
      const existing = await db.listMarks(id);
      // Resume where the reader stopped, clamped in case the file was replaced.
      const progress = await db.getProgress(id);
      const pageCount = meta.pageCount || pdfDoc.numPages;
      const resume = progress ? Math.min(Math.max(progress.page, 1), pageCount) : 1;
      clearPageTextCache();
      clearSearch();
      store.set({ doc: meta, pdf: pdfDoc, marks: existing, selectedId: null, restorePage: resume });
    } catch (err) {
      setToast(`打开失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy('');
    }
  }, []);

  const openFile = useCallback(
    async (file: File) => {
      setBusy('正在打开…');
      try {
        const id = await db.hashFile(file);
        const buf = await file.arrayBuffer();
        const existing = await db.getDoc(id);
        if (existing) {
          await openDocById(id);
          return;
        }
        const pdfDoc = await loadPdf(buf);
        const meta: DocMeta = {
          id,
          name: file.name,
          size: file.size,
          pageCount: pdfDoc.numPages,
          addedAt: Date.now(),
        };
        await db.putDoc({ ...meta, data: buf });
        clearPageTextCache();
        clearSearch();
        store.set({ doc: meta, pdf: pdfDoc, marks: [], selectedId: null, restorePage: 1 });
      } catch (err) {
        setToast(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy('');
      }
    },
    [openDocById],
  );

  /* ------------------------------------------------------------ shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (doc) setSearchOpen(true);
        return;
      }
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        void removeMark(selectedId);
      }
      if (e.key === 'Escape') {
        // Search results first — they cover the page and hide the marks.
        if (store.get().search.hits.length) clearSearch();
        else store.set({ selectedId: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, doc]);

  /* -------------------------------------------------------------- drag/drop */

  useEffect(() => {
    const onOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setHot(true);
    };
    const onLeave = () => setHot(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setHot(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && /pdf$/i.test(file.name)) void openFile(file);
      else setToast('只能打开 PDF 文件');
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFile]);

  // Read the bookmark tree once per document; open the panel only when there
  // is actually something to show.
  useEffect(() => {
    if (!pdf) {
      setOutline(null);
      return;
    }
    let cancelled = false;
    void loadOutline(pdf).then((nodes) => {
      if (cancelled) return;
      setOutline(nodes);
      if (nodes.length) setOutlineOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const exportInput = useMemo(
    () => (doc && pdf ? makeExportInput(doc, pdf, marks) : null),
    [doc, pdf, marks],
  );

  /* ------------------------------------------------------------------ view */

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          PDFMark
        </div>

        {doc && (
          <>
            <span className="doc-name" title={doc.name}>
              {doc.name}
            </span>
            <span className="doc-stat">
              {doc.pageCount} 页 · {marks.length} 条标注
            </span>

            {/* Drawing tools are noise while selecting text, so they step aside. */}
            {mode === 'annotate' && (
              <div className="toolgroup">
                {MARK_KINDS.map((k) => (
                  <button key={k} className={tool === k ? 'on' : ''} title={KIND_LABEL[k]} onClick={() => setTool(k)}>
                    <KindIcon kind={k} />
                  </button>
                ))}
                <span className="sep" />
                {MARK_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch${color === c ? ' on' : ''}`}
                    style={{ background: COLOR_HEX[c] }}
                    title={COLOR_LABEL[c]}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            )}

            <div className="toolgroup">
              <button onClick={() => setScale(scale - 0.15)} title="缩小">
                −
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-dim)', minWidth: 42, textAlign: 'center' }}>
                {Math.round(scale * 100)}%
              </span>
              <button onClick={() => setScale(scale + 0.15)} title="放大">
                +
              </button>
            </div>
          </>
        )}

        <span className="spacer" />

        {doc && (
          <div className="toolgroup">
            <button className={outlineOpen ? 'on' : ''} onClick={() => setOutlineOpen((v) => !v)}>
              目录
            </button>
            <button
              className={sidebar === 'search' ? 'on' : ''}
              onClick={() => setSearchOpen(true)}
              title="搜索全文（Ctrl / Cmd + F）"
            >
              搜索
            </button>
            <span className="sep" />
            <button
              className={mode === 'annotate' ? 'on' : ''}
              onClick={() => {
                setMode('annotate');
                setToast('拖选文字即划线');
              }}
              title="拖选即划线"
            >
              划线
            </button>
            <button
              className={mode === 'select' ? 'on' : ''}
              onClick={() => {
                setMode('select');
                setToast('拖选文字后按 Ctrl / Cmd + C 复制');
              }}
              title="拖选文字，可 Ctrl/Cmd+C 复制"
            >
              选文字
            </button>
          </div>
        )}

        <button onClick={() => fileRef.current?.click()}>{doc ? '打开' : '选择 PDF'}</button>
        {doc && (
          <button className="primary" onClick={() => setExportOpen(true)}>
            导出
          </button>
        )}
        <button onClick={() => setSettingsOpen(true)} title="模型设置">
          设置
        </button>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = '';
        }}
      />

      {doc && pdf ? (
        <div className="body">
          {outlineOpen && <OutlinePanel nodes={outline} pageCount={doc.pageCount} onClose={() => setOutlineOpen(false)} />}
          <PdfViewer />
          <aside className="sidebar">
            <div className="tabs">
              <button className={sidebar === 'notes' ? 'on' : ''} onClick={() => setSidebar('notes')}>
                批注
              </button>
              <button className={sidebar === 'search' ? 'on' : ''} onClick={() => setSidebar('search')}>
                搜索
              </button>
              <button className={sidebar === 'summary' ? 'on' : ''} onClick={() => setSidebar('summary')}>
                AI 摘要
              </button>
            </div>
            {sidebar === 'notes' ? <NotePanel /> : sidebar === 'search' ? <SearchPanel /> : <SummaryPanel />}
          </aside>
        </div>
      ) : (
        <div className={`dropzone${hot ? ' hot' : ''}`}>
          <div className="box">
            <div className="big">{busy || '把 PDF 拖进来'}</div>
            <div className="sub" style={{ marginTop: 8 }}>
              在浏览器里读、随手划线、写批注，一键导出成能直接喂给 AI 的 Markdown 摘要包。
              <br />
              文件从头到尾都留在这台电脑上，不上传任何服务器。
            </div>
            <div style={{ marginTop: 18 }}>
              <button className="primary" onClick={() => fileRef.current?.click()}>
                选择 PDF 文件
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {exportOpen && exportInput && <ExportDialog input={exportInput} onClose={() => setExportOpen(false)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** Tiny hand-drawn icons — cheaper than pulling in an icon library. */
function KindIcon({ kind }: { kind: (typeof MARK_KINDS)[number] }) {
  const p = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (kind === 'highlight') {
    return (
      <svg {...p}>
        <path d="M2.6 13.6h10.8" />
        <path d="M4.4 10.8 5.2 7.9l5.1-5.1a1.35 1.35 0 0 1 1.9 1.9L7.1 9.8l-2.7 1z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (kind === 'underline') {
    return (
      <svg {...p}>
        <path d="M4.6 3v4.4a3.4 3.4 0 0 0 6.8 0V3" />
        <path d="M3.6 13.6h8.8" />
      </svg>
    );
  }
  if (kind === 'strike') {
    return (
      <svg {...p}>
        <path d="M11.6 4.6C10.8 3.7 9.7 3.2 8.3 3.2 6.5 3.2 5.2 4.2 5.2 5.6c0 1 .7 1.7 2 2.1" />
        <path d="M4.5 11.4c.8.9 2 1.4 3.4 1.4 1.8 0 3.1-1 3.1-2.4 0-.6-.2-1.2-.7-1.6" />
        <path d="M2.6 8h10.8" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <rect x="2.6" y="3.6" width="10.8" height="8.8" rx="1.6" strokeDasharray="3 2" />
    </svg>
  );
}
