import React, { useEffect, useRef, useState } from 'react';

import { VIZ_CATEGORY_LABELS, listViz } from './vizRegistry';

// ── 編集モードのツールバー（Studio 準拠）───────────────────────────
// 「何を追加するか」をカテゴリごとのドロップダウンで選ぶ。
// Studio と同じ並び（チャート / 入力 / 装飾 / 図形 …）にしてあるのは、
// **こういう本質的でない部分は見慣れた形の方が使いやすい**ため。
//
// 押すと onAdd({kind, type}) が飛ぶ:
//   kind='viz'   … type は viz の登録名（dpx.line 等）
//   kind='input' … type は入力型（dropdown / timerange / date …）
// ────────────────────────────────────────────────────────────────

/** Studio に無い型も含む入力の一覧。★ は DPX 独自。 */
export const INPUT_KINDS = [
    { type: 'dropdown', name: 'ドロップダウン' },
    { type: 'multiselect', name: '複数選択' },
    { type: 'text', name: 'テキスト' },
    { type: 'number', name: '数値' },
    { type: 'timerange', name: '時間範囲' },
    { type: 'date', name: 'カレンダー（日付）', badge: 'DPX' },
    { type: 'daterange', name: 'カレンダー（期間）', badge: 'DPX' },
];

function Icon({ name, color }) {
    const c = { fill: 'none', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
    const g = {
        chart: (
            <g {...c}>
                <line x1="4" y1="19" x2="4" y2="11" />
                <line x1="10" y1="19" x2="10" y2="5" />
                <line x1="16" y1="19" x2="16" y2="14" />
            </g>
        ),
        input: (
            <g {...c}>
                <line x1="3" y1="8" x2="21" y2="8" />
                <circle cx="15" cy="8" r="2.6" fill={color} stroke="none" />
                <line x1="3" y1="16" x2="21" y2="16" />
                <circle cx="8" cy="16" r="2.6" fill={color} stroke="none" />
            </g>
        ),
        deco: (
            <g {...c}>
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="13" y2="17" />
            </g>
        ),
        shape: (
            <g {...c}>
                <rect x="3.5" y="6" width="10" height="10" rx="1.5" />
                <circle cx="16.5" cy="14" r="4.5" />
            </g>
        ),
        tab: (
            <g {...c}>
                <rect x="3" y="6" width="18" height="14" rx="2" />
                <path d="M3 10 L10 10 L10 6" />
            </g>
        ),
        // 区画：上辺の罫と、その下にくくられた2枚のパネル
        // （実際の見た目＝上辺の罫と揃える。中身を暗示する図にしない）
        group: (
            <g {...c}>
                <line x1="3" y1="6" x2="21" y2="6" />
                <rect x="4" y="10" width="7" height="9" rx="1" />
                <rect x="13" y="10" width="7" height="9" rx="1" />
            </g>
        ),
        data: (
            <g {...c}>
                <ellipse cx="12" cy="6" rx="7.5" ry="3" />
                <path d="M4.5 6 v6 c0 1.7 3.4 3 7.5 3 s7.5 -1.3 7.5 -3 V6" />
                <path d="M4.5 12 v6 c0 1.7 3.4 3 7.5 3 s7.5 -1.3 7.5 -3 v-6" />
            </g>
        ),
    };
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            {g[name] ?? g.chart}
        </svg>
    );
}

function Menu({ t, label, icon, items, onPick }) {
    const [open, setOpen] = useState(false);
    const btnRef = useRef(null);
    const popRef = useRef(null);
    const [rect, setRect] = useState(null);

    useEffect(() => {
        if (!open) return undefined;
        setRect(btnRef.current?.getBoundingClientRect() ?? null);
        // ⚠ ポップアップは fixed で DOM 上トリガーの外。popRef も除外しないと
        //   項目クリックが「外側」と判定されて閉じるだけになる（既知の罠）
        const onDown = (e) => {
            if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
            setOpen(false);
        };
        const onKey = (e) => e.key === 'Escape' && setOpen(false);
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                title={label}
                onClick={() => setOpen((o) => !o)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    height: 30,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: `1px solid ${open ? t.accent : 'transparent'}`,
                    background: open ? `${t.accent}1c` : 'transparent',
                    color: open ? t.accent : t.titleColor,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 12,
                }}
            >
                <Icon name={icon} color={open ? t.accent : t.subColor} />
                <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
            </button>
            {open && rect ? (
                <div
                    ref={popRef}
                    style={{
                        position: 'fixed',
                        top: rect.bottom + 5,
                        left: Math.min(rect.left, window.innerWidth - 240),
                        width: 226,
                        maxHeight: '60vh',
                        overflowY: 'auto',
                        zIndex: 5000,
                        padding: 5,
                        borderRadius: 9,
                        border: '1px solid rgba(140,175,235,0.28)',
                        background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(12,20,38,0.99)',
                        boxShadow: '0 18px 44px rgba(0,0,0,0.5)',
                    }}
                    className="dpx-scroll"
                >
                    <div style={{ fontSize: 10, color: t.subColor, padding: '4px 8px 6px', letterSpacing: '0.08em' }}>
                        {label}
                    </div>
                    {items.map((it) => (
                        <button
                            key={it.type}
                            type="button"
                            onClick={() => {
                                onPick(it.type);
                                setOpen(false);
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                width: '100%',
                                textAlign: 'left',
                                padding: '7px 8px',
                                borderRadius: 6,
                                border: 'none',
                                background: 'transparent',
                                color: t.textColor,
                                cursor: 'pointer',
                                fontSize: 12,
                                fontFamily: 'inherit',
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = `${t.accent}18`;
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent';
                            }}
                        >
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {it.name}
                            </span>
                            {it.badge ? (
                                <span
                                    style={{
                                        fontSize: 9,
                                        padding: '1px 5px',
                                        borderRadius: 4,
                                        color: t.accent,
                                        border: `1px solid ${t.accent}66`,
                                    }}
                                >
                                    {it.badge}
                                </span>
                            ) : null}
                        </button>
                    ))}
                </div>
            ) : null}
        </>
    );
}

