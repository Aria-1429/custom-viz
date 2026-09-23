import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// VU Console（アナログ VU メーターの計器盤）
//
// 複数のメトリクスを、レコーディングスタジオの VU メーター（針の計器）を
// 横に並べた「調整卓」として描く。1メトリクス = 1メーター。
//
//   ・針はバネ物理（減衰2次系）で振れる。値の急変時に少しオーバーシュートして
//     戻る「アナログらしさ」を出す。物理は rAF ループで SVG の transform を
//     直接更新し、React の再レンダリングを介さない（ハイブリッド描画）。
//   ・ピークホールド針（赤の細針）が最大振れ位置に残り、保持時間を過ぎると
//     ゆっくり現在値へ戻る。
//   ・しきい値の色帯（editor.threshold）を目盛りの外周に弧として描く。
//     最上位の帯に入るとピークランプが点灯する。
//   ・文字盤はビンテージ（クリーム）／ダーク（黒文字盤）／テーマ連動。
//   ・メーターのクリックでインタラクション（value.click）を発火できる。
//
// データモデル（2形態を自動判定）:
//   横持ち: 1列 = 1メーター（... | stats avg(cpu) as CPU, avg(mem) as MEM）
//           複数行あるときは「値の決め方」(last/first/avg/max/min/sum) で1値に畳む
//   縦持ち: 1行 = 1メーター（... | stats avg(load) as value by host）
//           文字列列がラベル、数値列が値
//
// 針の更新は rAF だが、全メーターが静止したらループを止める（省電力。
// world-map の「常時60fps全面再描画で4面4fps」の教訓）。データ・オプション
// 変更で再加熱する。DOM には常に最終 transform が属性として残るので、
// PNG 書き出し（DOM 複製）でも針が消えない。
// ---------------------------------------------------------------------------

const VIZ_VERSION = '1.0.0';

const DATA_SHAPES = ['auto', 'wide', 'long'];
const AGG_MODES = ['last', 'first', 'avg', 'max', 'min', 'sum'];
const FACE_STYLES = ['auto', 'vintage', 'dark'];
const SWEEP_ANGLES = [90, 120, 150];

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    fields: [], // 対象フィールド（[] = 数値列すべて）
    dataShape: 'auto', // auto / wide / long
    aggMode: 'last', // 横持ちで複数行のときの畳み方

    rangeMin: 0,
    rangeMax: 100,
    autoScale: false, // データから範囲を自動決定

    faceStyle: 'auto', // auto=テーマ連動 / vintage / dark

    sweepAngle: 90, // 針の振れ幅（度）
    unitText: '', // 文字盤中央の単位ラベル（例: %, ms, VU）
    decimals: 0, // 読み取り値の小数桁
    showValue: true, // デジタル読み取り値を表示
    showTickLabels: true, // 目盛りの数値を表示
    showLamp: true, // ピークランプ

    showPeak: true, // ピークホールド針
    peakHoldSec: 2.5, // ピーク保持時間（秒）
    animate: true, // バネ物理で針を振る

    maxColumns: 0, // 列数の上限（0=自動）
    maxMeters: 12, // メーター数の上限
};

// 値の範囲と色（editor.threshold）の既定。config.json の colorBands.default と一致させる
const COLOR_BAND_DEFAULTS = [
    { from: null, to: 70, value: '#4b8f5f' },
    { from: 70, to: 85, value: '#e0a63c' },
    { from: 85, to: null, value: '#d3413b' },
];

const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif';
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// メーター1枚の viewBox（座標系）。実寸はレイアウトが scale する
const VB_W = 160;
const VB_H = 104;
const METER_ASPECT = VB_W / VB_H;

// ---------------------------------------------------------------------------
// 汎用ユーティリティ
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// 数値正規化（カンマ・空白を許容）
function parseNum(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[,\s]/g, '').trim();
    if (s === '') return NaN;
    return Number(s);
}

function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

function withAlpha(color, alpha) {
    const rgb = hexToRgb(color);
    if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.round(alpha * 1000) / 1000})`;
    return color;
}

// 数値の表示整形（桁区切り・小数桁。巨大値は指数に逃がす）
function formatNumber(n, decimals) {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1e15) return n.toExponential(2);
    const fixed = n.toFixed(clamp(decimals, 0, 6));
    const [int, frac] = fixed.split('.');
    const withComma = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${withComma}.${frac}` : withComma;
}

// 目盛りラベル用の短い表記（大きい値は K/M/B に省略）
function formatTick(n) {
    if (!Number.isFinite(n)) return '';
    const abs = Math.abs(n);
    const units = [
        { v: 1e9, s: 'B' },
        { v: 1e6, s: 'M' },
        { v: 1e3, s: 'K' },
    ];
    for (const u of units) {
        if (abs >= u.v) {
            const q = n / u.v;
            return `${Number.isInteger(q) ? q : q.toFixed(1)}${u.s}`;
        }
    }
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 100) / 100);
}

