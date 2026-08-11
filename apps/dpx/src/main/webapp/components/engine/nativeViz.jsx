import React from 'react';

import { colorForValue, defaultColorRules, labelForValue, resolveColorRules } from './colorRules';
import { useDpxTheme } from './themes';
import { VizTooltip, useCountUp, usePointer, useVizKitStyles } from './vizKit';
import { useVizHover } from '../vizBus';

// ── DPX ネイティブ viz スイート ──────────────────────────────────
// プラットフォーム標準のチャート群。外部チャートライブラリに依存せず
// SVG/DOM で描く。全て解決済みテーマ（useDpxTheme）に連動し、
// editorConfig（日本語ラベル）でインスペクタのフォームが自動生成される。
//
// データ規約（dataSources.primary.data = {fields, columns}）:
//   dpx.line   … 1列目 = X（ラベル/時刻）、2列目以降 = 数値系列
//   dpx.bar    … 1列目 = ラベル、2列目 = 値
//   dpx.value  … 最初の数値列を使う（最終値＝現在値、直前値との差分を表示）
//   dpx.status … 1列目 = 名前、2列目 = 状態、3列目 = 補足（任意）
//   dpx.table  … 全列をそのまま表
// ────────────────────────────────────────────────────────────────

const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const fmt = (v, decimals = 1) => {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(decimals)}G`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(decimals)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(decimals)}k`;
    return Number.isInteger(v) ? String(v) : v.toFixed(decimals);
};

function useContainerSize(defaultW = 600) {
    // ⚠ callback ref を使う。データ到着前に「データがありません」ブランチを
    // 返すコンポーネントでは、mount 時の effect では ref がまだ null で、
    // 観測が永久に始まらない（実機で発生：チャートが既定幅 600px のまま）。
    const [w, setW] = React.useState(defaultW);
    const roRef = React.useRef(null);
    const ref = React.useCallback((el) => {
        if (roRef.current) {
            roRef.current.disconnect();
            roRef.current = null;
        }
        if (!el) return;
        if (el.offsetWidth) setW(el.offsetWidth);
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                const width = entries[0]?.contentRect?.width;
                if (width) setW(width);
            });
            ro.observe(el);
            roRef.current = ro;
        }
    }, []);
    return [ref, w];
}

/** 系列（またはラベル）の色を決める。
 *  cfg は colorRules の設定（一致モードなら名前で、範囲モードなら値で判定）。
 *  当たらなければテーマのパレットを順に使う。 */
function seriesColor(cfg, t, index, name) {
    const hit = cfg ? colorForValue(cfg, name) : null;
    return hit || t.palette[index % t.palette.length];
}

function EmptyHint({ loading, message }) {
    return (
        <div style={{ padding: 14, fontSize: 12, opacity: 0.55 }}>
            {loading ? '読み込み中…' : message}
        </div>
    );
}

// ── dpx.line ─────────────────────────────────────────────────────
// インタラクション:
//   - マウス追従のクロスヘア＋最近傍点のマーカー、値ツールチップ
//   - 凡例または線のホバーで **その系列にフォーカス**（他系列を減光・細く）
//   - 系列クリックで固定（ピン）。もう一度で解除
//   - 初回描画は stroke-dashoffset で「引かれていく」アニメ（ジオメトリを動かさない）

