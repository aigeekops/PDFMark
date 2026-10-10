import { useEffect, useRef, useState } from 'react';
import type { LlmConfig } from '../types';
import { loadLlmConfig, saveLlmConfig } from '../store/app';
import type { ExportTemplates } from '../lib/templates';
import { TEMPLATE_VARIABLES, loadTemplates, resetTemplates, saveTemplates } from '../lib/templates';
import { streamChat } from '../lib/llm';

interface Props {
  onClose: () => void;
}

/** Public, documented endpoints — just keystroke savers. Nothing is sent anywhere by us. */
const PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3.5-lightning:free' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
];

const TEMPLATE_FIELDS: { key: keyof ExportTemplates; label: string; rows: number }[] = [
  { key: 'notesDoc', label: '笔记 Markdown · 整体', rows: 7 },
  { key: 'notesMark', label: '笔记 Markdown · 每条标注', rows: 5 },
  { key: 'packageDoc', label: 'AI 标注包 · 整体', rows: 10 },
  { key: 'packageMark', label: 'AI 标注包 · 每条标注', rows: 5 },
];

export default function SettingsDialog({ onClose }: Props) {
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const [templates, setTemplates] = useState<ExportTemplates>(loadTemplates);
  const [showTemplates, setShowTemplates] = useState(false);
  const [probe, setProbe] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; message: string }>({
    state: 'idle',
    message: '',
  });
  const probeAbort = useRef<AbortController | null>(null);

  useEffect(() => () => probeAbort.current?.abort(), []);

  const patch = (next: Partial<LlmConfig>) => setConfig((prev) => ({ ...prev, ...next }));

  const save = () => {
    saveLlmConfig(config);
    saveTemplates(templates);
    onClose();
  };

  /** One tiny round-trip, so a bad endpoint shows up here instead of mid-summary. */
  const testConnection = async () => {
    probeAbort.current?.abort();
    const controller = new AbortController();
    probeAbort.current = controller;
    setProbe({ state: 'running', message: '' });
    const started = Date.now();
    let got = '';
    try {
      for await (const delta of streamChat(
        config,
        [{ role: 'user', content: '只回复两个字：可用' }],
        controller.signal,
      )) {
        got += delta;
        if (got.length > 60) break;
      }
      const ms = Date.now() - started;
      setProbe({
        state: 'ok',
        message: `连接正常（${ms} ms）。模型回复：${got.trim().slice(0, 40) || '（空）'}`,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setProbe({ state: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="mask" onClick={onClose}>
      <div className="dialog" style={{ width: 'min(560px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <header>模型设置</header>
        <div className="content">
          <div className="field">
            <label>服务商 API 地址（OpenAI 兼容）</label>
            <input
              value={config.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
            <div className="hint">填到版本号即可（如 https://openrouter.ai/api/v1），粘贴完整 /chat/completions 端点也能识别。</div>
          </div>

          <div className="field">
            <label>API Key</label>
            <input
              type="password"
              value={config.apiKey}
              placeholder="sk-…"
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
            <div className="hint">
              只存在这台电脑的浏览器 localStorage 里，不写进代码、不随仓库上传。换电脑要重新填。
            </div>
          </div>

          <div className="field">
            <label>模型名</label>
            <input value={config.model} placeholder="gpt-4o-mini" onChange={(e) => patch({ model: e.target.value })} />
          </div>

          <div className="field">
            <label>快速填充</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {PRESETS.map((p) => (
                <button key={p.label} onClick={() => patch({ baseUrl: p.baseUrl, model: p.model })}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="row">
              <button onClick={() => void testConnection()} disabled={probe.state === 'running'}>
                {probe.state === 'running' ? '正在测试…' : '测试连接'}
              </button>
              <span className="hint" style={{ margin: 0, flex: 1 }}>
                发一句话给模型，看配置到底通不通。不需要先有标注。
              </span>
            </div>
            {probe.message && (
              <div className="hint" style={{ marginTop: 6, color: probe.state === 'ok' ? '#2f7d4f' : '#b04f18' }}>
                {probe.message}
              </div>
            )}
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label>
              <button className="ghost" style={{ padding: 0 }} onClick={() => setShowTemplates((v) => !v)}>
                {showTemplates ? '▾' : '▸'} 导出模板
              </button>
            </label>
            {showTemplates && (
              <>
                <div className="hint" style={{ marginBottom: 8 }}>
                  用 <code>{'{{变量}}'}</code> 占位。<code>{'{{marks}}'}</code> 是所有条目渲染后的结果，
                  只有整体模板能用；其余变量见下。改坏了可以一键恢复默认。
                </div>
                {TEMPLATE_FIELDS.map((f) => (
                  <div key={f.key} style={{ marginBottom: 10 }}>
                    <div className="hint" style={{ marginBottom: 4 }}>
                      {f.label}
                    </div>
                    <textarea
                      rows={f.rows}
                      value={templates[f.key]}
                      onChange={(e) => setTemplates((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
                <div className="row" style={{ marginBottom: 8 }}>
                  <button onClick={() => setTemplates(resetTemplates())}>恢复默认模板</button>
                </div>
                <div className="hint">
                  {TEMPLATE_VARIABLES.map((v) => (
                    <span key={v.name} style={{ marginRight: 10, whiteSpace: 'nowrap' }}>
                      <code>{`{{${v.name}}}`}</code> {v.desc}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <footer>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
