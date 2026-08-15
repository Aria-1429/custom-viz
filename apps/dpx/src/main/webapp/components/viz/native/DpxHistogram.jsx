import React from 'react';

import {
    BrushStrokes,
    EmptyHint,
    VizTooltip,
    buildBins,
    fmtNumber,
    niceScale,
    seedFor,
    sturgesBins,
    useBrush,
    useContainerSize,
    useDpxTheme,
    useVizData,
} from '..';

// ── dpx.histogram（分布）────────────────────────────────────────
//
// データ規約: **1 列目 = 数値の並び**（1 行 1 観測値）。集計は viz 側で行う。
//
// ## 棒グラフと何が違うか
//
// 棒グラフは「カテゴリごとの値」を出す（ラベルが要る）。
// ヒストグラムは**値そのものを階級に分けて個数を数える**ので、
// **ラベル列が要らない**。応答時間・スコア・サイズの**ばらつき**を見る用途。
//
// SPL 側で `| stats count by range` を書かなくてよいのが利点
// （階級の切り方を画面で変えられる）。
//
// ⚠ **階級数の既定を大きくしない**。データが少ないと空の階級が並んで
//   「櫛」のように見える。スタージェスの公式で件数から決める。
// ────────────────────────────────────────────────────────────────

export function DpxHistogram({ dataSources, options = {}, height, loading, id }) {
    // ⭐ 画材（Brush Engine）。⚠ フックは early return より前（§8.1）
    const paint = useBrush();
    const t = useDpxTheme();
    const d = useVizData(dataSources);
    const [hover, setHover] = React.useState(null);
    // ⚠ callback ref 版を使う（データ未着で early return する viz では
    //   mount 時 effect の ref が null のままになり観測が始まらない。§8.1）
    const [ref, w] = useContainerSize(600);

    const values = React.useMemo(
        () => d.column(0).map((v) => Number(v)).filter((v) => Number.isFinite(v)),
        [d]
    );
    const binCount = Number(options.bins) > 0 ? Number(options.bins) : sturgesBins(values.length);
    const bins = React.useMemo(() => buildBins(values, binCount), [values, binCount]);

    if (d.isEmpty || bins.length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=数値）" />;
    }

    const h = typeof height === 'number' ? height : 240;
    const padL = 34;
    const padB = 22;
    const padT = 8;
    const plotW = Math.max(10, w - padL - 8);
    const plotH = Math.max(10, h - padB - padT);

    const maxCount = Math.max(...bins.map((b) => b.count), 1);
    const scale = niceScale(0, maxCount, 4);
    const barW = plotW / bins.length;
    const color = options.color || t.accent;

    return (
        <div ref={ref} style={{ height: h, position: 'relative' }}>
            <svg width="100%" height={h}>
                {/* 目盛り線。⚠ 文字は歪ませない層に置く（Ink Layer の既定で除外される） */}
                {scale.ticks.map((tk) => {
                    const y = padT + plotH - (tk / scale.max) * plotH;
                    return (
                        <g key={tk}>
                            <line x1={padL} y1={y} x2={w - 8} y2={y} stroke="rgba(128,160,220,0.14)" strokeWidth={1} />
                            <text x={padL - 6} y={y + 3} textAnchor="end" style={{ fontSize: 10, fill: t.subColor }}>
                                {fmtNumber(tk, 0)}
                            </text>
                        </g>
                    );
                })}
                {bins.map((b, i) => {
                    const bh = (b.count / scale.max) * plotH;
                    const x = padL + i * barW;
                    const y = padT + plotH - bh;
                    return (
                        <g key={i}>
                            {/* ⭐ 画材で塗る（見た目だけ）。⚠ 当たり判定は下の透明な
                                <rect> が持つ（原則 3：Visual と Interaction を分ける） */}
                            {paint && bh > 0.5 ? (
                                <BrushStrokes
                                    paths={paint.rect(
                                        x + 0.5,
                                        y,
                                        Math.max(1, barW - 1),
                                        Math.max(0, bh),
                                        // ⚠ seed に度数を入れない（再サーチで形が変わる）
                                        seedFor(id, `bin${i}`, i),
                                        color
                                    )}
                                    color={color}
                                    opacity={hover == null || hover === i ? 0.95 : 0.45}
                                />
                            ) : null}
                            <rect
                                x={x + 0.5}
                                y={y}
                                width={Math.max(1, barW - 1)}
                                height={Math.max(0, bh)}
                                fill={paint ? 'transparent' : color}
                                opacity={paint ? 1 : hover == null || hover === i ? 0.9 : 0.45}
                                onMouseEnter={() => setHover(i)}
                                onMouseLeave={() => setHover(null)}
                                style={{ transition: 'opacity 0.15s ease' }}
                            />
                        </g>
                    );
                })}
                {/* 両端の値だけ出す。全階級に数字を出すと重なって読めない */}
                <text x={padL} y={h - 6} style={{ fontSize: 10, fill: t.subColor }}>
                    {fmtNumber(bins[0].from)}
                </text>
                <text x={w - 8} y={h - 6} textAnchor="end" style={{ fontSize: 10, fill: t.subColor }}>
                    {fmtNumber(bins[bins.length - 1].to)}
                </text>
            </svg>
            {hover != null && bins[hover] ? (
                <VizTooltip
                    t={t}
                    width={w}
                    height={h}
                    x={padL + hover * barW + barW / 2}
                    y={padT + plotH - (bins[hover].count / scale.max) * plotH}
                    rows={[
                        { label: '範囲', value: `${fmtNumber(bins[hover].from)} 〜 ${fmtNumber(bins[hover].to)}` },
                        { label: '件数', value: fmtNumber(bins[hover].count, 0) },
                    ]}
                />
            ) : null}
        </div>
    );
}

DpxHistogram.config = {
    key: 'dpx.histogram',
    name: 'ヒストグラム（分布）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        bins: { type: 'number', default: 0 },
        color: { type: 'string', default: '' },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '階級数（0で自動）', option: 'bins', editor: 'editor.number', editorProps: { min: 0, max: 50 } }],
                [{ label: '色（空でテーマ）', option: 'color', editor: 'editor.color' }],
            ],
        },
    ],
};
