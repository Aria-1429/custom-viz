import React, { useEffect, useMemo, useRef, useState } from 'react';

import { VIZ_CATEGORY_LABELS, listViz } from '../viz/registry';

// ── viz ピッカー（パネル追加時に「まず viz を選ぶ」）───────────────
// 以前は「とりあえず棒グラフのパネルが生える → 後で種類を変える」形だった。
// 実際の作業順は「何を見せたいか（viz）を決めてから置く」なので、そちらに合わせる。
//
// DPX ならではの点:
//   Studio の viz 切替は右ペインのドロップダウン1個だが、DPX は iframe が無く
//   全 viz が同じツリーに居るので、**カード一覧でプレビューしながら選べる**。
// ────────────────────────────────────────────────────────────────

// 並び順：**データを見せるものが先、飾りは後**。
// ⚠ 未知のカテゴリを indexOf で引くと -1 になり**先頭に来てしまう**。
//   'shape' を書き忘れていたため図形が一番上に出ていた（実機で発生）。
//   → 見つからない場合は末尾に送る rank() を通す。
const CATEGORY_ORDER = ['chart', 'status', 'custom', 'deco', 'shape'];
const rank = (c) => {
    const i = CATEGORY_ORDER.indexOf(c ?? 'custom');
    return i < 0 ? CATEGORY_ORDER.length : i;
};

