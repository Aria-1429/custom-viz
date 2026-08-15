import React from 'react';

import {
    EmptyHint,
    VizTooltip,
    buildMatrix,
    cellKey,
    fmtNumber,
    heatRatio,
    pickTextColor,
    useContainerSize,
    useDpxTheme,
    useVizData,
} from '..';

// ── dpx.heatmap（クロス集計の濃淡）──────────────────────────────
//
// データ規約: **1列目 = 行, 2列目 = 列, 3列目 = 値**（`| stats count by a, b` の形）。
//
// ## 何を見る viz か
//
// 「曜日 × 時間帯」「ホスト × エラー種別」のように**2 つの軸の交差**で
// 濃淡を見る。表（dpx.table）は数字を読ませるが、こちらは**塊や偏りを一目で**掴む。
//
// ⚠ **セルに必ず数字を出さない**。セルが小さいと文字が潰れて読めないので、
//   幅・高さが足りるときだけ出す（自動判定）。
// ────────────────────────────────────────────────────────────────

export function DpxHeatmap({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    const d = useVizData(dataSources);
    const [hover, setHover] = React.useState(null);
    const [ref, w] = useContainerSize(600);

    const m = React.useMemo(
        () => buildMatrix(d.column(0), d.column(1), d.column(2)),
        [d]
    );

    if (d.isEmpty || d.columns.length < 3 || m.rows.length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=行、2列目=列、3列目=値）" />;
    }

    const h = typeof height === 'number' ? height : 240;
    const labelW = Math.min(Math.max(Number(options.labelWidth) || 70, 30), 160);
    const headH = 18;
    const gridW = Math.max(10, w - labelW - 8);
    const gridH = Math.max(10, h - headH - 6);
    const cellW = gridW / m.cols.length;
    const cellH = gridH / m.rows.length;
    const base = options.color || t.accent;
    // 文字を出せるだけの余裕があるときだけ数字を描く
    const showNums = options.showValues !== false && cellW >= 34 && cellH >= 18;
    const fields = d.fieldNames;

    return (
        <div ref={ref} style={{ height: h, position: 'relative' }}>
            <svg width="100%" height={h}>
                {/* 列見出し */}
                {m.cols.map((c, ci) => (
                    <text
                        key={c}
                        x={labelW + ci * cellW + cellW / 2}
                        y={12}
                        textAnchor="middle"
                        style={{ fontSize: 10, fill: t.subColor }}
                    >
                        {cellW >= 26 ? c : ''}
                    </text>
                ))}
                {m.rows.map((r, ri) => (
                    <g key={r}>
                        <text
                            x={labelW - 6}
                            y={headH + ri * cellH + cellH / 2 + 3}
                            textAnchor="end"
                            style={{ fontSize: 10, fill: t.subColor }}
                        >
                            {cellH >= 12 ? r : ''}
                        </text>
                        {m.cols.map((c, ci) => {
                            const v = m.map.get(cellKey(r, c));
                            const has = v != null;
                            const ratio = has ? heatRatio(v, m.min, m.max) : 0;
                            const x = labelW + ci * cellW;
                            const y = headH + ri * cellH;
                            const isHover = hover && hover.r === ri && hover.c === ci;
                            return (
                                <g key={c}>
                                    <rect
                                        x={x + 0.5}
                                        y={y + 0.5}
                                        width={Math.max(1, cellW - 1)}
                                        height={Math.max(1, cellH - 1)}
                                        rx={2}
                                        // 欠測は「薄い塗り」ではなく**枠だけ**にする。
                                        // 薄い塗りだと「値が小さい」と誤読される
                                        fill={has ? base : 'transparent'}
                                        fillOpacity={has ? 0.12 + ratio * 0.85 : 0}
                                        stroke={has ? 'none' : 'rgba(128,160,220,0.16)'}
                                        strokeWidth={1}
                                        style={{
                                            cursor: onEventTrigger ? 'pointer' : 'default',
                                            outline: isHover ? `1px solid ${t.accent}` : 'none',
                                        }}
                                        onMouseEnter={() => setHover({ r: ri, c: ci })}
                                        onMouseLeave={() => setHover(null)}
                                        onClick={(originalEvent) =>
                                            has &&
                                            onEventTrigger?.({
                                                type: 'cell.click',
                                                originalEvent,
                                                payload: {
                                                    name: fields[0] ?? 'row',
                                                    value: r,
                                                    [`row.${fields[0] ?? 'row'}.value`]: r,
                                                    [`row.${fields[1] ?? 'col'}.value`]: c,
                                                    [`row.${fields[2] ?? 'value'}.value`]: v,
                                                },
                                            })
                                        }
                                    />
                                    {showNums && has ? (
                                        <text
                                            x={x + cellW / 2}
                                            y={y + cellH / 2 + 3}
                                            textAnchor="middle"
                                            style={{
                                                fontSize: 10,
                                                pointerEvents: 'none',
                                                // ⚠ 濃い地に濃い文字を置かない。地の濃さから白/黒を選ぶ。
                                                //   ⚠ 地が解釈できないと null が返るので必ず既定へ落とす
                                                fill: (ratio > 0.55 ? pickTextColor(base) : null) ?? t.titleColor,
                                                fontVariantNumeric: 'tabular-nums',
                                            }}
                                        >
                                            {fmtNumber(v, 0)}
                                        </text>
                                    ) : null}
                                </g>
                            );
                        })}
                    </g>
                ))}
            </svg>
            {hover && m.map.get(cellKey(m.rows[hover.r], m.cols[hover.c])) != null ? (
                <VizTooltip
                    t={t}
                    width={w}
                    height={h}
                    x={labelW + hover.c * cellW + cellW / 2}
                    y={headH + hover.r * cellH}
                    rows={[
                        { label: fields[0] ?? '行', value: m.rows[hover.r] },
                        { label: fields[1] ?? '列', value: m.cols[hover.c] },
                        { label: fields[2] ?? '値', value: fmtNumber(m.map.get(cellKey(m.rows[hover.r], m.cols[hover.c]))) },
                    ]}
                />
            ) : null}
        </div>
    );
}

DpxHeatmap.config = {
    key: 'dpx.heatmap',
    name: 'ヒートマップ（クロス集計）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        color: { type: 'string', default: '' },
        showValues: { type: 'boolean', default: true },
        labelWidth: { type: 'number', default: 70 },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '数値を出す', option: 'showValues', editor: 'editor.checkbox' }],
                [{ label: '行ラベル幅(px)', option: 'labelWidth', editor: 'editor.slider', editorProps: { min: 30, max: 160, step: 2 } }],
                [{ label: '色（空でテーマ）', option: 'color', editor: 'editor.color' }],
            ],
        },
    ],
};
