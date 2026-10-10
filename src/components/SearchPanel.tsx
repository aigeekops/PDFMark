import { useEffect, useRef, useState } from 'react';
import { clearSearch, focusSearchHit, runSearch, useApp } from '../store/app';

/**
 * Search lives in the sidebar rather than the toolbar: the toolbar is already
 * full, and the results are a list — which is what a sidebar is for.
 */
export default function SearchPanel() {
  const { search } = useApp();
  const [draft, setDraft] = useState(search.query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setDraft(search.query);
  }, [search.query]);

  // Keep the current match visible as the reader steps through with the arrows.
  useEffect(() => {
    if (search.activeIndex < 0) return;
    listRef.current?.querySelector('.hit.on')?.scrollIntoView({ block: 'nearest' });
  }, [search.activeIndex]);

  const submit = () => {
    void runSearch(draft);
  };

  const step = (delta: number) => {
    if (!search.hits.length) return;
    const next = (search.activeIndex + delta + search.hits.length) % search.hits.length;
    focusSearchHit(next);
  };

  return (
    <>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <div className="row">
          <input
            ref={inputRef}
            placeholder="搜索全文…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button className="primary" onClick={submit} disabled={search.running}>
            搜索
          </button>
        </div>

        {search.hits.length > 0 && (
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 6, fontSize: 12 }}>
            <span style={{ color: 'var(--text-faint)' }}>
              {search.activeIndex + 1} / {search.hits.length}
              {search.truncated ? ' · 结果过多已截断' : ''}
            </span>
            <span className="row" style={{ gap: 4 }}>
              <button style={{ padding: '2px 8px' }} onClick={() => step(-1)}>
                ↑
              </button>
              <button style={{ padding: '2px 8px' }} onClick={() => step(1)}>
                ↓
              </button>
              <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => clearSearch()}>
                清除
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="panel" ref={listRef}>
        {search.running && <div className="empty">正在搜索… {search.progress}</div>}
        {!search.running && !search.hits.length && (
          <div className="empty">
            {search.query ? '没有找到匹配。' : '输入关键词，回车搜索。'}
            <br />
            扫描件（整页是图片的 PDF）没有文字层，搜不到内容。
          </div>
        )}
        {!search.running &&
          search.hits.map((hit, i) => (
            <div
              key={hit.id}
              className={`hit${i === search.activeIndex ? ' on' : ''}`}
              onClick={() => focusSearchHit(i)}
            >
              <div className="hit-head">第 {hit.page} 页</div>
              <div className="hit-text">
                <Highlighted text={hit.context} match={hit.match} />
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

/** Wrap the matched substring so the eye lands on it in a long list. */
function Highlighted({ text, match }: { text: string; match: string }) {
  const at = text.toLowerCase().indexOf(match.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + match.length)}</mark>
      {text.slice(at + match.length)}
    </>
  );
}