export function DpxLine({ dataSources, options = {}, height, loading }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const [ref, width] = useContainerSize();
    const [pt, pointerHandlers] = usePointer();
    const [hoverSeries, setHoverSeries] = React.useState(null);
    const [pinned, setPinned] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length < 2 || (cols[1] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=X、2列目以降=数値系列）" />;
    }

    const h = Math.max(typeof height === 'number' ? height : 240, 80);
    const xLabels = cols[0].map((v) => String(v));
    const series = cols
        .slice(1)
        .map((col, i) => ({ name: fields[i + 1] ?? `series${i + 1}`, values: col.map(toNum) }))
        .filter((s) => s.values.some((v) => v !== null));

    const lineColorCfg = resolveColorRules(options.colors ?? options.seriesColors, null);
    const showArea = options.showArea !== false;
    const showDots = Boolean(options.showDots);
    const showGrid = options.showGrid !== false;
    const showLegend = options.showLegend !== false && series.length > 1;
    const lineWidth = Number(options.lineWidth) || 2;
    const smooth = options.smooth !== false;
    const animate = options.animate !== false;
    const focused = pinned ?? hoverSeries;

    const all = series.flatMap((s) => s.values).filter((v) => v !== null);
    const maxV = Math.max(...all, 0);
    const minV = Math.min(...all, 0);
    const span = maxV - minV || 1;

    const padL = 46;
    const padR = 14;
    const padT = 12;
    const legendH = showLegend ? 24 : 0;
    const padB = 24;
    const plotW = Math.max(width - padL - padR, 10);
    const plotH = Math.max(h - padT - padB - legendH, 10);
    const px = (i) => padL + (xLabels.length <= 1 ? plotW / 2 : (i / (xLabels.length - 1)) * plotW);
    const py = (v) => padT + plotH - ((v - minV) / span) * plotH;

    // なめらかな線（Catmull-Rom 由来の三次ベジェ）。点を動かさないので追加コストは軽い
    const pathFor = (vals) => {
        const pts = [];
        vals.forEach((v, i) => {
            if (v !== null) pts.push([px(i), py(v)]);
        });
        if (pts.length === 0) return '';
        if (!smooth || pts.length < 3) {
            return pts.map((q, i) => `${i === 0 ? 'M' : 'L'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('');
        }
        let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] ?? pts[i];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = pts[i + 2] ?? p2;
            const c1x = p1[0] + (p2[0] - p0[0]) / 6;
            const c1y = p1[1] + (p2[1] - p0[1]) / 6;
            const c2x = p2[0] - (p3[0] - p1[0]) / 6;
            const c2y = p2[1] - (p3[1] - p1[1]) / 6;
            d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
        }
        return d;
    };

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => minV + span * r);
    const xTickEvery = Math.max(1, Math.ceil(xLabels.length / Math.max(2, Math.floor(plotW / 90))));

    // カーソルに最も近い X インデックス
    const hoverIdx =
        pt.x != null && xLabels.length > 0
            ? Math.max(
                  0,
                  Math.min(
                      xLabels.length - 1,
                      Math.round(((pt.x - padL) / Math.max(plotW, 1)) * (xLabels.length - 1))
                  )
              )
            : null;
    const showCrosshair = hoverIdx != null && pt.x >= padL - 8 && pt.x <= padL + plotW + 8;

    return (
        <div ref={ref} style={{ height: h, position: 'relative' }} {...pointerHandlers}>
            <svg width="100%" height={h - legendH} style={{ display: 'block' }} className="dpx-hit">
                {showGrid
                    ? ticks.map((v) => (
                          <g key={v}>
                              <line
                                  x1={padL}
                                  x2={padL + plotW}
                                  y1={py(v)}
                                  y2={py(v)}
                                  stroke={t.subColor}
                                  strokeOpacity={0.16}
                              />
                              <text x={padL - 7} y={py(v) + 3} textAnchor="end" fontSize={10} fill={t.subColor}>
                                  {fmt(v)}
                              </text>
                          </g>
                      ))
                    : null}
                {xLabels.map((label, i) =>
                    i % xTickEvery === 0 ? (
                        <text
                            key={i}
                            x={px(i)}
                            y={padT + plotH + 15}
                            textAnchor="middle"
                            fontSize={10}
                            fill={t.subColor}
                        >
                            {label.length > 10 ? `${label.slice(0, 9)}…` : label}
                        </text>
                    ) : null
                )}

                {/* クロスヘア（縦線）。ジオメトリの再ラスタライズを避けるため線1本のみ */}
                {showCrosshair ? (
                    <line
                        x1={px(hoverIdx)}
                        x2={px(hoverIdx)}
                        y1={padT}
                        y2={padT + plotH}
                        stroke={t.accent}
                        strokeOpacity={0.5}
                        strokeDasharray="3 3"
                    />
                ) : null}

                {series.map((s, si) => {
                    const color = seriesColor(lineColorCfg, t, si, s.name);
                    const line = pathFor(s.values);
                    const isFocused = focused === s.name;
                    const dim = focused != null && !isFocused;
                    const firstIdx = s.values.findIndex((v) => v !== null);
                    const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
                    const w = isFocused ? lineWidth + 1.2 : lineWidth;
                    return (
                        <g
                            key={s.name}
                            style={{ opacity: dim ? 0.18 : 1, transition: 'opacity 0.18s ease' }}
                            onMouseEnter={() => setHoverSeries(s.name)}
                            onMouseLeave={() => setHoverSeries(null)}
                            onClick={() => setPinned((prev) => (prev === s.name ? null : s.name))}
                        >
                            {showArea && firstIdx >= 0 ? (
                                <path
                                    d={`${line}L${px(lastIdx).toFixed(1)},${py(minV)}L${px(firstIdx).toFixed(1)},${py(minV)}Z`}
                                    fill={color}
                                    fillOpacity={isFocused ? 0.2 : dim ? 0.05 : 0.12}
                                    style={{ transition: 'fill-opacity 0.18s ease' }}
                                />
                            ) : null}
                            {/* フォーカス時のグローは「太い半透明の実線」で代替（SVG フィルタは使わない） */}
                            {isFocused ? (
                                <path d={line} fill="none" stroke={color} strokeWidth={w + 5} strokeOpacity={0.18} />
                            ) : null}
                            <path
                                d={line}
                                fill="none"
                                stroke={color}
                                strokeWidth={w}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                ref={(el) => {
                                    if (!el || !animate || el.dataset.drawn) return;
                                    const len = el.getTotalLength?.() ?? 0;
                                    if (!len) return;
                                    el.dataset.drawn = '1';
                                    el.style.setProperty('--dpx-len', len);
                                    el.style.strokeDasharray = len;
                                    el.style.animation = `dpxDraw 0.9s ease-out ${si * 0.08}s both`;
                                    // ⚠ 描き込みが終わったら dasharray を必ず捨てる。
                                    //   残したままだとパネル幅が変わった（ResizeObserver で
                                    //   後から広がる）ときに「古い長さの破線」が線を途中で
                                    //   切ってしまう。塗り(area)は dasharray の影響を受けない
                                    //   ため、線だけが途中で消えて見える（実機で再現・確認）。
                                    const clear = () => {
                                        el.style.animation = '';
                                        el.style.strokeDasharray = '';
                                        el.style.strokeDashoffset = '';
                                    };
                                    el.addEventListener('animationend', clear, { once: true });
                                    // アニメが走らなかった場合の保険（タブ非表示など）
                                    setTimeout(clear, 1200 + si * 80);
                                }}
                                style={{ transition: 'stroke-width 0.18s ease' }}
                            />
                            {showDots
                                ? s.values.map((v, i) =>
                                      v === null ? null : <circle key={i} cx={px(i)} cy={py(v)} r={2.5} fill={color} />
                                  )
                                : null}
                            {/* クロスヘア位置のマーカー */}
                            {showCrosshair && s.values[hoverIdx] !== null && !dim ? (
                                <g>
                                    <circle cx={px(hoverIdx)} cy={py(s.values[hoverIdx])} r={7} fill={color} fillOpacity={0.22} />
                                    <circle
                                        cx={px(hoverIdx)}
                                        cy={py(s.values[hoverIdx])}
                                        r={3.5}
                                        fill={color}
                                        stroke={t.colorScheme === 'light' ? '#fff' : '#0b1220'}
                                        strokeWidth={1.5}
                                    />
                                </g>
                            ) : null}
                        </g>
                    );
                })}
            </svg>

            {showCrosshair ? (
                <VizTooltip
                    t={t}
                    x={pt.x}
                    y={pt.y}
                    width={width}
                    height={h}
                    title={xLabels[hoverIdx]}
                    accent={t.accent}
                    rows={series.map((s, si) => ({
                        label: s.name,
                        value: fmt(s.values[hoverIdx]),
                        color: seriesColor(lineColorCfg, t, si, s.name),
                        dim: focused != null && focused !== s.name,
                    }))}
                />
            ) : null}

            {showLegend ? (
                <div style={{ display: 'flex', gap: 12, padding: '2px 12px', fontSize: 11, flexWrap: 'wrap' }}>
                    {series.map((s, si) => {
                        const color = seriesColor(lineColorCfg, t, si, s.name);
                        const isFocused = focused === s.name;
                        const dim = focused != null && !isFocused;
                        return (
                            <button
                                key={s.name}
                                type="button"
                                onMouseEnter={() => setHoverSeries(s.name)}
                                onMouseLeave={() => setHoverSeries(null)}
                                onClick={() => setPinned((prev) => (prev === s.name ? null : s.name))}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 5,
                                    background: 'transparent',
                                    border: 'none',
                                    padding: '2px 4px',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    color: dim ? t.subColor : t.titleColor,
                                    opacity: dim ? 0.5 : 1,
                                    fontFamily: 'inherit',
                                    fontSize: 11,
                                    transition: 'opacity 0.15s ease',
                                }}
                                title={pinned === s.name ? 'クリックで固定を解除' : 'クリックでこの系列に固定'}
                            >
                                <span
                                    style={{
                                        width: isFocused ? 14 : 10,
                                        height: 3,
                                        borderRadius: 2,
                                        background: color,
                                        transition: 'width 0.15s ease',
                                    }}
                                />
                                {s.name}
                                {pinned === s.name ? <span style={{ color: t.accent, fontSize: 9 }}>●</span> : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}

DpxLine.config = {
    key: 'dpx.line',
    name: '折れ線・エリア',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        colors: { type: 'object', default: {} },
        showArea: { type: 'boolean', default: true },
        showDots: { type: 'boolean', default: false },
        showGrid: { type: 'boolean', default: true },
        showLegend: { type: 'boolean', default: true },
        smooth: { type: 'boolean', default: true },
        animate: { type: 'boolean', default: true },
        lineWidth: { type: 'number', default: 2 },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '塗りつぶし', option: 'showArea', editor: 'editor.checkbox' }],
                [{ label: 'なめらかな線', option: 'smooth', editor: 'editor.checkbox' }],
                [{ label: 'ポイント表示', option: 'showDots', editor: 'editor.checkbox' }],
                [{ label: 'グリッド線', option: 'showGrid', editor: 'editor.checkbox' }],
                [{ label: '凡例を表示', option: 'showLegend', editor: 'editor.checkbox' }],
                [{ label: '描画アニメ', option: 'animate', editor: 'editor.checkbox' }],
                [{ label: '線の太さ(px)', option: 'lineWidth', editor: 'editor.slider', editorProps: { min: 1, max: 6, step: 0.5 } }],
            ],
        },
        {
            label: '値→色',
            layout: [
                [
                    {
                        label: '系列の色（未設定ならテーマ配色）',
                        option: 'colors',
                        editor: 'editor.colorRules',
                        editorProps: { valueHint: '系列名（例: web）' },
                    },
                ],
            ],
        },
    ],
};

// ── dpx.bar ──────────────────────────────────────────────────────
// インタラクション: ホバーで対象を強調＋他を減光、値ツールチップ、
// クリックでトークン発火。初回は下から伸びるアニメ（transform のみ）。

export function DpxBar({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const { hoverKey, setHoverKey } = useVizHover();
    const [ref, width] = useContainerSize();
    const [pt, pointerHandlers] = usePointer();
    const [hoverIdx, setHoverIdx] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=ラベル、2列目=値）" />;
    }

    const h = Math.max(typeof height === 'number' ? height : 240, 60);
    const labels = cols[0].map((v) => String(v));
    const values = cols[1].map(toNum);
    const maxV = Math.max(...values.filter((v) => v !== null), 1);
    const showValues = options.showValues !== false;
    const singleColor = options.monochrome !== false;
    const animate = options.animate !== false;
    const barColorCfg = resolveColorRules(options.colors ?? options.barColors, null);

    return (
        <div
            ref={ref}
            style={{
                height: h,
                display: 'flex',
                alignItems: 'flex-end',
                gap: 8,
                padding: '10px 14px 24px',
                boxSizing: 'border-box',
                position: 'relative',
            }}
            {...pointerHandlers}
        >
            {labels.map((label, i) => {
                const v = values[i];
                const ratio = v === null ? 0 : v / maxV;
                const ruled = barColorCfg ? colorForValue(barColorCfg, label) ?? colorForValue(barColorCfg, v) : null;
                const baseColor = typeof options.color === 'string' && options.color ? options.color : t.accent;
                const color = ruled || (singleColor ? baseColor : t.palette[i % t.palette.length]);
                const key = `bar:${label}`;
                const hovered = hoverIdx === i || hoverKey === key;
                const dimmed = (hoverIdx !== null && hoverIdx !== i) || (hoverKey?.startsWith('bar:') && hoverKey !== key);
                return (
                    <div
                        key={label + i}
                        onMouseEnter={() => {
                            setHoverIdx(i);
                            setHoverKey(key);
                        }}
                        onMouseLeave={() => {
                            setHoverIdx(null);
                            setHoverKey(null);
                        }}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'bar.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'label',
                                    value: label,
                                    [`row.${fields[0] ?? 'label'}.value`]: label,
                                    [`row.${fields[1] ?? 'value'}.value`]: v,
                                },
                            })
                        }
                        style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            height: '100%',
                            cursor: onEventTrigger ? 'pointer' : 'default',
                            opacity: dimmed ? 0.32 : 1,
                            transition: 'opacity 0.15s ease',
                            position: 'relative',
                        }}
                    >
                        {showValues ? (
                            <span
                                style={{
                                    fontSize: 11,
                                    color: hovered ? t.titleColor : t.subColor,
                                    marginBottom: 3,
                                    fontWeight: hovered ? 700 : 400,
                                    transition: 'color 0.15s ease',
                                }}
                            >
                                {fmt(v)}
                            </span>
                        ) : null}
                        <div
                            className="dpx-bar-rect"
                            style={{
                                width: hovered ? '80%' : '70%',
                                height: `${Math.max(ratio * 100, 1.5)}%`,
                                borderRadius: '6px 6px 2px 2px',
                                background: `linear-gradient(180deg, ${color}, ${color}77)`,
                                // グローは影で表現（filter は使わない）
                                boxShadow: hovered ? `0 0 14px ${color}88, 0 0 3px ${color}` : `0 0 8px ${color}33`,
                                transition: 'height 0.4s ease, width 0.15s ease, box-shadow 0.15s ease',
                                animation: animate ? `dpxGrow 0.6s ease-out ${Math.min(i * 0.05, 0.4)}s both` : 'none',
                            }}
                        />
                        <span
                            style={{
                                position: 'absolute',
                                bottom: -19,
                                fontSize: 10,
                                color: hovered ? t.titleColor : t.subColor,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: '100%',
                                transition: 'color 0.15s ease',
                            }}
                        >
                            {label}
                        </span>
                    </div>
                );
            })}
            {hoverIdx !== null ? (
                <VizTooltip
                    t={t}
                    x={pt.x}
                    y={pt.y}
                    width={width}
                    height={h}
                    title={labels[hoverIdx]}
                    rows={[{ label: fields[1] ?? '値', value: fmt(values[hoverIdx]) }]}
                />
            ) : null}
        </div>
    );
}

DpxBar.config = {
    key: 'dpx.bar',
    name: '棒グラフ',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        showValues: { type: 'boolean', default: true },
        monochrome: { type: 'boolean', default: true },
        animate: { type: 'boolean', default: true },
        color: { type: 'string', default: '' },
        colors: { type: 'object', default: {} },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '値を表示', option: 'showValues', editor: 'editor.checkbox' }],
                [{ label: '単色にする', option: 'monochrome', editor: 'editor.checkbox' }],
                [{ label: '描画アニメ', option: 'animate', editor: 'editor.checkbox' }],
                [{ label: 'バーの色（単色時）', option: 'color', editor: 'editor.color' }],
            ],
        },
        {
            label: '値→色',
            layout: [
                [
                    {
                        label: 'ラベル/値の色（設定すると優先）',
                        option: 'colors',
                        editor: 'editor.colorRules',
                        editorProps: { valueHint: 'ラベル（例: app-1）' },
                    },
                ],
            ],
        },
    ],
};

// ── dpx.value ────────────────────────────────────────────────────

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
    const deltaColor = delta === null ? t.subColor : deltaUp === (options.upIsBad === true) ? '#ff5c8a' : '#3cdcb4';

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
                    {fmt(animatedValue, decimals)}
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
const DEFAULT_STATUS_MATCHES = [
    { value: 'ok', color: '#3cdcb4', label: '' },
    { value: 'warn', color: '#ffb020', label: '' },
    { value: 'crit', color: '#ff5c8a', label: '' },
];
const DEFAULT_STATUS_COLORS = {
    ok: '#3cdcb4', up: '#3cdcb4', normal: '#3cdcb4', healthy: '#3cdcb4', success: '#3cdcb4', good: '#3cdcb4', green: '#3cdcb4',
    warn: '#ffb020', warning: '#ffb020', degraded: '#ffb020', slow: '#ffb020', amber: '#ffb020', yellow: '#ffb020',
    crit: '#ff5c8a', critical: '#ff5c8a', down: '#ff5c8a', error: '#ff5c8a', fail: '#ff5c8a', failed: '#ff5c8a', red: '#ff5c8a',
    info: '#4ea1ff', blue: '#4ea1ff',
};

export function DpxStatus({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    useVizKitStyles();
    const { hoverKey, setHoverKey } = useVizHover();
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length < 2 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません（1列目=名前、2列目=状態）" />;
    }

    const h = typeof height === 'number' ? height : 200;
    const names = cols[0].map((v) => String(v));
    const states = cols[1].map((v) => String(v ?? ''));
    const details = cols[2] ?? [];
    const columns = Math.max(1, Number(options.columns) || 3);
    const showDetail = options.showDetail !== false && cols.length > 2;
    // options.colors（新形式）→ 旧 options.rules（配列）→ 未設定 の順で解決する
    const colorCfg = resolveColorRules(options.colors ?? options.rules, null);
    const upperState = options.upperCaseState !== false;

    return (
        <div
            className="dpx-scroll"
            style={{
                height: h,
                overflow: 'auto',
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: 8,
                padding: 10,
                boxSizing: 'border-box',
                alignContent: 'start',
            }}
        >
            {names.map((name, i) => {
                const state = states[i];
                // 設定があればそれに従い、無ければ「よくある表記」の既定色にフォールバック
                const configured = colorCfg ? colorForValue(colorCfg, state) : null;
                const color = configured || DEFAULT_STATUS_COLORS[String(state).toLowerCase()] || t.subColor;
                const stateLabel = (colorCfg ? labelForValue(colorCfg, state) : null) || state;
                const hkey = `status:${name}`;
                const hovered = hoverKey === hkey;
                const dimmed = hoverKey?.startsWith('status:') && !hovered;
                return (
                    <div
                        key={name + i}
                        onMouseEnter={() => setHoverKey(hkey)}
                        onMouseLeave={() => setHoverKey(null)}
                        onClick={(originalEvent) =>
                            onEventTrigger?.({
                                type: 'status.click',
                                originalEvent,
                                payload: {
                                    name: fields[0] ?? 'name',
                                    value: name,
                                    [`row.${fields[0] ?? 'name'}.value`]: name,
                                    [`row.${fields[1] ?? 'status'}.value`]: state,
                                },
                            })
                        }
                        style={{
                            border: `1px solid ${color}${hovered ? '99' : '55'}`,
                            borderLeft: `4px solid ${color}`,
                            borderRadius: 8,
                            padding: '8px 10px',
                            background: hovered ? `${color}1f` : `${color}0d`,
                            cursor: onEventTrigger ? 'pointer' : 'default',
                            minWidth: 0,
                            transform: hovered ? 'translateY(-2px)' : 'none',
                            boxShadow: hovered ? `0 6px 18px rgba(0,0,0,0.35), 0 0 0 1px ${color}44` : 'none',
                            opacity: dimmed ? 0.45 : 1,
                            transition: 'transform 0.15s ease, background 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ position: 'relative', width: 8, height: 8, flex: 'none' }}>
                                {options.pulse !== false ? (
                                    <span
                                        style={{
                                            position: 'absolute',
                                            inset: 0,
                                            borderRadius: 4,
                                            background: color,
                                            animation: 'dpxPulse 1.8s ease-in-out infinite',
                                        }}
                                    />
                                ) : null}
                                <span
                                    style={{
                                        position: 'absolute',
                                        inset: 0,
                                        borderRadius: 4,
                                        background: color,
                                        boxShadow: `0 0 8px ${color}`,
                                    }}
                                />
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {name}
                            </span>
                        </div>
                        <div
                            style={{
                                fontSize: 10,
                                color: t.subColor,
                                marginTop: 3,
                                textTransform: upperState ? 'uppercase' : 'none',
                            }}
                        >
                            {stateLabel}
                            {showDetail && details[i] !== undefined ? ` ・ ${details[i]}` : ''}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

DpxStatus.config = {
    key: 'dpx.status',
    name: 'ステータス一覧',
    category: 'status',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        columns: { type: 'number', default: 3 },
        showDetail: { type: 'boolean', default: true },
        upperCaseState: { type: 'boolean', default: true },
        pulse: { type: 'boolean', default: true },
        colors: { type: 'object', default: { mode: 'match', matches: DEFAULT_STATUS_MATCHES, defaultColor: '' } },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '列数', option: 'columns', editor: 'editor.slider', editorProps: { min: 1, max: 6, step: 1 } }],
                [{ label: '補足列を表示', option: 'showDetail', editor: 'editor.checkbox' }],
                [{ label: '状態を大文字で表示', option: 'upperCaseState', editor: 'editor.checkbox' }],
                [{ label: 'ドットを脈動させる', option: 'pulse', editor: 'editor.checkbox' }],
            ],
        },
        {
            label: '値→色',
            layout: [
                [{ label: '状態の色', option: 'colors', editor: 'editor.colorRules', editorProps: { valueHint: '状態（例: ok）' } }],
            ],
        },
    ],
};

// ── dpx.table ────────────────────────────────────────────────────

export function DpxTable({ dataSources, options = {}, height, loading, onEventTrigger }) {
    const t = useDpxTheme();
    const [hoverRow, setHoverRow] = React.useState(null);
    const data = dataSources?.primary?.data;
    const cols = data?.columns ?? [];
    const fields = (data?.fields ?? []).map((f) => f?.name ?? f);
    if (cols.length === 0 || (cols[0] ?? []).length === 0) {
        return <EmptyHint loading={loading} message="データがありません" />;
    }

    const h = typeof height === 'number' ? height : 240;
    const maxRows = Number(options.maxRows) || 50;
    const rowCount = Math.min(cols[0].length, maxRows);
    const dense = Boolean(options.dense);
    const pad = dense ? '4px 10px' : '7px 10px';
    // 列ごとの数値最大値（値バーのスケール用）
    const numericMax = cols.map((col) => {
        const nums = col.slice(0, rowCount).map(toNum).filter((v) => v !== null);
        return nums.length > 0 ? Math.max(...nums) : 0;
    });

    return (
        <div className="dpx-scroll" style={{ height: h, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: dense ? 11 : 12 }}>
                <thead>
                    <tr>
                        {fields.map((f) => (
                            <th
                                key={f}
                                style={{
                                    position: 'sticky',
                                    top: 0,
                                    textAlign: 'left',
                                    padding: pad,
                                    fontSize: 10,
                                    letterSpacing: '0.08em',
                                    textTransform: 'uppercase',
                                    color: t.subColor,
                                    borderBottom: `1px solid ${t.accent}44`,
                                    background: 'inherit',
                                }}
                            >
                                {f}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {Array.from({ length: rowCount }, (_, r) => (
                        <tr
                            key={r}
                            onMouseEnter={() => setHoverRow(r)}
                            onMouseLeave={() => setHoverRow(null)}
                            onClick={(originalEvent) =>
                                onEventTrigger?.({
                                    type: 'row.click',
                                    originalEvent,
                                    payload: Object.fromEntries([
                                        ['name', fields[0] ?? 'col0'],
                                        ['value', cols[0][r]],
                                        ...fields.map((f, c) => [`row.${f}.value`, cols[c][r]]),
                                    ]),
                                })
                            }
                            style={{
                                background:
                                    hoverRow === r
                                        ? `${t.accent}1f`
                                        : options.striped !== false && r % 2 === 1
                                        ? 'rgba(128,160,220,0.06)'
                                        : 'transparent',
                                cursor: onEventTrigger ? 'pointer' : 'default',
                                boxShadow: hoverRow === r ? `inset 3px 0 0 ${t.accent}` : 'none',
                                transition: 'background 0.12s ease',
                            }}
                        >
                            {cols.map((col, c) => {
                                const raw = col[r];
                                const num = toNum(raw);
                                // 数値列は背景に控えめなバーを敷いて大小を一目で分かるようにする
                                const colMax = numericMax[c];
                                const showBar = options.valueBars !== false && num !== null && colMax > 0;
                                return (
                                    <td
                                        key={c}
                                        style={{
                                            padding: pad,
                                            borderBottom: '1px solid rgba(128,160,220,0.08)',
                                            position: 'relative',
                                            textAlign: num !== null ? 'right' : 'left',
                                            fontVariantNumeric: num !== null ? 'tabular-nums' : 'normal',
                                        }}
                                    >
                                        {showBar ? (
                                            <span
                                                style={{
                                                    position: 'absolute',
                                                    left: 0,
                                                    top: 3,
                                                    bottom: 3,
                                                    width: `${Math.max((num / colMax) * 100, 1)}%`,
                                                    background: `${t.accent}1c`,
                                                    borderRadius: 3,
                                                    pointerEvents: 'none',
                                                }}
                                            />
                                        ) : null}
                                        <span style={{ position: 'relative' }}>{String(raw ?? '')}</span>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

DpxTable.config = {
    key: 'dpx.table',
    name: 'テーブル',
    category: 'chart',
    dataContract: { requiredDataSources: ['primary'], optionalDataSources: [] },
    optionsSchema: {
        maxRows: { type: 'number', default: 50 },
        striped: { type: 'boolean', default: true },
        dense: { type: 'boolean', default: false },
        valueBars: { type: 'boolean', default: true },
    },
    editorConfig: [
        {
            label: '表示',
            layout: [
                [{ label: '最大行数', option: 'maxRows', editor: 'editor.number' }],
                [{ label: 'しましま', option: 'striped', editor: 'editor.checkbox' }],
                [{ label: '高密度', option: 'dense', editor: 'editor.checkbox' }],
                [{ label: '数値列に値バー', option: 'valueBars', editor: 'editor.checkbox' }],
            ],
        },
    ],
};
