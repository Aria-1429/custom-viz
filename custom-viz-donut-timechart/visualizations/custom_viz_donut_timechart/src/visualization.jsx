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
// Custom Viz Donut Timechart  v0.2.0
// 「Endpoint Protection Status」カード風の複合ビジュアライゼーション:
//   上段: ドーナツ（中央に最大セグメントの割合%）+ 凡例（値・Total行つき）
//   下段: 合計値の推移を示すトレンドチャート（エリア + ライン）
//
// 想定データ（timechart 形式・推奨）:
//   | timechart span=15m count by status
//   → fields: _time, Protected, "At Risk", Offline ...
//   最新（最後の非空）行の値でドーナツ・凡例を描き、
//   各時刻の合計値でトレンドチャートを描く。
//
// 互換データ（stats 形式）:
//   | stats count by status → 第1列=カテゴリ, 第2列=数値
//   この場合トレンドチャートは自動で非表示になる。
//
// v0.2.0 の改善:
//   - フィールド選択 UI（editor.columnSelector）で時刻/カテゴリ/値の列を指定可能
//   - マルチバリューセルの救済・堅牢な数値パース（桁連結事故を防止）
//   - コンテナ実寸に応じたオートフィット（凡例フォント・ドーナツを自動スケール）
//   - 編集画面ラベルの日本語化・color7/8 追加・debug オーバーレイ
// ---------------------------------------------------------------------------

// オプションのデフォルト値（config.json の optionsSchema.default と一致させる）
const DEFAULT_COLORS = [
    '#3fd66e', // 緑（正常・Protected 想定）
    '#f0912e', // オレンジ（At Risk 想定）
    '#ef4d6a', // レッド（Offline / Critical 想定）
    '#5b8def', // 青
    '#a78bfa', // 紫
    '#2dd4bf', // ティール
    '#f5c518', // 黄
    '#38bdf8', // ライトブルー
];

// Others（集約先）の色（モード別）
const OTHERS_COLOR = { dark: '#5b6070', light: '#c2c7d6' };

const DEFAULTS = {
    totalColor: '#7da6dd',
    sparkColor: '#3d7fd9',
    thickness: 26,
    gap: 2,
    maxSegments: 6,
    rounded: false,
    glow: true,
    glowStrength: 6,
    centerPercent: true, // 中央に最大セグメントの%を表示（OFFなら合計値）
    showLegend: true,
    showPercent: false,
    showTotalRow: true,
    showSparkline: true,
    sparkHeight: 110,
    sparkFill: true,
    autoFit: true,
    debug: false,
};

// editorConfig では editor.text が未サポートのため、これらは固定値として扱う。
const CENTER_TOTAL_LABEL = 'Total';
const TOTAL_ROW_LABEL = 'Total';
const OTHERS_LABEL = 'Others';
const VALUE_FORMAT = 'comma'; // 'comma' | 'compact' | 'plain'

// カラーパレット（ライト / ダーク両モード対応）
const PALETTES = {
    dark: {
        centerValue: '#cfe2ff',
        centerLabel: '#e4e6f1',
        legendLabel: '#e4e6f1',
        legendValue: '#ffffff',
        legendPercent: '#9aa0ba',
        divider: 'rgba(255, 255, 255, 0.10)',
        track: 'rgba(255, 255, 255, 0.05)',
        rowHover: 'rgba(255, 255, 255, 0.04)',
        sparkBaseline: 'rgba(255, 255, 255, 0.14)',
        debugBg: 'rgba(10, 14, 26, 0.92)',
        debugText: '#c7d0e8',
    },
    light: {
        centerValue: '#1b2a4a',
        centerLabel: '#2c3350',
        legendLabel: '#2c3350',
        legendValue: '#141a30',
        legendPercent: '#767c93',
        divider: 'rgba(15, 20, 40, 0.10)',
        track: 'rgba(15, 20, 40, 0.06)',
        rowHover: 'rgba(15, 20, 40, 0.035)',
        sparkBaseline: 'rgba(15, 20, 40, 0.16)',
        debugBg: 'rgba(245, 247, 252, 0.94)',
        debugText: '#2c3350',
    },
};

// ドーナツの寸法（SVG viewBox 座標系）
const VIEWBOX = 240;
const CENTER = VIEWBOX / 2;
const RADIUS = 94;
const MIN_ARC_ABS = 1.5;

// トレンドチャートの論理座標（描画時は横に引き伸ばす）
const SPARK_W = 600;
const SPARK_H = 100;
const SPARK_PAD = 6;

// マルチバリュー展開の安全上限
const MAX_MV_EXPAND = 10000;

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

