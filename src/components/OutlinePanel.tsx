import { useCallback, useMemo, useState } from 'react';
import { flattenOutline } from '../lib/outline';
import type { OutlineNode } from '../lib/outline';
import { setCurrentPage, useApp } from '../store/app';

interface Props {
  /** null while still being read. */
  nodes: OutlineNode[] | null;
  pageCount: number;
  onClose: () => void;
}

export default function OutlinePanel({ nodes, pageCount, onClose }: Props) {
  const { currentPage } = useApp();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [jump, setJump] = useState('');

  const flat = useMemo(() => {
    if (!nodes) return [];
    const all = flattenOutline(nodes);
    // Hide anything nested under a collapsed ancestor.
    const hiddenBelow: number[] = [];
    return all.filter(({ node, depth }) => {
      if (hiddenBelow.length && depth > hiddenBelow[hiddenBelow.length - 1]) return false;
      while (hiddenBelow.length && depth <= hiddenBelow[hiddenBelow.length - 1]) hiddenBelow.pop();
      const key = keyOf(node);
      if (collapsed.has(key)) hiddenBelow.push(depth);
      return true;
    });
  }, [nodes, collapsed]);

  /** The last bookmark at or before the page on screen — i.e. where we are. */
  const activeKey = useMemo(() => {
    if (!nodes?.length || !currentPage) return null;
    let best: OutlineNode | null = null;
    for (const { node } of flattenOutline(nodes)) {
      if (node.page !== null && node.page <= currentPage) best = node;
      else if (node.page !== null && node.page > currentPage) break;
    }
    return best ? keyOf(best) : null;
  }, [nodes, currentPage]);

  const jumpTo = useCallback((page: number) => {
    document.getElementById(`page-${page}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setCurrentPage(page);
  }, []);

  const go = () => {
    const page = Number(jump);
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      setJump('');
      return;
    }
    jumpTo(page);
    setJump('');
  };

  return (
    <nav className="outline">
      <div className="outline-head">
        <span>目录</span>
        <button className="ghost" style={{ padding: '2px 6px', fontSize: 12 }} onClick={onClose}>
          收起
        </button>
      </div>

      <div className="outline-tree">
        {nodes === null && <div className="empty">读取目录…</div>}

        {nodes?.length === 0 && (
          <div className="empty">
            这份 PDF 没有内置书签目录。
            <br />
            可以用下面的页码直接跳。
          </div>
        )}

        {flat.map(({ node, depth }) => {
          const key = keyOf(node);
          const hasChildren = node.children.length > 0;
          return (
            <div
              key={key}
              className={`outline-item${activeKey === key ? ' on' : ''}`}
              style={{ paddingLeft: 6 + depth * 12 }}
              title={node.title}
              onClick={() => {
                if (hasChildren) {
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                }
                if (node.page !== null) jumpTo(node.page);
              }}
            >
              <span className="twisty">{hasChildren ? (collapsed.has(key) ? '▸' : '▾') : ''}</span>
              <span
                className="title"
                style={{ fontWeight: node.bold ? 650 : 400, fontStyle: node.italic ? 'italic' : 'normal' }}
              >
                {node.title}
              </span>
              <span className="pg">{node.page ?? ''}</span>
            </div>
          );
        })}
      </div>

      <div className="outline-foot">
        <input
          placeholder={`跳到第 1–${pageCount} 页`}
          value={jump}
          onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
        />
        <button onClick={go}>跳转</button>
      </div>
    </nav>
  );
}

/** Titles repeat constantly in real PDFs, so index them by identity instead. */
const ids = new WeakMap<OutlineNode, string>();
let counter = 0;
function keyOf(node: OutlineNode): string {
  let id = ids.get(node);
  if (!id) {
    id = `n${counter++}`;
    ids.set(node, id);
  }
  return id;
}
