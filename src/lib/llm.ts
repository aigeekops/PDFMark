import type { LlmConfig } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Waiting for the response headers. A gateway that is unreachable (wrong host,
 * blocked by a proxy, no CORS) can hang forever instead of failing, so this has
 * to be bounded — otherwise the UI sits on "streaming" with no way out.
 */
const CONNECT_TIMEOUT_MS = 30_000;
/** Waiting between two chunks once the stream has started. */
const IDLE_TIMEOUT_MS = 60_000;

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('还没填 API 地址');
  // Tolerate users pasting the full endpoint — most docs (OpenRouter included)
  // show `…/v1/chat/completions` in their curl examples.
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

/** OpenRouter wants these for app attribution; they also raise the free tier quota. */
function attributionHeaders(url: string): Record<string, string> {
  try {
    if (!new URL(url).hostname.endsWith('openrouter.ai')) return {};
  } catch {
    return {};
  }
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return {
    'HTTP-Referer': origin || 'https://github.com/aigeekops/pdfmark',
    'X-Title': 'PDFMark',
  };
}

/**
 * Minimal OpenAI-compatible streaming client. Works with OpenAI, and with any
 * gateway that speaks `/chat/completions` + SSE — which is most of them.
 */
export async function* streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (!config.apiKey.trim()) throw new Error('还没填 API Key');
  if (!config.model.trim()) throw new Error('还没填模型名');

  const url = endpoint(config.baseUrl);
  // Our own controller so a timeout can abort the request without marking the
  // caller's signal aborted (which the UI reads as "user pressed stop").
  const ctrl = new AbortController();
  let timedOut: 'connect' | 'idle' | null = null;

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const forward = () => ctrl.abort();
  signal.addEventListener('abort', forward, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number, why: 'connect' | 'idle') => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = why;
      ctrl.abort();
    }, ms);
  };

  let res: Response;
  try {
    arm(CONNECT_TIMEOUT_MS, 'connect');
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
        ...attributionHeaders(url),
      },
      body: JSON.stringify({
        model: config.model.trim(),
        messages,
        stream: true,
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
    if (timedOut === 'connect') {
      throw new Error(
        `请求发出 ${CONNECT_TIMEOUT_MS / 1000} 秒没有任何回应。地址能不能从浏览器打开、是否需要代理，都值得查一下。`,
      );
    }
    if (signal.aborted) throw err;
    throw new Error(
      `请求没能发出去：${err instanceof Error ? err.message : String(err)}。常见原因是地址拼错、网络/代理不通，或该网关不允许浏览器直接调用（CORS）。`,
    );
  }

  if (!res.ok) {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
    const detail = await res.text().catch(() => '');
    throw new Error(`模型返回 ${res.status}：${detail.slice(0, 300)}`);
  }
  if (!res.body) {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
    throw new Error('模型没有返回内容');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      arm(IDLE_TIMEOUT_MS, 'idle');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split('\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          // Some gateways report failures as an SSE frame instead of a status code.
          if (json?.error) {
            const message = json.error.message ?? JSON.stringify(json.error);
            throw new Error(`模型返回错误：${String(message).slice(0, 300)}`);
          }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        } catch (err) {
          if (err instanceof SyntaxError) continue; // keep-alive comment or partial frame
          throw err;
        }
      }
    }
  } catch (err) {
    if (timedOut === 'idle') {
      throw new Error(
        `连接已建立，但 ${IDLE_TIMEOUT_MS / 1000} 秒没有新内容返回。免费档模型排队时会出现这种情况，可以稍后重试或换个模型名。`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
  }
}
