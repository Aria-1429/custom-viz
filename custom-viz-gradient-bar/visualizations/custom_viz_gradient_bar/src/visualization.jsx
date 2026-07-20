import {
    useDataSources,
    useTheme,
    useOptions,
    useDimensions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';
import chartIcon from './assets/ChartColumnSquare.svg';

// ---------------------------------------------------------------------------
// テーマ別パレット（構造色。バーの塗りはオプション由来のカラースケールで別途決定）
// ---------------------------------------------------------------------------
const PALETTES = {
    dark: {
        title: '#f2f3fa',
        label: '#d6d8e6',
        value: '#f2f3fa',
        percent: '#a2a6bf',
        axisText: '#8a8ea6',
        axisLine: 'rgba(255, 255, 255, 0.10)',
        track: 'rgba(255, 255, 255, 0.06)',
        insideBarText: '#ffffff',
    },
    light: {
        title: '#1f2440',
        label: '#3c4258',
        value: '#1f2440',
        percent: '#6b7186',
        axisText: '#7a7f94',
        axisLine: 'rgba(0, 0, 0, 0.12)',
        track: 'rgba(0, 0, 0, 0.06)',
        insideBarText: '#ffffff',
    },
};

const LABEL_COL = 'minmax(96px, 160px)';

// ---------------------------------------------------------------------------
// オプション既定値（optionsSchema の default と一致させること）
// 色・数値・真偽はすべて editor.color / editor.number / editor.checkbox 由来
// ---------------------------------------------------------------------------
const DEFAULTS = {
    // データフィールド選択（'' = ラベルは第1列 / 値は第2列。columnSelector の DOS 文字列にも対応）
    labelField: '',
    valueField: '',
    // 塗り方式
    useValueColors: false, // false=単色グラデーション(既定), true=値ベースのカラースケール
    // 値ベースのカラースケール
    lowColor: '#3fb950', // 低値側（安全＝緑）
    midColor: '#f5c518', // 中間色（黄）
    highColor: '#ef4d4d', // 高値側（危険＝赤）
    useMidColor: true, // 3 色スケールにする
    reverse: false, // 低↔高を反転（ONで「高い値＝赤」）
    scaleMin: null, // 正規化の下限（空欄=データ最小）
    scaleMax: null, // 正規化の上限（空欄=データ最大）
    // 単色グラデーション（useValueColors=false のとき）
    barColor: '#9333ea', // グラデーションの基準色
    // 並び替え・件数
    sortByValue: true, // 値で並べ替える（OFF=サーチ結果の順序を維持）
    sortAscending: false, // 昇順（OFF=降順）
    topN: 0, // 上位 N 件のみ表示（0=全件）
    // 表示要素
    showTitle: true,
    showAxis: true,
    showValue: true,
    showPercent: true,
    showTrack: true,
    glow: true, // バーに発光エフェクト
    animate: true, // マウント時に伸びるアニメーション
    // レイアウト
    fillHeight: true, // 高さいっぱいに行を広げる
    barThickness: 0, // バーの太さ（px、0=自動）
    debug: false, // options の生値を画面に出す診断オーバーレイ
};

// ---------------------------------------------------------------------------
// データ整形ユーティリティ
// ---------------------------------------------------------------------------
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const numRows = data.columns[0].length;
            return Array.from({ length: numRows }, (_, i) => data.columns.map((col) => col[i]));
        }
    } catch (e) {
        // 想定外のデータ形式でも落とさない
    }
    return [];
}

function toNumber(value) {
    if (value === null || value === undefined) return NaN;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
}

