import {
    VisualizationExtensionProvider,
    useDataSources,
    useDimensions,
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
// 編集画面のサイドパネル（editorConfig）で設定した値を useOptions() で受け取る。
// 未設定・型不一致でも、ここで安全側に補正する。
// ---------------------------------------------------------------------------
const DEFAULT_COLORS = [
    '#5b8def', // 青（INFO 相当・最大セグメント想定）
    '#2dd4bf', // ティール
    '#f5c518', // 黄
    '#f0912e', // オレンジ
    '#ef4d6a', // レッド/ピンク
    '#a78bfa', // 紫
    '#38bdf8', // ライトブルー
    '#84cc16', // ライム
];

// Others（集約先）の色（モード別）
const OTHERS_COLOR = { dark: '#5b6070', light: '#c2c7d6' };

const DEFAULTS = {
    thickness: 24,
    gap: 3,
    maxSegments: 6, // 上位N件だけ色分けし、残りを Others に集約
    showLegend: true,
    showTotal: true,
    showPercent: true, // 凡例にパーセントを表示するか
    showBar: true, // 凡例に割合バーを表示するか
    rounded: false, // 弧端は角（butt）。極小スライスの被りを避けクリーンに見せる
    glow: true, // ネオン風の発光エフェクト（既定ON）
    glowStrength: 6, // グローの広がり（px相当）
    valueFormat: 'comma', // 'comma' | 'compact' | 'plain'
};

// フィールド選択（editor.columnSelector）の既定。空欄=既定列にフォールバック。
const DEFAULT_CATEGORY_FIELD = '';
const DEFAULT_VALUE_FIELD = '';

// editorConfig では editor.text が未サポートのため、これらは固定値として扱う。
const CENTER_LABEL = 'Total';
const OTHERS_LABEL = 'Others';

// ---------------------------------------------------------------------------
// カラーパレット（ライト / ダーク両モード対応、セグメント色はオプション優先）
// ---------------------------------------------------------------------------
const PALETTES = {
    dark: {
        title: '#f3f4fb',
        centerValue: '#ffffff',
        centerLabel: '#8a8ea6',
        legendLabel: '#e4e6f1',
        legendValue: '#ffffff',
        legendPercent: '#9aa0ba',
        track: 'rgba(255, 255, 255, 0.05)',
        barTrack: 'rgba(255, 255, 255, 0.07)',
        rowHover: 'rgba(255, 255, 255, 0.04)',
    },
    light: {
        title: '#1b2340',
        centerValue: '#141a30',
        centerLabel: '#6b7186',
        legendLabel: '#2c3350',
        legendValue: '#141a30',
        legendPercent: '#767c93',
        track: 'rgba(15, 20, 40, 0.06)',
        barTrack: 'rgba(15, 20, 40, 0.08)',
        rowHover: 'rgba(15, 20, 40, 0.035)',
    },
};

// ドーナツの寸法（SVG viewBox 座標系）
const VIEWBOX = 240;
const CENTER = VIEWBOX / 2;
const RADIUS = 94;
// tiny スライスの最小弧長（円周ピクセル）。丸端の張り出し（strokeWidth/2）で
// 隣接スライスに食い込むのを防ぐため、描画時に太さ・gap から動的に算出する。
const MIN_ARC_ABS = 1.5;

// ---------------------------------------------------------------------------
// オプション正規化：型不一致・範囲外・欠損をすべて安全側へ補正
// editorConfig は color1..color6 のようにフラットなキーで色を渡すため、
// それらを配列に組み直す。指定が無いセグメントは既定色にフォールバック。
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

const VALID_VALUE_FORMATS = ['comma', 'compact', 'plain'];

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};

    // color1..colorN（editorConfig 側）を優先。無ければ配列 colors、さらに無ければ既定色。
    const colors = [];
    for (let i = 0; i < DEFAULT_COLORS.length; i += 1) {
        const flatKey = `color${i + 1}`;
        let c = pickColor(o, flatKey, null);
        // 後方互換：配列 colors[] が渡されている場合も拾う
        if (!c && Array.isArray(o.colors) && isHexColor(o.colors[i])) {
            c = o.colors[i].trim();
        }
        colors.push(c || DEFAULT_COLORS[i]);
    }

    const vf = typeof o.valueFormat === 'string' && VALID_VALUE_FORMATS.includes(o.valueFormat.trim())
        ? o.valueFormat.trim()
        : DEFAULTS.valueFormat;

    return {
        colors,
        // フィールド選択（DOS 文字列/生名/配列いずれも resolveFieldIndex で解決）
        categoryField: o.categoryField ?? DEFAULT_CATEGORY_FIELD,
        valueField: o.valueField ?? DEFAULT_VALUE_FIELD,
        thickness: clampNumber(o.thickness, 8, 60, DEFAULTS.thickness),
        gap: clampNumber(o.gap, 0, 16, DEFAULTS.gap),
        maxSegments: clampNumber(o.maxSegments, 2, 12, DEFAULTS.maxSegments),
        showLegend: typeof o.showLegend === 'boolean' ? o.showLegend : DEFAULTS.showLegend,
        showTotal: typeof o.showTotal === 'boolean' ? o.showTotal : DEFAULTS.showTotal,
        showPercent: typeof o.showPercent === 'boolean' ? o.showPercent : DEFAULTS.showPercent,
        showBar: typeof o.showBar === 'boolean' ? o.showBar : DEFAULTS.showBar,
        rounded: typeof o.rounded === 'boolean' ? o.rounded : DEFAULTS.rounded,
        glow: typeof o.glow === 'boolean' ? o.glow : DEFAULTS.glow,
        glowStrength: clampNumber(o.glowStrength, 0, 20, DEFAULTS.glowStrength),
        totalLabel: CENTER_LABEL,
        valueFormat: vf,
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
// マルチバリューセルの救済（chord-flow v0.2 のパターン）
// stats values() や mvexpand し忘れで、1行のセルに配列（環境により改行区切り文字列）が
// 届くことがある。放置すると String(配列)="A,B,..." がラベルに化け、数値は
// カンマ除去で桁連結（"52","31" → 5231）した怪物になる。全カラムのトークン数が
// 一致する行だけ平行展開して復元し、不一致行はそのまま（後段で数値ガードが落とす）。
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
        // 全カラムが L と 1（スカラー）のいずれかのときだけ平行展開する。
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
    // 配列/改行 mv が数値列に残っていたら先頭要素だけ採用（桁連結を防ぐ）
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
// editor.columnSelector は DOS 文字列（"> primary | seriesByName('x')"）で届く。
// カスタム viz には未解決のまま来るので、名前/インデックス/配列を自前で解決する。
// ---------------------------------------------------------------------------
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

// 選択されたカテゴリ列・値列で集計する。
// 値列が未指定/カテゴリ列と同じになったときは、最初の数値列を自動採用する。
function buildChartData(rows, fieldNames, opts) {
    const catIdx = resolveFieldIndex(opts.categoryField, fieldNames, rows, 0);
    let valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, 1);

    // 値列がカテゴリ列と重複、または解決に失敗して範囲外なら数値列を探す
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

// 値の大きい順に並べ、上位 maxSegments-1 件はそのまま、残りを Others に集約する。
// これで tiny スライスが上部にゴチャつくのを防ぎ、リングも凡例もクリーンになる。
function aggregateItems(items, total, opts, othersColor) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const limit = Math.max(1, Math.floor(opts.maxSegments));

    // 集約が不要（件数が上限以下）ならそのまま色付けして返す
    if (sorted.length <= limit) {
        return sorted.map((it, i) => ({
            ...it,
            color: opts.colors[i % opts.colors.length],
            isOthers: false,
        }));
    }

    const head = sorted.slice(0, limit - 1).map((it, i) => ({
        ...it,
        color: opts.colors[i % opts.colors.length],
        isOthers: false,
    }));
    const tail = sorted.slice(limit - 1);
    const othersValue = tail.reduce((sum, it) => sum + it.value, 0);

    if (othersValue > 0) {
        head.push({
            label: `${OTHERS_LABEL} (${tail.length})`,
            value: othersValue,
            color: othersColor,
            isOthers: true,
        });
    }
    return head;
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

function fieldToTitle(fieldName) {
    if (!fieldName) return '';
    return String(fieldName).replace(/[_-]+/g, ' ').toUpperCase();
}

// ---------------------------------------------------------------------------
// セグメント計算
// 円周上に stroke-dasharray で各弧を配置。固定の隙間ピクセルを使い、
// 小さいスライスでも「浮いた点」にならず、隣接スライスとも重ならない。
// ---------------------------------------------------------------------------
function buildSegments(chartItems, total, circumference, opts) {
    if (total <= 0) return [];

    const nonZero = chartItems.filter((it) => it.value > 0).length;
    if (nonZero === 0) return [];

    // 丸端は両端に strokeWidth/2 ずつ張り出す。隣接スライスへの食い込みを防ぐため、
    // 丸端が使える最小弧長 = 太さ相当。これ未満のスライスは butt（角）で描く。
    const capOverhang = opts.rounded ? opts.thickness : 0;
    const roundableMinArc = opts.thickness; // これ以上なら丸端でも破綻しない

    // gap は「丸端の張り出し」も見込んで確保する。小スライスが多いと張り出しで
    // 隣に重なるため、gap に capOverhang を上乗せして必ず分離する。
    const effectiveGap = opts.gap + capOverhang * 0.5;
    const totalGap = nonZero > 1 ? effectiveGap * nonZero : 0;
    const usable = Math.max(circumference - totalGap, 0);

    // 極小スライスの下限。丸端の張り出しで潰れない最小値を確保しつつ、
    // 角描画なら控えめの下限に留める。
    const minArc = Math.max(MIN_ARC_ABS, capOverhang * 0.15);

    let offset = 0;
    const segments = [];
    chartItems.forEach((item, index) => {
        if (item.value <= 0) return;
        const share = item.value / total;
        let arcLen = share * usable;
        if (arcLen < minArc) arcLen = minArc;

        // 弧が丸端の直径未満なら、その弧だけ butt に落として張り出しを消す
        const cap = opts.rounded && arcLen >= roundableMinArc ? 'round' : 'butt';

        segments.push({
            ...item,
            index,
            share,
            arcLen,
            offset,
            cap,
        });
        offset += arcLen + (nonZero > 1 ? effectiveGap : 0);
    });
    return segments;
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
// stroke-dasharray + dashoffset 方式。全円を -90deg 回転して 12 時起点・時計回り。
// フラットモダン：太めのクリーンなリング＋（任意で）丸端＋控えめグロー。
// ---------------------------------------------------------------------------
function DonutRing({ segments, total, palette, opts, mounted, uid, activeIndex, onHover }) {
    const circumference = 2 * Math.PI * RADIUS;
    const stroke = opts.thickness;
    const dash = (len) => `${mounted ? len : 0} ${circumference}`;

    return (
        <svg
            viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
            width="100%"
            height="100%"
            style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', overflow: 'visible' }}
            role="img"
        >
            <defs>
                {/* ネオン発光：色付きの複製ストロークをぼかして下敷きにする */}
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

                {/* 発光レイヤー（各セグメント色でぼかし、下に敷いて光らせる） */}
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

                {/* 本体レイヤー（くっきり） */}
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

            {/* 中央のトータル表示（回転の影響を受けないよう g の外側に置く）
                ホバー中はそのセグメントの値・ラベルにスワップして情報密度を上げる */}
            {opts.showTotal &&
                (() => {
                    const active = activeIndex !== null
                        ? segments.find((s) => s.index === activeIndex)
                        : null;
                    const bigText = active
                        ? formatValue(active.value, opts.valueFormat)
                        : formatValue(total, opts.valueFormat);
                    const subText = active ? active.label : opts.totalLabel;
                    const bigSize = bigText.length > 8 ? 30 : bigText.length > 6 ? 36 : 42;
                    return (
                        <>
                            <text
                                x={CENTER}
                                y={CENTER - 6}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                style={{
                                    fill: active ? active.color : palette.centerValue,
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
                                        fontSize: 14,
                                        fontWeight: 600,
                                        letterSpacing: '0.02em',
                                        opacity: mounted ? 1 : 0,
                                        transition: 'opacity 500ms ease 550ms',
                                    }}
                                >
                                    {subText.length > 18 ? `${subText.slice(0, 17)}…` : subText}
                                </text>
                            ) : null}
                        </>
                    );
                })()}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// 凡例（割合バー付き・ホバー連動）
// ---------------------------------------------------------------------------
function Legend({ segments, palette, opts, activeIndex, onHover, scale = 1 }) {
    const maxShare = segments.reduce((m, s) => Math.max(m, s.share), 0) || 1;

    // 小サイズではフォント・余白・行間を縮める。0.7〜1.0 の範囲でスケール。
    const s = Math.max(0.7, Math.min(1, scale));
    const labelFont = Math.round(14 * s);
    const valueFont = Math.round(14 * s);
    const rowPadV = Math.max(3, Math.round(7 * s));
    const rowPadH = Math.max(6, Math.round(10 * s));
    const rowGap = Math.max(3, Math.round(6 * s));
    const colGap = Math.max(6, Math.round(12 * s));

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: rowGap,
                minWidth: 0,
                width: '100%',
                maxHeight: '100%',
                overflowY: 'auto',
                overflowX: 'hidden',
            }}
        >
            {segments.map((seg) => {
                const isActive = activeIndex === seg.index;
                const dimmed = activeIndex !== null && !isActive;
                return (
                    <div
                        key={`legend-${seg.index}`}
                        onMouseEnter={() => onHover(seg.index)}
                        onMouseLeave={() => onHover(null)}
                        style={{
                            display: 'grid',
                            gridTemplateColumns: `auto minmax(${Math.round(50 * s)}px, 1fr) auto`,
                            alignItems: 'center',
                            columnGap: colGap,
                            rowGap: Math.max(3, Math.round(6 * s)),
                            padding: `${rowPadV}px ${rowPadH}px`,
                            borderRadius: 8,
                            background: isActive ? palette.rowHover : 'transparent',
                            opacity: dimmed ? 0.5 : 1,
                            transition: 'background 160ms ease, opacity 160ms ease',
                        }}
                    >
                        <span
                            style={{
                                width: Math.max(8, Math.round(10 * s)),
                                height: Math.max(8, Math.round(10 * s)),
                                borderRadius: 3,
                                background: seg.color,
                                boxShadow: opts.glow ? `0 0 8px ${seg.color}aa` : 'none',
                                flexShrink: 0,
                            }}
                        />
                        <span
                            title={seg.label}
                            style={{
                                color: palette.legendLabel,
                                fontSize: labelFont,
                                fontWeight: 500,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {seg.label}
                        </span>
                        <span
                            style={{
                                fontSize: valueFont,
                                whiteSpace: 'nowrap',
                                textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            <span style={{ color: palette.legendValue, fontWeight: 700 }}>
                                {formatValue(seg.value, opts.valueFormat)}
                            </span>
                            {opts.showPercent ? (
                                <span style={{ color: palette.legendPercent, marginLeft: 6 }}>
                                    {formatPercent(seg.share)}
                                </span>
                            ) : null}
                        </span>

                        {/* 割合バー（全幅を占め、値列の下に薄く敷く） */}
                        {opts.showBar ? (
                            <div
                                style={{
                                    gridColumn: '2 / 4',
                                    height: 4,
                                    borderRadius: 999,
                                    background: palette.barTrack,
                                    overflow: 'hidden',
                                }}
                            >
                                <div
                                    style={{
                                        height: '100%',
                                        width: `${(seg.share / maxShare) * 100}%`,
                                        background: seg.color,
                                        borderRadius: 999,
                                        transition: 'width 900ms cubic-bezier(0.22, 1, 0.36, 1)',
                                    }}
                                />
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ドーナツグラフ全体レイアウト
// ---------------------------------------------------------------------------
function DonutChart({ fieldNames, rows, mode, opts }) {
    const palette = PALETTES[mode] || PALETTES.dark;
    const othersColor = OTHERS_COLOR[mode] || OTHERS_COLOR.dark;
    const circumference = 2 * Math.PI * RADIUS;

    const { items, total, catIdx } = useMemo(
        () => buildChartData(rows, fieldNames, opts),
        [rows, fieldNames, opts]
    );
    const chartItems = useMemo(
        () => aggregateItems(items, total, opts, othersColor),
        [items, total, opts, othersColor]
    );
    const segments = useMemo(
        () => buildSegments(chartItems, total, circumference, opts),
        [chartItems, total, circumference, opts]
    );

    // SVG フィルタ ID の衝突を避けるための一意サフィックス
    const uid = useMemo(() => Math.floor(Math.random() * 1e9).toString(36), []);

    // ドーナツ⇔凡例のホバー連動
    const [activeIndex, setActiveIndex] = useState(null);

    // マウント後にリングを描き進めるアニメーション用フラグ
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    // コンテナ実寸を計測してレイアウトを決める（小サイズで見切れないように）
    const [containerRef, size] = useMeasuredSize();
    const W = size.width;
    const H = size.height;

    if (segments.length === 0) return <NoDataState />;

    // タイトルは選択中のカテゴリ列名から生成する
    const title = fieldToTitle(fieldNames?.[catIdx]);

    // ---- サイズに応じたレイアウト判定 ----------------------------------
    // まだ計測前（W===0）は従来どおり横並びで暫定描画する。
    const measured = W > 0 && H > 0;

    // パディングは小さいパネルで詰める
    const padV = measured ? Math.max(6, Math.min(20, Math.round(H * 0.06))) : 20;
    const padH = measured ? Math.max(8, Math.min(24, Math.round(W * 0.05))) : 24;

    // タイトルフォントも縮める。極小パネルではタイトルを隠す。
    const titleFont = measured ? Math.max(11, Math.min(15, Math.round(W / 26))) : 15;
    const showTitle = Boolean(title) && (!measured || H > 90);
    const titleH = showTitle ? titleFont + 12 : 0;

    // 凡例に使えるおおよその領域から縮小係数を出す
    const availW = measured ? W - padH * 2 : 9999;
    const availH = measured ? H - padV * 2 - titleH : 9999;

    // 横に凡例を置く余地があるか（狭ければ縦積み or 凡例オフ）
    // ドーナツ最小 120px + 凡例最小 150px + gap を確保できれば横並び。
    const canSideBySide = !measured || availW >= 300;
    // 凡例を出す縦スペースがあるか（縦積み時）。無ければドーナツのみ。
    const stackHasRoom = availH >= 220;
    const legendVisible =
        opts.showLegend && (canSideBySide ? true : stackHasRoom);

    const legendScale = measured
        ? Math.max(0.7, Math.min(1, Math.min(availW, 420) / 300))
        : 1;

    const gap = measured ? Math.max(10, Math.min(28, Math.round(W * 0.03))) : 28;

    // ドーナツの最小確保サイズ（横並び時は幅の一部、縦積み時は残り高さ）
    const donutMin = measured
        ? Math.max(90, Math.min(availH, canSideBySide ? availW * 0.42 : availW))
        : 200;

    return (
        <div
            ref={containerRef}
            className="viz-container"
            style={{ padding: `${padV}px ${padH}px`, overflow: 'hidden' }}
        >
            {showTitle && (
                <div
                    style={{
                        color: palette.title,
                        fontSize: titleFont,
                        fontWeight: 800,
                        letterSpacing: '0.08em',
                        marginBottom: 12,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {title}
                </div>
            )}
            <div
                style={{
                    display: 'flex',
                    flexDirection: canSideBySide ? 'row' : 'column',
                    flexWrap: 'nowrap',
                    alignItems: 'center',
                    gap,
                    height: `calc(100% - ${titleH}px)`,
                    minHeight: 0,
                }}
            >
                {/* ドーナツ */}
                <div
                    style={{
                        flex: legendVisible
                            ? canSideBySide
                                ? '1 1 42%'
                                : '1 1 auto'
                            : '1 1 100%',
                        width: canSideBySide ? 'auto' : '100%',
                        minWidth: 0,
                        minHeight: canSideBySide ? 0 : Math.min(donutMin, availH),
                        height: canSideBySide ? '100%' : 'auto',
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

                {/* 凡例（横並び=右／縦積み=下。領域が無ければ非表示にしてドーナツ優先） */}
                {legendVisible && (
                    <div
                        style={{
                            flex: canSideBySide ? '1 1 58%' : '0 1 auto',
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
                            palette={palette}
                            opts={opts}
                            activeIndex={activeIndex}
                            onHover={setActiveIndex}
                            scale={legendScale}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// データソース + オプション接続
// ---------------------------------------------------------------------------
function DonutChartVisualization({ mode }) {
    const { dataSources, loading } = useDataSources();
    const { options } = useOptions();

    const data = dataSources?.primary?.data || null;
    const rows = useMemo(() => {
        if (!data) return [];
        // mv セル（配列/改行）を平行展開して救済してから使う
        return expandMultivalueRows(normalizeData(data));
    }, [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f?.name || f), [data]);
    const opts = useMemo(() => normalizeOptions(options), [options]);

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) return <NoDataState />;

    return <DonutChart fieldNames={fieldNames} rows={rows} mode={mode} opts={opts} />;
}

// ---------------------------------------------------------------------------
// テーマガード付きルート
// useTheme() が undefined（テーマ未取得）の間は App をレンダリングしない
// ---------------------------------------------------------------------------
function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme;

    // テーマ取得前は何も描画しない（取得後にのみレンダリング）
    if (!colorScheme) {
        return null;
    }

    const mode = colorScheme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <DonutChartVisualization mode={mode} />
        </SplunkThemeProvider>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
    <VisualizationExtensionProvider>
        <App />
    </VisualizationExtensionProvider>
);
