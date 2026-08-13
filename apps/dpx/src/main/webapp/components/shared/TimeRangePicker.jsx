import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button, TextInput, inputStyle } from './ui';

// ── 時間範囲ピッカー（Splunk 標準相当） ─────────────────────────
// プリセット（プリセット / 相対 / 全期間 / カスタム）をタブで切り替える
// ポップオーバー。値は Splunk の時間修飾子文字列（-24h@h, now, epoch 等）
// をそのまま扱うので、SPL の earliest/latest にそのまま渡せる。
// ────────────────────────────────────────────────────────────────

export const TIME_PRESETS = [
    { group: 'リアルタイム相当', items: [
        { label: '直近 15 分', earliest: '-15m', latest: 'now' },
        { label: '直近 60 分', earliest: '-60m', latest: 'now' },
        { label: '直近 4 時間', earliest: '-4h', latest: 'now' },
        { label: '直近 24 時間', earliest: '-24h', latest: 'now' },
        { label: '直近 7 日', earliest: '-7d', latest: 'now' },
        { label: '直近 30 日', earliest: '-30d', latest: 'now' },
    ] },
    { group: '当該期間', items: [
        { label: '今日', earliest: '@d', latest: 'now' },
        { label: '昨日', earliest: '-1d@d', latest: '@d' },
        { label: '今週', earliest: '@w0', latest: 'now' },
        { label: '先週', earliest: '-1w@w0', latest: '@w0' },
        { label: '今月', earliest: '@mon', latest: 'now' },
        { label: '先月', earliest: '-1mon@mon', latest: '@mon' },
        { label: '今年', earliest: '@y', latest: 'now' },
    ] },
    { group: 'その他', items: [
        { label: '全期間', earliest: '0', latest: 'now' },
    ] },
];

export function timeRangeLabel(earliest, latest) {
    for (const g of TIME_PRESETS) {
        const hit = g.items.find((p) => p.earliest === earliest && p.latest === latest);
        if (hit) return hit.label;
    }
    if (!earliest && !latest) return '全期間';
    return `${earliest || '0'} 〜 ${latest || 'now'}`;
}