// ラベルの推定幅による切り詰め（CJK≈1.0em / その他≈0.62em）
function truncateLabel(s, maxUnits) {
    const str = String(s);
    let units = 0;
    for (let i = 0; i < str.length; i++) {
        units += str.codePointAt(i) > 0x2e7f ? 1.0 : 0.62;
        if (units > maxUnits) return `${str.slice(0, Math.max(1, i))}…`;
    }
    return str;
}

// ---------------------------------------------------------------------------
// オプション・帯の正規化
// ---------------------------------------------------------------------------

/**
 * editor.threshold の生値（[{from,to,value}]）を正規化する。
 * - 配列でない / 空 / 全要素が壊れている → 既定の帯へ倒す
 * - from/to は null・欠落・非数値のいずれも「境界なし」(±Infinity) とみなす
 * - value（色）が解釈できない要素は落とす
 * - from > to の逆転は入れ替えて救済し、from 昇順に並べ直す
 */
function normalizeBands(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const out = [];
    src.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        if (!hexToRgb(b.value)) return;
        const f = parseNum(b.from);
        const t = parseNum(b.to);
        let from = Number.isFinite(f) ? f : -Infinity;
        let to = Number.isFinite(t) ? t : Infinity;
        if (from > to) [from, to] = [to, from];
        out.push({ from, to, color: b.value });
    });
    if (out.length === 0) {
        return COLOR_BAND_DEFAULTS.map((b) => ({
            from: b.from === null ? -Infinity : b.from,
            to: b.to === null ? Infinity : b.to,
            color: b.value,
        }));
    }
    out.sort((a, b) => a.from - b.from);
    return out;
}

// 値が属する帯（無ければ null）
function bandFor(value, bands) {
    if (!Number.isFinite(value)) return null;
    for (let i = bands.length - 1; i >= 0; i--) {
        const b = bands[i];
        if (value >= b.from && (value < b.to || (b.to === Infinity && value >= b.from))) return b;
    }
    // 端の取りこぼし（value === 最終帯の to など）は最寄りへ
    if (bands.length && value >= bands[bands.length - 1].to) return bands[bands.length - 1];
    if (bands.length && value < bands[0].from) return bands[0];
    return null;
}

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const pick = (key, fallback, type) => {
        const v = o[key];
        if (type === 'number') {
            const n = parseNum(v);
            return Number.isFinite(n) ? n : fallback;
        }
        if (type === 'boolean') return typeof v === 'boolean' ? v : fallback;
        if (type === 'string') return typeof v === 'string' ? v : fallback;
        return v === undefined ? fallback : v;
    };
    const oneOf = (key, list, fallback) => {
        const v = o[key];
        return list.includes(v) ? v : fallback;
    };

    // fields は生のフィールド名配列（editor.columnMultiSelectionByFieldNameEditor）。
    // DOS 文字列や壊れた値は「未選択」へ倒す
    const fields = Array.isArray(o.fields) ? o.fields.filter((f) => typeof f === 'string' && f !== '') : [];

    // sweepAngle は select の value が数値でも文字列でも通す
    const sweepRaw = parseNum(o.sweepAngle);
    const sweepAngle = SWEEP_ANGLES.includes(sweepRaw) ? sweepRaw : DEFAULTS.sweepAngle;

    return {
        fields,
        dataShape: oneOf('dataShape', DATA_SHAPES, DEFAULTS.dataShape),
        aggMode: oneOf('aggMode', AGG_MODES, DEFAULTS.aggMode),

        rangeMin: pick('rangeMin', DEFAULTS.rangeMin, 'number'),
        rangeMax: pick('rangeMax', DEFAULTS.rangeMax, 'number'),
        autoScale: pick('autoScale', DEFAULTS.autoScale, 'boolean'),

        colorBands: normalizeBands(o.colorBands),
        faceStyle: oneOf('faceStyle', FACE_STYLES, DEFAULTS.faceStyle),

        sweepAngle,
        unitText: pick('unitText', DEFAULTS.unitText, 'string'),
        decimals: clamp(pick('decimals', DEFAULTS.decimals, 'number'), 0, 6),
        showValue: pick('showValue', DEFAULTS.showValue, 'boolean'),
        showTickLabels: pick('showTickLabels', DEFAULTS.showTickLabels, 'boolean'),
        showLamp: pick('showLamp', DEFAULTS.showLamp, 'boolean'),

        showPeak: pick('showPeak', DEFAULTS.showPeak, 'boolean'),
        peakHoldSec: clamp(pick('peakHoldSec', DEFAULTS.peakHoldSec, 'number'), 0, 60),
        animate: pick('animate', DEFAULTS.animate, 'boolean'),

        maxColumns: clamp(Math.round(pick('maxColumns', DEFAULTS.maxColumns, 'number')), 0, 24),
        maxMeters: clamp(Math.round(pick('maxMeters', DEFAULTS.maxMeters, 'number')), 1, 24),
    };
}

