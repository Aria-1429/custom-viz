import React from 'react';

import {
    BrushStrokes,
    EmptyHint,
    colorForValue,
    resolveColorRules,
    seedFor,
    toNum,
    useBrush,
    useDpxTheme,
} from '..';

// ── dpx.donut（ドーナツ）────────────────────────────────────────
//
// データ規約: 1列目 = ラベル、2列目 = 値
// ────────────────────────────────────────────────────────────────

export function DpxDonut({ dataSources, options = {}, width, height, loading, onEventTrigger, id }) {
    // ⭐ 画材（Brush Engine）。⚠ フックは early return より前（§8.1）
    const paint = useBrush();
    const t = useDpxTheme();
    const [hover, setHover] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    const colorCfg = React.useMemo(() => resolveColorRules(options.colors, null), [options.colors]);

    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=ラベル、2列目=値）" />;
    }

    const labels = cols[0];
    const values = cols[1].map(toNum);
    const pairs = labels
        .map((l, i) => ({ label: String(l ?? ''), value: values[i] ?? 0 }))
        .filter((p) => Number.isFinite(p.value) && p.value > 0);
    if (pairs.length === 0) return <EmptyHint loading={loading} message="数値がありません" />;

    const total = pairs.reduce((a, b) => a + b.value, 0);
    const w = typeof width === 'number' ? width : 320;
    const h = typeof height === 'number' ? height : 240;
    const size = Math.max(Math.min(w, h) - 16, 80);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 6;
    const inner = r * (Number(options.innerRatio) || 0.62);
    const palette = t.palette ?? [];

    // 円弧のパスを作る。⚠ 1件しか無いと start==end で円が消えるので、
    //    その場合はドーナツを丸ごと1色で描く。
    const arc = (a0, a1) => {
        const p = (a) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
        const q = (a) => [cx + Math.sin(a) * inner, cy - Math.cos(a) * inner];
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const [x0, y0] = p(a0);
        const [x1, y1] = p(a1);
        const [x2, y2] = q(a1);
        const [x3, y3] = q(a0);
        return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`;
    };

    let acc = 0;
    const slices = pairs.map((p, i) => {
        const a0 = (acc / total) * Math.PI * 2;
        acc += p.value;
        const a1 = (acc / total) * Math.PI * 2;
        const ruled = colorCfg ? colorForValue(colorCfg, p.label) ?? colorForValue(colorCfg, p.value) : null;
        return { ...p, a0, a1, color: ruled || palette[i % palette.length] || t.accent, pct: (p.value / total) * 100 };
    });

    const showLegend = options.showLegend !== false;
    const fmtN = (n) => n.toLocaleString('ja-JP');

    return (
        <div style={{ height: h, display: 'flex', alignItems: 'center', gap: 12, minHeight: 0 }}>
            <svg width={size} height={size} style={{ flex: 'none', overflow: 'visible' }}>
                {/* ⭐ 画材で塗った扇形（見た目）。当たり判定は下の <path> が持つ（原則 3）。
                    ⚠ 先に描く＝背面に置く。透明な当たり判定 path が上に重なる */}
                {paint
                    ? slices.map((sl, i) => (
                          <BrushStrokes
                              key={`b${i}`}
                              paths={paint.arc(
                                  cx,
                                  cy,
                                  r,
                                  inner,
                                  pairs.length === 1 ? 0 : sl.a0,
                                  pairs.length === 1 ? Math.PI * 1.9999 : sl.a1,
                                  // ⚠ seed に「値」を入れない（再サーチで形が変わる）
                                  seedFor(id, sl.label, i),
                                  sl.color
                              )}
                              color={sl.color}
                              opacity={hover === null || hover === i ? 1 : 0.42}
                          />
                      ))
                    : null}
                {slices.map((s, i) => (
                    <path
                        key={i}
                        d={pairs.length === 1 ? arc(0, Math.PI * 1.9999) : arc(s.a0, s.a1)}
                        // ⭐ 画材のときは**この path を透明にして当たり判定だけ残す**（原則 3）。
                        //    ホバー・クリックのハンドラがこの要素に付いているので、
                        //    消すとインタラクションが全部死ぬ
                        fill={paint ? 'transparent' : s.color}
                        opacity={paint ? 1 : hover === null || hover === i ? 1 : 0.42}
                        stroke={paint ? 'none' : t.colorScheme === 'light' ? '#ffffff' : '#0a1020'}
                        strokeWidth="1.5"
                        style={{ cursor: onEventTrigger ? 'pointer' : 'default', transition: 'opacity 0.12s ease' }}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'slice.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'label',
                                    value: s.label,
                                    [`row.${fields[0] ?? 'label'}.value`]: s.label,
                                    [`row.${fields[1] ?? 'value'}.value`]: s.value,
                                },
                            })
                        }
                    />
                ))}
                {/* 中央：合計、ホバー中はその要素の値 */}
                <text x={cx} y={cy - 4} textAnchor="middle" fontSize={Math.max(size * 0.055, 9)} fill={t.subColor}>
                    {hover === null ? options.centerLabel || '合計' : slices[hover].label}
                </text>
                <text
                    x={cx}
                    y={cy + Math.max(size * 0.085, 14)}
                    textAnchor="middle"
                    fontSize={Math.max(size * 0.115, 14)}
                    fontWeight="700"
                    fill={t.titleColor}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                    {hover === null ? fmtN(total) : `${slices[hover].pct.toFixed(1)}%`}
                </text>
            </svg>
            {showLegend ? (
                <div className="dpx-scroll" style={{ flex: 1, minWidth: 0, maxHeight: h, overflow: 'auto', fontSize: 11 }}>
                    {slices.map((s, i) => (
                        <div
                            key={i}
                            onMouseEnter={() => setHover(i)}
                            onMouseLeave={() => setHover(null)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '2px 4px',
                                borderRadius: 4,
                                background: hover === i ? `${t.accent}1f` : 'transparent',
                            }}
                        >
                            <span style={{ width: 9, height: 9, flex: 'none', borderRadius: 2, background: s.color }} />
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.titleColor }}>
                                {s.label}
                            </span>
                            <span style={{ color: t.subColor, fontVariantNumeric: 'tabular-nums' }}>
                                {options.legendShows === 'value' ? fmtN(s.value) : `${s.pct.toFixed(1)}%`}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

DpxDonut.config = {
    key: 'dpx.donut',
    name: 'ドーナツ（構成比）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        innerRatio: { type: 'number', default: 0.62 },
        showLegend: { type: 'boolean', default: true },
        legendShows: { type: 'string', default: 'percent' },
        centerLabel: { type: 'string', default: '合計' },
        colors: { type: 'object', default: null },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '穴の大きさ', option: 'innerRatio', editor: 'editor.slider', editorProps: { min: 0, max: 0.85, step: 0.01 } }],
                [{ label: '中央の見出し', option: 'centerLabel', editor: 'editor.text' }],
                [{ label: '凡例を出す', option: 'showLegend', editor: 'editor.checkbox' }],
                [
                    {
                        label: '凡例に出す値',
                        option: 'legendShows',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'percent', label: '割合（%）' },
                                { value: 'value', label: '実数' },
                            ],
                        },
                    },
                ],
            ],
        },
        { label: '色', layout: [[{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }]] },
    ],
};

// ── dpx.ranking ──────────────────────────────────────────────────
// 横棒のランキング。上位 N 件を「順位・ラベル・バー・値」で並べる。
// 縦棒（dpx.bar）はラベルが長いと潰れるので、項目名を読ませたいときはこちら。