// columnSelector は文字列(DOS)、配列、生フィールド名のいずれでも届きうる。
// 文字列/配列はそのまま resolveFieldIndex に渡すため、素通しで受ける。
function pickFieldSpec(raw, key) {
    const v = raw?.[key];
    if (typeof v === 'string' || Array.isArray(v)) return v;
    return '';
}

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};

    const colors = [];
    for (let i = 0; i < DEFAULT_COLORS.length; i += 1) {
        const c = pickColor(o, `color${i + 1}`, null);
        colors.push(c || DEFAULT_COLORS[i]);
    }

    return {
        colors,
        // フィールド選択（'' = 自動判定）
        timeField: pickFieldSpec(o, 'timeField'),
        categoryField: pickFieldSpec(o, 'categoryField'),
        valueField: pickFieldSpec(o, 'valueField'),

        totalColor: pickColor(o, 'totalColor', DEFAULTS.totalColor),
        sparkColor: pickColor(o, 'sparkColor', DEFAULTS.sparkColor),
        thickness: clampNumber(o.thickness, 8, 60, DEFAULTS.thickness),
        gap: clampNumber(o.gap, 0, 16, DEFAULTS.gap),
        maxSegments: clampNumber(o.maxSegments, 2, 8, DEFAULTS.maxSegments),
        rounded: pickBool(o, 'rounded', DEFAULTS.rounded),
        glow: pickBool(o, 'glow', DEFAULTS.glow),
        glowStrength: clampNumber(o.glowStrength, 0, 20, DEFAULTS.glowStrength),
        centerPercent: pickBool(o, 'centerPercent', DEFAULTS.centerPercent),
        showLegend: pickBool(o, 'showLegend', DEFAULTS.showLegend),
        showPercent: pickBool(o, 'showPercent', DEFAULTS.showPercent),
        showTotalRow: pickBool(o, 'showTotalRow', DEFAULTS.showTotalRow),
        showSparkline: pickBool(o, 'showSparkline', DEFAULTS.showSparkline),
        sparkHeight: clampNumber(o.sparkHeight, 40, 300, DEFAULTS.sparkHeight),
        sparkFill: pickBool(o, 'sparkFill', DEFAULTS.sparkFill),
        autoFit: pickBool(o, 'autoFit', DEFAULTS.autoFit),
        debug: pickBool(o, 'debug', DEFAULTS.debug),
        valueFormat: VALUE_FORMAT,
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

function toNumber(value) {
    if (value === null || value === undefined) return NaN;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : NaN;
}

// ---------------------------------------------------------------------------
// マルチバリューセルの救済（chord-flow v0.2 のパターン）
// stats の values() などで mv が1行のセルに配列（環境により改行区切り文字列）で
// 届くと、String(配列)="A,B" がカテゴリ名に化け、数値は "5200"+"3100"→桁連結して
// 5.2e30 の怪物になる。全カラムのトークン数が一致する行だけ平行展開して復元し、
// 不一致行は null 行に置換して確実に落とす。
// ---------------------------------------------------------------------------
function cellTokens(c) {
    if (Array.isArray(c)) return c;
    if (typeof c === 'string' && c.includes('\n')) return c.split('\n');
    return [c];
}

function expandMultivalueRows(rows) {
    let touched = false;
    const out = [];
    for (const row of rows) {
        if (!Array.isArray(row)) {
            out.push(row);
            continue;
        }
        const tokens = row.map(cellTokens);
        const L = tokens.reduce((m, t) => Math.max(m, t.length), 0);
        if (L <= 1) {
            out.push(tokens.map((t) => t[0]));
            continue;
        }
        touched = true;
        if (tokens.every((t) => t.length === L)) {
            const n = Math.min(L, MAX_MV_EXPAND);
            for (let k = 0; k < n; k += 1) out.push(tokens.map((t) => t[k]));
        } else {
            out.push(new Array(row.length).fill(null));
        }
    }
    return { rows: out, touched };
}

// ---------------------------------------------------------------------------
// フィールド選択の解決（chord-flow v0.4 のパターン）
// editor.columnSelector は選択結果を DOS 文字列（"> primary | seriesByName('x')"）で
// 書き、カスタム viz には未解決のまま届く。名前/インデックス/生フィールド名/
// ホスト解決済み配列のいずれでも解決できるようにする。'' はフォールバック列。
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

// timechart 形式か（時刻列を持つか）を判定し、モデルを組み立てる。
//   timechart モード: 時刻列 = timeField 指定 or _time。series = それ以外の
//     非アンダースコア列。最新（最後の、少なくとも1系列が数値の）行をドーナツ値に、
//     各行の合計をトレンド系列にする。
//   stats モード: categoryField/valueField 指定 or 第1列=カテゴリ, 第2列=数値。
//     トレンドなし。
function buildModel(fieldNames, rawRows, opts) {
    const { rows: rows, touched: mvTouched } = expandMultivalueRows(rawRows);
    const meta = { mvTouched };

    // 時刻列の解決: 明示指定 > _time 列 > なし
    let timeIdx = -1;
    if (opts.timeField) {
        timeIdx = resolveFieldIndex(opts.timeField, fieldNames, rows, -1);
    }
    if (timeIdx < 0) {
        timeIdx = fieldNames.findIndex((f) => f === '_time');
    }

    if (timeIdx >= 0) {
        const seriesIdx = fieldNames
            .map((name, i) => ({ name, i }))
            .filter(({ name, i }) => i !== timeIdx && !String(name).startsWith('_'));

        const parsed = rows.map((row) =>
            seriesIdx.map(({ i }) => {
                const n = toNumber(Array.isArray(row) ? row[i] : undefined);
                return Number.isFinite(n) && n >= 0 ? n : NaN;
            })
        );
        const trend = parsed.map((vals) =>
            vals.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0)
        );
        const trendTimes = rows.map((row) =>
            Array.isArray(row) && row[timeIdx] != null ? String(row[timeIdx]) : ''
        );

        let latest = -1;
        for (let r = parsed.length - 1; r >= 0; r -= 1) {
            if (parsed[r].some((v) => Number.isFinite(v))) {
                latest = r;
                break;
            }
        }

        const items =
            latest >= 0
                ? seriesIdx.map(({ name }, s) => ({
                      label: String(name),
                      value: Number.isFinite(parsed[latest][s]) ? parsed[latest][s] : 0,
                  }))
                : [];

        return {
            mode: 'timechart',
            items: items.filter((it) => it.label !== ''),
            trend,
            trendTimes,
            meta: { ...meta, timeField: fieldNames[timeIdx] || '_time' },
        };
    }

    // stats モード。カテゴリ/値の列は指定 or 第1列/第2列。
    const catIdx = resolveFieldIndex(opts.categoryField, fieldNames, rows, 0);
    const valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, 1);

    const items = rows
        .map((row) => {
            const cat = Array.isArray(row) ? row[catIdx] : undefined;
            const val = Array.isArray(row) ? row[valIdx] : undefined;
            return {
                label: cat !== null && cat !== undefined ? String(cat) : '',
                value: toNumber(val),
            };
        })
        .filter((it) => it.label !== '' && Number.isFinite(it.value) && it.value >= 0);

    return {
        mode: 'stats',
        items,
        trend: [],
        trendTimes: [],
        meta: { ...meta, categoryField: fieldNames[catIdx], valueField: fieldNames[valIdx] },
    };
}