// ---------------------------------------------------------------------------
// データ正規化とモデル構築
// ---------------------------------------------------------------------------

// rows / columns 両形式に対応（columns 形式で届くことが実機である）
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const n = data.columns[0].length;
            return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
        }
    } catch (e) {
        /* 想定外形式でも落とさない */
    }
    return [];
}

function fieldNamesOf(data) {
    return (data?.fields || []).map((f) => f?.name || f).filter((n) => typeof n === 'string');
}

// 列が数値列か（先頭50行のうち1つでも数値が入っていれば数値列とみなす）
function isNumericColumn(rows, colIdx) {
    const n = Math.min(rows.length, 50);
    for (let i = 0; i < n; i++) {
        if (Number.isFinite(parseNum(rows[i]?.[colIdx]))) return true;
    }
    return false;
}

function aggregate(values, mode) {
    const nums = values.filter((v) => Number.isFinite(v));
    if (nums.length === 0) return NaN;
    switch (mode) {
        case 'first':
            return nums[0];
        case 'avg':
            return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'max':
            return Math.max(...nums);
        case 'min':
            return Math.min(...nums);
        case 'sum':
            return nums.reduce((a, b) => a + b, 0);
        case 'last':
        default:
            return nums[nums.length - 1];
    }
}

// 上限側の「切りのいい値」（1/2/5 × 10^k）へ切り上げ
function niceCeil(v) {
    if (!Number.isFinite(v) || v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = 10 ** exp;
    for (const m of [1, 2, 5, 10]) {
        if (v <= m * base) return m * base;
    }
    return 10 * base;
}

/**
 * データとオプションからメーターの一覧を組み立てる。
 * 返り値: { meters: [{label, value, row}], lo, hi, error? }
 *   row は「そのメーターの元になった行」を {field: 値} で持つ（ドリルダウン用）
 */
function buildModel(rows, fieldNames, opts) {
    if (rows.length === 0 || fieldNames.length === 0) return { meters: [], lo: 0, hi: 1, error: 'nodata' };

    // 数値列 / 非数値列を仕分け
    const numericIdx = [];
    const stringIdx = [];
    fieldNames.forEach((name, i) => {
        if (isNumericColumn(rows, i)) numericIdx.push(i);
        else stringIdx.push(i);
    });

    // 対象フィールド：選択があれば「存在する数値列」に絞る。無ければ数値列すべて
    const selectedIdx =
        opts.fields.length > 0
            ? opts.fields.map((f) => fieldNames.indexOf(f)).filter((i) => i >= 0 && numericIdx.includes(i))
            : numericIdx;
    if (selectedIdx.length === 0) return { meters: [], lo: 0, hi: 1, error: 'nonumeric' };

    // 形の決定：auto は「数値1列＋文字列列あり＋複数行」なら縦持ち
    let shape = opts.dataShape;
    if (shape === 'auto') {
        shape = selectedIdx.length === 1 && stringIdx.length > 0 && rows.length >= 2 ? 'long' : 'wide';
    }

    const rowObj = (row) => {
        const obj = {};
        fieldNames.forEach((name, i) => {
            obj[name] = row?.[i];
        });
        return obj;
    };

    let meters = [];
    if (shape === 'long') {
        const valIdx = selectedIdx[0];
        const labIdx = stringIdx.length > 0 ? stringIdx[0] : -1;
        meters = rows.map((row, i) => ({
            label: labIdx >= 0 ? String(row?.[labIdx] ?? `#${i + 1}`) : `#${i + 1}`,
            value: parseNum(row?.[valIdx]),
            row: rowObj(row),
        }));
    } else {
        const lastRow = rows[rows.length - 1];
        meters = selectedIdx.map((ci) => ({
            label: fieldNames[ci],
            value: aggregate(rows.map((r) => parseNum(r?.[ci])), opts.aggMode),
            row: rowObj(lastRow),
        }));
    }

    // 値が数値にならなかったメーターは落とす（全部落ちたらエラー）
    meters = meters.filter((m) => Number.isFinite(m.value));
    if (meters.length === 0) return { meters: [], lo: 0, hi: 1, error: 'nonumeric' };
    meters = meters.slice(0, opts.maxMeters);

    // 目盛りの範囲
    let lo = opts.rangeMin;
    let hi = opts.rangeMax;
    if (opts.autoScale) {
        const vmax = Math.max(...meters.map((m) => m.value));
        const vmin = Math.min(...meters.map((m) => m.value));
        lo = Math.min(0, vmin);
        hi = niceCeil(vmax <= 0 ? 1 : vmax);
    }
    if (!(hi > lo)) hi = lo + 1;

    return { meters, lo, hi };
}

// ---------------------------------------------------------------------------
// レイアウト（グリッドの列数をコンテナ実寸から決める）
// ---------------------------------------------------------------------------

function computeGrid(w, h, n, maxColumns) {
    const GAP = 8;
    let best = { cols: 1, cellW: w, cellH: h, scale: 0 };
    const colLimit = maxColumns > 0 ? Math.min(maxColumns, n) : n;
    for (let cols = 1; cols <= colLimit; cols++) {
        const rows = Math.ceil(n / cols);
        const cellW = (w - GAP * (cols - 1)) / cols;
        const cellH = (h - GAP * (rows - 1)) / rows;
        if (cellW <= 0 || cellH <= 0) continue;
        // メーターのアスペクト比を保ったときの表示スケール
        const scale = Math.min(cellW / METER_ASPECT, cellH);
        if (scale > best.scale) best = { cols, cellW, cellH, scale };
    }
    return { cols: best.cols, gap: GAP };
}

// ---------------------------------------------------------------------------
// メーターの幾何（viewBox 160×104 内。針の pivot は文字盤の下）
// ---------------------------------------------------------------------------

const FACE = { x: 6, y: 6, w: 148, h: 74 }; // 文字盤（ガラス窓）
const STRIP_Y = 84; // 下部ストリップ（ラベル・読み取り値）

// 角度は「真上=0、右回りが正」。x = cx + r·sin, y = cy − r·cos
function polar(geom, r, angDeg) {
    const a = (angDeg * Math.PI) / 180;
    return { x: geom.px + r * Math.sin(a), y: geom.py - r * Math.cos(a) };
}

function arcPath(geom, r, a0, a1) {
    const p0 = polar(geom, r, a0);
    const p1 = polar(geom, r, a1);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

/**
 * sweep（開き角）に応じて針軸の位置と各半径を決める。
 * 90° は VU らしく軸を文字盤の下に隠す。開き角が大きいほど端の目盛りが
 * 下がってくるので、軸を上げて（スピードメーター寄りにして）
 * 端の目盛り数値が文字盤からはみ出ないようにする。
 */
function meterGeom(sweepAngle) {
    const half = sweepAngle / 2;
    const sinH = Math.sin((half * Math.PI) / 180);
    const cosH = Math.cos((half * Math.PI) / 180);
    const px = 80;
    const py = sweepAngle <= 90 ? 100 : sweepAngle <= 120 ? 92 : 82;
    // 文字盤の横幅（中心から 70）と上端に収まる最大半径
    const rMax = Math.min(88, 70 / Math.max(sinH, 0.35), py - FACE.y - 8);
    const geom = {
        half,
        px,
        py,
        rBand: rMax, // 色帯の弧
        rTickOut: rMax - 5, // 目盛り外端
        rTickIn: rMax - 12, // 目盛り内端（メジャー）
        rTickInMinor: rMax - 9, // 目盛り内端（マイナー）
        rLabel: rMax - 20, // 目盛り数値
        rNeedle: rMax - 3, // 針の長さ
        rPeak: rMax - 6, // ピーク針の長さ
    };
    // 端の目盛り数値が文字盤の下端を割るなら、ラベル半径を外側へ出して救済
    // （y = py − r·cos は r が大きいほど上がる）。ただし目盛り線には重ねない
    const endLabelY = py - geom.rLabel * cosH;
    const maxY = FACE.y + FACE.h - 6;
    if (endLabelY > maxY && cosH > 0.05) {
        geom.rLabel = Math.min(geom.rTickIn - 3, Math.max(geom.rLabel, (py - maxY) / cosH));
    }
    return geom;
}

// 値 → 針の角度（度）。範囲外は少しだけ振り切らせる（アナログの「振り切れ」）
function angleForValue(value, lo, hi, half) {
    const frac = (value - lo) / (hi - lo);
    return (clamp(frac, -0.04, 1.04) * 2 - 1) * half;
}

// ---------------------------------------------------------------------------
// パレット（テーマ × 文字盤の質感）
// ---------------------------------------------------------------------------

function palette(mode, faceStyle) {
    const style = faceStyle === 'auto' ? (mode === 'dark' ? 'dark' : 'vintage') : faceStyle;
    const consoleBg = mode === 'dark' ? '#15161a' : '#e8e6e0';
    if (style === 'vintage') {
        return {
            style,
            consoleBg,
            bezel: '#26282e',
            bezelEdge: '#3a3d45',
            face: '#efe6cf',
            faceEdge: '#c9bfa4',
            tick: '#3a3428',
            tickMinor: withAlpha('#3a3428', 0.55),
            tickLabel: '#4a4335',
            unit: withAlpha('#3a3428', 0.75),
            needle: '#23201a',
            peak: '#c2372f',
            hub: '#1d1f24',
            stripText: '#cfd2d8',
            stripValue: '#e8eaee',
            lampOff: '#3a3d45',
            glass: 'rgba(255,255,255,0.35)',
        };
    }
    return {
        style,
        consoleBg,
        bezel: '#1c1e24',
        bezelEdge: '#33363f',
        face: '#0f1115',
        faceEdge: '#2a2d35',
        tick: '#c9ced8',
        tickMinor: withAlpha('#c9ced8', 0.45),
        tickLabel: '#aeb4c0',
        unit: withAlpha('#c9ced8', 0.65),
        needle: '#e8eaee',
        peak: '#e0524a',
        hub: '#33363f',
        stripText: '#aeb4c0',
        stripValue: '#e8eaee',
        lampOff: '#2a2d35',
        glass: 'rgba(255,255,255,0.10)',
    };
}

// ---------------------------------------------------------------------------
// スピナー永久表示対策（公式フックの取りこぼし窓を loading 中のポーリングで回収）
// ---------------------------------------------------------------------------

const RESCUE_POLL_MS = 500;

function useDataSourcesWithRescue() {
    const official = useDataSources();
    const [rescue, setRescue] = useState(null);
    const officialLoading = Boolean(official?.loading);

    useEffect(() => {
        if (!officialLoading) return undefined;
        setRescue(null); // 新しいロードサイクル。前回の回収値は使わない
        let timer = 0;
        const tick = () => {
            try {
                const cur = globalThis.DashboardExtensionAPI?.getDataSources?.();
                if (cur && !cur.loading) {
                    setRescue(cur);
                    return;
                }
            } catch (e) {
                /* ホスト未応答でも落とさない。次のtickで再試行 */
            }
            timer = setTimeout(tick, RESCUE_POLL_MS);
        };
        timer = setTimeout(tick, RESCUE_POLL_MS);
        return () => clearTimeout(timer);
    }, [officialLoading]);

    return officialLoading && rescue ? rescue : official;
}

// ---------------------------------------------------------------------------
// メーター1枚（SVG）。針の transform は rAF ループが直接書く
// ---------------------------------------------------------------------------

function Meter({ meter, index, opts, geom, lo, hi, pal, registerNeedle, attachClick }) {
    const { half } = geom;
    const bands = opts.colorBands;
    const restAng = -half; // 針のレスト位置（左端）。attach 直後の初期角に使う

    // 目盛り（メジャー5分割＋各区間にマイナー4本）
    const ticks = [];
    const MAJOR = 5;
    const MINOR = 4;
    for (let i = 0; i <= MAJOR; i++) {
        const frac = i / MAJOR;
        const ang = (frac * 2 - 1) * half;
        ticks.push({ ang, major: true, value: lo + (hi - lo) * frac });
        if (i < MAJOR) {
            for (let j = 1; j <= MINOR; j++) {
                const f2 = (i + j / (MINOR + 1)) / MAJOR;
                ticks.push({ ang: (f2 * 2 - 1) * half, major: false });
            }
        }
    }

    // 色帯の弧（目盛り範囲と交差する部分だけ描く）
    const bandArcs = bands
        .map((b) => {
            const f0 = clamp((Math.max(b.from, lo) - lo) / (hi - lo), 0, 1);
            const f1 = clamp((Math.min(b.to, hi) - lo) / (hi - lo), 0, 1);
            if (f1 <= f0) return null;
            return { d: arcPath(geom, geom.rBand, (f0 * 2 - 1) * half, (f1 * 2 - 1) * half), color: b.color };
        })
        .filter(Boolean);

    // ピークランプ：最上位の帯に入っているときに点灯。
    // 帯が1つだけ（from が -Infinity）のときは「常時点灯」になってしまうので点けない
    const topBand = bands[bands.length - 1];
    const lampOn = opts.showLamp && topBand && Number.isFinite(topBand.from) && meter.value >= topBand.from;
    const lampColor = lampOn ? topBand.color : pal.lampOff;

    // ラベルと読み取り値（下部ストリップ）
    const label = truncateLabel(meter.label, 14);
    const valueText = formatNumber(meter.value, opts.decimals);

    // クリック（ドリルダウン）はセル div ごと登録する。payload は毎レンダー差し替え
    const payload = useMemo(() => {
        const p = { name: meter.label, value: meter.value };
        Object.entries(meter.row || {}).forEach(([k, v]) => {
            p[`row.${k}.value`] = v;
        });
        return p;
    }, [meter]);

    return (
        <div
            ref={(el) => attachClick(el, payload)}
            data-role="meter"
            title={`${meter.label}: ${valueText}`}
            style={{ width: '100%', height: '100%', cursor: 'pointer', minWidth: 0, minHeight: 0 }}
        >
            <svg
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                width="100%"
                height="100%"
                preserveAspectRatio="xMidYMid meet"
                style={{ display: 'block' }}
            >
                {/* ベゼル（外枠） */}
                <rect x="0" y="0" width={VB_W} height={VB_H} rx="7" fill={pal.bezel} stroke={pal.bezelEdge} strokeWidth="1" />

                {/* 文字盤 */}
                <clipPath id={`vu-face-${index}`}>
                    <rect x={FACE.x} y={FACE.y} width={FACE.w} height={FACE.h} rx="4" />
                </clipPath>
                <rect
                    x={FACE.x}
                    y={FACE.y}
                    width={FACE.w}
                    height={FACE.h}
                    rx="4"
                    fill={pal.face}
                    stroke={pal.faceEdge}
                    strokeWidth="1"
                />

                <g clipPath={`url(#vu-face-${index})`}>
                    {/* 色帯 */}
                    {bandArcs.map((a, i) => (
                        <path
                            key={i}
                            data-role="band"
                            d={a.d}
                            fill="none"
                            stroke={a.color}
                            strokeWidth="3.4"
                            strokeLinecap="butt"
                        />
                    ))}

                    {/* 目盛り */}
                    {ticks.map((t, i) => {
                        const rIn = t.major ? geom.rTickIn : geom.rTickInMinor;
                        const p0 = polar(geom, rIn, t.ang);
                        const p1 = polar(geom, geom.rTickOut, t.ang);
                        return (
                            <line
                                key={i}
                                data-role={t.major ? 'tick' : 'tick-minor'}
                                x1={p0.x}
                                y1={p0.y}
                                x2={p1.x}
                                y2={p1.y}
                                stroke={t.major ? pal.tick : pal.tickMinor}
                                strokeWidth={t.major ? 1.4 : 0.7}
                            />
                        );
                    })}

                    {/* 目盛り数値 */}
                    {opts.showTickLabels &&
                        ticks
                            .filter((t) => t.major)
                            .map((t, i) => {
                                const p = polar(geom, geom.rLabel, t.ang);
                                return (
                                    <text
                                        key={i}
                                        data-role="tick-label"
                                        x={p.x}
                                        y={p.y + 2.6}
                                        textAnchor="middle"
                                        fontSize="6.6"
                                        fontFamily={FONT_STACK}
                                        fill={pal.tickLabel}
                                    >
                                        {formatTick(t.value)}
                                    </text>
                                );
                            })}

                    {/* 単位ラベル（文字盤中央） */}
                    {opts.unitText !== '' && (
                        <text
                            data-role="unit"
                            x={geom.px}
                            y={FACE.y + FACE.h - 14}
                            textAnchor="middle"
                            fontSize="10"
                            fontWeight="700"
                            fontFamily={FONT_STACK}
                            fill={pal.unit}
                            letterSpacing="1"
                        >
                            {opts.unitText}
                        </text>
                    )}

                    {/* ピーク針（rAF が transform を書く。React はこの属性を触らない） */}
                    {opts.showPeak && (
                        <g data-role="peak-needle" ref={(el) => registerNeedle(index, 'peak', el, restAng)}>
                            <line
                                x1={geom.px}
                                y1={geom.py}
                                x2={geom.px}
                                y2={geom.py - geom.rPeak}
                                stroke={pal.peak}
                                strokeWidth="0.9"
                                opacity="0.85"
                            />
                        </g>
                    )}

                    {/* 針 */}
                    <g data-role="needle" ref={(el) => registerNeedle(index, 'main', el, restAng)}>
                        <line
                            x1={geom.px}
                            y1={geom.py}
                            x2={geom.px}
                            y2={geom.py - geom.rNeedle}
                            stroke={pal.needle}
                            strokeWidth="1.7"
                            strokeLinecap="round"
                        />
                    </g>

                    {/* ガラスの反射（ごく薄いハイライト） */}
                    <path
                        d={`M ${FACE.x} ${FACE.y} L ${FACE.x + FACE.w * 0.45} ${FACE.y} L ${FACE.x + FACE.w * 0.2} ${
                            FACE.y + FACE.h
                        } L ${FACE.x} ${FACE.y + FACE.h} Z`}
                        fill={pal.glass}
                        opacity="0.25"
                        pointerEvents="none"
                    />
                </g>

                {/* 針の軸。90° は文字盤の下端（軸は盤の外に隠れる）、広角は盤内に見える */}
                <circle
                    cx={geom.px}
                    cy={Math.min(geom.py, FACE.y + FACE.h)}
                    r="3.2"
                    fill={pal.hub}
                    stroke={pal.bezelEdge}
                    strokeWidth="0.6"
                />

                {/* ピークランプ */}
                {opts.showLamp && (
                    <g>
                        <circle
                            data-role="lamp"
                            data-on={lampOn ? '1' : '0'}
                            cx={FACE.x + FACE.w - 9}
                            cy={FACE.y + 10}
                            r="3.4"
                            fill={lampColor}
                            stroke={pal.bezelEdge}
                            strokeWidth="0.7"
                        />
                        {lampOn && (
                            <circle cx={FACE.x + FACE.w - 9} cy={FACE.y + 10} r="6" fill={withAlpha(lampColor, 0.35)} />
                        )}
                    </g>
                )}

                {/* 下部ストリップ：ラベル（左）と読み取り値（右） */}
                <text
                    data-role="label"
                    x={FACE.x + 3}
                    y={STRIP_Y + 13}
                    fontSize="8.4"
                    fontWeight="600"
                    fontFamily={FONT_STACK}
                    fill={pal.stripText}
                >
                    {label}
                </text>
                {opts.showValue && (
                    <text
                        data-role="value"
                        x={FACE.x + FACE.w - 3}
                        y={STRIP_Y + 13}
                        textAnchor="end"
                        fontSize="9.4"
                        fontWeight="700"
                        fontFamily={MONO_STACK}
                        fill={pal.stripValue}
                    >
                        {valueText}
                    </text>
                )}
            </svg>
        </div>
    );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function CenterMessage({ children, sub }) {
    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                fontFamily: FONT_STACK,
                opacity: 0.85,
                textAlign: 'center',
                padding: 12,
                boxSizing: 'border-box',
            }}
        >
            <div style={{ fontSize: 13 }}>{children}</div>
            {sub && <div style={{ fontSize: 12, opacity: 0.7 }}>{sub}</div>}
        </div>
    );
}

