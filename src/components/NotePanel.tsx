import { useEffect, useMemo, useRef, useState } from 'react';
import type { Mark, MarkColor, MarkKind } from '../types';
import { COLOR_LABEL, KIND_LABEL, MARK_COLORS, MARK_KINDS } from '../types';
import { COLOR_HEX } from '../lib/theme';
import { copyToClipboard } from '../lib/export';
import { removeMark, selectMark, updateMark, useApp } from '../store/app';

export default function NotePanel() {
  const { marks, selectedId } = useApp();
  const [query, setQuery] = useState('');
  const [onlyCommented, setOnlyCommented] = useState(false);
  const [colors, setColors] = useState<Set<MarkColor>>(() => new Set(MARK_COLORS));
  const [kinds, setKinds] = useState<Set<MarkKind>>(() => new Set(MARK_KINDS));

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return marks.filter((m) => {
      if (!colors.has(m.color)) return false;
      if (!kinds.has(m.kind)) return false;
      if (onlyCommented && !m.note.trim()) return false;
      if (!q) return true;
      return m.quote.toLowerCase().includes(q) || m.note.toLowerCase().includes(q);
    });
  }, [marks, query, onlyCommented, colors, kinds]);

  const commented = marks.filter((m) => m.note.trim()).length;

  if (!marks.length) {
    return (
      <div className="empty">
        还没有标注。
        <br />
        在左边按住鼠标拖一段文字，就划上了。
        <br />
        双击可以只选中一个词。
      </div>
    );
  }

  return (
    <>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <input
            placeholder="搜划线内容或批注…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          {MARK_COLORS.map((c) => (
            <button
              key={c}
              className={`chip${colors.has(c) ? ' on' : ''}`}
              style={{ borderColor: colors.has(c) ? COLOR_HEX[c] : undefined }}
              onClick={() => setColors((prev) => toggle(prev, c))}
              title={`筛选${COLOR_LABEL[c]}色`}
            >
              <span className="chip-dot" style={{ background: COLOR_HEX[c] }} />
              {COLOR_LABEL[c]}
            </button>
          ))}
        </div>

        <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          {MARK_KINDS.map((k) => (
            <button
              key={k}
              className={`chip${kinds.has(k) ? ' on' : ''}`}
              onClick={() => setKinds((prev) => toggle(prev, k))}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="row" style={{ justifyContent: 'space-between', fontSize: 12, color: 'var(--text-faint)' }}>
          <span>
            {filtered.length === marks.length
              ? `共 ${marks.length} 条 · ${commented} 条有批注`
              : `筛出 ${filtered.length} / ${marks.length} 条`}
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={onlyCommented}
              onChange={(e) => setOnlyCommented(e.target.checked)}
            />
            只看有批注
          </label>
        </div>
      </div>

      <div className="panel">
        {filtered.map((mark) => (
          <NoteCard key={mark.id} mark={mark} selected={mark.id === selectedId} />
        ))}
        {!filtered.length && <div className="empty">没有匹配的标注。</div>}
      </div>
    </>
  );
}

function NoteCard({ mark, selected }: { mark: Mark; selected: boolean }) {
  const [note, setNote] = useState(mark.note);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setNote(mark.note);
  }, [mark.id, mark.note]);

  const onChange = (value: string) => {
    setNote(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void updateMark(mark.id, { note: value });
    }, 400);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div
      className={`note-card${selected ? ' on' : ''}`}
      onClick={() => selectMark(mark.id)}
      style={{ borderLeft: `3px solid ${COLOR_HEX[mark.color]}` }}
    >
      <div className="note-head">
        <span>第 {mark.page} 页</span>
        <span>·</span>
        <span>
          {KIND_LABEL[mark.kind]} · {COLOR_LABEL[mark.color]}
        </span>
        <span className="spacer" />
        <button
          className="ghost"
          style={{ padding: '2px 6px', fontSize: 12 }}
          onClick={(e) => {
            e.stopPropagation();
            const payload = mark.note.trim() ? `${mark.quote}\n\n批注：${mark.note.trim()}` : mark.quote;
            void copyToClipboard(payload).then((ok) => {
              window.dispatchEvent(
                new CustomEvent('pdfmark:toast', { detail: ok ? '已复制原文' : '复制失败' }),
              );
            });
          }}
        >
          复制
        </button>
        <button
          className="ghost"
          style={{ padding: '2px 6px', fontSize: 12 }}
          onClick={(e) => {
            e.stopPropagation();
            void removeMark(mark.id);
          }}
        >
          删除
        </button>
      </div>

      <p className="note-quote">{mark.quote || '（无文字内容）'}</p>

      <textarea
        placeholder="写点批注…"
        value={note}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