// 系列数が maxSegments を超える場合、値の小さいものを Others に集約する。
// timechart モードでは SPL の列順（= 色の割り当て順）を保つ。
function aggregateItems(items, opts, othersColor, preserveOrder) {
    const limit = Math.max(2, Math.floor(opts.maxSegments));
    const ordered = preserveOrder ? [...items] : [...items].sort((a, b) => b.value - a.value);

    if (ordered.length <= limit) {
        return ordered.map((it, i) => ({
            ...it,
            color: opts.colors[i % opts.colors.length],
            isOthers: false,
        }));
    }

    const byValueAsc = [...ordered].sort((a, b) => a.value - b.value);
    const toGroup = new Set(byValueAsc.slice(0, ordered.length - (limit - 1)));

    const head = [];
    let othersValue = 0;
    let othersCount = 0;
    ordered.forEach((it) => {
        if (toGroup.has(it)) {
            othersValue += it.value;
            othersCount += 1;
        } else {
            head.push({
                ...it,
                color: opts.colors[head.length % opts.colors.length],
                isOthers: false,
            });
        }
    });
    if (othersCount > 0) {
        head.push({
            label: `${OTHERS_LABEL} (${othersCount})`,
            value: othersValue,
            color: othersColor,
            isOthers: true,
        });
    }
    return head;
}

function formatValue(value, fmt) {
    if (!Number.isFinite(value)) return '0';
    // 極端に大きい値はカンマ30桁でレイアウトが崩壊するため指数表記に退避
    if (Math.abs(value) >= 1e15) return value.toExponential(2);
    if (fmt === 'plain') return String(value);
    if (fmt === 'compact') {
        const abs = Math.abs(value);
        if (abs >= 1e9) return `${trimZero(value / 1e9)}B`;
        if (abs >= 1e6) return `${trimZero(value / 1e6)}M`;
        if (abs >= 1e3) return `${trimZero(value / 1e3)}K`;
        return String(value);
    }
    return value.toLocaleString('en-US'); // comma
}