function VuConsoleViz({ mode }) {
    const { dataSources, loading } = useDataSourcesWithRescue() || {};
    const optionsApi = useOptions();
    const options = optionsApi?.options;

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const model = useMemo(() => buildModel(rows, fieldNames, opts), [rows, fieldNames, opts]);

    // --- コンテナ実寸（オートフィット） ---
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 780, h: 360 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 780;
        const h = el.clientHeight || 360;
        setDims((d) => (Math.abs(d.w - w) > 1 || Math.abs(d.h - h) > 1 ? { w, h } : d));
    }, []);
    const setContainer = useCallback(
        (el) => {
            containerRef.current = el;
            if (!el) return;
            measure(el);
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => measure(el));
                ro.observe(el);
                el.__ro = ro;
            }
        },
        [measure]
    );

    // --- 針の物理（rAF ハイブリッド描画） ---
    // needleEls: `${index}:${kind}` → SVG <g>。sim: index → {ang, vel, peak, peakAt}
    const needleEls = useRef(new Map());
    const sim = useRef(new Map());
    const rafId = useRef(0);
    const running = useRef(false);
    const paramsRef = useRef({ targets: [], half: 45, animate: true, showPeak: true, peakHoldSec: 2.5 });

    // 減速モーション設定（OS 設定）はバネを使わず即時反映にする
    const reducedMotion = useRef(false);
    useEffect(() => {
        try {
            reducedMotion.current = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
        } catch (e) {
            reducedMotion.current = false;
        }
    }, []);

    // 針軸は開き角で変わる（meterGeom）。rAF から読むので ref 経由で毎レンダー更新する
    const pivotRef = useRef({ px: 80, py: 100 });
    const setTransform = useCallback((el, ang) => {
        if (!el) return;
        const { px, py } = pivotRef.current;
        el.setAttribute('transform', `rotate(${ang.toFixed(2)} ${px} ${py})`);
    }, []);

    // callback ref（useCallback で安定化。React はこの transform を書かない）。
    // attach 時に現在のシム角（初回は左端のレスト位置）を即書きして
    // 「一瞬だけ transform 無し」のフレームを避ける
    const registerNeedle = useCallback(
        (index, kind, el, restAng) => {
            const key = `${index}:${kind}`;
            if (!el) {
                needleEls.current.delete(key);
                return;
            }
            needleEls.current.set(key, el);
            const s = sim.current.get(index);
            const ang = s ? (kind === 'peak' ? s.peak : s.ang) : restAng;
            setTransform(el, ang);
        },
        [setTransform]
    );

    // ループ本体。全メーター静止で自動停止（データ・オプション変更で再加熱）
    const tick = useCallback(
        (now) => {
            const P = paramsRef.current;
            const dtRaw = (now - (P.lastT || now)) / 1000;
            P.lastT = now;
            const dt = clamp(dtRaw || 0.016, 0.001, 0.05);

            let allSettled = true;
            P.targets.forEach((target, index) => {
                let s = sim.current.get(index);
                if (!s) {
                    s = { ang: -P.half, vel: 0, peak: -P.half, peakAt: now };
                    sim.current.set(index, s);
                }

                if (!P.animate || reducedMotion.current) {
                    s.ang = target;
                    s.vel = 0;
                } else {
                    // 減衰2次系（少しオーバーシュートさせて「振れる」感じを出す）
                    const OMEGA = 8.5; // 固有角速度
                    const ZETA = 0.6; // 減衰比（<1 でアンダーダンプ）
                    const acc = OMEGA * OMEGA * (target - s.ang) - 2 * ZETA * OMEGA * s.vel;
                    s.vel += acc * dt;
                    s.ang += s.vel * dt;
                    if (Math.abs(s.vel) > 0.005 || Math.abs(target - s.ang) > 0.02) allSettled = false;
                    else {
                        s.ang = target;
                        s.vel = 0;
                    }
                }

                // ピークホールド：針の最大振れを保持し、保持時間を過ぎたら降りる
                if (s.ang >= s.peak) {
                    s.peak = s.ang;
                    s.peakAt = now;
                } else if (P.showPeak && now - s.peakAt > P.peakHoldSec * 1000) {
                    const FALL = 26; // 降下速度（度/秒）
                    s.peak = Math.max(s.ang, s.peak - FALL * dt);
                    if (s.peak > s.ang) allSettled = false;
                }

                setTransform(needleEls.current.get(`${index}:main`), s.ang);
                if (P.showPeak) setTransform(needleEls.current.get(`${index}:peak`), s.peak);
            });

            if (allSettled) {
                running.current = false;
                return;
            }
            rafId.current = requestAnimationFrame(tick);
        },
        [setTransform]
    );

    const wake = useCallback(() => {
        if (running.current) return;
        if (typeof requestAnimationFrame !== 'function') {
            // rAF が無い環境（検証ハーネス等）でも最終値は必ず反映する
            const P = paramsRef.current;
            P.targets.forEach((target, index) => {
                sim.current.set(index, { ang: target, vel: 0, peak: target, peakAt: 0 });
                setTransform(needleEls.current.get(`${index}:main`), target);
                if (P.showPeak) setTransform(needleEls.current.get(`${index}:peak`), target);
            });
            return;
        }
        running.current = true;
        paramsRef.current.lastT = 0;
        rafId.current = requestAnimationFrame(tick);
    }, [tick, setTransform]);

    // データ・オプションが変わったら目標角を更新して再加熱
    const geom = useMemo(() => meterGeom(opts.sweepAngle), [opts.sweepAngle]);
    pivotRef.current = { px: geom.px, py: geom.py }; // rAF が読む針軸（stale closure 回避）
    useEffect(() => {
        const targets = model.meters.map((m) => angleForValue(m.value, model.lo, model.hi, geom.half));
        paramsRef.current = {
            ...paramsRef.current,
            targets,
            half: geom.half,
            animate: opts.animate,
            showPeak: opts.showPeak,
            peakHoldSec: opts.peakHoldSec,
        };
        // 消えたメーターのシム状態を掃除
        [...sim.current.keys()].forEach((k) => {
            if (k >= targets.length) sim.current.delete(k);
        });
        wake();
        return () => {
            if (rafId.current) cancelAnimationFrame(rafId.current);
            running.current = false;
        };
    }, [model, geom, opts.animate, opts.showPeak, opts.peakHoldSec, wake]);

    // --- ドリルダウン（クリック登録は1ノード1回。payload は WeakMap で差し替え） ---
    const clickPayloads = useRef(new WeakMap());
    const registeredClicks = useRef(new WeakSet());
    const attachClick = useCallback((node, payload) => {
        if (!node) return;
        clickPayloads.current.set(node, payload);
        if (registeredClicks.current.has(node)) return;
        registeredClicks.current.add(node);
        try {
            addDrilldownListener({
                node,
                action: 'value.click',
                payloadCallback: () => clickPayloads.current.get(node) || {},
            });
        } catch (e) {
            /* ホスト外（ローカル検証）でも落とさない */
        }
    }, []);

    // --- ガード（フックはすべて呼び終えてから return する） ---
    if (loading) {
        return (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WaitSpinner size="medium" />
            </div>
        );
    }
    if (!rawData || rows.length === 0 || model.error === 'nodata') {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }
    if (model.error === 'nonumeric') {
        return (
            <CenterMessage sub="数値のフィールドが見つかりません。対象フィールドの選択を確認してください。">
                データがありません。サーチ結果を確認してください。
            </CenterMessage>
        );
    }

    const pal = palette(mode, opts.faceStyle);
    const n = model.meters.length;
    const grid = computeGrid(dims.w - 16, dims.h - 16, n, opts.maxColumns);

    return (
        <div
            ref={setContainer}
            data-viz-version={VIZ_VERSION}
            style={{
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden',
                fontFamily: FONT_STACK,
                background: pal.consoleBg,
                padding: 8,
                display: 'grid',
                gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
                gridAutoRows: '1fr', // 行の高さを均等割りにする（auto だと svg が潰れる）
                gap: grid.gap,
                alignItems: 'stretch',
                justifyItems: 'stretch',
            }}
        >
            {model.meters.map((meter, i) => (
                <Meter
                    key={`${meter.label}:${i}`}
                    meter={meter}
                    index={i}
                    opts={opts}
                    geom={geom}
                    lo={model.lo}
                    hi={model.hi}
                    pal={pal}
                    registerNeedle={registerNeedle}
                    attachClick={attachClick}
                />
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ルート（テーマガード必須）
// ---------------------------------------------------------------------------

function App() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画
    const mode = colorScheme === 'dark' ? 'dark' : 'light';
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <VuConsoleViz mode={mode} />
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
