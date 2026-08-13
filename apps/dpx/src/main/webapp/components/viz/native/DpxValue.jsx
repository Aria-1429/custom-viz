import React from 'react';

import {
    EmptyHint,
    colorForValue,
    fmtNumber,
    resolveColorRules,
    toNum,
    useCountUp,
    useDpxTheme,
    useVizKitStyles,
} from '..';

// ── dpx.value（単一値）──────────────────────────────────────────
//
// データ規約: 最初の数値列を使う（最終値＝現在値、直前値との差分を表示）
// ────────────────────────────────────────────────────────────────

export function DpxValue({ dataSources, options = {}, height, loading }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const numericCol = cols.find((col) => col.some((v) => toNum(v) !== null)) ?? [];
    const values = numericCol.map(toNum).filter((v) => v !== null);
    const current = values.length > 0 ? values[values.length - 1] : null;
    // ⚠ フックは early return より前に呼ぶ（データ有無でフック数が変わると
    //    React が "Rendered more hooks than during the previous render" で落ちる。
    //    データ到着で「なし→あり」に変わる viz では必ず踏む）
    const animatedValue = useCountUp(current, { enabled: options.animate !== false && current !== null });
    if (values.length === 0) {
        return <EmptyHint loading={loading} message="数値列がありません" />;
    }

    const h = typeof height === 'number' ? height : 160;
    const prev = values.length > 1 ? values[values.length - 2] : null;
    const delta = prev !== null && prev !== 0 ? ((current - prev) / Math.abs(prev)) * 100 : null;
    const size = Number(options.size) || 44;
    // 値→色（範囲モードのしきい値）。当たらなければ options.color → アクセント
    const colorCfg = resolveColorRules(options.colors ?? options.thresholds, null);
    const color = (colorCfg ? colorForValue(colorCfg, current) : null) || options.color || t.accent;
    const showSpark = options.showSpark !== false && values.length > 1;
    const decimals = Number.isFinite(Number(options.decimals)) ? Number(options.decimals) : 1;
    const deltaUp = delta !== null && delta >= 0;
    // ⚠ 良化／悪化の色を**決め打ちにしない**。テーマが持つ色を使う。
    //   固定色（緑・ピンク）だと、無彩色前提のプリセット（E Ink）で
    //   そこだけ色が浮く（実機で発生）。テーマ側で定義されていなければ従来色に落とす
    const deltaColor =
        delta === null
            ? t.subColor
            : deltaUp === (options.upIsBad === true)
              ? t.badColor ?? t.errorColor ?? '#ff5c8a'
              : t.goodColor ?? '#3cdcb4';

    const sparkW = 120;
    const sparkH = 30;
    const minV = Math.min(...values);
    const span = Math.max(...values) - minV || 1;
    const sparkPts = values
        .map((v, i) => `${((i / (values.length - 1)) * sparkW).toFixed(1)},${(sparkH - ((v - minV) / span) * sparkH).toFixed(1)}`)
        .join(' ');

    return (
        <div style={{ height: h, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            {options.caption ? (
                <span style={{ fontSize: 12, color: t.subColor, letterSpacing: '0.1em' }}>{options.caption}</span>
            ) : null}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span
                    style={{
                        fontSize: size,
                        fontWeight: 700,
                        color,
                        fontVariantNumeric: 'tabular-nums',
                        textShadow: options.glow ? `0 0 16px ${color}` : 'none',
                        lineHeight: 1,
                    }}
                >
                    {fmtNumber(animatedValue, decimals)}
                </span>
                {options.unit ? <span style={{ fontSize: size * 0.4, color: t.subColor }}>{options.unit}</span> : null}
            </div>
            {delta !== null ? (
                <span style={{ fontSize: 12, color: deltaColor }}>
                    {deltaUp ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
                </span>
            ) : null}
            {showSpark ? (
                <svg width={sparkW} height={sparkH} style={{ overflow: 'visible', marginTop: 2 }}>
                    <polygon
                        points={`0,${sparkH} ${sparkPts} ${sparkW},${sparkH}`}
                        fill={color}
                        fillOpacity={0.15}
                    />
                    <polyline
                        points={sparkPts}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.6}
                        strokeOpacity={0.85}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                    {/* 末端のパルス（transform/opacity のみ＝コンポジタ処理） */}
                    <circle
                        cx={sparkW}
                        cy={sparkH - ((values[values.length - 1] - minV) / span) * sparkH}
                        r={4}
                        fill={color}
                        style={{ transformOrigin: `${sparkW}px ${sparkH - ((values[values.length - 1] - minV) / span) * sparkH}px`, animation: 'dpxPulse 2s ease-in-out infinite' }}
                    />
                    <circle
                        cx={sparkW}
                        cy={sparkH - ((values[values.length - 1] - minV) / span) * sparkH}
                        r={2}
                        fill={color}
                    />
                </svg>
            ) : null}
        </div>
    );
}

DpxValue.config = {
    key: 'dpx.value',
    name: '単一値',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        caption: { type: 'string', default: '' },
        unit: { type: 'string', default: '' },
        size: { type: 'number', default: 44 },
        decimals: { type: 'number', default: 1 },
        color: { type: 'string', default: '' },
        colors: { type: 'object', default: {} },
        glow: { type: 'boolean', default: false },
        showSpark: { type: 'boolean', default: true },
        animate: { type: 'boolean', default: true },
        upIsBad: { type: 'boolean', default: false },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: 'キャプション', option: 'caption', editor: 'editor.text' }],
                [{ label: '単位', option: 'unit', editor: 'editor.text' }],
                [{ label: 'サイズ(px)', option: 'size', editor: 'editor.number' }],
                [{ label: '小数桁', option: 'decimals', editor: 'editor.number' }],
                [{ label: '色', option: 'color', editor: 'editor.color' }],
                [{ label: 'グロー', option: 'glow', editor: 'editor.checkbox' }],
                [{ label: 'スパークライン', option: 'showSpark', editor: 'editor.checkbox' }],
                [{ label: 'カウントアップ', option: 'animate', editor: 'editor.checkbox' }],
                [{ label: '増加を悪化として扱う', option: 'upIsBad', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '値→色',
            layout: [[{ label: 'しきい値の色', option: 'colors', editor: 'editor.colorRules' }]],
        },
    ],
};

// ── dpx.status ───────────────────────────────────────────────────

// ステータスの既定色（一致モードの初期値として使う）