/** カテゴリごとの簡易アイコン（外部アセットを使わず SVG で描く）。 */
function VizGlyph({ type, color }) {
    const common = { fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
    const paths = {
        'dpx.line': <polyline points="2,17 8,10 13,13 22,4" {...common} />,
        'dpx.bar': (
            <g {...common}>
                <line x1="4" y1="20" x2="4" y2="11" />
                <line x1="10" y1="20" x2="10" y2="5" />
                <line x1="16" y1="20" x2="16" y2="14" />
                <line x1="21" y1="20" x2="21" y2="8" />
            </g>
        ),
        'dpx.value': (
            <g {...common}>
                <path d="M4 16 L8 6 L12 16" />
                <line x1="5.5" y1="13" x2="10.5" y2="13" />
                <line x1="16" y1="16" x2="21" y2="16" />
            </g>
        ),
        'dpx.status': (
            <g {...common}>
                <circle cx="7" cy="12" r="3.2" />
                <circle cx="17" cy="12" r="3.2" />
            </g>
        ),
        'dpx.table': (
            <g {...common}>
                <rect x="3" y="5" width="18" height="14" rx="1.5" />
                <line x1="3" y1="10" x2="21" y2="10" />
                <line x1="9" y1="10" x2="9" y2="19" />
            </g>
        ),
        'deco.text': (
            <g {...common}>
                <line x1="4" y1="8" x2="20" y2="8" />
                <line x1="4" y1="13" x2="20" y2="13" />
                <line x1="4" y1="18" x2="14" y2="18" />
            </g>
        ),
        'deco.clock': (
            <g {...common}>
                <circle cx="12" cy="12" r="8" />
                <path d="M12 7.5 L12 12 L15.5 14" />
            </g>
        ),
    };
    return (
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
            {paths[type] ?? (
                <g {...common}>
                    <rect x="3.5" y="5" width="17" height="14" rx="2" />
                    <path d="M7 15 L11 10 L14 13 L17.5 8.5" />
                </g>
            )}
        </svg>
    );
}

export default function VizPicker({ t, onPick, onCancel }) {
    const [q, setQ] = useState('');
    const [active, setActive] = useState(0);
    const inputRef = useRef(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Esc で閉じる
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onCancel?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    const all = useMemo(() => listViz(), []);
    const hits = useMemo(() => {
        const s = q.trim().toLowerCase();
        const list = s
            ? all.filter((v) => v.name.toLowerCase().includes(s) || v.type.toLowerCase().includes(s))
            : all;
        // カテゴリ順に並べる
        return [...list].sort(
            (a, b) =>
                rank(a.category) - rank(b.category) ||
                a.name.localeCompare(b.name)
        );
    }, [all, q]);

    // グループ化して見出しを出す
    const groups = useMemo(() => {
        const m = new Map();
        hits.forEach((v) => {
            const c = v.category ?? 'custom';
            if (!m.has(c)) m.set(c, []);
            m.get(c).push(v);
        });
        return [...m.entries()];
    }, [hits]);

    const commit = (i) => {
        const v = hits[i];
        if (v) onPick(v.type);
    };

    const onKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, hits.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            commit(active);
        }
    };

    let flat = -1; // グループをまたいだ通し番号（キーボード操作用）

    return (
        <div
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onCancel?.();
            }}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 4000,
                background: 'rgba(4, 8, 18, 0.62)',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                paddingTop: '9vh',
            }}
        >
            <div
                style={{
                    width: 620,
                    maxWidth: '92vw',
                    maxHeight: '76vh',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 12,
                    border: '1px solid rgba(140,175,235,0.25)',
                    background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(13, 21, 40, 0.98)',
                    boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
                    overflow: 'hidden',
                }}
            >
                <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid rgba(140,175,235,0.16)' }}>
                    <div style={{ fontSize: 13, color: t.titleColor, marginBottom: 9, fontWeight: 600 }}>
                        ビジュアライゼーションを選ぶ
                    </div>
                    <input
                        ref={inputRef}
                        className="dpx-input"
                        value={q}
                        placeholder="名前で絞り込み（↑↓ で移動・Enter で決定・Esc で閉じる）"
                        onChange={(e) => {
                            setQ(e.target.value);
                            setActive(0);
                        }}
                        onKeyDown={onKeyDown}
                        style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            padding: '7px 10px',
                            borderRadius: 6,
                            border: '1px solid rgba(140,175,235,0.28)',
                            background: t.colorScheme === 'light' ? '#f6f8fc' : 'rgba(8,14,28,0.9)',
                            color: t.textColor,
                            fontSize: 12,
                            outline: 'none',
                        }}
                    />
                </div>

                <div className="dpx-scroll" style={{ overflowY: 'auto', padding: '10px 12px 14px' }}>
                    {hits.length === 0 ? (
                        <div style={{ fontSize: 12, color: t.subColor, padding: 16, textAlign: 'center' }}>
                            該当する viz がありません
                        </div>
                    ) : (
                        groups.map(([cat, items]) => (
                            <div key={cat} style={{ marginBottom: 12 }}>
                                <div
                                    style={{
                                        fontSize: 10,
                                        letterSpacing: '0.1em',
                                        color: t.subColor,
                                        margin: '4px 4px 7px',
                                    }}
                                >
                                    {VIZ_CATEGORY_LABELS[cat] ?? cat}
                                </div>
                                <div
                                    style={{
                                        display: 'grid',
                                        // カスタム viz の type は長いので枠を少し広めに取る
                                        gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))',
                                        gap: 8,
                                    }}
                                >
                                    {items.map((v) => {
                                        flat += 1;
                                        const i = flat;
                                        const on = i === active;
                                        return (
                                            <button
                                                key={v.type}
                                                type="button"
                                                onMouseEnter={() => setActive(i)}
                                                onClick={() => onPick(v.type)}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 10,
                                                    padding: '10px 11px',
                                                    borderRadius: 8,
                                                    cursor: 'pointer',
                                                    textAlign: 'left',
                                                    border: `1px solid ${on ? t.accent : 'rgba(140,175,235,0.2)'}`,
                                                    background: on
                                                        ? `${t.accent}1f`
                                                        : t.colorScheme === 'light'
                                                          ? '#fbfcfe'
                                                          : 'rgba(255,255,255,0.03)',
                                                    color: t.textColor,
                                                    transition: 'border-color .12s ease, background .12s ease',
                                                }}
                                            >
                                                <VizGlyph type={v.type} color={on ? t.accent : t.subColor} />
                                                {/* ⚠ **flex の子は既定で縮まない**（min-width:auto）。
                                                    `minWidth:0` と `flex:1` を付けないと、中の長い文字列が
                                                    ボタンを押し広げて**隣のカードに重なる**（実機で発生：
                                                    `custom_viz_attack_globe.custom_viz_…` がはみ出した）。 */}
                                                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                                                    <span
                                                        style={{
                                                            display: 'block',
                                                            fontSize: 12,
                                                            fontWeight: 600,
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap',
                                                        }}
                                                    >
                                                        {v.name}
                                                    </span>
                                                    {/* ⚠ こちらにも省略指定が要る（名前だけ付けていて漏れていた）。
                                                        カスタム viz の type は `app.app` 形式で非常に長い */}
                                                    <span
                                                        style={{
                                                            display: 'block',
                                                            fontSize: 10,
                                                            color: t.subColor,
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap',
                                                        }}
                                                        title={v.type}
                                                    >
                                                        {v.type}
                                                    </span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
