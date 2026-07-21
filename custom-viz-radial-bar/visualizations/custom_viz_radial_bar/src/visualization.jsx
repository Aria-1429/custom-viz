import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';
import chartIcon from './assets/ChartColumnSquare.svg';

// ---------------------------------------------------------------------------
// コンテナ実寸の計測フック（オートフィット／小サイズ対応の中核）
// useDimensions() は環境により未取得のことがあるため、ResizeObserver で
// 実際の描画領域を直接測る。非対応環境では初回に一度だけ計測してフォールバック。
// ---------------------------------------------------------------------------
function useMeasuredSize() {
    const ref = useRef(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 0;
        const h = el.clientHeight || 0;
        setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    }, []);

    const setRef = useCallback(
        (el) => {
            ref.current = el;
            if (el) measure(el);
        },
        [measure]
    );

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        measure(el);
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => measure(el));
        ro.observe(el);
        return () => ro.disconnect();
    }, [measure]);

    return [setRef, size];
}

// ---------------------------------------------------------------------------
// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
// ---------------------------------------------------------------------------
// 値ベースの色スケール（既定は画像に合わせた紫→青のグラデーション）
const DEFAULT_SCALE = {
    lowColor: '#7c3aed', // 紫（小さい値）
    midColor: '#4f7bf0', // 青紫
    highColor: '#38bdf8', // 水色（大きい値）
};

// カテゴリ別パレット（値ベースOFF時）
const DEFAULT_COLORS = [
    '#38bdf8',
    '#4f7bf0',
    '#6366f1',
    '#7c3aed',
    '#a855f7',
    '#ec4899',
    '#f0912e',
    '#2dd4bf',
    '#84cc16',
    '#f5c518',
    '#ef4d6a',
    '#5b8def',
];

const DEFAULTS = {
    useValueColors: true,
    useMidColor: true,
    reverse: false,
    maxBars: 12,
    gapDeg: 4,
    innerRadiusPct: 34,
    cornerRadius: 4,
    showTrack: true,
    showLabels: true,
    showValueOnBar: false,
    showTotal: true,
    usdCenter: false,
    glow: true,
    glowStrength: 5,
    valueFormat: 'comma',
};

const DEFAULT_CATEGORY_FIELD = '';
const DEFAULT_VALUE_FIELD = '';

// editor.text はカスタム viz での可否が不確実なため、中央タイトルは固定値扱い。
const CENTER_LABEL = 'Total';

// ---------------------------------------------------------------------------
// カラーパレット（ライト / ダーク両モード対応）
// ---------------------------------------------------------------------------
const PALETTES = {
    dark: {
        bg: 'transparent',
        title: '#f3f4fb',
        centerValue: '#ffffff',
        centerLabel: '#8a8ea6',
        centerDisc: '#12141c',
        centerDiscStroke: 'rgba(255,255,255,0.06)',
        label: '#c9cddf',
        labelActive: '#ffffff',
        track: 'rgba(255, 255, 255, 0.045)',
        valueOnBar: 'rgba(255,255,255,0.92)',
    },
    light: {
        bg: 'transparent',
        title: '#1b2340',
        centerValue: '#141a30',
        centerLabel: '#6b7186',
        centerDisc: '#ffffff',
        centerDiscStroke: 'rgba(15,20,40,0.10)',
        label: '#3a4160',
        labelActive: '#141a30',
        track: 'rgba(15, 20, 40, 0.06)',
        valueOnBar: 'rgba(20,26,48,0.92)',
    },
};

// ---------------------------------------------------------------------------
// オプション正規化：型不一致・範囲外・欠損をすべて安全側へ補正
// ---------------------------------------------------------------------------
function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

function isHexColor(s) {
    return typeof s === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
}

function pickColor(raw, key, fallback) {
    const v = raw?.[key];
    return isHexColor(v) ? v.trim() : fallback;
}

function pickBool(raw, key, fallback) {
    return typeof raw?.[key] === 'boolean' ? raw[key] : fallback;
}