function trimZero(n) {
    return Number(n.toFixed(1)).toString();
}

function formatPercent(share) {
    const pct = share * 100;
    if (pct > 0 && pct < 0.1) return '<0.1%';
    return `${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// セグメント計算（stroke-dasharray 方式・donut-graph と同一ロジック）
// ---------------------------------------------------------------------------
function buildSegments(chartItems, total, circumference, opts) {
    if (total <= 0) return [];

    const nonZero = chartItems.filter((it) => it.value > 0).length;
    if (nonZero === 0) return [];

    const capOverhang = opts.rounded ? opts.thickness : 0;
    const roundableMinArc = opts.thickness;
    const effectiveGap = opts.gap + capOverhang * 0.5;
    const totalGap = nonZero > 1 ? effectiveGap * nonZero : 0;
    const usable = Math.max(circumference - totalGap, 0);
    const minArc = Math.max(MIN_ARC_ABS, capOverhang * 0.15);

    let offset = 0;
    const segments = [];
    chartItems.forEach((item, index) => {
        if (item.value <= 0) return;
        const share = item.value / total;
        let arcLen = share * usable;
        if (arcLen < minArc) arcLen = minArc;
        const cap = opts.rounded && arcLen >= roundableMinArc ? 'round' : 'butt';

        segments.push({ ...item, index, share, arcLen, offset, cap });
        offset += arcLen + (nonZero > 1 ? effectiveGap : 0);
    });
    return segments;
}

// ---------------------------------------------------------------------------
// コンテナ実寸の計測（オートフィット用）
// ---------------------------------------------------------------------------
function useContainerSize() {
    const ref = useRef(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 0;
        const h = el.clientHeight || 0;
        setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    }, []);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        measure(el);
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => measure(el));
        ro.observe(el);
        return () => ro.disconnect();
    }, [measure]);

    return [ref, size];
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
// ドーナツ本体（SVG）
// 中央表示: centerPercent ON → 最大セグメントの割合% + ラベル
//           centerPercent OFF → 合計値 + "Total"
// ---------------------------------------------------------------------------
function DonutRing({ segments, total, palette, opts, mounted, uid, activeIndex, onHover }) {
    const circumference = 2 * Math.PI * RADIUS;
    const stroke = opts.thickness;
    const dash = (len) => `${mounted ? len : 0} ${circumference}`;

    const topSegment = segments.reduce(
        (best, s) => (best === null || s.share > best.share ? s : best),
        null
    );
    const active = activeIndex !== null ? segments.find((s) => s.index === activeIndex) : null;

    let bigText;
    let subText;
    let bigFill;
    if (active) {
        bigText = opts.centerPercent
            ? formatPercent(active.share)
            : formatValue(active.value, opts.valueFormat);
        subText = active.label;
        bigFill = active.color;
    } else if (opts.centerPercent && topSegment) {
        bigText = formatPercent(topSegment.share);
        subText = topSegment.label;
        bigFill = palette.centerValue;
    } else {
        bigText = formatValue(total, opts.valueFormat);
        subText = CENTER_TOTAL_LABEL;
        bigFill = palette.centerValue;
    }
    const bigSize = bigText.length > 8 ? 30 : bigText.length > 6 ? 36 : 42;

    return (
        <svg
            viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
            width="100%"
            height="100%"
            style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', overflow: 'visible' }}
            role="img"
        >
            <defs>
                {opts.glow && (
                    <filter id={`neon-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation={opts.glowStrength} />
                    </filter>
                )}
            </defs>

            <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
                {/* トラック（背景リング） */}
                <circle
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    fill="none"
                    stroke={palette.track}
                    strokeWidth={stroke}
                />

                {/* 発光レイヤー */}
                {opts.glow && opts.glowStrength > 0 && (
                    <g filter={`url(#neon-${uid})`} style={{ pointerEvents: 'none' }}>
                        {segments.map((seg) => {
                            const isActive = activeIndex === seg.index;
                            const dimmed = activeIndex !== null && !isActive;
                            return (
                                <circle
                                    key={`glow-${seg.index}`}
                                    cx={CENTER}
                                    cy={CENTER}
                                    r={RADIUS}
                                    fill="none"
                                    stroke={seg.color}
                                    strokeWidth={stroke}
                                    strokeLinecap={seg.cap}
                                    strokeDasharray={dash(seg.arcLen)}
                                    strokeDashoffset={-seg.offset}
                                    style={{
                                        opacity: dimmed ? 0.12 : isActive ? 0.95 : 0.7,
                                        transition: `stroke-dasharray 950ms cubic-bezier(0.22, 1, 0.36, 1) ${seg.index * 70}ms, opacity 220ms ease`,
                                    }}
                                />
                            );
                        })}
                    </g>
                )}

                {/* 本体レイヤー */}
                <g>
                    {segments.map((seg) => {
                        const isActive = activeIndex === seg.index;
                        const dimmed = activeIndex !== null && !isActive;
                        return (
                            <circle
                                key={`seg-${seg.index}`}
                                cx={CENTER}
                                cy={CENTER}
                                r={RADIUS}
                                fill="none"
                                stroke={seg.color}
                                strokeWidth={stroke}
                                strokeLinecap={seg.cap}
                                strokeDasharray={dash(seg.arcLen)}
                                strokeDashoffset={-seg.offset}
                                onMouseEnter={() => onHover(seg.index)}
                                onMouseLeave={() => onHover(null)}
                                style={{
                                    opacity: dimmed ? 0.32 : 1,
                                    cursor: 'default',
                                    transition: `stroke-dasharray 950ms cubic-bezier(0.22, 1, 0.36, 1) ${seg.index * 70}ms, opacity 200ms ease`,
                                }}
                            >
                                <title>{`${seg.label}: ${formatValue(seg.value, opts.valueFormat)} (${formatPercent(seg.share)})`}</title>
                            </circle>
                        );
                    })}
                </g>
            </g>

            {/* 中央表示（回転の影響を受けないよう g の外側） */}
            <text
                x={CENTER}
                y={CENTER - 6}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{
                    fill: bigFill,
                    fontSize: bigSize,
                    fontWeight: 800,
                    letterSpacing: '-0.01em',
                    fontVariantNumeric: 'tabular-nums',
                    opacity: mounted ? 1 : 0,
                    transition: 'opacity 500ms ease 450ms, fill 200ms ease',
                }}
            >
                {bigText}
            </text>
            {subText ? (
                <text
                    x={CENTER}
                    y={CENTER + 24}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    style={{
                        fill: palette.centerLabel,
                        fontSize: 15,
                        fontWeight: 600,
                        letterSpacing: '0.02em',
                        opacity: mounted ? 1 : 0,
                        transition: 'opacity 500ms ease 550ms',
                    }}
                >
                    {subText.length > 18 ? `${subText.slice(0, 17)}…` : subText}
                </text>
            ) : null}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// 凡例（画像スタイル: ドット + ラベル + 右寄せ値、行間に区切り線、Total 行つき）
