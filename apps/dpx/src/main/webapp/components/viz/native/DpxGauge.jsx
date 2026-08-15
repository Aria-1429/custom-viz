import React from 'react';

import {
    BrushStrokes,
    EmptyHint,
    colorForValue,
    fmtNumber,
    resolveColorRules,
    seedFor,
    useBrush,
    useCountUp,
    useDpxTheme,
    useVizData,
} from '..';

// ── dpx.gauge（ゲージ／達成率）──────────────────────────────────
//
// データ規約: **1 行目の 1 列目 = 現在値**（2 列目があれば目標値）。
// 目標はオプションでも指定でき、**データの 2 列目が優先**（SPL で動かせるように）。
//
// ## 単一値（dpx.value）と何が違うか
//
// 単一値は「数字そのもの」を見せる。ゲージは**「上限に対してどこまで来たか」**を
// 見せる。SLO 達成率・ディスク使用率・進捗のように**満タンが意味を持つ**指標向け。
//
// ⚠ **円弧は `stroke` で描く**（`fill` ではない）。太い線を引くのが定石で、
//   塗りつぶしの扇形を作る必要はない。`strokeDasharray` で伸縮させる。
// ────────────────────────────────────────────────────────────────

/** 極座標 → デカルト座標（12 時方向を 0 度とし、時計回り）。 */
function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/**
 * 円弧の `d`。
 *
 * ⚠ **360 度ちょうどの弧は描けない**（始点と終点が同じ座標になり、
 *   ブラウザは「長さ 0 の弧」と解釈して**何も描かない**）。
 *   リング（全周）が要る場合は `<circle>` を使う。ここは 360 未満前提。
 */