const VALID_VALUE_FORMATS = ['comma', 'compact', 'plain'];

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};

    const colors = [];
    for (let i = 0; i < DEFAULT_COLORS.length; i += 1) {
        let c = pickColor(o, `color${i + 1}`, null);
        if (!c && Array.isArray(o.colors) && isHexColor(o.colors[i])) c = o.colors[i].trim();
        colors.push(c || DEFAULT_COLORS[i]);
    }

    const vf =
        typeof o.valueFormat === 'string' && VALID_VALUE_FORMATS.includes(o.valueFormat.trim())
            ? o.valueFormat.trim()
            : DEFAULTS.valueFormat;

    return {
        categoryField: o.categoryField ?? DEFAULT_CATEGORY_FIELD,
        valueField: o.valueField ?? DEFAULT_VALUE_FIELD,
        colors,
        lowColor: pickColor(o, 'lowColor', DEFAULT_SCALE.lowColor),
        midColor: pickColor(o, 'midColor', DEFAULT_SCALE.midColor),
        highColor: pickColor(o, 'highColor', DEFAULT_SCALE.highColor),
        useValueColors: pickBool(o, 'useValueColors', DEFAULTS.useValueColors),
        useMidColor: pickBool(o, 'useMidColor', DEFAULTS.useMidColor),
        reverse: pickBool(o, 'reverse', DEFAULTS.reverse),
        maxBars: clampNumber(o.maxBars, 2, 40, DEFAULTS.maxBars),
        gapDeg: clampNumber(o.gapDeg, 0, 20, DEFAULTS.gapDeg),
        innerRadiusPct: clampNumber(o.innerRadiusPct, 10, 70, DEFAULTS.innerRadiusPct),
        cornerRadius: clampNumber(o.cornerRadius, 0, 16, DEFAULTS.cornerRadius),
        showTrack: pickBool(o, 'showTrack', DEFAULTS.showTrack),
        showLabels: pickBool(o, 'showLabels', DEFAULTS.showLabels),
        showValueOnBar: pickBool(o, 'showValueOnBar', DEFAULTS.showValueOnBar),
        showTotal: pickBool(o, 'showTotal', DEFAULTS.showTotal),
        usdCenter: pickBool(o, 'usdCenter', DEFAULTS.usdCenter),
        glow: pickBool(o, 'glow', DEFAULTS.glow),
        glowStrength: clampNumber(o.glowStrength, 0, 20, DEFAULTS.glowStrength),
        valueFormat: vf,
        totalLabel: CENTER_LABEL,
    };
}

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

// ---------------------------------------------------------------------------
// マルチバリューセルの救済（donut-graph / chord-flow のパターン）
// ---------------------------------------------------------------------------
const MAX_MV_EXPAND = 10000;

function cellTokens(c) {
    if (Array.isArray(c)) return c;
    if (typeof c === 'string' && c.includes('\n')) return c.split('\n');
    return [c];
}

function expandMultivalueRows(rows) {
    let expanded = false;
    const out = [];
    for (const row of rows) {
        if (!Array.isArray(row)) {
            out.push(row);
            continue;
        }
        const tokens = row.map(cellTokens);
        const L = tokens.reduce((m, t) => Math.max(m, t.length), 0);
        if (L <= 1) {
            out.push(row);
            continue;
        }
        const alignable = tokens.every((t) => t.length === L || t.length === 1);
        if (!alignable || out.length >= MAX_MV_EXPAND) {
            out.push(row);
            continue;
        }
        expanded = true;
        for (let k = 0; k < L && out.length < MAX_MV_EXPAND; k += 1) {
            out.push(tokens.map((t) => (t.length === 1 ? t[0] : t[k])));
        }
    }
    return expanded ? out : rows;
}