// editor.columnSelector（標準 viz の「データ設定」と同じ UI）は選択結果を
// DOS 文字列（例: "> primary | seriesByName('host')"）としてオプションに書く。
// カスタム viz には DOS が未解決のまま届く（dynamicColor の実測と同じ挙動）ため、
// 文字列からフィールド名/インデックスを自前でパースする。将来ホストが解決して
// 列データ配列が届くようになっても動くよう、配列は列内容の照合で解決する。
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
    // ホスト解決済みの列データ（配列）: 先頭数行を各列と照合してインデックスを特定
    if (Array.isArray(spec)) {
        for (let i = 0; i < fieldNames.length; i += 1) {
            const n = Math.min(spec.length, sampleRows.length, 5);
            let ok = n > 0;
            for (let k = 0; k < n; k += 1) {
                const cell = Array.isArray(sampleRows[k]) ? sampleRows[k][i] : undefined;
                if (String(cell) !== String(spec[k])) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return fallbackIdx;
    }
    if (typeof spec !== 'string') return fallbackIdx;
    const s = spec.trim();
    if (s === '') return fallbackIdx;
    let name = s;
    if (s.startsWith('>')) {
        const byName = s.match(/seriesByName\(\s*['"]([^'"]+)['"]\s*\)/);
        const byIndex = s.match(/seriesByIndex\(\s*(\d+)\s*\)/);
        if (byName) {
            name = byName[1];
        } else if (byIndex) {
            const idx = Number(byIndex[1]);
            return idx >= 0 && idx < fieldNames.length ? idx : fallbackIdx;
        } else {
            return fallbackIdx; // 解釈できない DOS はデフォルト列に退避
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

// ラベル列・値列（インデックス）を指定して集計する
function buildChartData(rows, opts, labelIdx, valueIdx) {
    let items = rows
        .map((row) => ({
            label:
                row?.[labelIdx] !== null && row?.[labelIdx] !== undefined
                    ? String(row[labelIdx])
                    : '',
            value: toNumber(row?.[valueIdx]),
        }))
        .filter((item) => item.label !== '' && Number.isFinite(item.value) && item.value >= 0);

    // 合計・最小・最大は「並べ替え・件数制限の前」の全件で算出する
    const total = items.reduce((sum, item) => sum + item.value, 0);

    if (opts.sortByValue) {
        items = items
            .slice()
            .sort((a, b) => (opts.sortAscending ? a.value - b.value : b.value - a.value));
    }
    if (opts.topN > 0 && items.length > opts.topN) {
        // 上位 N は常に「値が大きい順の上位」。表示順は sortAscending に従う
        const byDesc = items.slice().sort((a, b) => b.value - a.value).slice(0, opts.topN);
        const keep = new Set(byDesc);
        items = items.filter((it) => keep.has(it));
    }

    const values = items.map((it) => it.value);
    const maxValue = values.reduce((m, v) => Math.max(m, v), 0);
    const minValue = values.length ? values.reduce((m, v) => Math.min(m, v), Infinity) : 0;
    return { items, total, maxValue, minValue };
}

// 軸の最大値と目盛りを「きりのよい値」で計算する
function computeAxis(maxValue) {
    if (!Number.isFinite(maxValue) || maxValue <= 0) {
        return { axisMax: 1, ticks: [0, 1] };
    }
    const roughStep = maxValue / 3;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const normalized = roughStep / magnitude;
    let step;
    if (normalized <= 1) step = 1 * magnitude;
    else if (normalized <= 2) step = 2 * magnitude;
    else if (normalized <= 5) step = 5 * magnitude;
    else step = 10 * magnitude;

    const axisMax = Math.ceil(maxValue / step) * step;
    const ticks = [];
    for (let t = 0; t <= axisMax + step * 0.001; t += step) {
        ticks.push(t);
    }
    return { axisMax, ticks };
}

function formatTick(value) {
    if (value >= 1e9) return `${trimZero(value / 1e9)}G`;
    if (value >= 1e6) return `${trimZero(value / 1e6)}M`;
    if (value >= 1e3) return `${trimZero(value / 1e3)}K`;
    return String(value);
}

function trimZero(n) {
    return Number(n.toFixed(1)).toString();
}

function formatValue(value) {
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString('en-US');
}

function fieldToTitle(fieldName) {
    if (!fieldName) return '';
    return String(fieldName).replace(/[_-]+/g, ' ').toUpperCase();
}

// ---------------------------------------------------------------------------
// オプション正規化（未設定・型不一致でも安全側へ）
// ---------------------------------------------------------------------------
function clampInt(value, min, max, fallback) {
    const n = Math.round(toNumber(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function asBool(value, fallback) {
    if (value === true || value === false) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

function isHexColor(value) {
    return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

function toNumberOrNull(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function normalizeOptions(options) {
    const o = options || {};
    return {
        // columnSelector の値（DOS 文字列/生名/配列）はそのまま保持し、resolveFieldIndex で解決する
        labelField: o.labelField ?? DEFAULTS.labelField,
        valueField: o.valueField ?? DEFAULTS.valueField,
        useValueColors: asBool(o.useValueColors, DEFAULTS.useValueColors),
        lowColor: isHexColor(o.lowColor) ? o.lowColor.trim() : DEFAULTS.lowColor,
        midColor: isHexColor(o.midColor) ? o.midColor.trim() : DEFAULTS.midColor,
        highColor: isHexColor(o.highColor) ? o.highColor.trim() : DEFAULTS.highColor,
        useMidColor: asBool(o.useMidColor, DEFAULTS.useMidColor),
        reverse: asBool(o.reverse, DEFAULTS.reverse),
        scaleMin: toNumberOrNull(o.scaleMin),
        scaleMax: toNumberOrNull(o.scaleMax),
        barColor: isHexColor(o.barColor) ? o.barColor.trim() : DEFAULTS.barColor,
        sortByValue: asBool(o.sortByValue, DEFAULTS.sortByValue),
        sortAscending: asBool(o.sortAscending, DEFAULTS.sortAscending),
        topN: clampInt(o.topN, 0, 1000, DEFAULTS.topN),
        showTitle: asBool(o.showTitle, DEFAULTS.showTitle),
        showAxis: asBool(o.showAxis, DEFAULTS.showAxis),
        showValue: asBool(o.showValue, DEFAULTS.showValue),
        showPercent: asBool(o.showPercent, DEFAULTS.showPercent),
        showTrack: asBool(o.showTrack, DEFAULTS.showTrack),
        glow: asBool(o.glow, DEFAULTS.glow),
        animate: asBool(o.animate, DEFAULTS.animate),
        fillHeight: asBool(o.fillHeight, DEFAULTS.fillHeight),
        barThickness: clampInt(o.barThickness, 0, 80, DEFAULTS.barThickness),
        debug: asBool(o.debug, DEFAULTS.debug),
    };
}

// ---------------------------------------------------------------------------
// カラー計算
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) {
        h = h.split('').map((c) => c + c).join('');
    }
    const num = parseInt(h, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function hexToRgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const u = Math.max(0, Math.min(1, t));
    const r = Math.round(a.r + (b.r - a.r) * u);
    const g = Math.round(a.g + (b.g - a.g) * u);
    const bl = Math.round(a.b + (b.b - a.b) * u);
    return `#${[r, g, bl].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// 正規化値 t(0..1) をカラースケール（low →[mid]→ high）にマップして hex を返す
function scaleColorFor(t, opts) {
    let u = Math.max(0, Math.min(1, t));
    if (opts.reverse) u = 1 - u;
    if (opts.useMidColor) {
        if (u <= 0.5) return lerpColor(opts.lowColor, opts.midColor, u / 0.5);
        return lerpColor(opts.midColor, opts.highColor, (u - 0.5) / 0.5);
    }
    return lerpColor(opts.lowColor, opts.highColor, u);
}

// ある基準色から、そのバー1本用のグラデーション（濃→淡）を生成する
function gradientFor(baseHex) {
    const dark = lerpColor(baseHex, '#000000', 0.22);
    const light = lerpColor(baseHex, '#ffffff', 0.32);
    return `linear-gradient(90deg, ${dark} 0%, ${baseHex} 55%, ${light} 100%)`;
}

// バー1本の基準色を決定する（値ベース or 単色）
function barBaseColor(item, opts, scaleLo, scaleHi) {
    if (!opts.useValueColors) return opts.barColor;
    const span = scaleHi - scaleLo;
    const t = span > 0 ? (item.value - scaleLo) / span : 0.5;
    return scaleColorFor(t, opts);
}

// ---------------------------------------------------------------------------
// 状態表示コンポーネント
// ---------------------------------------------------------------------------
function LoadingState() {
    return (
        <div className="viz-container viz-container--empty">
            <WaitSpinner size="large" />
        </div>
    );
}

function NoDataState() {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">
                <img src={chartIcon} className="viz-message-icon" alt="" />
                <Paragraph>No data available</Paragraph>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// 横棒グラフ本体
// ---------------------------------------------------------------------------
function BarRow({ item, index, axisMax, total, palette, opts, mounted, barBase, barHeight }) {
    const pct = axisMax > 0 ? Math.min((item.value / axisMax) * 100, 100) : 0;
    const share = total > 0 ? (item.value / total) * 100 : 0;
    const labelInside = pct > 78; // バーが長い場合は値ラベルをバー内側に配置
    const showLabel = opts.showValue || opts.showPercent;

    const glow = opts.glow
        ? `0 0 10px ${hexToRgba(barBase, 0.45)}, 0 0 22px ${hexToRgba(barBase, 0.22)}`
        : 'none';

    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: `${LABEL_COL} 1fr`,
                alignItems: 'center',
                columnGap: 14,
                minHeight: barHeight,
            }}
        >
            <div
                title={item.label}
                style={{
                    color: palette.label,
                    fontSize: 13,
                    lineHeight: 1.2,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
            >
                {item.label}
            </div>

            <div style={{ position: 'relative', height: barHeight }}>
                {/* トラック（下地） */}
                {opts.showTrack && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            borderRadius: barHeight / 2,
                            background: palette.track,
                        }}
                    />
                )}
                {/* バー本体 */}
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        height: '100%',
                        width: mounted ? `${pct}%` : opts.animate ? '0%' : `${pct}%`,
                        minWidth: item.value > 0 ? 6 : 0,
                        borderRadius: barHeight / 2,
                        background: gradientFor(barBase),
                        boxShadow: glow,
                        transition: opts.animate
                            ? `width 700ms cubic-bezier(0.22, 1, 0.36, 1) ${index * 60}ms`
                            : 'none',
                    }}
                />
                {/* 値ラベル */}
                {showLabel && (
                    <span
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: `${pct}%`,
                            transform: labelInside
                                ? 'translate(calc(-100% - 10px), -50%)'
                                : 'translate(10px, -50%)',
                            whiteSpace: 'nowrap',
                            fontSize: 13,
                            fontVariantNumeric: 'tabular-nums',
                            color: labelInside ? palette.insideBarText : palette.value,
                            fontWeight: 600,
                            opacity: mounted || !opts.animate ? 1 : 0,
                            transition: opts.animate
                                ? `opacity 400ms ease ${index * 60 + 350}ms`
                                : 'none',
                        }}
                    >
                        {opts.showValue && formatValue(item.value)}
                        {opts.showValue && opts.showPercent && ' '}
                        {opts.showPercent && (
                            <span
                                style={{
                                    color: labelInside ? palette.insideBarText : palette.percent,
                                    fontWeight: 400,
                                }}
                            >
                                ({share.toFixed(1)}%)
                            </span>
                        )}
                    </span>
                )}
            </div>
        </div>
    );
}

function Axis({ ticks, axisMax, palette }) {
    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: `${LABEL_COL} 1fr`,
                columnGap: 14,
                marginTop: 12,
                flex: '0 0 auto',
            }}
        >
            <div />
            <div
                style={{
                    position: 'relative',
                    height: 20,
                    borderTop: `1px solid ${palette.axisLine}`,
                }}
            >
                {ticks.map((tick, i) => {
                    const pct = axisMax > 0 ? (tick / axisMax) * 100 : 0;
                    const isFirst = i === 0;
                    const isLast = i === ticks.length - 1;
                    return (
                        <span
                            key={tick}
                            style={{
                                position: 'absolute',
                                top: 5,
                                left: `${pct}%`,
                                transform: isFirst
                                    ? 'none'
                                    : isLast
                                      ? 'translateX(-100%)'
                                      : 'translateX(-50%)',
                                fontSize: 11,
                                color: palette.axisText,
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            {formatTick(tick)}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

// 値ベース塗り時の凡例（連続グラデーションバー＋min/max）
function ScaleLegend({ opts, scaleLo, scaleHi, palette }) {
    const stops = [];
    const N = 12;
    for (let i = 0; i <= N; i += 1) {
        stops.push(scaleColorFor(i / N, opts));
    }
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 10,
                flex: '0 0 auto',
            }}
        >
            <span
                style={{
                    fontSize: 11,
                    color: palette.axisText,
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {formatValue(scaleLo)}
            </span>
            <div
                style={{
                    flex: 1,
                    height: 8,
                    borderRadius: 4,
                    background: `linear-gradient(90deg, ${stops.join(', ')})`,
                }}
            />
            <span
                style={{
                    fontSize: 11,
                    color: palette.axisText,
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {formatValue(scaleHi)}
            </span>
        </div>
    );
}

function DebugOverlay({ rawOptions }) {
    return (
        <pre
            style={{
                position: 'absolute',
                top: 4,
                right: 4,
                maxWidth: '60%',
                maxHeight: '60%',
                overflow: 'auto',
                margin: 0,
                padding: '6px 8px',
                fontSize: 10,
                lineHeight: 1.35,
                background: 'rgba(0,0,0,0.8)',
                color: '#7CFC7C',
                border: '1px solid rgba(255,255,255,0.25)',
                borderRadius: 4,
                zIndex: 10,
                pointerEvents: 'none',
                whiteSpace: 'pre-wrap',
            }}
        >
            {JSON.stringify(rawOptions ?? {}, null, 2)}
        </pre>
    );
}

function BarChart({ fieldNames, rows, mode, opts, rawOptions, height }) {
    const palette = PALETTES[mode] || PALETTES.dark;
    // フィールド選択（未指定/解決不能ならラベル=第1列, 値=第2列にフォールバック）
    const labelIdx = useMemo(
        () => resolveFieldIndex(opts.labelField, fieldNames, rows, 0),
        [opts.labelField, fieldNames, rows]
    );
    const valueIdx = useMemo(
        () => resolveFieldIndex(opts.valueField, fieldNames, rows, 1),
        [opts.valueField, fieldNames, rows]
    );
    const { items, total, maxValue, minValue } = useMemo(
        () => buildChartData(rows, opts, labelIdx, valueIdx),
        [rows, opts, labelIdx, valueIdx]
    );
    const { axisMax, ticks } = useMemo(() => computeAxis(maxValue), [maxValue]);

    // 値ベース塗りのスケール境界（空欄=データ min/max）
    const scaleLo = opts.scaleMin !== null ? opts.scaleMin : minValue;
    const scaleHi = opts.scaleMax !== null ? opts.scaleMax : maxValue;

    // マウント後にバーを伸ばすアニメーション用フラグ
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    if (items.length === 0) return <NoDataState />;

    const title = opts.showTitle ? fieldToTitle(fieldNames?.[labelIdx]) : '';

    // 行の太さ：オプション指定 → 高さいっぱいの自動計算 → 既定 14px
    let barHeight = 14;
    if (opts.barThickness > 0) {
        barHeight = opts.barThickness;
    } else if (opts.fillHeight && Number.isFinite(height) && height > 0) {
        const chrome =
            28 /* padding */ +
            (title ? 32 : 0) +
            (opts.showAxis ? 32 : 0) +
            (opts.useValueColors ? 28 : 0);
        const rowGap = 12;
        const avail = Math.max(0, height - chrome);
        const perRow = avail / items.length;
        barHeight = Math.max(10, Math.min(48, perRow - rowGap));
    }
    const rowGap = 12;

    return (
        <div
            className="viz-container"
            style={{
                position: 'relative',
                padding: '14px 20px 10px',
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
            }}
        >
            {opts.debug && <DebugOverlay rawOptions={rawOptions} />}
            {title && (
                <div
                    style={{
                        color: palette.title,
                        fontSize: 14,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        marginBottom: 14,
                        flex: '0 0 auto',
                    }}
                >
                    {title}
                </div>
            )}
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    rowGap: rowGap,
                    flex: opts.fillHeight ? '1 1 auto' : '0 0 auto',
                    justifyContent: opts.fillHeight ? 'space-around' : 'flex-start',
                    minHeight: 0,
                }}
            >
                {items.map((item, index) => (
                    <BarRow
                        key={`${item.label}-${index}`}
                        item={item}
                        index={index}
                        axisMax={axisMax}
                        total={total}
                        palette={palette}
                        opts={opts}
                        mounted={mounted}
                        barBase={barBaseColor(item, opts, scaleLo, scaleHi)}
                        barHeight={barHeight}
                    />
                ))}
            </div>
            {opts.showAxis && <Axis ticks={ticks} axisMax={axisMax} palette={palette} />}
            {opts.useValueColors && (
                <ScaleLegend opts={opts} scaleLo={scaleLo} scaleHi={scaleHi} palette={palette} />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース接続
// ---------------------------------------------------------------------------
function BarChartVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();
    const dims = useDimensions();

    const data = dataSources?.primary?.data || null;
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f?.name || f), [data]);
    const opts = useMemo(() => normalizeOptions(options), [options]);

    // useDimensions が未対応/未取得のときは ResizeObserver で実寸をフォールバック計測
    const containerRef = useRef(null);
    const [measuredHeight, setMeasuredHeight] = useState(0);
    useEffect(() => {
        const el = containerRef.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            if (el) setMeasuredHeight(el.clientHeight || 0);
            return undefined;
        }
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const h = entry.contentRect?.height || el.clientHeight || 0;
                if (h > 0) setMeasuredHeight(h);
            }
        });
        ro.observe(el);
        setMeasuredHeight(el.clientHeight || 0);
        return () => ro.disconnect();
    }, []);

    const height =
        Number.isFinite(dims?.height) && dims.height > 0 ? dims.height : measuredHeight;

    let body;
    if (loading) body = <LoadingState />;
    else if (!data || rows.length === 0) body = <NoDataState />;
    else
        body = (
            <BarChart
                fieldNames={fieldNames}
                rows={rows}
                mode={mode}
                opts={opts}
                rawOptions={options}
                height={height}
            />
        );

    return (
        <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
            {body}
        </div>
    );
}

// ---------------------------------------------------------------------------
// テーマガード付きルート
// useTheme() が undefined（テーマ未取得）の間は App をレンダリングしない
// ---------------------------------------------------------------------------
function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme;

    if (!colorScheme) {
        return null;
    }

    const mode = colorScheme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <BarChartVisualization mode={mode} />
        </SplunkThemeProvider>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(<App />);