function arcPath(cx, cy, r, startDeg, endDeg) {
    const s = polar(cx, cy, r, startDeg);
    const e = polar(cx, cy, r, endDeg);
    const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

export function DpxGauge({ dataSources, options = {}, height, loading, id }) {
    // ⚠ フックは early return より前（§8.1 の白紙バグ対策）
    const paint = useBrush();
    const t = useDpxTheme();
    const d = useVizData(dataSources);
    const colorCfg = React.useMemo(() => resolveColorRules(options.colors, null), [options.colors]);

    const raw = d.isEmpty ? null : Number(d.column(0)[0]);
    const value = Number.isFinite(raw) ? raw : null;
    // ⚠ カウントアップも early return の前で呼ぶ（フック数を変えない）
    const shown = useCountUp(options.animate === false ? null : value);

    if (d.isEmpty || value == null) {
        return <EmptyHint loading={loading} message="データがありません（1列目=値）" />;
    }

    // 目標は「データの 2 列目 > オプション」の順。SPL で動かせるほうを優先する。
    const fromData = d.columns.length > 1 ? Number(d.column(1)[0]) : NaN;
    const max = Number.isFinite(fromData) && fromData > 0 ? fromData : Number(options.max) || 100;
    const min = Number(options.min) || 0;
    const span = max - min || 1;
    const ratio = Math.max(0, Math.min(1, (value - min) / span));

    const h = typeof height === 'number' ? height : 220;
    const size = Math.max(80, Math.min(h - 8, 260));
    const cx = size / 2;
    const cy = size / 2;
    const stroke = Math.max(8, Math.round(size * (Number(options.thickness) || 12) / 100));
    const r = (size - stroke) / 2 - 2;

    // 半円（180度）か 3/4 円（270度）か。壁面では半円のほうが読み取りやすい
    const sweep = options.shape === 'half' ? 180 : 270;
    const startDeg = options.shape === 'half' ? -90 : -135;
    const endDeg = startDeg + sweep;
    const valueDeg = startDeg + sweep * ratio;

    const ruled = colorCfg ? colorForValue(colorCfg, value) : null;
    const color = ruled || t.accent;
    const label = options.label || d.fieldNames[0] || '';
    const unit = options.unit || '';
    const pct = Math.round(ratio * 100);

    return (
        <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width={size} height={size} style={{ overflow: 'visible' }}>
                {/* 溝（残りぶん）。薄い一定色で「満タンまでの距離」を示す */}
                <path
                    d={arcPath(cx, cy, r, startDeg, endDeg)}
                    fill="none"
                    stroke="rgba(128,160,220,0.16)"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                />
                {/* 実測ぶん。⚠ ratio=0 のとき長さ 0 の弧になるので描かない */}
                {ratio > 0.001 ? (
                    paint ? (
                        // ⭐ 画材で塗る。⚠ **弧は「線」ではなく「面」として渡す**
                        //   （`brushArc` は外半径・内半径のリング）。線幅の帯を
                        //   r±stroke/2 の面に置き換える。
                        //   ⚠ 角度は **12時起点・時計回りのラジアン**（`brushArc` の規約）。
                        //     ここの deg は同じ起点なので変換は度→ラジアンだけでよい。
                        <BrushStrokes
                            paths={paint.arc(
                                cx,
                                cy,
                                r + stroke / 2,
                                Math.max(0, r - stroke / 2),
                                (startDeg * Math.PI) / 180,
                                (valueDeg * Math.PI) / 180,
                                // ⚠ seed に「値」を入れない（再サーチのたびに形が変わる）
                                seedFor(id, label || 'gauge', 0),
                                color
                            )}
                            color={color}
                        />
                    ) : (
                        <path
                            d={arcPath(cx, cy, r, startDeg, valueDeg)}
                            fill="none"
                            stroke={color}
                            strokeWidth={stroke}
                            strokeLinecap="round"
                            style={{ transition: options.animate === false ? 'none' : 'stroke 0.3s ease' }}
                        />
                    )
                ) : null}
                <text
                    x={cx}
                    y={cy + (options.shape === 'half' ? 0 : 6)}
                    textAnchor="middle"
                    style={{ fontSize: Math.round(size * 0.2), fontWeight: 700, fill: t.titleColor, fontVariantNumeric: 'tabular-nums' }}
                >
                    {options.showPercent ? `${pct}%` : fmtNumber(shown ?? value)}
                </text>
                {unit && !options.showPercent ? (
                    <text x={cx} y={cy + Math.round(size * 0.15)} textAnchor="middle" style={{ fontSize: 11, fill: t.subColor }}>
                        {unit}
                    </text>
                ) : null}
                {label ? (
                    <text
                        x={cx}
                        y={cy + Math.round(size * (options.shape === 'half' ? 0.3 : 0.34))}
                        textAnchor="middle"
                        style={{ fontSize: 11, fill: t.subColor, letterSpacing: '0.06em' }}
                    >
                        {label}
                    </text>
                ) : null}
            </svg>
        </div>
    );
}

DpxGauge.config = {
    key: 'dpx.gauge',
    name: 'ゲージ（達成率）',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        shape: { type: 'string', default: 'arc' },
        min: { type: 'number', default: 0 },
        max: { type: 'number', default: 100 },
        thickness: { type: 'number', default: 12 },
        label: { type: 'string', default: '' },
        unit: { type: 'string', default: '' },
        showPercent: { type: 'boolean', default: false },
        animate: { type: 'boolean', default: true },
        colors: { type: 'object', default: null },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [
                    {
                        label: '形',
                        option: 'shape',
                        editor: 'editor.radioBar',
                        editorProps: {
                            values: [
                                { value: 'arc', label: '3/4円' },
                                { value: 'half', label: '半円' },
                            ],
                        },
                    },
                ],
                [{ label: '太さ（%）', option: 'thickness', editor: 'editor.slider', editorProps: { min: 4, max: 30, step: 1 } }],
                [{ label: '％で表示', option: 'showPercent', editor: 'editor.checkbox' }],
                [{ label: '数字を動かす', option: 'animate', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '範囲',
            layout: [
                [{ label: '最小値', option: 'min', editor: 'editor.number' }],
                [{ label: '最大値（2列目があればそちら優先）', option: 'max', editor: 'editor.number' }],
            ],
        },
        {
            label: 'ラベル',
            layout: [
                [{ label: '見出し（空で列名）', option: 'label', editor: 'editor.text' }],
                [{ label: '単位', option: 'unit', editor: 'editor.text' }],
            ],
        },
        { label: '色', layout: [[{ label: '色のルール', option: 'colors', editor: 'editor.colorRules' }]] },
    ],
};