function toNumber(value) {
    if (value === null || value === undefined) return NaN;
    let v = value;
    if (Array.isArray(v)) v = v[0];
    else if (typeof v === 'string' && v.includes('\n')) v = v.split('\n')[0];
    const n = Number(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
}

function cellToLabel(value) {
    if (value === null || value === undefined) return '';
    let v = value;
    if (Array.isArray(v)) v = v[0];
    else if (typeof v === 'string' && v.includes('\n')) v = v.split('\n')[0];
    return String(v);
}

// ---------------------------------------------------------------------------
// フィールド選択の解決（chord-flow v0.4 の resolveFieldIndex）
// ---------------------------------------------------------------------------
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
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
            return fallbackIdx;
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

// カテゴリ列・値列を解決して集計する。値列が未指定/重複なら最初の数値列を採用。
function buildChartData(rows, fieldNames, opts) {
    const catIdx = resolveFieldIndex(opts.categoryField, fieldNames, rows, 0);
    let valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, 1);

    if (valIdx === catIdx || valIdx < 0 || valIdx >= (fieldNames.length || Infinity)) {
        valIdx = -1;
        const scanCols = fieldNames.length || (rows[0] ? rows[0].length : 0);
        for (let c = 0; c < scanCols; c += 1) {
            if (c === catIdx) continue;
            if (rows.some((r) => Number.isFinite(toNumber(r?.[c])))) {
                valIdx = c;
                break;
            }
        }
        if (valIdx === -1) valIdx = catIdx === 0 ? 1 : 0;
    }

    const items = rows
        .map((row) => ({
            label: cellToLabel(row?.[catIdx]),
            value: toNumber(row?.[valIdx]),
        }))
        .filter((item) => item.label !== '' && Number.isFinite(item.value) && item.value >= 0);

    const total = items.reduce((sum, item) => sum + item.value, 0);
    return { items, total, catIdx, valIdx };
}

// 値の大きい順に並べ、上位 maxBars 件だけ残す。
function limitItems(items, opts) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const limit = Math.max(2, Math.floor(opts.maxBars));
    return sorted.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 値→色のカラースケール（calendar-heatmap の lerpColor / scaleColorFor パターン）
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
    let h = hex.replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const u = Math.max(0, Math.min(1, t));
    const r = Math.round(a.r + (b.r - a.r) * u);
    const g = Math.round(a.g + (b.g - a.g) * u);
    const bl = Math.round(a.b + (b.b - a.b) * u);
    return `rgb(${r}, ${g}, ${bl})`;
}

function scaleColorFor(t, opts) {
    let u = Math.max(0, Math.min(1, t));
    if (opts.reverse) u = 1 - u;
    if (opts.useMidColor) {
        return u <= 0.5
            ? lerpColor(opts.lowColor, opts.midColor, u / 0.5)
            : lerpColor(opts.midColor, opts.highColor, (u - 0.5) / 0.5);
    }
    return lerpColor(opts.lowColor, opts.highColor, u);
}

// ---------------------------------------------------------------------------
// 値フォーマット
// ---------------------------------------------------------------------------
function trimZero(n) {
    return Number(n.toFixed(1)).toString();
}

function formatValue(value, fmt) {
    if (!Number.isFinite(value)) return '0';
    if (fmt === 'plain') return String(value);
    if (fmt === 'compact') {
        const abs = Math.abs(value);
        if (abs >= 1e9) return `${trimZero(value / 1e9)}B`;
        if (abs >= 1e6) return `${trimZero(value / 1e6)}M`;
        if (abs >= 1e3) return `${trimZero(value / 1e3)}K`;
        return String(value);
    }
    return value.toLocaleString('en-US');
}

function fieldToTitle(fieldName) {
    if (!fieldName) return '';
    return String(fieldName).replace(/[_-]+/g, ' ').toUpperCase();
}

