import React from 'react';

import {
    BrushOverlay,
    EmptyHint,
    colorForValue,
    resolveColorRules,
    seedFor,
    toNum,
    useBrush,
    useDpxTheme,
} from '..';

// ── dpx.ranking（ランキング）────────────────────────────────────
//
// データ規約: 1列目 = ラベル、2列目 = 値（降順に並べて上位を出す）
// ⚠ dpx.bar の横向きと見た目が似るが**別の viz**。
// ────────────────────────────────────────────────────────────────

export function DpxRanking({ dataSources, options = {}, height, loading, onEventTrigger, id }) {
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

    const topN = Number(options.topN) || 10;
    const rows = cols[0]
        .map((l, i) => ({ label: String(l ?? ''), value: toNum(cols[1][i]) ?? 0 }))
        .filter((r) => Number.isFinite(r.value));
    // 既定は降順。SPL 側で並べ替え済みの順を尊重したいときは「元の順」を選ぶ
    const sorted = options.order === 'none' ? rows : rows.slice().sort((a, b) => (options.order === 'asc' ? a.value - b.value : b.value - a.value));
    const shown = sorted.slice(0, topN);
    if (shown.length === 0) return <EmptyHint loading={loading} message="数値がありません" />;

    const max = Math.max(...shown.map((r) => r.value), 0) || 1;
    const h = typeof height === 'number' ? height : 240;
    const palette = t.palette ?? [];
    const showRank = options.showRank !== false;
    const fmtN = (n) => n.toLocaleString('ja-JP');

    return (
        <div className="dpx-scroll" style={{ height: h, overflow: 'auto' }}>
            {shown.map((r, i) => {
                const ruled = colorCfg ? colorForValue(colorCfg, r.label) ?? colorForValue(colorCfg, r.value) : null;
                const color = ruled || (options.monochrome !== false ? t.accent : palette[i % palette.length] || t.accent);
                return (
                    <div
                        key={`${r.label}-${i}`}
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'bar.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'label',
                                    value: r.label,
                                    [`row.${fields[0] ?? 'label'}.value`]: r.label,
                                    [`row.${fields[1] ?? 'value'}.value`]: r.value,
                                },
                            })
                        }
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '4px 6px',
                            borderRadius: 4,
                            background: hover === i ? `${t.accent}14` : 'transparent',
                            cursor: onEventTrigger ? 'pointer' : 'default',
                        }}
                    >
                        {showRank ? (
                            <span
                                style={{
                                    flex: 'none',
                                    width: 20,
                                    textAlign: 'right',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: i < 3 ? t.accent : t.subColor,
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                {i + 1}
                            </span>
                        ) : null}
                        <span
                            style={{
                                flex: 'none',
                                width: `${Math.min(Math.max(Number(options.labelWidth) || 34, 10), 60)}%`,
                                fontSize: 11,
                                color: t.titleColor,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                            title={r.label}
                        >
                            {r.label}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, height: 14, background: 'rgba(128,160,220,0.12)', borderRadius: 3, overflow: 'hidden' }}>
                            <span
                                style={{
                                    display: 'block',
                                    height: '100%',
                                    position: 'relative',
                                    width: `${Math.max((r.value / max) * 100, 1)}%`,
                                    // ⭐ 画材のときは寸法だけ使う（当たり判定・アニメは span のまま）
                                    background: paint ? 'none' : `linear-gradient(90deg, ${color}bb, ${color})`,
                                    borderRadius: paint ? 0 : 3,
                                    transition: 'width 0.3s ease',
                                }}
                            >
                                {paint ? (
                                    <BrushOverlay paint={paint} seed={seedFor(id, r.label, i)} color={color} />
                                ) : null}
                            </span>
                        </span>
                        <span style={{ flex: 'none', fontSize: 11, color: t.titleColor, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>
                            {fmtN(r.value)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

DpxRanking.config = {
    key: 'dpx.ranking',
    name: 'ランキング（横棒）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        topN: { type: 'number', default: 10 },
        order: { type: 'string', default: 'desc' },
        showRank: { type: 'boolean', default: true },
        monochrome: { type: 'boolean', default: true },
        labelWidth: { type: 'number', default: 34 },
        colors: { type: 'object', default: null },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '上位何件', option: 'topN', editor: 'editor.number', editorProps: { min: 1, max: 100 } }],
                [
                    {
                        label: '並び順',
                        option: 'order',
                        editor: 'editor.select',
                        editorProps: {
                            values: [
                                { value: 'desc', label: '大きい順' },
                                { value: 'asc', label: '小さい順' },
                                { value: 'none', label: 'サーチ結果のまま' },
                            ],
                        },
                    },
                ],
                [{ label: '順位を出す', option: 'showRank', editor: 'editor.checkbox' }],
                [{ label: '単色にする', option: 'monochrome', editor: 'editor.checkbox' }],
                [{ label: 'ラベル幅（%）', option: 'labelWidth', editor: 'editor.slider', editorProps: { min: 10, max: 60, step: 1 } }],
            ],
        },
        { label: '色', layout: [[{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }]] },
    ],
};