// fontScale でコンテナ実寸に応じてフォント・パディングを調整する。
// ---------------------------------------------------------------------------
function Legend({ segments, total, palette, opts, activeIndex, onHover, fontScale }) {
    const rows = segments.map((seg) => ({
        key: `seg-${seg.index}`,
        index: seg.index,
        label: seg.label,
        value: seg.value,
        share: seg.share,
        color: seg.color,
        isTotal: false,
    }));
    if (opts.showTotalRow) {
        rows.push({
            key: 'total',
            index: null,
            label: TOTAL_ROW_LABEL,
            value: total,
            share: 1,
            color: opts.totalColor,
            isTotal: true,
        });
    }

    // 小パネルでは下限を大きく下げてフォント・余白を実際に縮める（見切れ回避）。
    const fontSize = Math.round(clampNumber(16 * fontScale, 8, 20, 16));
    const rowPadV = Math.round(clampNumber(13 * fontScale, 2, 16, 13));
    const dotSize = Math.round(clampNumber(12 * fontScale, 6, 15, 12));
    // 値列の最小幅も fontScale に追従（狭いセルで値が押し出されないように）。
    const valueMin = Math.round(clampNumber(50 * fontScale, 28, 70, 50));
    const colGap = Math.round(clampNumber(14 * fontScale, 6, 18, 14));

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                minWidth: 0,
                width: '100%',
                // 行が縦に収まらないときはクリップせずスクロールさせる。
                maxHeight: '100%',
                overflowY: 'auto',
                overflowX: 'hidden',
            }}
        >
            {rows.map((row, i) => {
                const isActive = !row.isTotal && activeIndex === row.index;
                const dimmed = !row.isTotal && activeIndex !== null && !isActive;
                return (
                    <div
                        key={row.key}
                        onMouseEnter={row.isTotal ? undefined : () => onHover(row.index)}
                        onMouseLeave={row.isTotal ? undefined : () => onHover(null)}
                        style={{
                            display: 'grid',
                            gridTemplateColumns: `auto minmax(${valueMin}px, 1fr) auto`,
                            alignItems: 'center',
                            columnGap: colGap,
                            padding: `${rowPadV}px 10px`,
                            borderTop: i > 0 ? `1px solid ${palette.divider}` : 'none',
                            borderRadius: 2,
                            background: isActive ? palette.rowHover : 'transparent',
                            opacity: dimmed ? 0.5 : 1,
                            transition: 'background 160ms ease, opacity 160ms ease',
                        }}
                    >
                        <span
                            style={{
                                width: dotSize,
                                height: dotSize,
                                borderRadius: '50%',
                                background: row.color,
                                boxShadow: opts.glow ? `0 0 8px ${row.color}aa` : 'none',
                                flexShrink: 0,
                            }}
                        />
                        <span
                            title={row.label}
                            style={{
                                color: palette.legendLabel,
                                fontSize,
                                fontWeight: row.isTotal ? 600 : 500,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {row.label}
                        </span>
                        <span
                            style={{
                                fontSize,
                                whiteSpace: 'nowrap',
                                textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            <span style={{ color: palette.legendValue, fontWeight: 700 }}>
                                {formatValue(row.value, opts.valueFormat)}
                            </span>
                            {opts.showPercent && !row.isTotal ? (
                                <span style={{ color: palette.legendPercent, marginLeft: 6 }}>
                                    {formatPercent(row.share)}
                                </span>
                            ) : null}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// トレンドチャート（合計値の推移。エリア + ライン、軸なしのスパークライン風）
// preserveAspectRatio="none" で横に引き伸ばし、ラインは
// vector-effect="non-scaling-stroke" で太さを一定に保つ。
// ---------------------------------------------------------------------------
function TrendChart({ trend, trendTimes, palette, opts, mounted, uid, height }) {
    const points = useMemo(() => {
        const vals = trend.filter((v) => Number.isFinite(v));
        if (vals.length < 2) return null;

        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const span = max - min || 1;
        const usableH = SPARK_H - SPARK_PAD * 2;

        const lo = min - span * 0.15;
        const hi = max + span * 0.15;
        const range = hi - lo || 1;

        const n = trend.length;
        return trend.map((v, i) => {
            const x = n > 1 ? (i / (n - 1)) * SPARK_W : 0;
            const val = Number.isFinite(v) ? v : lo;
            const y = SPARK_PAD + usableH * (1 - (val - lo) / range);
            return [x, y];
        });
    }, [trend]);

    if (!points) return null;

    const linePath = points
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
        .join(' ');
    const areaPath = `${linePath} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`;

    const vals = trend.filter((v) => Number.isFinite(v));
    const summary = `min ${formatValue(Math.min(...vals), opts.valueFormat)} / max ${formatValue(
        Math.max(...vals),
        opts.valueFormat
    )} / latest ${formatValue(vals[vals.length - 1], opts.valueFormat)}`;
    const timeRange =
        trendTimes.length > 1 && trendTimes[0] && trendTimes[trendTimes.length - 1]
            ? `${trendTimes[0]} – ${trendTimes[trendTimes.length - 1]}`
            : '';

    return (
        <div
            style={{
                width: '100%',
                // 小パネルでは親から縮めた高さが渡る（未指定なら従来の sparkHeight）。
                height: height != null ? height : opts.sparkHeight,
                flexShrink: 0,
                overflow: 'hidden',
                opacity: mounted ? 1 : 0,
                transition: 'opacity 600ms ease 300ms',
            }}
        >
            <svg
                viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                width="100%"
                height="100%"
                preserveAspectRatio="none"
                role="img"
                style={{ display: 'block' }}
            >
                <title>{timeRange ? `${timeRange} — ${summary}` : summary}</title>
                <defs>
                    <linearGradient id={`sparkfill-${uid}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={opts.sparkColor} stopOpacity="0.45" />
                        <stop offset="100%" stopColor={opts.sparkColor} stopOpacity="0.03" />
                    </linearGradient>
                </defs>

                {/* ベースライン */}
                <line
                    x1="0"
                    y1={SPARK_H - 1}
                    x2={SPARK_W}
                    y2={SPARK_H - 1}
                    stroke={palette.sparkBaseline}
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                />

                {opts.sparkFill && <path d={areaPath} fill={`url(#sparkfill-${uid})`} />}

                {/* グロー（ラインの下敷き） */}
                {opts.glow && opts.glowStrength > 0 && (
                    <path
                        d={linePath}
                        fill="none"
                        stroke={opts.sparkColor}
                        strokeWidth="4"
                        strokeOpacity="0.35"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                    />
                )}

                <path
                    d={linePath}
                    fill="none"
                    stroke={opts.sparkColor}
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
        </div>
    );
}

// ---------------------------------------------------------------------------
// debug オーバーレイ（options が反映されない事故の切り分け用）
// ---------------------------------------------------------------------------
function DebugOverlay({ opts, model, rawOptions, palette }) {
    const dump = {
        mode: model.mode,
        meta: model.meta,
        itemCount: model.items.length,
        trendLen: model.trend.length,
        normalized: opts,
        rawOptions,
    };
    return (
        <pre
            style={{
                position: 'absolute',
                top: 8,
                right: 8,
                maxWidth: '58%',
                maxHeight: '92%',
                overflow: 'auto',
                margin: 0,
                padding: '8px 10px',
                fontSize: 10,
                lineHeight: 1.4,
                background: palette.debugBg,
                color: palette.debugText,
                border: `1px solid ${palette.divider}`,
                borderRadius: 6,
                zIndex: 5,
                pointerEvents: 'auto',
            }}
        >
            {JSON.stringify(dump, null, 2)}
        </pre>
    );
}

// ---------------------------------------------------------------------------
// 全体レイアウト（上段: ドーナツ + 凡例 / 下段: トレンドチャート）
// ---------------------------------------------------------------------------
function DonutTimechart({ model, mode, opts, rawOptions }) {
    const palette = PALETTES[mode] || PALETTES.dark;
    const othersColor = OTHERS_COLOR[mode] || OTHERS_COLOR.dark;
    const circumference = 2 * Math.PI * RADIUS;

    const [containerRef, size] = useContainerSize();

    const total = useMemo(
        () => model.items.reduce((sum, it) => sum + it.value, 0),
        [model.items]
    );
    const chartItems = useMemo(
        () => aggregateItems(model.items, opts, othersColor, model.mode === 'timechart'),
        [model.items, model.mode, opts, othersColor]
    );
    const segments = useMemo(
        () => buildSegments(chartItems, total, circumference, opts),
        [chartItems, total, circumference, opts]
    );

    const uid = useMemo(() => Math.floor(Math.random() * 1e9).toString(36), []);

    const [activeIndex, setActiveIndex] = useState(null);

    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    // ---- コンテナ実寸に応じたレイアウト判定（小サイズで見切れないように） ----
    // まだ計測前（W===0）は従来の広めの見た目で暫定描画する。
    const W = size.width;
    const H = size.height;
    const measured = W > 0 && H > 0;

    // パディングは小パネルで詰める（大パネルでは従来の 18/22 を維持）。
    const padV = measured ? Math.max(6, Math.min(18, Math.round(H * 0.06))) : 18;
    const padH = measured ? Math.max(8, Math.min(22, Math.round(W * 0.05))) : 22;

    // オートフィット: コンテナ幅を基準に凡例フォント/ドーナツ枠をスケール。
    // 基準幅 640px（config の initialWidth）を 1.0 とし、小パネルでは 0.5 まで縮む。
    const fontScale = opts.autoFit && W > 0 ? clampNumber(W / 640, 0.5, 1.35, 1) : 1;
    // ドーナツ枠は高さと幅の小さい方に追従（縦長パネルで巨大化しないよう上限）。
    // 下限は 90 まで下げ、小パネルでもドーナツが枠に収まるようにする。
    const donutBasis = opts.autoFit
        ? Math.round(clampNumber(Math.min(W * 0.42, H * 0.9), 90, 360, 220))
        : 220;

    if (segments.length === 0) {
        return (
            <div ref={containerRef} className="viz-container" style={{ position: 'relative' }}>
                <NoDataState />
                {opts.debug && (
                    <DebugOverlay opts={opts} model={model} rawOptions={rawOptions} palette={palette} />
                )}
            </div>
        );
    }

    const trendAvailable =
        opts.showSparkline && model.mode === 'timechart' && model.trend.length >= 2;

    // ---- レイアウト決定（donut-graph の canSideBySide/legendVisible パターン） ----
    // 幅の使える領域からレイアウトを段階的に決める:
    //   側並び（ドーナツ左・凡例右）… 十分広い
    //   縦積み（ドーナツ上・凡例下）… 中くらいの幅
    //   ドーナツのみ（凡例非表示）… 縦にも収める余地が無い
    const availW = measured ? W - padH * 2 : 9999;
    const availH = measured ? H - padV * 2 : 9999;

    // ドーナツ最小 ~120px + 凡例最小 ~170px + gap を確保できれば側並び。
    const canSideBySide = !measured || availW >= 300;

    // トレンドの高さを縦スペースに応じて決める。狭い縦では比例縮小し、
    // 余地が無ければ非表示にして絶対に下へあふれさせない。
    let trendHeight = 0;
    let showTrend = false;
    if (trendAvailable) {
        if (!measured) {
            trendHeight = opts.sparkHeight;
            showTrend = true;
        } else {
            // パネル高さの ~28% を上限に、sparkHeight を超えない範囲で確保。
            const desired = Math.min(opts.sparkHeight, Math.round(availH * 0.28));
            // 40px 未満しか取れない＝ドーナツを潰すのでトレンドは諦める。
            if (desired >= 40 && availH - desired >= 120) {
                trendHeight = desired;
                showTrend = true;
            }
        }
    }

    // ドーナツ＋凡例に使える縦領域（トレンド分を差し引く）。
    const topAvailH = measured ? availH - (showTrend ? trendHeight + 14 : 0) : 9999;

    // 凡例を出すか。側並びなら幅が足りている前提で常時、縦積みなら
    // ドーナツを確保した上で凡例に割ける縦領域があるときだけ。
    const legendVisible =
        opts.showLegend &&
        (!measured || (canSideBySide ? topAvailH >= 90 : topAvailH >= 210));

    const gap = measured ? Math.max(10, Math.min(28, Math.round(W * 0.03))) : 28;

    return (
        <div
            ref={containerRef}
            className="viz-container"
            style={{
                position: 'relative',
                padding: `${padV}px ${padH}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: showTrend ? 14 : 0,
                overflow: 'hidden',
            }}
        >
            {/* 上段: ドーナツ +（余地があれば）凡例 */}
            <div
                style={{
                    display: 'flex',
                    flexDirection: canSideBySide ? 'row' : 'column',
                    flexWrap: 'nowrap',
                    alignItems: 'center',
                    gap,
                    flex: '1 1 auto',
                    minHeight: 0,
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        flex: legendVisible
                            ? canSideBySide
                                ? `1 1 ${donutBasis}px`
                                : '1 1 auto'
                            : '1 1 100%',
                        width: canSideBySide ? 'auto' : '100%',
                        minWidth: 0,
                        maxWidth: canSideBySide && legendVisible ? donutBasis + 60 : '100%',
                        height: canSideBySide ? '100%' : 'auto',
                        minHeight: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                    }}
                >
                    <DonutRing
                        segments={segments}
                        total={total}
                        palette={palette}
                        opts={opts}
                        mounted={mounted}
                        uid={uid}
                        activeIndex={activeIndex}
                        onHover={setActiveIndex}
                    />
                </div>

                {legendVisible && (
                    <div
                        style={{
                            flex: canSideBySide ? '1 1 55%' : '0 1 auto',
                            minWidth: 0,
                            width: canSideBySide ? 'auto' : '100%',
                            maxHeight: '100%',
                            minHeight: 0,
                            display: 'flex',
                            overflow: 'hidden',
                        }}
                    >
                        <Legend
                            segments={segments}
                            total={total}
                            palette={palette}
                            opts={opts}
                            activeIndex={activeIndex}
                            onHover={setActiveIndex}
                            fontScale={fontScale}
                        />
                    </div>
                )}
            </div>

            {/* 下段: トレンドチャート（timechart 形式・縦に余地があるときのみ） */}
            {showTrend && (
                <TrendChart
                    trend={model.trend}
                    trendTimes={model.trendTimes}
                    palette={palette}
                    opts={opts}
                    mounted={mounted}
                    uid={uid}
                    height={trendHeight}
                />
            )}

            {opts.debug && (
                <DebugOverlay opts={opts} model={model} rawOptions={rawOptions} palette={palette} />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース + オプション接続
// ---------------------------------------------------------------------------
function DonutTimechartVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();

    const data = dataSources?.primary?.data || null;
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(
        () => (data?.fields || []).map((f) => (f && typeof f === 'object' ? f.name : f) || ''),
        [data]
    );
    const opts = useMemo(() => normalizeOptions(options), [options]);
    const model = useMemo(() => buildModel(fieldNames, rows, opts), [fieldNames, rows, opts]);

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0 || model.items.length === 0) return <NoDataState />;

    return <DonutTimechart model={model} mode={mode} opts={opts} rawOptions={options} />;
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
            <DonutTimechartVisualization mode={mode} />
        </SplunkThemeProvider>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
    <VisualizationExtensionProvider>
        <App />
    </VisualizationExtensionProvider>
);