export default function TimeRangePicker({ t, earliest, latest, onChange, width = 200 }) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState('preset');
    const [draft, setDraft] = useState({ earliest, latest });
    const [rect, setRect] = useState(null);
    const btnRef = useRef(null);
    const popRef = useRef(null);

    useLayoutEffect(() => {
        if (!open || !btnRef.current) return;
        setRect(btnRef.current.getBoundingClientRect());
        setDraft({ earliest, latest });
    }, [open, earliest, latest]);

    useEffect(() => {
        if (!open) return undefined;
        const close = (e) => {
            if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
            setOpen(false);
        };
        const onKey = (e) => e.key === 'Escape' && setOpen(false);
        window.addEventListener('pointerdown', close, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', close, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const apply = (e, l) => {
        onChange({ earliest: e, latest: l });
        setOpen(false);
    };

    const tabBtn = (id, label) => (
        <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
                flex: 1,
                padding: '6px 4px',
                background: tab === id ? `${t.accent}22` : 'transparent',
                border: 'none',
                borderBottom: tab === id ? `2px solid ${t.accent}` : '2px solid transparent',
                color: tab === id ? t.accent : t.subColor,
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: 'inherit',
            }}
        >
            {label}
        </button>
    );

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                className="dpx-input dpx-btn"
                onClick={() => setOpen((o) => !o)}
                style={{ ...inputStyle(t), width, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            >
                <span style={{ color: t.accent, fontSize: 11 }}>🕘</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                    {timeRangeLabel(earliest, latest)}
                </span>
                <span style={{ color: t.accent, fontSize: 9 }}>▼</span>
            </button>
            {open && rect ? (
                <div
                    ref={popRef}
                    style={{
                        position: 'fixed',
                        left: Math.min(rect.left, window.innerWidth - 320),
                        top: Math.min(rect.bottom + 4, window.innerHeight - 380),
                        width: 300,
                        background: t.colorScheme === 'light' ? '#ffffff' : '#111a2e',
                        border: `1px solid ${t.accent}55`,
                        borderRadius: 10,
                        boxShadow: '0 14px 40px rgba(0,0,0,0.55)',
                        zIndex: 10000,
                        overflow: 'hidden',
                    }}
                >
                    <div style={{ display: 'flex', borderBottom: '1px solid rgba(140,175,235,0.2)' }}>
                        {tabBtn('preset', 'プリセット')}
                        {tabBtn('relative', '相対')}
                        {tabBtn('absolute', '絶対')}
                        {tabBtn('advanced', '詳細')}
                    </div>
                    <div className="dpx-scroll" style={{ maxHeight: 300, overflowY: 'auto', padding: 10 }}>
                        {tab === 'preset' ? (
                            TIME_PRESETS.map((g) => (
                                <div key={g.group} style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 10, color: t.subColor, marginBottom: 4, letterSpacing: '0.08em' }}>
                                        {g.group}
                                    </div>
                                    {g.items.map((p) => {
                                        const selected = p.earliest === earliest && p.latest === latest;
                                        return (
                                            <button
                                                key={p.label}
                                                type="button"
                                                onClick={() => apply(p.earliest, p.latest)}
                                                style={{
                                                    display: 'block',
                                                    width: '100%',
                                                    textAlign: 'left',
                                                    padding: '5px 8px',
                                                    background: selected ? `${t.accent}22` : 'transparent',
                                                    border: 'none',
                                                    borderRadius: 5,
                                                    color: selected ? t.accent : t.titleColor,
                                                    fontSize: 12,
                                                    cursor: 'pointer',
                                                    fontFamily: 'inherit',
                                                }}
                                            >
                                                {p.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            ))
                        ) : tab === 'relative' ? (
                            <RelativeTab t={t} onApply={apply} />
                        ) : tab === 'absolute' ? (
                            <AbsoluteTab t={t} draft={draft} setDraft={setDraft} onApply={apply} />
                        ) : (
                            <div>
                                <div style={{ fontSize: 11, color: t.subColor, marginBottom: 6 }}>
                                    Splunk の時間修飾子をそのまま指定できます（例: <code>-24h@h</code> / <code>@d</code> / <code>now</code>）
                                </div>
                                <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, color: t.subColor, marginBottom: 3 }}>開始（earliest）</div>
                                    <TextInput t={t} value={draft.earliest} mono onChange={(v) => setDraft((d) => ({ ...d, earliest: v }))} />
                                </div>
                                <div style={{ marginBottom: 10 }}>
                                    <div style={{ fontSize: 11, color: t.subColor, marginBottom: 3 }}>終了（latest）</div>
                                    <TextInput t={t} value={draft.latest} mono onChange={(v) => setDraft((d) => ({ ...d, latest: v }))} />
                                </div>
                                <Button t={t} kind="primary" full label="適用" onClick={() => apply(draft.earliest, draft.latest)} />
                            </div>
                        )}
                    </div>
                </div>
            ) : null}
        </>
    );
}

function RelativeTab({ t, onApply }) {
    const [amount, setAmount] = useState(30);
    const [unit, setUnit] = useState('m');
    const [snap, setSnap] = useState(true);
    const units = [
        { value: 's', label: '秒' },
        { value: 'm', label: '分' },
        { value: 'h', label: '時間' },
        { value: 'd', label: '日' },
        { value: 'w', label: '週' },
        { value: 'mon', label: 'か月' },
        { value: 'y', label: '年' },
    ];
    const earliest = `-${amount}${unit}${snap ? `@${unit === 'w' ? 'w0' : unit}` : ''}`;
    return (
        <div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <input
                    className="dpx-input"
                    type="number"
                    min={1}
                    value={amount}
                    onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
                    style={{ ...inputStyle(t), width: 70 }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                    {units.map((u) => (
                        <button
                            key={u.value}
                            type="button"
                            onClick={() => setUnit(u.value)}
                            style={{
                                padding: '4px 8px',
                                background: unit === u.value ? `${t.accent}33` : 'transparent',
                                border: `1px solid ${unit === u.value ? t.accent : 'rgba(140,175,235,0.28)'}`,
                                borderRadius: 5,
                                color: unit === u.value ? t.accent : t.titleColor,
                                fontSize: 11,
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                            }}
                        >
                            {u.label}
                        </button>
                    ))}
                </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12, color: t.titleColor, cursor: 'pointer' }}>
                <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
                単位の先頭に丸める（snap）
            </label>
            <div style={{ fontSize: 11, color: t.subColor, marginBottom: 8, fontFamily: 'Menlo, Consolas, monospace' }}>
                {earliest} 〜 now
            </div>
            <Button t={t} kind="primary" full label="適用" onClick={() => onApply(earliest, 'now')} />
        </div>
    );
}

function AbsoluteTab({ t, draft, setDraft, onApply }) {
    // datetime-local ⇄ epoch 秒。SPL には epoch を渡す（曖昧さがない）
    const toLocalInput = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return '';
        const d = new Date(n * 1000);
        const pad = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const fromLocalInput = (s) => (s ? String(Math.floor(new Date(s).getTime() / 1000)) : '');
    return (
        <div>
            <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: t.subColor, marginBottom: 3 }}>開始日時</div>
                <input
                    className="dpx-input"
                    type="datetime-local"
                    style={inputStyle(t)}
                    value={toLocalInput(draft.earliest)}
                    onChange={(e) => setDraft((d) => ({ ...d, earliest: fromLocalInput(e.target.value) }))}
                />
            </div>
            <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: t.subColor, marginBottom: 3 }}>終了日時</div>
                <input
                    className="dpx-input"
                    type="datetime-local"
                    style={inputStyle(t)}
                    value={toLocalInput(draft.latest)}
                    onChange={(e) => setDraft((d) => ({ ...d, latest: fromLocalInput(e.target.value) }))}
                />
            </div>
            <Button
                t={t}
                kind="primary"
                full
                label="適用"
                onClick={() => onApply(draft.earliest, draft.latest)}
            />
        </div>
    );
}
