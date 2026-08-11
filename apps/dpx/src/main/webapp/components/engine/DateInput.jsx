import React, { useEffect, useMemo, useRef, useState } from 'react';

// ── カレンダー入力（Studio に無い入力型）─────────────────────────
// Studio の入力は dropdown / multiselect / text / number / timerange のみで、
// 「日付を1日だけ選ぶ」「期間を2点で選ぶ」ための**カレンダー UI が存在しない**。
// 時間範囲ピッカーの相対指定（-24h@h 等）は運用向けだが、
// 「2026-08-03 の分だけ見たい」のような**特定日の指定には向かない**。
//
// ここでは OS 依存の <input type="date"> を使わず自前で描く。理由:
//   - ブラウザ既定のカレンダーはダークテーマに追随せず浮く（他のドロップダウンと同じ問題）
//   - 週の開始曜日・和暦表記などの揺れをこちらで制御したい
//
// 値の形:
//   mode='single' … token に "YYYY-MM-DD"
//   mode='range'  … token.earliest / token.latest に Splunk の時刻修飾子を入れる
//                   （その日の 00:00 〜 翌日 00:00。SPL でそのまま使える）
// ────────────────────────────────────────────────────────────────

const WD = ['日', '月', '火', '水', '木', '金', '土'];

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
};
const sameDay = (a, b) => a && b && fmt(a) === fmt(b);