// ---------------------------------------------------------------------------
// 角度→座標。12時起点・時計回り（-90deg オフセット）。
// ---------------------------------------------------------------------------
function polar(cx, cy, r, angleDeg) {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

// 角丸の環状セクター（annular sector）パス。
// r0=内半径, r1=外半径, a0..a1=角度[deg]。cr=角の丸み半径[px]。
// 外周と内周の両端に円弧フィレットを入れて「先端が丸いバー」に見せる。
function annularSectorPath(cx, cy, r0, r1, a0, a1, cr) {
    const rOut = Math.max(r1, r0 + 0.5);
    const rIn = Math.max(r0, 0.5);
    // 角丸半径は「バー幅の半分」と外周の弧幅・指定値の最小に制限
    const barWidth = rOut - rIn;
    const arcSpanDeg = a1 - a0;
    const arcWidthOut = (rOut * arcSpanDeg * Math.PI) / 180;
    const arcWidthIn = (rIn * arcSpanDeg * Math.PI) / 180;
    let radius = Math.max(0, cr);
    radius = Math.min(radius, barWidth / 2, arcWidthOut / 2, arcWidthIn / 2);

    // フィレット分を角度・半径方向に食い込ませるためのオフセット
    const dAngOut = (radius / rOut) * (180 / Math.PI); // 外周でのフィレット角度幅
    const dAngIn = (radius / rIn) * (180 / Math.PI); // 内周でのフィレット角度幅

    if (radius < 0.75 || arcSpanDeg <= 2 * Math.max(dAngOut, dAngIn)) {
        // フィレット不能なほど細い/狭いバーは角のまま描く
        const p1 = polar(cx, cy, rIn, a0);
        const p2 = polar(cx, cy, rOut, a0);
        const p3 = polar(cx, cy, rOut, a1);
        const p4 = polar(cx, cy, rIn, a1);
        const large = arcSpanDeg > 180 ? 1 : 0;
        return [
            `M ${p1.x} ${p1.y}`,
            `L ${p2.x} ${p2.y}`,
            `A ${rOut} ${rOut} 0 ${large} 1 ${p3.x} ${p3.y}`,
            `L ${p4.x} ${p4.y}`,
            `A ${rIn} ${rIn} 0 ${large} 0 ${p1.x} ${p1.y}`,
            'Z',
        ].join(' ');
    }

    // 角丸あり：各コーナーで「半径方向の直線」→ 四分円フィレット → 「弧」へ滑らかに接続
    // 外周の弧の始点・終点（フィレット分を内側に寄せた角度）
    const oStart = polar(cx, cy, rOut, a0 + dAngOut);
    const oEnd = polar(cx, cy, rOut, a1 - dAngOut);
    // 内周の弧の始点・終点
    const iEnd = polar(cx, cy, rIn, a1 - dAngIn);
    const iStart = polar(cx, cy, rIn, a0 + dAngIn);

    // 半径直線の端点（フィレット手前）
    const radOutA0 = polar(cx, cy, rOut - radius, a0); // a0 側・外周直線の始点
    const radOutA1 = polar(cx, cy, rOut - radius, a1); // a1 側
    const radInA0 = polar(cx, cy, rIn + radius, a0);
    const radInA1 = polar(cx, cy, rIn + radius, a1);

    const largeOut = a1 - dAngOut - (a0 + dAngOut) > 180 ? 1 : 0;
    const largeIn = a1 - dAngIn - (a0 + dAngIn) > 180 ? 1 : 0;

    return [
        `M ${radInA0.x} ${radInA0.y}`, // 内周側・a0 の半径直線 始点
        `L ${radOutA0.x} ${radOutA0.y}`, // 外へ
        `A ${radius} ${radius} 0 0 1 ${oStart.x} ${oStart.y}`, // 外周コーナー フィレット
        `A ${rOut} ${rOut} 0 ${largeOut} 1 ${oEnd.x} ${oEnd.y}`, // 外周の弧
        `A ${radius} ${radius} 0 0 1 ${radOutA1.x} ${radOutA1.y}`, // a1 側 外周フィレット
        `L ${radInA1.x} ${radInA1.y}`, // 内へ（a1 の半径直線）
        `A ${radius} ${radius} 0 0 1 ${iEnd.x} ${iEnd.y}`, // 内周コーナー フィレット
        `A ${rIn} ${rIn} 0 ${largeIn} 0 ${iStart.x} ${iStart.y}`, // 内周の弧（逆回り）
        `A ${radius} ${radius} 0 0 1 ${radInA0.x} ${radInA0.y}`, // a0 側 内周フィレット
        'Z',
    ].join(' ');
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
// ラジアルバー本体（SVG）
// 各カテゴリを等角のくさび（環状セクター）で描き、値=外側への伸び として表現する。
// ---------------------------------------------------------------------------
const VIEWBOX = 400;
const C = VIEWBOX / 2;

function RadialBar({ bars, total, palette, opts, mounted, uid, activeIndex, onHover }) {
    const n = bars.length;
    if (n === 0) return null;

    const slice = 360 / n;
    const gap = Math.min(opts.gapDeg, slice * 0.8);

    // 外周ラベルの余白を見込んで描画半径を決める
    const labelPad = opts.showLabels ? 46 : 12;
    const rMax = C - labelPad;
    const rInner = Math.max(24, rMax * (opts.innerRadiusPct / 100));

    const maxValue = bars.reduce((m, b) => Math.max(m, b.value), 0) || 1;

    // 値→外半径。0 でも内周から少しだけ出す（見た目の下限）
    const barOuter = (v) => {
        const t = maxValue > 0 ? v / maxValue : 0;
        return rInner + (rMax - rInner) * (mounted ? t : 0);
    };

    return (
        <svg
            viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
            width="100%"
            height="100%"
            style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', overflow: 'visible' }}
            role="img"
        >
            <defs>
                {opts.glow && opts.glowStrength > 0 && (
                    <filter id={`glow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation={opts.glowStrength} />
                    </filter>
                )}
                {/* バー内の微かな放射グラデーション（画像のツヤ感） */}
                <radialGradient id={`sheen-${uid}`} cx="50%" cy="50%" r="65%">
                    <stop offset="0%" stopColor="rgba(255,255,255,0.16)" />
                    <stop offset="55%" stopColor="rgba(255,255,255,0.04)" />
                    <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                </radialGradient>
            </defs>

            {/* 背景トラック（各バーの最大長まで薄く敷く） */}
            {opts.showTrack &&
                bars.map((b, i) => {
                    const a0 = i * slice + gap / 2;
                    const a1 = (i + 1) * slice - gap / 2;
                    return (
                        <path
                            key={`track-${i}`}
                            d={annularSectorPath(C, C, rInner, rMax, a0, a1, opts.cornerRadius)}
                            fill={palette.track}
                            style={{ pointerEvents: 'none' }}
                        />
                    );
                })}

            {/* 発光レイヤー（各バー色でぼかして下敷き） */}
            {opts.glow && opts.glowStrength > 0 && (
                <g filter={`url(#glow-${uid})`} style={{ pointerEvents: 'none' }}>
                    {bars.map((b, i) => {
                        const a0 = i * slice + gap / 2;
                        const a1 = (i + 1) * slice - gap / 2;
                        const isActive = activeIndex === i;
                        const dimmed = activeIndex !== null && !isActive;
                        return (
                            <path
                                key={`glow-${i}`}
                                d={annularSectorPath(C, C, rInner, barOuter(b.value), a0, a1, opts.cornerRadius)}
                                fill={b.color}
                                style={{
                                    opacity: dimmed ? 0.06 : isActive ? 0.65 : 0.4,
                                    transition:
                                        'opacity 220ms ease, d 900ms cubic-bezier(0.22,1,0.36,1)',
                                }}
                            />
                        );
                    })}
                </g>
            )}

            {/* 本体バー */}
            <g>
                {bars.map((b, i) => {
                    const a0 = i * slice + gap / 2;
                    const a1 = (i + 1) * slice - gap / 2;
                    const isActive = activeIndex === i;
                    const dimmed = activeIndex !== null && !isActive;
                    const rOut = barOuter(b.value);
                    const d = annularSectorPath(C, C, rInner, rOut, a0, a1, opts.cornerRadius);
                    return (
                        <g key={`bar-${i}`} style={{ pointerEvents: 'none' }}>
                            <path
                                d={d}
                                fill={b.color}
                                style={{
                                    opacity: dimmed ? 0.3 : 1,
                                    transition:
                                        'opacity 200ms ease, d 900ms cubic-bezier(0.22,1,0.36,1)',
                                }}
                            />
                            {/* ツヤ（発光ONのときだけ・控えめ） */}
                            {opts.glow && (
                                <path
                                    d={d}
                                    fill={`url(#sheen-${uid})`}
                                    style={{
                                        opacity: dimmed ? 0.15 : 1,
                                        pointerEvents: 'none',
                                        transition: 'opacity 200ms ease, d 900ms cubic-bezier(0.22,1,0.36,1)',
                                    }}
                                />
                            )}
                            {/* バー上の値ラベル */}
                            {opts.showValueOnBar && rOut - rInner > 22 && (
                                (() => {
                                    const mid = (a0 + a1) / 2;
                                    const p = polar(C, C, rOut - 12, mid);
                                    return (
                                        <text
                                            x={p.x}
                                            y={p.y}
                                            textAnchor="middle"
                                            dominantBaseline="middle"
                                            style={{
                                                fill: palette.valueOnBar,
                                                fontSize: 12,
                                                fontWeight: 700,
                                                fontVariantNumeric: 'tabular-nums',
                                                pointerEvents: 'none',
                                                opacity: mounted ? (dimmed ? 0.4 : 1) : 0,
                                                transition: 'opacity 400ms ease 400ms',
                                            }}
                                        >
                                            {formatValue(b.value, opts.valueFormat)}
                                        </text>
                                    );
                                })()
                            )}
                        </g>
                    );
                })}
            </g>

            {/* 外周ラベル */}
            {opts.showLabels &&
                bars.map((b, i) => {
                    const mid = i * slice + slice / 2;
                    const isActive = activeIndex === i;
                    const dimmed = activeIndex !== null && !isActive;
                    const lp = polar(C, C, rMax + 16, mid);
                    // 左右で textAnchor を切り替え、上下では中央寄せ
                    const norm = ((mid % 360) + 360) % 360;
                    let anchor = 'middle';
                    if (norm > 8 && norm < 172) anchor = 'start';
                    else if (norm > 188 && norm < 352) anchor = 'end';
                    const label = b.label.length > 16 ? `${b.label.slice(0, 15)}…` : b.label;
                    return (
                        <text
                            key={`lab-${i}`}
                            x={lp.x}
                            y={lp.y}
                            textAnchor={anchor}
                            dominantBaseline="middle"
                            onMouseEnter={() => onHover(i)}
                            onMouseLeave={() => onHover(null)}
                            style={{
                                fill: isActive ? palette.labelActive : palette.label,
                                fontSize: 12,
                                fontWeight: isActive ? 800 : 600,
                                letterSpacing: '0.01em',
                                opacity: mounted ? (dimmed ? 0.45 : 1) : 0,
                                transition: 'opacity 300ms ease, fill 160ms ease, font-weight 160ms ease',
                                cursor: 'default',
                            }}
                        >
                            <title>{`${b.label}: ${opts.usdCenter ? '$' : ''}${formatValue(b.value, opts.valueFormat)}`}</title>
                            {label}
                        </text>
                    );
                })}

            {/* ホバー用の当たり判定レイヤー（各スライスの全角度・全長を覆う透明セクター）。
                背景トラックのグレー部分にカーソルを合わせても、そのカテゴリがフォーカスされる。
                最前面に置き、ツールチップ（<title>）もここに集約する。 */}
            <g>
                {bars.map((b, i) => {
                    const a0 = i * slice + gap / 2;
                    const a1 = (i + 1) * slice - gap / 2;
                    return (
                        <path
                            key={`hit-${i}`}
                            d={annularSectorPath(C, C, rInner, rMax, a0, a1, opts.cornerRadius)}
                            fill="transparent"
                            onMouseEnter={() => onHover(i)}
                            onMouseLeave={() => onHover(null)}
                            style={{ cursor: 'default', pointerEvents: 'all' }}
                        >
                            <title>{`${b.label}: ${opts.usdCenter ? '$' : ''}${formatValue(
                                b.value,
                                opts.valueFormat
                            )} (${((b.value / (total || 1)) * 100).toFixed(1)}%)`}</title>
                        </path>
                    );
                })}
            </g>

            {/* 中央ディスク */}
            <circle
                cx={C}
                cy={C}
                r={rInner - 6}
                fill={palette.centerDisc}
                stroke={palette.centerDiscStroke}
                strokeWidth={1}
                style={{ pointerEvents: 'none' }}
            />

            {/* 中央のトータル（ホバー中はそのバーの値/ラベルにスワップ） */}
            {opts.showTotal &&
                (() => {
                    const active = activeIndex !== null ? bars[activeIndex] : null;
                    const raw = active ? active.value : total;
                    const bigText = `${opts.usdCenter ? '$' : ''}${formatValue(raw, opts.valueFormat)}`;
                    const subText = active ? active.label : opts.totalLabel;
                    // 中央ディスク内に確実に収まるよう文字サイズを決める。
                    // ディスク直径から左右パディングを引いた「使える横幅」に、
                    // 数字の推定字幅（≈0.62×fontSize）で bigText が収まる上限を求める。
                    const discR = rInner - 6;
                    const innerPad = Math.max(8, discR * 0.22); // 上下左右の余白
                    const availW = Math.max(10, (discR - innerPad) * 2); // ディスク内の使える横幅
                    const availH = Math.max(10, (discR - innerPad) * 2); // 同・縦
                    // 横幅で決まる上限（字幅0.62）と、縦（ビッグ＋サブで約2.4行分）で決まる上限の小さい方
                    const byWidth = availW / (Math.max(1, bigText.length) * 0.62);
                    const byHeight = availH / 2.4;
                    const bigSize = Math.max(11, Math.min(30, Math.round(Math.min(byWidth, byHeight))));
                    const subSize = Math.max(9, Math.min(14, Math.round(bigSize * 0.46)));
                    // ラベル（上）＋値（下）の2段を中央に縦センタリング。
                    const hasSub = Boolean(subText);
                    const bigY = hasSub ? C + bigSize * 0.34 : C;
                    const subY = C - bigSize * 0.5;
                    return (
                        <>
                            {hasSub ? (
                                <text
                                    x={C}
                                    y={subY}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    style={{
                                        fill: palette.centerLabel,
                                        fontSize: subSize,
                                        fontWeight: 600,
                                        letterSpacing: '0.03em',
                                        opacity: mounted ? 1 : 0,
                                        transition: 'opacity 500ms ease 450ms',
                                    }}
                                >
                                    {subText.length > 16 ? `${subText.slice(0, 15)}…` : subText}
                                </text>
                            ) : null}
                            <text
                                x={C}
                                y={bigY}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                style={{
                                    fill: active ? active.color : palette.centerValue,
                                    fontSize: bigSize,
                                    fontWeight: 800,
                                    letterSpacing: '-0.01em',
                                    fontVariantNumeric: 'tabular-nums',
                                    opacity: mounted ? 1 : 0,
                                    transition: 'opacity 500ms ease 350ms, fill 200ms ease',
                                }}
                            >
                                {bigText}
                            </text>
                        </>
                    );
                })()}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// ラジアルバーグラフ全体レイアウト
// ---------------------------------------------------------------------------
function RadialBarChart({ fieldNames, rows, mode, opts }) {
    const palette = PALETTES[mode] || PALETTES.dark;

    const { items, total, catIdx } = useMemo(
        () => buildChartData(rows, fieldNames, opts),
        [rows, fieldNames, opts]
    );

    const bars = useMemo(() => {
        const limited = limitItems(items, opts);
        const maxV = limited.reduce((m, b) => Math.max(m, b.value), 0) || 1;
        const minV = limited.reduce((m, b) => Math.min(m, b.value), Infinity);
        const span = maxV - (Number.isFinite(minV) ? minV : 0);
        return limited.map((it, i) => {
            let color;
            if (opts.useValueColors) {
                const t = span > 0 ? (it.value - minV) / span : 1;
                color = scaleColorFor(t, opts);
            } else {
                color = opts.colors[i % opts.colors.length];
            }
            return { ...it, color };
        });
    }, [items, opts]);

    const uid = useMemo(() => Math.floor(Math.random() * 1e9).toString(36), []);
    const [activeIndex, setActiveIndex] = useState(null);

    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const [containerRef, size] = useMeasuredSize();
    const W = size.width;
    const H = size.height;

    if (bars.length === 0) return <NoDataState />;

    const title = fieldToTitle(fieldNames?.[catIdx]);
    const measured = W > 0 && H > 0;

    const pad = measured ? Math.max(6, Math.min(20, Math.round(Math.min(W, H) * 0.03))) : 16;
    const titleFont = measured ? Math.max(11, Math.min(15, Math.round(W / 30))) : 14;
    const showTitle = Boolean(title) && (!measured || H > 140);
    const titleH = showTitle ? titleFont + 14 : 0;

    return (
        <div
            ref={containerRef}
            className="viz-container"
            style={{ padding: pad, overflow: 'hidden', background: palette.bg }}
        >
            {showTitle && (
                <div
                    style={{
                        color: palette.title,
                        fontSize: titleFont,
                        fontWeight: 800,
                        letterSpacing: '0.08em',
                        marginBottom: 10,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        textAlign: 'center',
                    }}
                >
                    {title}
                </div>
            )}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: `calc(100% - ${titleH}px)`,
                    minHeight: 0,
                }}
            >
                <RadialBar
                    bars={bars}
                    total={total}
                    palette={palette}
                    opts={opts}
                    mounted={mounted}
                    uid={uid}
                    activeIndex={activeIndex}
                    onHover={setActiveIndex}
                />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース + オプション接続
// ---------------------------------------------------------------------------
function RadialBarVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();

    const data = dataSources?.primary?.data || null;
    const rows = useMemo(() => {
        if (!data) return [];
        return expandMultivalueRows(normalizeData(data));
    }, [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f?.name || f), [data]);
    const opts = useMemo(() => normalizeOptions(options), [options]);

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) return <NoDataState />;

    return <RadialBarChart fieldNames={fieldNames} rows={rows} mode={mode} opts={opts} />;
}

// ---------------------------------------------------------------------------
// テーマガード付きルート
// ---------------------------------------------------------------------------
function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画

    const mode = colorScheme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <RadialBarVisualization mode={mode} />
        </SplunkThemeProvider>
    );
}

// ホスト初期化完了（DashboardExtensionAPI 注入＋テーマ/データの初期 state 受信）を
// 待ってからマウントする。公式フックは購読登録時に現在値を再送しないため、
// 初期 state がマウントより後に届くと取り逃して永久に描画されないことがある。
// 最大5秒待っても揃わない場合はフォールバック描画（テーマは light 既定）に入る。
const MOUNT_START = Date.now();

function hostReady() {
    try {
        const api = globalThis.DashboardExtensionAPI;
        return Boolean(api && api.getTheme()?.theme && api.getDataSources());
    } catch (e) {
        return false;
    }
}

function mountApp() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(
        <VisualizationExtensionProvider>
            <App />
        </VisualizationExtensionProvider>
    );
}

(function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mountApp();
    } else {
        setTimeout(mountWhenReady, 50);
    }
})();
