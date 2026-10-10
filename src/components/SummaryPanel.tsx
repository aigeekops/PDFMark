import { useCallback, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { PackageScope } from '../lib/export';
import { DEFAULT_PACKAGE_OPTIONS, buildAiPackage, buildSummaryPrompt, copyToClipboard, downloadFile, estimateTokens } from '../lib/export';
import { streamChat } from '../lib/llm';
import type { ExportInput } from '../lib/export';
import { loadLlmConfig, makeExportInput, useApp } from '../store/app';

type Phase = 'idle' | 'packing' | 'streaming' | 'done' | 'error';

const SCOPE_LABEL: Record<PackageScope, string> = {
  marks: '只给划线片段',
  markedPages: '划线 + 所在页全文',
  fullDoc: '划线 + 全文',
};

export default function SummaryPanel() {
  const { doc, pdf, marks } = useApp();
  const [phase, setPhase] = useState<Phase>('idle');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [scope, setScope] = useState<PackageScope>(DEFAULT_PACKAGE_OPTIONS.scope);
  const [tokenHint, setTokenHint] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const config = loadLlmConfig();

  useEffect(() => () => abortRef.current?.abort(), []);

  // A model can take a long time to answer — show the wait ticking so a slow
  // response doesn't look like a frozen page.
  useEffect(() => {
    if (phase !== 'packing' && phase !== 'streaming') return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const buildInput = useCallback((): ExportInput | null => {
    if (!doc || !pdf) return null;
    return makeExportInput(doc, pdf, marks);
  }, [doc, pdf, marks]);

  const configured = Boolean(config.baseUrl.trim() && config.apiKey.trim() && config.model.trim());

  const run = useCallback(async () => {
    const input = buildInput();
    if (!input) return;
    if (!configured) {
      setError('还没配置模型。点顶部「设置」填 API 地址 / Key / 模型名。');
      setPhase('error');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('packing');
    setError('');
    setOutput('');
    let acc = '';
    try {
      const pkg = await buildAiPackage(input, { ...DEFAULT_PACKAGE_OPTIONS, scope });
      setTokenHint(estimateTokens(pkg));
      setPhase('streaming');
      for await (const delta of streamChat(
        config,
        [
          { role: 'system', content: buildSummaryPrompt(input.docName) },
          { role: 'user', content: pkg },
        ],
        controller.signal,
      )) {
        acc += delta;
        setOutput(acc);
      }
      if (!acc.trim()) {
        throw new Error('模型连上了，但一个字都没返回。多半是免费档被限流或排队超时，换个模型名或稍后重试。');
      }
      setPhase('done');
    } catch (err) {
      if (controller.signal.aborted) {
        // User pressed stop. Keep whatever arrived; if nothing did, go back to
        // the start screen instead of leaving a blank panel behind.
        setPhase(acc.trim() ? 'done' : 'idle');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [buildInput, config, configured, scope]);

  if (!doc) return null;

  return (
    <>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <div className="field" style={{ marginBottom: 8 }}>
          <label>喂给模型的原文范围</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as PackageScope)}>
            {(Object.keys(SCOPE_LABEL) as PackageScope[]).map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          {phase === 'streaming' ? (
            <button
              onClick={() => {
                abortRef.current?.abort();
              }}
            >
              停止
            </button>
          ) : (
            <button className="primary" onClick={() => void run()} disabled={!marks.length}>
              {phase === 'packing' ? <span className="spin" /> : null}
              {phase === 'packing' ? '整理标注…' : '生成摘要'}
            </button>
          )}
          <button
            onClick={() => {
              void (async () => {
                const input = buildInput();
                if (!input) return;
                const pkg = await buildAiPackage(input, { ...DEFAULT_PACKAGE_OPTIONS, scope });
                downloadFile(`${stripExt(doc.name)}-标注包.md`, pkg);
              })();
            }}
            disabled={!marks.length}
          >
            下载标注包
          </button>
        </div>

        <div className="hint" style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 8 }}>
          {configured ? `模型：${config.model}` : '未配置模型 — 可以先下载标注包，手动粘给任意 AI。'}
          {tokenHint ? ` · 本次约 ${tokenHint.toLocaleString()} tokens` : ''}
        </div>
        {(phase === 'packing' || phase === 'streaming') && (
          <div className="hint" style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>
            {phase === 'packing' ? '正在整理标注…' : elapsed < 3 ? '已发出请求，等模型开口…' : `等待中 ${elapsed}s`}
            {phase === 'streaming' && elapsed >= 3 ? ' — 免费档模型排队时可能要等一会儿' : ''}
          </div>
        )}
        {!configured && (
          <button
            className="ghost"
            style={{ padding: '2px 0', marginTop: 4 }}
            onClick={() => window.dispatchEvent(new CustomEvent('pdfmark:settings'))}
          >
            去设置 →
          </button>
        )}
      </div>

      <div className="panel">
        {phase === 'idle' && !output && (
          <div className="empty">
            点「生成摘要」，把你的划线和批注整理成一份重点摘要。
            <br />
            <br />
            也可以直接「下载标注包」，粘给 ChatGPT / Claude / 任何模型。
          </div>
        )}

        {phase === 'error' && (
          <div className="empty" style={{ color: '#b04f18' }}>
            {error}
          </div>
        )}

        {!output && (phase === 'packing' || phase === 'streaming') && (
          <div className="empty">
            正在把标注整理成提示词，然后等模型返回…
            {elapsed >= 3 && (
              <>
                <br />
                已等待 {elapsed}s。模型还没开口，可以继续等，也可以点「停止」。
              </>
            )}
          </div>
        )}

        {output && (
          <>
            <div
              className="markdown"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(output) as string) }}
            />
            <div className="row" style={{ marginTop: 16 }}>
              <button
                onClick={() => {
                  void copyToClipboard(output).then((ok) => {
                    if (ok) window.dispatchEvent(new CustomEvent('pdfmark:toast', { detail: '摘要已复制' }));
                  });
                }}
              >
                复制摘要
              </button>
              <button onClick={() => downloadFile(`${stripExt(doc.name)}-摘要.md`, output)}>下载 .md</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function stripExt(name: string): string {
  return name.replace(/\.pdf$/i, '');
}