/** その月のカレンダーマス（前後の月で埋めた 6 週ぶん）。 */
function monthGrid(year, month) {
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export default function DateInput({ t, value, onChange, mode = 'single', width = 190 }) {
    const [open, setOpen] = useState(false);
    const [cursor, setCursor] = useState(() => parse(value)?.getTime?.() ?? Date.now());
    const [range, setRange] = useState({ from: null, to: null });
    const boxRef = useRef(null);
    const popRef = useRef(null);

    // 外側クリックで閉じる。⚠ ポップアップは fixed で DOM 上は外にあるので
    //   popRef も除外しないと「選ぼうとした瞬間に閉じる」（実機で踏んだ既知の罠）
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (boxRef.current?.contains(e.target)) return;
            if (popRef.current?.contains(e.target)) return;
            setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, [open]);

    const cur = new Date(cursor);
    const cells = useMemo(() => monthGrid(cur.getFullYear(), cur.getMonth()), [cursor]);
    const selected = parse(value);
    const today = new Date();

    const pick = (d) => {
        if (mode === 'range') {
            if (!range.from || range.to) {
                setRange({ from: d, to: null });
                return;
            }
            const [a, b] = d < range.from ? [d, range.from] : [range.from, d];
            setRange({ from: a, to: b });
            onChange({ from: fmt(a), to: fmt(b) });
            setOpen(false);
            return;
        }
        onChange(fmt(d));
        setOpen(false);
    };

    // ⚠ 幅が狭いと「期間を選択」が見切れる。範囲モードは既定幅でも収まる短い文言にし、
    //   選択後は MM/DD 表記に縮める（年は同一年なら自明なので落とす）。実機で調整。
    const short = (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
        return m ? `${m[2]}/${m[3]}` : s;
    };
    const label =
        mode === 'range'
            ? value && value.from
                ? `${short(value.from)} 〜 ${value.to ? short(value.to) : '…'}`
                : '期間'
            : value || '日付';

    const cellStyle = (d) => {
        const inMonth = d.getMonth() === cur.getMonth();
        const isSel =
            mode === 'range'
                ? (range.from && sameDay(d, range.from)) || (range.to && sameDay(d, range.to))
                : sameDay(d, selected);
        const inRange =
            mode === 'range' && range.from && range.to && d > range.from && d < range.to;
        return {
            height: 28,
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 11,
            fontFamily: 'inherit',
            background: isSel ? t.accent : inRange ? `${t.accent}26` : 'transparent',
            color: isSel ? '#fff' : inMonth ? t.textColor : t.subColor,
            opacity: inMonth ? 1 : 0.35,
            outline: sameDay(d, today) && !isSel ? `1px solid ${t.accent}66` : 'none',
        };
    };

    const rect = boxRef.current?.getBoundingClientRect();

    return (
        <div ref={boxRef} style={{ width }}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                style={{
                    width: '100%',
                    height: 30,
                    boxSizing: 'border-box',
                    textAlign: 'left',
                    padding: '0 9px',
                    borderRadius: 6,
                    border: `1px solid ${open ? t.accent : 'rgba(140,175,235,0.28)'}`,
                    background: t.colorScheme === 'light' ? '#f6f8fc' : 'rgba(8,14,28,0.85)',
                    color: value ? t.textColor : t.subColor,
                    fontSize: 12,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                }}
            >
                <svg viewBox="0 0 24 24" width="13" height="13" style={{ flex: 'none' }}>
                    <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke={t.subColor} strokeWidth="1.6" />
                    <line x1="3" y1="10" x2="21" y2="10" stroke={t.subColor} strokeWidth="1.6" />
                    <line x1="8" y1="3" x2="8" y2="6" stroke={t.subColor} strokeWidth="1.6" strokeLinecap="round" />
                    <line x1="16" y1="3" x2="16" y2="6" stroke={t.subColor} strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            </button>

            {open && rect ? (
                <div
                    ref={popRef}
                    style={{
                        position: 'fixed',
                        top: rect.bottom + 4,
                        left: Math.min(rect.left, window.innerWidth - 250),
                        width: 238,
                        zIndex: 5000,
                        padding: 10,
                        borderRadius: 10,
                        border: '1px solid rgba(140,175,235,0.28)',
                        background: t.colorScheme === 'light' ? '#ffffff' : 'rgba(12,20,38,0.99)',
                        boxShadow: '0 18px 44px rgba(0,0,0,0.5)',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                        <button type="button" onClick={() => setCursor(new Date(cur.getFullYear(), cur.getMonth() - 1, 1).getTime())} style={navBtn(t)}>
                            ‹
                        </button>
                        <span style={{ flex: 1, textAlign: 'center', fontSize: 12, color: t.titleColor }}>
                            {cur.getFullYear()}年 {cur.getMonth() + 1}月
                        </span>
                        <button type="button" onClick={() => setCursor(new Date(cur.getFullYear(), cur.getMonth() + 1, 1).getTime())} style={navBtn(t)}>
                            ›
                        </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                        {WD.map((w, i) => (
                            <div
                                key={w}
                                style={{
                                    textAlign: 'center',
                                    fontSize: 10,
                                    padding: '2px 0 4px',
                                    color: i === 0 ? '#ff8a8a' : i === 6 ? '#8ab4ff' : t.subColor,
                                }}
                            >
                                {w}
                            </div>
                        ))}
                        {cells.map((d) => (
                            <button key={d.getTime()} type="button" style={cellStyle(d)} onClick={() => pick(d)}>
                                {d.getDate()}
                            </button>
                        ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                        <button type="button" style={miniBtn(t)} onClick={() => pick(new Date())}>
                            今日
                        </button>
                        <button
                            type="button"
                            style={miniBtn(t)}
                            onClick={() => {
                                setRange({ from: null, to: null });
                                onChange(mode === 'range' ? { from: '', to: '' } : '');
                                setOpen(false);
                            }}
                        >
                            クリア
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

const navBtn = (t) => ({
    width: 24,
    height: 24,
    borderRadius: 5,
    border: '1px solid rgba(140,175,235,0.25)',
    background: 'transparent',
    color: t.subColor,
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
    padding: 0,
    fontFamily: 'inherit',
});

const miniBtn = (t) => ({
    flex: 1,
    height: 24,
    borderRadius: 5,
    border: '1px solid rgba(140,175,235,0.25)',
    background: 'transparent',
    color: t.subColor,
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'inherit',
});