const sep = () => (
    <span style={{ width: 1, height: 20, background: 'rgba(140,175,235,0.22)', flex: 'none', margin: '0 4px' }} />
);

export default function EditToolbar({
    t,
    onAddViz,
    onAddInput,
    onAddTab,
    onAddGroup,
    canUndo,
    onUndo,
    canRedo,
    onRedo,
    onOpenDataSources,
    dataSourceCount = 0,
}) {
    const all = listViz();
    const byCat = (cat) => all.filter((v) => (v.category ?? 'custom') === cat).map((v) => ({ type: v.type, name: v.name }));
    const charts = [...byCat('chart'), ...byCat('status'), ...byCat('custom')];

    const iconBtn = (enabled) => ({
        width: 30,
        height: 30,
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'transparent',
        color: enabled ? t.titleColor : t.subColor,
        opacity: enabled ? 1 : 0.35,
        cursor: enabled ? 'pointer' : 'default',
        fontFamily: 'inherit',
        fontSize: 15,
        lineHeight: 1,
        padding: 0,
    });

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: '5px 8px',
                marginBottom: 12,
                borderRadius: 9,
                background: t.colorScheme === 'light' ? '#f4f7fc' : 'rgba(255,255,255,0.045)',
                border: '1px solid rgba(140,175,235,0.18)',
            }}
        >
            <button type="button" title="元に戻す" style={iconBtn(canUndo)} disabled={!canUndo} onClick={onUndo}>
                ↶
            </button>
            <button type="button" title="やり直す" style={iconBtn(canRedo)} disabled={!canRedo} onClick={onRedo}>
                ↷
            </button>
            {sep()}
            <Menu t={t} label="チャート" icon="chart" items={charts} onPick={onAddViz} />
            <Menu t={t} label="入力" icon="input" items={INPUT_KINDS} onPick={onAddInput} />
            <Menu t={t} label="装飾" icon="deco" items={byCat('deco')} onPick={onAddViz} />
            <Menu t={t} label="図形" icon="shape" items={byCat('shape')} onPick={onAddViz} />
            {sep()}
            {/* 区画（グループ）＝複数パネルを1つの領域としてくくる。
                パネル・入力と並ぶ「追加できるもの」なのでツールバーに置く */}
            <button type="button" title="区画を追加（パネルをくくる枠）" style={iconBtn(true)} onClick={onAddGroup}>
                <Icon name="group" color={t.subColor} />
            </button>
            <button type="button" title="タブを追加" style={iconBtn(true)} onClick={onAddTab}>
                <Icon name="tab" color={t.subColor} />
            </button>
            {sep()}
            {/* データソース（共有サーチ）。Studio と同じく、サーチは
                ダッシュボードに属するものとして上部から管理する */}
            <button
                type="button"
                title="データソース（共有サーチ）"
                onClick={onOpenDataSources}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 30,
                    padding: '0 9px',
                    borderRadius: 6,
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: t.titleColor,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 12,
                }}
            >
                <Icon name="data" color={t.subColor} />
                <span>データソース</span>
                {dataSourceCount > 0 ? (
                    <span
                        style={{
                            fontSize: 10,
                            minWidth: 16,
                            textAlign: 'center',
                            padding: '1px 4px',
                            borderRadius: 8,
                            color: t.accent,
                            border: `1px solid ${t.accent}66`,
                        }}
                    >
                        {dataSourceCount}
                    </span>
                ) : null}
            </button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: t.subColor, paddingRight: 4 }}>
                ドラッグで移動 / 矢印キーで微調整 / Shift+矢印でリサイズ / Ctrl+D 複製 / Ctrl+S 保存
            </span>
        </div>
    );
}
