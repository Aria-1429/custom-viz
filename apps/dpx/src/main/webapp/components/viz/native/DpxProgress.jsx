import React from 'react';

import {
    BrushOverlay,
    EmptyHint,
    colorForValue,
    fmtNumber,
    resolveColorRules,
    seedFor,
    toNum,
    useBrush,
    useDpxTheme,
    useVizData,
} from '..';

// ── dpx.progress（進捗バー）─────────────────────────────────────
//
// データ規約: **1列目 = ラベル, 2列目 = 現在値**（3列目があれば目標値）。
//
// ## ランキング（dpx.ranking）と何が違うか
//
// ランキングは**項目どうしを比べる**（最大値を 100% として相対的に描く）。
// 進捗バーは**それぞれの目標に対する達成率**を描くので、
// **項目ごとに目標が違ってよい**。ノルマ・SLO・容量の使用率向け。
//
// ⚠ **100% を超える値がありうる**（超過達成・容量オーバー）。
//   バーは 100% で止めつつ、**数字は実値を出す**。丸めて隠すと事故に気づけない。
// ────────────────────────────────────────────────────────────────

export function DpxProgress({ dataSources, options = {}, height, loading, onEventTrigger, id }) {
    // ⭐ 画材（Brush Engine）。⚠ フックは early return より前（§8.1）
    const paint = useBrush();
    const t = useDpxTheme();
    const d = useVizData(dataSources);
    const [hover, setHover] = React.useState(null);
    const colorCfg = React.useMemo(() => resolveColorRules(options.colors, null), [options.colors]);

    if (d.isEmpty || d.columns.length < 2) {
        return <EmptyHint loading={loading} message="データがありません（1列目=ラベル、2列目=値）" />;
    }

    const labels = d.column(0);
    const values = d.column(1);
    const targets = d.columns.length > 2 ? d.column(2) : null;
    const fallbackTarget = Number(options.target) || 100;

    const rows = labels
        .map((l, i) => {
            const value = toNum(values[i]);
            const tgtRaw = targets ? toNum(targets[i]) : null;
            const target = Number.isFinite(tgtRaw) && tgtRaw > 0 ? tgtRaw : fallbackTarget;
            return { label: String(l ?? ''), value: value ?? 0, target };
        })
        .filter((r) => Number.isFinite(r.value));

    if (rows.length === 0) return <EmptyHint loading={loading} message="数値がありません" />;

    const h = typeof height === 'number' ? height : 240;
    const barH = Math.max(6, Math.min(Number(options.barHeight) || 10, 28));
    const showPercent = options.showPercent !== false;
    const fields = d.fieldNames;
    const palette = t.palette ?? [];

    return (
        <div className="dpx-scroll" style={{ height: h, overflow: 'auto', padding: '2px 4px' }}>
            {rows.map((r, i) => {
                // ⚠ 割合は 1 で頭打ちにする（バーが枠外へ伸びるのを防ぐ）。
                //   ただし表示する数字は実値のままにする
                const ratio = r.target > 0 ? r.value / r.target : 0;
                const clamped = Math.max(0, Math.min(1, ratio));
                const over = ratio > 1;
                const ruled = colorCfg
                    ? colorForValue(colorCfg, r.value) ?? colorForValue(colorCfg, r.label)
                    : null;
                const color =
                    ruled ||
                    (over && options.warnOver !== false
                        ? t.errorColor || '#e5534b'
                        : options.monochrome !== false
                          ? t.accent
                          : palette[i % palette.length] || t.accent);
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
                            padding: '5px 6px',
                            borderRadius: 4,
                            background: hover === i ? `${t.accent}12` : 'transparent',
                            cursor: onEventTrigger ? 'pointer' : 'default',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
                            <span
                                style={{
                                    flex: 1,
                                    minWidth: 0,
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
                            <span
                                style={{
                                    flex: 'none',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: over && options.warnOver !== false ? color : t.titleColor,
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                {showPercent
                                    ? `${Math.round(ratio * 100)}%`
                                    : `${fmtNumber(r.value)} / ${fmtNumber(r.target)}`}
                            </span>
                        </div>
                        <div
                            style={{
                                height: barH,
                                borderRadius: barH / 2,
                                background: 'rgba(128,160,220,0.14)',
                                overflow: 'hidden',
                            }}
                        >
                            <div
                                style={{
                                    height: '100%',
                                    position: 'relative',
                                    width: `${clamped * 100}%`,
                                    // ⭐ 画材のときは寸法だけ使う（当たり判定・アニメは div のまま）
                                    borderRadius: paint ? 0 : barH / 2,
                                    background: paint ? 'none' : color,
                                    transition: 'width 0.35s ease',
                                }}
                            >
                                {paint ? (
                                    <BrushOverlay
                                        paint={paint}
                                        seed={seedFor(id, r.label, i)}
                                        color={color}
                                    />
                                ) : null}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

DpxProgress.config = {
    key: 'dpx.progress',
    name: '進捗バー（目標比）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        target: { type: 'number', default: 100 },
        barHeight: { type: 'number', default: 10 },
        showPercent: { type: 'boolean', default: true },
        monochrome: { type: 'boolean', default: true },
        warnOver: { type: 'boolean', default: true },
        colors: { type: 'object', default: null },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '目標値（3列目があればそちら優先）', option: 'target', editor: 'editor.number' }],
                [{ label: 'バーの高さ(px)', option: 'barHeight', editor: 'editor.slider', editorProps: { min: 6, max: 28, step: 1 } }],
                [{ label: '％で表示', option: 'showPercent', editor: 'editor.checkbox' }],
                [{ label: '単色にする', option: 'monochrome', editor: 'editor.checkbox' }],
                [{ label: '超過を強調', option: 'warnOver', editor: 'editor.checkbox' }],
            ],
        },
        { label: '色', layout: [[{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }]] },
    ],
};
