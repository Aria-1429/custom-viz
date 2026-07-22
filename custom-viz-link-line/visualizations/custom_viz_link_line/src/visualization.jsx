import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
    useMode,
} from '@splunk/dashboard-studio-extension/react';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// Link Line（サーバ間コネクタ線）
//
// SOC ダッシュボードで「サーバ（パネル）同士を線で繋ぎ、接続の状態に応じて
// 線の色を変える」ためのコネクタ・ビジュアライゼーション。
//
// ・データ: シングルバリュー。サーチ結果の値フィールド（既定は「数値を含む
//   最後の列」）の最終行を採用し、しきい値（基本色＋しきい値×3）で線の色を
//   決める（標準 Single Value の範囲色に相当。editor.dynamicColor はカスタム
//   viz では使えないため自前実装）。
// ・線の形: 「表示モード」でキャンバス上で直接編集する。
//   ※ Studio の編集モード中はホストがカスタム viz(iframe)への入力を遮断する
//     （viz 本体への mousedown はパネル選択に使われる）ため、編集モードでは
//     viz 内のドラッグ UI は動かない。そのため表示モードで「✎ 線を編集」
//     トグルを押してから編集する方式にしている。
//     - 点（○）をドラッグ = 移動
//     - セグメント中央の「＋」をドラッグ/クリック = 折れ点を追加
//     - 中間の点をダブルクリック = 削除
//     - 「線をリセット」ボタン = 既定の水平線に戻す
//   点列は正規化座標(0..1)の JSON として setOptions で保存される（表示モード
//   でもホストのダッシュボード定義 store が更新される）。その後ダッシュボード
//   の「編集」→「保存」で確定する。パネルをリサイズすると線も相対的に追従する。
// ・質感: フラット / ソフトシャドウ / ネオン発光 / 立体パイプ の4種＋
//   線幅・破線・流れアニメーション・不透明度。背景は透明で、どんな
//   ダッシュボードにも馴染む。
// ・データが無い/数値が無い場合も線は消さず、ニュートラル色（グレー）で
//   描画し、値ラベルに N/A を表示する（コネクタとしての表示を維持）。
// ---------------------------------------------------------------------------

// バージョン表記（デプロイ確認用。編集モードの案内・色設定パネル・debug に表示）
const VIZ_VERSION = '1.5.0';

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    valueField: '', // 値フィールド（'' = 数値を含む最後の列）

    linePoints: '', // 線の点列 JSON（'' = 既定の水平線。表示モードの線編集で setOptions 保存）
    cornerRadius: 14, // 折れ角の丸み（px）
    allowViewEdit: true, // 表示モードでの線編集（✎ボタン）を許可

    styleMode: 1, // 1=フラット, 2=ソフトシャドウ, 3=ネオン発光, 4=立体パイプ
    lineWidth: 6, // 線の太さ（px）
    lineGradient: true, // 始点→終点の淡いグラデーション（立体感）
    dashLength: 0, // 破線の長さ（px、0で実線）
    flowSpeed: 0, // 流れアニメーション速度（0で停止）
    pulseCaps: false, // 端点をパルス発光させる
    lineOpacity: 100, // 不透明度（%）

    showEndCaps: true, // 両端のコネクタ（丸端子）
    arrowHead: false, // 終点の矢印
    showValue: true, // 値ラベル（線の中央）
    valueDecimals: 0, // 小数点以下の桁数

    colorMethod: 'range', // 動的色設定の方式（range=範囲 / match=一致）
    colorBands: '', // 動的色設定・範囲（JSON。'' = 簡易しきい値を使用）
    colorMatches: '', // 動的色設定・一致（JSON）
    useThresholds: true, // しきい値で色分け
    baseColor: '#53a051', // 基本色（しきい値1未満／固定色）
    threshold1: 40,
    color1: '#f8be34',
    threshold2: 70,
    color2: '#f1813f',
    threshold3: 90,
    color3: '#dc4e41',

    debug: false,
};

// 既定の線（左→右の水平線。正規化座標）
const DEFAULT_POINTS = [
    { x: 0.07, y: 0.5 },
    { x: 0.93, y: 0.5 },
];

// データ無し/数値無しのときのニュートラル色
const NEUTRAL_COLOR = '#8b93a1';

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// ---------------------------------------------------------------------------
// 汎用ユーティリティ
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function clamp01(v) {
    return clamp(v, 0, 1);
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

function parseRgb(color) {
    const m = String(color).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

// color を toward（白/黒など）へ ratio だけ寄せる。'rgb(...)' を返す
function mixColor(color, toward, ratio) {
    const a = hexToRgb(color) || parseRgb(color);
    const b = hexToRgb(toward) || parseRgb(toward);
    if (!a || !b) return color;
    const u = clamp01(ratio);
    return `rgb(${Math.round(a.r + (b.r - a.r) * u)},${Math.round(a.g + (b.g - a.g) * u)},${Math.round(
        a.b + (b.b - a.b) * u
    )})`;
}

// rgba 化（不透明度付き）。hex/rgb どちらでも受ける
function withAlpha(color, alpha) {
    const rgb = hexToRgb(color) || parseRgb(color);
    if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
    return color;
}

// 値のフォーマット（カンマ区切り・小数桁）
function fmtValue(n, decimals) {
    if (!Number.isFinite(n)) return 'N/A';
    if (Math.abs(n) >= 1e15) return n.toExponential(2);
    const d = clamp(Math.round(decimals) || 0, 0, 6);
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// CJK を含むかで文字幅を推定（値ラベルのチップ幅算出用の近似）
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        w += cp > 0x2e7f ? fontSize : fontSize * 0.62;
    }
    return w;
}

// ---------------------------------------------------------------------------
// オプション正規化（型・範囲を安全側へ）
// ---------------------------------------------------------------------------

function normalizeOptions(raw) {
    const o = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const bool = (v, d) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);
    const numOr = (v, d) => {
        const n = parseNum(v);
        return Number.isFinite(n) ? n : d;
    };
    const colorOr = (v, d) => (hexToRgb(v) ? v : d);

    return {
        valueField: typeof o.valueField === 'string' || Array.isArray(o.valueField) ? o.valueField : '',

        linePoints: typeof o.linePoints === 'string' ? o.linePoints : '',
        cornerRadius: clamp(numOr(o.cornerRadius, DEFAULTS.cornerRadius), 0, 300),
        allowViewEdit: bool(o.allowViewEdit, DEFAULTS.allowViewEdit),

        styleMode: clamp(Math.round(numOr(o.styleMode, DEFAULTS.styleMode)), 1, 4),
        lineWidth: clamp(numOr(o.lineWidth, DEFAULTS.lineWidth), 1, 40),
        lineGradient: bool(o.lineGradient, DEFAULTS.lineGradient),
        dashLength: clamp(numOr(o.dashLength, DEFAULTS.dashLength), 0, 200),
        flowSpeed: clamp(numOr(o.flowSpeed, DEFAULTS.flowSpeed), 0, 10),
        pulseCaps: bool(o.pulseCaps, DEFAULTS.pulseCaps),
        lineOpacity: clamp(numOr(o.lineOpacity, DEFAULTS.lineOpacity), 10, 100),

        showEndCaps: bool(o.showEndCaps, DEFAULTS.showEndCaps),
        arrowHead: bool(o.arrowHead, DEFAULTS.arrowHead),
        showValue: bool(o.showValue, DEFAULTS.showValue),
        valueDecimals: clamp(Math.round(numOr(o.valueDecimals, DEFAULTS.valueDecimals)), 0, 6),

        colorMethod: o.colorMethod === 'match' ? 'match' : 'range',
        colorBands: typeof o.colorBands === 'string' ? o.colorBands : '',
        colorMatches: typeof o.colorMatches === 'string' ? o.colorMatches : '',
        useThresholds: bool(o.useThresholds, DEFAULTS.useThresholds),
        baseColor: colorOr(o.baseColor, DEFAULTS.baseColor),
        threshold1: numOr(o.threshold1, DEFAULTS.threshold1),
        color1: colorOr(o.color1, DEFAULTS.color1),
        threshold2: numOr(o.threshold2, DEFAULTS.threshold2),
        color2: colorOr(o.color2, DEFAULTS.color2),
        threshold3: numOr(o.threshold3, DEFAULTS.threshold3),
        color3: colorOr(o.color3, DEFAULTS.color3),

        debug: bool(o.debug, DEFAULTS.debug),
    };
}

// ---------------------------------------------------------------------------
// データ正規化（rows / columns 両形式・マルチバリュー救済）
// ---------------------------------------------------------------------------

function normalizeData(data) {
    try {
        if (!data) return [];
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
    try {
        return (data?.fields || []).map((f) => (typeof f === 'string' ? f : f?.name || ''));
    } catch (e) {
        return [];
    }
}

// editor.columnSelector は選択結果を DOS 文字列（"> primary | seriesByName('x')"）で書く。
// カスタム viz には未解決で届くので自前パース。将来ホストが配列で渡す場合にも対応。
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

// Splunk のマルチバリューセルを平行展開して救済（トークン数一致時のみ）
function cellTokens(c) {
    if (Array.isArray(c)) return c;
    if (typeof c === 'string' && c.includes('\n')) return c.split('\n');
    return [c];
}

function expandMultivalueRows(rows) {
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
        if (tokens.every((t) => t.length === L)) {
            for (let k = 0; k < L; k += 1) out.push(tokens.map((t) => t[k]));
        } else {
            out.push(new Array(row.length).fill(null));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// シングルバリュー抽出（値フィールドの最終行。既定は「数値を含む最後の列」）
// ---------------------------------------------------------------------------

function extractValue(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount === 0) return { value: NaN, valIdx: -1 };

    let fallback = -1;
    for (let c = colCount - 1; c >= 0 && fallback < 0; c -= 1) {
        for (const row of rows) {
            if (Array.isArray(row) && Number.isFinite(parseNum(row[c]))) {
                fallback = c;
                break;
            }
        }
    }
    const valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, fallback >= 0 ? fallback : colCount - 1);

    // 数値（最終行から遡って最初の有限値）と、生の文字列値（最終行から遡って最初の非空セル。
    // 「一致」方式の照合や、非数値のラベル表示に使う）
    let value = NaN;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (!Array.isArray(row)) continue;
        const v = parseNum(row[valIdx]);
        if (Number.isFinite(v)) {
            value = v;
            break;
        }
    }
    let raw = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (!Array.isArray(row)) continue;
        const cell = row[valIdx];
        if (cell !== null && cell !== undefined && String(cell).trim() !== '') {
            raw = String(cell).trim();
            break;
        }
    }
    return { value, valIdx, raw };
}

// ---------------------------------------------------------------------------
// 値→色（動的色設定＝範囲バンド優先、無ければ簡易しきい値）
// 標準の editor.dynamicColor はカスタム viz に編集内容が渡らない（ホスト専用の
// context に保存され options に来ない）ため、標準パネルと同じ操作感の
// 「範囲を＋で追加する」エディタを viz 内（表示画面）に自前実装している。
// ---------------------------------------------------------------------------

// colorBands JSON（[[from, "#rrggbb"], ..., [null, "#rrggbb"]]。from 降順・null=「より小さい」）
function parseColorBands(str) {
    if (typeof str !== 'string' || str.trim() === '') return null;
    try {
        const arr = JSON.parse(str);
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const bands = [];
        for (const it of arr) {
            let from;
            let color;
            if (Array.isArray(it)) {
                from = it[0];
                color = it[1];
            } else if (it && typeof it === 'object') {
                from = it.from;
                color = it.color;
            } else {
                return null;
            }
            if (!hexToRgb(color)) return null;
            if (from === null || from === undefined || from === '') {
                bands.push({ from: null, color });
            } else {
                const n = parseNum(from);
                if (!Number.isFinite(n)) return null;
                bands.push({ from: n, color });
            }
        }
        // from 降順・「より小さい」(null) は最後
        bands.sort((a, b) => {
            if (a.from === null) return 1;
            if (b.from === null) return -1;
            return b.from - a.from;
        });
        return bands;
    } catch (e) {
        return null;
    }
}

function serializeColorBands(bands) {
    return JSON.stringify(bands.map((b) => [b.from, b.color]));
}

// 一致（値の完全一致 → 色）の JSON（[["key", "#rrggbb"], ...]）
function parseColorMatches(str) {
    if (typeof str !== 'string' || str.trim() === '') return null;
    try {
        const arr = JSON.parse(str);
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const matches = [];
        for (const it of arr) {
            let key;
            let color;
            if (Array.isArray(it)) {
                key = it[0];
                color = it[1];
            } else if (it && typeof it === 'object') {
                key = it.key;
                color = it.color;
            } else {
                return null;
            }
            if (!hexToRgb(color)) return null;
            matches.push({ key: key === null || key === undefined ? '' : String(key), color });
        }
        return matches;
    } catch (e) {
        return null;
    }
}

function serializeColorMatches(matches) {
    return JSON.stringify(matches.map((m) => [m.key, m.color]));
}

// プリセットパレット（標準の動的色設定に倣った 7 段ランプ。左=低↓ / 右=高↑）
const RAMP_RG_DARK = ['#d13b2e', '#dd6832', '#e28f2e', '#c9a32b', '#a8b02f', '#7ca832', '#4f9c45'];
const RAMP_RG_LIGHT = ['#e06c5d', '#ea8f62', '#f0ac60', '#e3c65b', '#c1cc66', '#96bf5e', '#6fb35e'];
const RAMP_BLUE_DARK = ['#0e4d64', '#136180', '#1a769c', '#2389b8', '#3f9fc6', '#6ab6d4', '#93cbe0'];
const RAMP_BLUE_LIGHT = ['#5da7c7', '#72b3cf', '#87bfd8', '#9ccbe0', '#b1d7e8', '#c6e3f1', '#dbeff9'];

// ランプ一覧（idx 0=赤→緑, 1=緑→赤, 2=青）。dark/light はプリセットパレットのタブに対応
function getRamps(dark) {
    const rg = dark ? RAMP_RG_DARK : RAMP_RG_LIGHT;
    const blue = dark ? RAMP_BLUE_DARK : RAMP_BLUE_LIGHT;
    return [rg, [...rg].reverse(), blue];
}

// ランプをバンド行数に合わせてサンプリングして色を割り当てる
// （行は from 降順・最後が「より小さい」。上の行ほど高い値 = ランプの右端↑）
function applyRampToBands(bands, ramp) {
    const n = bands.length;
    return bands.map((b, i) => {
        const t = n <= 1 ? 0 : 1 - i / (n - 1); // 上の行 → 1、最下行 → 0
        const idx = Math.round(t * (ramp.length - 1));
        return { ...b, color: ramp[idx] };
    });
}

// 簡易しきい値オプションから同等のバンド列を作る（色設定パネルの初期値に使用）
function bandsFromFixedThresholds(opts) {
    const bands = [
        { t: opts.threshold1, c: opts.color1 },
        { t: opts.threshold2, c: opts.color2 },
        { t: opts.threshold3, c: opts.color3 },
    ]
        .filter((b) => Number.isFinite(b.t))
        .sort((a, b) => b.t - a.t)
        .map((b) => ({ from: b.t, color: b.c }));
    bands.push({ from: null, color: opts.baseColor });
    return bands;
}

function colorFromBands(value, bands) {
    for (const b of bands) {
        if (b.from === null) return b.color;
        if (value >= b.from) return b.color;
    }
    return bands[bands.length - 1].color;
}

// 色解決の入口。method='match' は生値の完全一致、'range' は範囲バンド（無ければ簡易しきい値）
function resolveLineColor(state, value, rawValue, opts) {
    if (state.method === 'match') {
        const key = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
        if (state.matches) {
            for (const m of state.matches) {
                if (m.key !== '' && m.key === key) return m.color;
            }
        }
        return NEUTRAL_COLOR;
    }
    if (!Number.isFinite(value)) return NEUTRAL_COLOR;
    if (state.bands && state.bands.length > 0) return colorFromBands(value, state.bands);
    return colorForValue(value, opts);
}

function colorForValue(value, opts) {
    if (!Number.isFinite(value)) return NEUTRAL_COLOR;
    const bands = parseColorBands(opts.colorBands);
    if (bands) return colorFromBands(value, bands);
    if (!opts.useThresholds) return opts.baseColor;
    const fixed = [
        { t: opts.threshold1, c: opts.color1 },
        { t: opts.threshold2, c: opts.color2 },
        { t: opts.threshold3, c: opts.color3 },
    ]
        .filter((b) => Number.isFinite(b.t))
        .sort((a, b) => a.t - b.t);
    let col = opts.baseColor;
    for (const b of fixed) {
        if (value >= b.t) col = b.c;
    }
    return col;
}

// ---------------------------------------------------------------------------
// 線の幾何（点列 JSON・角丸パス・中点/終端角度）
// ---------------------------------------------------------------------------

function parsePoints(str) {
    if (typeof str !== 'string' || str.trim() === '') return null;
    try {
        const arr = JSON.parse(str);
        if (!Array.isArray(arr)) return null;
        const pts = [];
        for (const it of arr) {
            let x;
            let y;
            if (Array.isArray(it)) {
                x = parseNum(it[0]);
                y = parseNum(it[1]);
            } else if (it && typeof it === 'object') {
                x = parseNum(it.x);
                y = parseNum(it.y);
            }
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            pts.push({ x: clamp01(x), y: clamp01(y) });
        }
        return pts.length >= 2 ? pts : null;
    } catch (e) {
        return null;
    }
}

function serializePoints(pts) {
    return JSON.stringify(pts.map((p) => [Math.round(p.x * 10000) / 10000, Math.round(p.y * 10000) / 10000]));
}

// 折れ点を角丸にしたパス（radius は両隣セグメント長の半分まで）
function roundedPathD(pts, radius) {
    if (!pts || pts.length < 2) return '';
    const fmt = (n) => Math.round(n * 100) / 100;
    let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
    for (let i = 1; i < pts.length - 1; i += 1) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const v1 = { x: p1.x - p0.x, y: p1.y - p0.y };
        const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
        const len1 = Math.hypot(v1.x, v1.y);
        const len2 = Math.hypot(v2.x, v2.y);
        const rr = Math.min(radius, len1 / 2, len2 / 2);
        if (rr < 0.5 || len1 < 1e-6 || len2 < 1e-6) {
            d += ` L ${fmt(p1.x)} ${fmt(p1.y)}`;
            continue;
        }
        const a = { x: p1.x - (v1.x / len1) * rr, y: p1.y - (v1.y / len1) * rr };
        const b = { x: p1.x + (v2.x / len2) * rr, y: p1.y + (v2.y / len2) * rr };
        d += ` L ${fmt(a.x)} ${fmt(a.y)} Q ${fmt(p1.x)} ${fmt(p1.y)} ${fmt(b.x)} ${fmt(b.y)}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
    return d;
}

// ポリライン全長・中点座標・終端角度（角丸は無視した近似で十分）
function polylineGeometry(pts) {
    let total = 0;
    const segs = [];
    for (let i = 0; i < pts.length - 1; i += 1) {
        const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        segs.push(len);
        total += len;
    }
    let mid = { ...pts[0] };
    let acc = 0;
    for (let i = 0; i < segs.length; i += 1) {
        if (acc + segs[i] >= total / 2) {
            const t = segs[i] > 0 ? (total / 2 - acc) / segs[i] : 0;
            mid = {
                x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
                y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
            };
            break;
        }
        acc += segs[i];
    }
    const pA = pts[pts.length - 2] || pts[0];
    const pB = pts[pts.length - 1];
    const endAngle = Math.atan2(pB.y - pA.y, pB.x - pA.x);
    return { total, mid, endAngle };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function LinkLine({ mode }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const options = optionsApi?.options;
    const setOptions = optionsApi?.setOptions;
    const modeApi = useMode();
    const isEdit = modeApi?.mode === 'edit';

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const extracted = useMemo(() => extractValue(rows, fieldNames, opts), [rows, fieldNames, opts]);
    const value = extracted.value;

    // コンテナ実寸の計測（線は正規化座標なのでリサイズに追従する）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 360, h: 140 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 360;
        const h = el.clientHeight || 140;
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

    // --- 線の点列（options ⇔ 編集ドラフト） ---
    const optsPts = useMemo(() => parsePoints(opts.linePoints) || DEFAULT_POINTS, [opts.linePoints]);
    const [draft, setDraft] = useState(null); // 編集中のローカル点列（null = options 由来）
    const dragRef = useRef(null); // { idx, work, moved } ドラッグ中の状態
    const lastSavedRef = useRef(null); // 直近 setOptions した linePoints JSON（echo と外部変更の区別用）
    // 直近 setOptions した色設定（echo と外部変更の区別用）
    const lastColorRef = useRef({ bands: null, matches: null, method: null });

    // 表示モードで行った変更のうち、まだホストの options に反映されていないもの。
    // ホストによっては表示モード中の setOptions が保存対象に取り込まれないため、
    // ここに保持しておき「編集モードに入った瞬間」に再送（flush）して確定させる。
    const pendingRef = useRef({}); // { linePoints? / colorBands? / colorMatches? / colorMethod? }

    // 最新の options / setOptions を effect から stale なく参照するためのミラー
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const setOptionsRef = useRef(setOptions);
    setOptionsRef.current = setOptions;

    // 外部で linePoints が変わったら（undo・リセット・他画面での編集）、ドラッグ中でなければ追従する。
    // 自分の保存の echo なら pending を消し込む
    useEffect(() => {
        const incoming = typeof opts.linePoints === 'string' ? opts.linePoints : '';
        if (pendingRef.current.linePoints !== undefined && incoming === pendingRef.current.linePoints) {
            delete pendingRef.current.linePoints; // ホストに反映された
        }
        if (dragRef.current) return;
        if (incoming !== lastSavedRef.current) {
            setDraft(null);
            delete pendingRef.current.linePoints;
        }
    }, [opts.linePoints]);

    // 色設定 3 オプションも同様（echo 消し込み・外部変更でドラフト破棄）
    useEffect(() => {
        const pairs = [
            ['colorBands', opts.colorBands, lastColorRef.current.bands],
            ['colorMatches', opts.colorMatches, lastColorRef.current.matches],
            ['colorMethod', opts.colorMethod, lastColorRef.current.method],
        ];
        let external = false;
        for (const [key, val, last] of pairs) {
            const incoming = typeof val === 'string' ? val : '';
            if (pendingRef.current[key] !== undefined && incoming === pendingRef.current[key]) {
                delete pendingRef.current[key];
            }
            if (last !== null && incoming !== last) external = true;
        }
        if (external) {
            setColorDraft(null);
            delete pendingRef.current.colorBands;
            delete pendingRef.current.colorMatches;
            delete pendingRef.current.colorMethod;
            lastColorRef.current = { bands: null, matches: null, method: null };
        }
    }, [opts.colorBands, opts.colorMatches, opts.colorMethod]);

    // 表示モードでの線編集トグル（編集モード中は iframe への入力がホストに遮断されるため、
    // 線のドラッグ編集・色設定は表示モードで行う）
    const [unlocked, setUnlocked] = useState(false);
    const lineEditActive = !isEdit && unlocked && opts.allowViewEdit;

    // 動的色設定パネル（標準の dynamicColor 相当を viz 内で再現）
    // colorDraft = { method: 'range'|'match', bands: [...], matches: [{key,color}] } | null
    const [colorEditorOpen, setColorEditorOpen] = useState(false);
    const [colorDraft, setColorDraft] = useState(null);
    const [paletteDark, setPaletteDark] = useState(true); // プリセットパレットのダーク/ライト
    const [rampIdx, setRampIdx] = useState(0); // 選択中ランプ（0=赤→緑,1=緑→赤,2=青）
    const [rampMenuOpen, setRampMenuOpen] = useState(false);

    // モードが切り替わったら編集 UI を閉じる。ドラフトは破棄しない（表示モードの変更を
    // 編集モードへ持ち越し、下の flush effect で確定させるため）
    useEffect(() => {
        setUnlocked(false);
        setColorEditorOpen(false);
    }, [isEdit]);

    // ★編集モードに入った瞬間、表示モードで行った未確定の変更（pending）を setOptions で再送する。
    // ホストによっては表示モード中の setOptions がダッシュボード定義に取り込まれず、
    // 編集モードに入ると線が元に戻る（実機で確認）。モード変化イベントは iframe に届き続ける
    // （= iframe は view→edit で生存する）ため、編集モードの正規ルートで送り直せば
    // 定義が dirty になり「保存」で永続化される。
    useEffect(() => {
        if (!isEdit) return;
        const raw = optionsRef.current && typeof optionsRef.current === 'object' ? optionsRef.current : {};
        const patch = {};
        const pend = pendingRef.current;
        if (pend.linePoints !== undefined && pend.linePoints !== (typeof raw.linePoints === 'string' ? raw.linePoints : '')) {
            patch.linePoints = pend.linePoints;
        }
        for (const key of ['colorBands', 'colorMatches', 'colorMethod']) {
            if (pend[key] !== undefined && pend[key] !== (typeof raw[key] === 'string' ? raw[key] : '')) {
                patch[key] = pend[key];
            }
        }
        if (Object.keys(patch).length > 0 && typeof setOptionsRef.current === 'function') {
            setOptionsRef.current({ ...raw, ...patch });
        }
    }, [isEdit]);

    const points = draft || optsPts;
    const ptsRef = useRef(points);
    ptsRef.current = points;

    const savePoints = useCallback(
        (pts) => {
            const json = serializePoints(pts);
            lastSavedRef.current = json;
            pendingRef.current.linePoints = json;
            setDraft(pts.map((p) => ({ ...p })));
            if (typeof setOptions === 'function') {
                setOptions({ ...(options && typeof options === 'object' ? options : {}), linePoints: json });
            }
        },
        [setOptions, options]
    );

    // ドラッグ開始（点 idx を basePts から動かす）。pointer/mouse 両対応・window 捕捉
    const startDragAt = useCallback(
        (idx, basePts) => (ev) => {
            if (!lineEditActive || dragRef.current) return;
            if (ev) {
                if (typeof ev.preventDefault === 'function') ev.preventDefault();
                if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
            }
            const w = typeof window !== 'undefined' ? window : null;
            if (!w) return;
            const work = basePts.map((p) => ({ ...p }));
            dragRef.current = { idx, work, moved: false };
            setDraft(work.map((p) => ({ ...p })));

            const onMove = (mv) => {
                const st = dragRef.current;
                if (!st || typeof mv.clientX !== 'number') return;
                const el = containerRef.current;
                if (!el || typeof el.getBoundingClientRect !== 'function') return;
                const rect = el.getBoundingClientRect();
                if (!rect || !rect.width || !rect.height) return;
                const nx = clamp((mv.clientX - rect.left) / rect.width, 0.01, 0.99);
                const ny = clamp((mv.clientY - rect.top) / rect.height, 0.02, 0.98);
                st.work[st.idx] = { x: nx, y: ny };
                st.moved = true;
                setDraft(st.work.map((p) => ({ ...p })));
            };
            const onUp = () => {
                const st = dragRef.current;
                ['pointermove', 'mousemove'].forEach((t) => w.removeEventListener(t, onMove));
                ['pointerup', 'mouseup'].forEach((t) => w.removeEventListener(t, onUp));
                if (!st) return;
                dragRef.current = null;
                savePoints(st.work);
            };
            ['pointermove', 'mousemove'].forEach((t) => w.addEventListener(t, onMove));
            ['pointerup', 'mouseup'].forEach((t) => w.addEventListener(t, onUp));
        },
        [lineEditActive, savePoints]
    );

    // セグメント i の中点に折れ点を追加し、そのままドラッグ開始
    const startInsertAt = useCallback(
        (i) => (ev) => {
            if (!lineEditActive || dragRef.current) return;
            const cur = ptsRef.current;
            if (!cur[i] || !cur[i + 1]) return;
            const midPt = { x: (cur[i].x + cur[i + 1].x) / 2, y: (cur[i].y + cur[i + 1].y) / 2 };
            const next = [...cur.slice(0, i + 1), midPt, ...cur.slice(i + 1)];
            startDragAt(i + 1, next)(ev);
        },
        [lineEditActive, startDragAt]
    );

    // 中間の点をダブルクリックで削除（端点は残す）
    const removeAt = useCallback(
        (idx) => {
            const cur = ptsRef.current;
            if (idx <= 0 || idx >= cur.length - 1 || cur.length <= 2) return;
            const next = cur.filter((_, i) => i !== idx);
            savePoints(next);
        },
        [savePoints]
    );

    const resetPoints = useCallback(() => {
        lastSavedRef.current = '';
        pendingRef.current.linePoints = '';
        setDraft(null);
        if (typeof setOptions === 'function') {
            setOptions({ ...(options && typeof options === 'object' ? options : {}), linePoints: '' });
        }
    }, [setOptions, options]);

    // --- 動的色設定パネルの操作（変更は即 setOptions で保存） ---
    // 現在の色設定（ドラフトが無ければ options から構築）
    const buildColorState = useCallback(
        () => ({
            method: opts.colorMethod,
            bands: parseColorBands(opts.colorBands) || bandsFromFixedThresholds(opts),
            matches: parseColorMatches(opts.colorMatches) || [{ key: '', color: '#53a051' }],
        }),
        [opts]
    );

    const saveColor = useCallback(
        (next) => {
            const bandsJson = serializeColorBands(next.bands);
            const matchesJson = serializeColorMatches(next.matches);
            const method = next.method === 'match' ? 'match' : 'range';
            lastColorRef.current = { bands: bandsJson, matches: matchesJson, method };
            pendingRef.current.colorBands = bandsJson;
            pendingRef.current.colorMatches = matchesJson;
            pendingRef.current.colorMethod = method;
            setColorDraft(next);
            if (typeof setOptions === 'function') {
                setOptions({
                    ...(options && typeof options === 'object' ? options : {}),
                    colorBands: bandsJson,
                    colorMatches: matchesJson,
                    colorMethod: method,
                });
            }
        },
        [setOptions, options]
    );

    const toggleColorEditor = useCallback(() => {
        setColorEditorOpen((open) => {
            if (!open) {
                setColorDraft((d) => d || buildColorState());
                setRampMenuOpen(false);
            }
            return !open;
        });
    }, [buildColorState]);

    // ドラフトを変換して保存（bands は from 降順・null 最後を維持）
    const colorMutate = useCallback(
        (fn) => {
            const cur = colorDraft || buildColorState();
            const next = fn({
                method: cur.method,
                bands: cur.bands.map((b) => ({ ...b })),
                matches: cur.matches.map((m) => ({ ...m })),
            });
            next.bands.sort((a, b) => {
                if (a.from === null) return 1;
                if (b.from === null) return -1;
                return b.from - a.from;
            });
            saveColor(next);
        },
        [colorDraft, buildColorState, saveColor]
    );

    const revertColorToDefault = useCallback(() => {
        lastColorRef.current = { bands: '', matches: '', method: 'range' };
        pendingRef.current.colorBands = '';
        pendingRef.current.colorMatches = '';
        pendingRef.current.colorMethod = 'range';
        setColorDraft(null);
        setColorEditorOpen(false);
        if (typeof setOptions === 'function') {
            setOptions({
                ...(options && typeof options === 'object' ? options : {}),
                colorBands: '',
                colorMatches: '',
                colorMethod: 'range',
            });
        }
    }, [setOptions, options]);

    // --- アニメーション（rAF で stroke-dashoffset / 端点パルスを直接更新） ---
    const svgRef = useRef(null);
    const speedRef = useRef(opts.flowSpeed);
    speedRef.current = opts.flowSpeed;
    const flowActive = opts.flowSpeed > 0;
    const animActive = flowActive || opts.pulseCaps;
    useEffect(() => {
        if (!animActive || typeof requestAnimationFrame === 'undefined') return undefined;
        let raf = 0;
        let prev = null;
        let off = 0;
        let tSec = 0;
        const step = (ts) => {
            if (prev === null) prev = ts;
            const dt = Math.min(0.1, Math.max(0, (ts - prev) / 1000));
            prev = ts;
            off += dt * speedRef.current * 60; // 速度1 ≒ 60px/秒
            tSec += dt;
            const rootEl = svgRef.current;
            if (rootEl && typeof rootEl.querySelectorAll === 'function') {
                rootEl.querySelectorAll('[data-anim="dash"]').forEach((el) => {
                    const period = parseNum(el.getAttribute('data-period'));
                    const p = Number.isFinite(period) && period > 0 ? period : 60;
                    el.setAttribute('stroke-dashoffset', String(-(off % p)));
                });
                rootEl.querySelectorAll('[data-anim="pulse"]').forEach((el) => {
                    const period = parseNum(el.getAttribute('data-period')) || 2.4;
                    const base = parseNum(el.getAttribute('data-base')) || 8;
                    const amp = parseNum(el.getAttribute('data-amp')) || 12;
                    const phase = (tSec % period) / period;
                    el.setAttribute('r', String(base + amp * phase));
                    el.setAttribute('opacity', String((1 - phase) * 0.5));
                });
            }
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [animActive]);

    // --- 幾何・色の算出 ---
    const { w, h } = dims;
    const pxPts = points.map((p) => ({ x: p.x * w, y: p.y * h }));
    const pathD = roundedPathD(pxPts, opts.cornerRadius);
    const geo = polylineGeometry(pxPts);
    // 色: ドラフト（パネル編集中）があればそれを優先してライブプレビュー
    // （ホストが表示モードの setOptions を反映しない環境でも見た目が追従する）
    const rawValue = extracted.raw;
    const colorState = colorDraft || {
        method: opts.colorMethod,
        bands: parseColorBands(opts.colorBands),
        matches: parseColorMatches(opts.colorMatches),
    };
    const color = resolveLineColor(colorState, value, rawValue, opts);
    const lw = opts.lineWidth;

    // 端点と全体方向（グラデーション・パイプのハイライトオフセットに使用）
    const startPt = pxPts[0];
    const endPt = pxPts[pxPts.length - 1];
    const overallAngle = Math.atan2(endPt.y - startPt.y, endPt.x - startPt.x);
    const perp = { x: Math.sin(overallAngle), y: -Math.cos(overallAngle) }; // 進行方向の左手（≒上）側

    // 破線と流れアニメーション:
    //   dashLength > 0 → 本体を破線にし、flowSpeed > 0 ならその破線を流す
    //   dashLength = 0 → 実線。flowSpeed > 0 なら明るい粒（オーバーレイ破線）を流す
    const dashGap = Math.max(2, Math.round(opts.dashLength * 0.75));
    const dashArr = opts.dashLength > 0 ? `${opts.dashLength} ${dashGap}` : undefined;
    const mainPeriod = opts.dashLength > 0 ? opts.dashLength + dashGap : 0;
    const useFlowOverlay = flowActive && opts.dashLength === 0;
    const flowDot = Math.max(3, lw * 1.1);
    const flowGap = Math.max(10, flowDot * 3);
    const flowPeriod = flowDot + flowGap;

    // 質感ごとのストロークレイヤー（下から順に描画）。
    // strokePaint は始点→終点の淡いグラデーション（立体感）。lineGradient オフで単色
    const strokePaint = opts.lineGradient ? 'url(#llGrad)' : color;
    const layers = [];
    if (opts.styleMode === 3) {
        // ネオン発光: ガウスぼかしのハロー2層 + 本体 + 明るい芯
        layers.push({ key: 'halo1', w: lw * 2.6, c: withAlpha(color, 0.5), filter: 'url(#llBlurWide)', opacity: 0.55 });
        layers.push({ key: 'halo2', w: lw * 1.35, c: withAlpha(color, 0.85), filter: 'url(#llBlurTight)', opacity: 0.8 });
        layers.push({ key: 'main', w: lw, c: strokePaint, main: true });
        layers.push({ key: 'core', w: Math.max(1, lw * 0.34), c: mixColor(color, '#ffffff', 0.65), dashed: true });
    } else if (opts.styleMode === 4) {
        // 立体パイプ: 暗い縁 + 本体 + 上側に寄せたスペキュラハイライト
        layers.push({ key: 'edge', w: lw * 1.45, c: mixColor(color, '#000000', 0.5) });
        layers.push({ key: 'main', w: lw, c: strokePaint, main: true });
        layers.push({
            key: 'core',
            w: Math.max(1, lw * 0.28),
            c: mixColor(color, '#ffffff', 0.7),
            dashed: true,
            opacity: 0.85,
            offsetPerp: lw * 0.22,
        });
    } else if (opts.styleMode === 2) {
        // ソフトシャドウ
        layers.push({ key: 'main', w: lw, c: strokePaint, main: true, shadow: true });
    } else {
        // フラット（ミニマル）
        layers.push({ key: 'main', w: lw, c: strokePaint, main: true });
    }

    // 端点・矢印・値ラベル
    const capR = clamp(lw * 0.8 + 3, 6, 24);
    const arrowLen = Math.max(11, lw * 2.3);
    const cosA = Math.cos(geo.endAngle);
    const sinA = Math.sin(geo.endAngle);
    const arrowW = arrowLen * 0.5;
    const arrowBx = endPt.x - cosA * arrowLen;
    const arrowBy = endPt.y - sinA * arrowLen;
    // シェブロン（凧型）矢印: 先端 → 左羽 → 内側ノッチ → 右羽
    const arrowD =
        `M ${endPt.x} ${endPt.y} ` +
        `L ${arrowBx - sinA * arrowW} ${arrowBy + cosA * arrowW} ` +
        `L ${endPt.x - cosA * arrowLen * 0.72} ${endPt.y - sinA * arrowLen * 0.72} ` +
        `L ${arrowBx + sinA * arrowW} ${arrowBy - cosA * arrowW} Z`;

    // 数値はフォーマット、非数値（「一致」方式の文字列値など）は生値を表示
    const labelText = Number.isFinite(value)
        ? fmtValue(value, opts.valueDecimals)
        : rawValue
          ? rawValue.length > 14
              ? `${rawValue.slice(0, 13)}…`
              : rawValue
          : 'N/A';
    const labelFont = clamp(11.5 + lw * 0.35, 11, 20);
    const chipH = labelFont + 12;
    const chipDotR = Math.max(3, labelFont * 0.26);
    const chipW = estimateTextWidth(labelText, labelFont) + chipDotR * 2 + labelFont * 1.7;
    const chipBg = mode === 'dark' ? 'rgba(10,14,26,0.88)' : 'rgba(255,255,255,0.92)';
    // dataviz 原則: テキストは系列色でなくインク色。色の識別はチップ内のドットが担う
    const chipInk = mode === 'dark' ? 'rgba(228,234,244,0.95)' : 'rgba(28,36,48,0.92)';

    const hintColor = mode === 'dark' ? 'rgba(220,228,240,0.75)' : 'rgba(40,50,60,0.7)';
    const chromeBg = mode === 'dark' ? 'rgba(13,16,32,0.85)' : 'rgba(255,255,255,0.9)';
    const chromeBorder = mode === 'dark' ? 'rgba(139,147,161,0.5)' : 'rgba(90,100,110,0.4)';
    const handleFill = mode === 'dark' ? '#0e1424' : '#ffffff';
    const panelBg = mode === 'dark' ? 'rgba(13,16,32,0.97)' : 'rgba(255,255,255,0.98)';
    const chipStyle = {
        padding: '4px 11px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        borderRadius: 8,
        background: chromeBg,
        border: `1px solid ${chromeBorder}`,
        color: hintColor,
        cursor: 'pointer',
        userSelect: 'none',
        boxShadow: mode === 'dark' ? '0 2px 10px rgba(0,0,0,0.35)' : '0 2px 10px rgba(20,30,40,0.12)',
    };

    return (
        <div
            ref={setContainer}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden',
                background: 'transparent', // どのダッシュボードにも馴染むよう背景は持たない
                fontFamily: FONT_STACK,
            }}
        >
            <svg
                ref={svgRef}
                width={w}
                height={h}
                viewBox={`0 0 ${w} ${h}`}
                style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
            >
                <defs>
                    <linearGradient
                        id="llGrad"
                        gradientUnits="userSpaceOnUse"
                        x1={startPt.x}
                        y1={startPt.y}
                        x2={endPt.x}
                        y2={endPt.y}
                    >
                        <stop offset="0%" stopColor={mixColor(color, '#ffffff', 0.3)} />
                        <stop offset="55%" stopColor={color} />
                        <stop offset="100%" stopColor={mixColor(color, '#000000', 0.22)} />
                    </linearGradient>
                    <filter id="llShadow" x="-40%" y="-40%" width="180%" height="180%">
                        <feDropShadow
                            dx="0"
                            dy="1.5"
                            stdDeviation="2.6"
                            floodColor="#000000"
                            floodOpacity={mode === 'dark' ? 0.55 : 0.22}
                        />
                    </filter>
                    <filter id="llBlurTight" x="-80%" y="-80%" width="260%" height="260%">
                        <feGaussianBlur stdDeviation={Math.max(1.5, lw * 0.45)} />
                    </filter>
                    <filter id="llBlurWide" x="-120%" y="-120%" width="340%" height="340%">
                        <feGaussianBlur stdDeviation={Math.max(3, lw * 1.1)} />
                    </filter>
                    <filter id="llChipShadow" x="-40%" y="-40%" width="180%" height="180%">
                        <feDropShadow
                            dx="0"
                            dy="1"
                            stdDeviation="2"
                            floodColor="#000000"
                            floodOpacity={mode === 'dark' ? 0.45 : 0.18}
                        />
                    </filter>
                </defs>

                <g opacity={opts.lineOpacity / 100}>
                    {/* 線本体（質感レイヤー） */}
                    {layers.map((l) => {
                        const isDashTarget = (l.main || l.dashed) && opts.dashLength > 0;
                        const animated = isDashTarget && flowActive;
                        const pathEl = (
                            <path
                                key={l.key}
                                d={pathD}
                                fill="none"
                                stroke={l.c}
                                strokeWidth={l.w}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeDasharray={isDashTarget ? dashArr : undefined}
                                opacity={l.opacity}
                                data-role={l.main ? 'main-line' : `line-${l.key}`}
                                data-anim={animated ? 'dash' : undefined}
                                data-period={animated ? mainPeriod : undefined}
                                filter={l.shadow ? 'url(#llShadow)' : l.filter}
                            />
                        );
                        if (!l.offsetPerp) return pathEl;
                        const tx = (perp.x * l.offsetPerp).toFixed(2);
                        const ty = (perp.y * l.offsetPerp).toFixed(2);
                        return (
                            <g key={`g-${l.key}`} transform={`translate(${tx} ${ty})`}>
                                {pathEl}
                            </g>
                        );
                    })}

                    {/* 流れる粒（実線のときのオーバーレイ。ぼかした下層＋シャープな粒の2層） */}
                    {useFlowOverlay && (
                        <g data-role="flow-group">
                            <path
                                d={pathD}
                                fill="none"
                                stroke={withAlpha(mixColor(color, '#ffffff', 0.5), 0.55)}
                                strokeWidth={Math.max(3.5, lw * 0.85)}
                                strokeLinecap="round"
                                strokeDasharray={`${flowDot} ${flowGap}`}
                                filter="url(#llBlurTight)"
                                data-role="flow-glow"
                                data-anim="dash"
                                data-period={flowPeriod}
                            />
                            <path
                                d={pathD}
                                fill="none"
                                stroke={mixColor(color, '#ffffff', 0.75)}
                                strokeWidth={Math.max(2, lw * 0.4)}
                                strokeLinecap="round"
                                strokeDasharray={`${flowDot} ${flowGap}`}
                                opacity={0.95}
                                data-role="flow"
                                data-anim="dash"
                                data-period={flowPeriod}
                            />
                        </g>
                    )}

                    {/* 端点コネクタ（ポート風: 淡いハロー＋面フィルのリング＋色のコアドット） */}
                    {opts.showEndCaps &&
                        [startPt, ...(opts.arrowHead ? [] : [endPt])].map((p, i) => (
                            <g key={`cap${i}`} data-role="endcap">
                                {opts.styleMode === 3 && (
                                    <circle
                                        cx={p.x}
                                        cy={p.y}
                                        r={capR * 1.9}
                                        fill={withAlpha(color, 0.3)}
                                        filter="url(#llBlurTight)"
                                    />
                                )}
                                <circle cx={p.x} cy={p.y} r={capR * 1.6} fill={withAlpha(color, 0.14)} />
                                <circle
                                    cx={p.x}
                                    cy={p.y}
                                    r={capR}
                                    fill={mode === 'dark' ? '#0c111e' : '#ffffff'}
                                    stroke={color}
                                    strokeWidth={Math.max(1.5, lw * 0.26)}
                                    filter="url(#llChipShadow)"
                                />
                                <circle cx={p.x} cy={p.y} r={capR * 0.42} fill={color} />
                                {opts.pulseCaps && (
                                    <circle
                                        cx={p.x}
                                        cy={p.y}
                                        r={capR}
                                        fill="none"
                                        stroke={color}
                                        strokeWidth={1.5}
                                        opacity={0}
                                        data-anim="pulse"
                                        data-base={capR}
                                        data-amp={capR * 1.7}
                                        data-period="2.4"
                                    />
                                )}
                            </g>
                        ))}

                    {/* 終点の矢印（シェブロン形状） */}
                    {opts.arrowHead && (
                        <path
                            d={arrowD}
                            fill={color}
                            stroke={mixColor(color, '#000000', 0.25)}
                            strokeWidth={1}
                            strokeLinejoin="round"
                            data-role="arrow"
                        />
                    )}

                    {/* 値ラベル（線の中央。インク色テキスト＋色ドットのチップ） */}
                    {opts.showValue && (
                        <g data-role="value-label">
                            <rect
                                x={geo.mid.x - chipW / 2}
                                y={geo.mid.y - chipH / 2}
                                width={chipW}
                                height={chipH}
                                rx={chipH / 2}
                                fill={chipBg}
                                stroke={withAlpha(color, 0.45)}
                                strokeWidth={1}
                                filter="url(#llChipShadow)"
                            />
                            <circle cx={geo.mid.x - chipW / 2 + chipH / 2} cy={geo.mid.y} r={chipDotR} fill={color} />
                            <text
                                x={geo.mid.x - chipW / 2 + chipH / 2 + chipDotR + labelFont * 0.45}
                                y={geo.mid.y}
                                textAnchor="start"
                                dominantBaseline="central"
                                fontSize={labelFont}
                                fontWeight={650}
                                letterSpacing="0.2"
                                fill={chipInk}
                                style={{ fontFamily: FONT_STACK }}
                            >
                                {labelText}
                            </text>
                        </g>
                    )}
                </g>

                {/* 線編集（表示モード・トグルON）: 点ハンドルと「＋」（追加）ハンドル */}
                {lineEditActive && (
                    <g style={{ pointerEvents: 'auto' }} data-role="edit-layer">
                        {pxPts.slice(0, -1).map((p, i) => {
                            const q = pxPts[i + 1];
                            const mx = (p.x + q.x) / 2;
                            const my = (p.y + q.y) / 2;
                            return (
                                <g
                                    key={`mid${i}`}
                                    data-role="midpoint"
                                    onPointerDown={startInsertAt(i)}
                                    onMouseDown={startInsertAt(i)}
                                    style={{ cursor: 'crosshair' }}
                                >
                                    <circle
                                        cx={mx}
                                        cy={my}
                                        r={6.5}
                                        fill={withAlpha(color, 0.18)}
                                        stroke={color}
                                        strokeWidth={1.2}
                                        strokeDasharray="2 2"
                                    />
                                    <path
                                        d={`M ${mx - 3} ${my} L ${mx + 3} ${my} M ${mx} ${my - 3} L ${mx} ${my + 3}`}
                                        stroke={color}
                                        strokeWidth={1.4}
                                        strokeLinecap="round"
                                    />
                                </g>
                            );
                        })}
                        {pxPts.map((p, i) => {
                            const isEndpoint = i === 0 || i === pxPts.length - 1;
                            return (
                                <circle
                                    key={`v${i}`}
                                    data-role="vertex"
                                    cx={p.x}
                                    cy={p.y}
                                    r={isEndpoint ? 8.5 : 7.5}
                                    fill={handleFill}
                                    stroke={color}
                                    strokeWidth={isEndpoint ? 3 : 2}
                                    style={{ cursor: 'grab' }}
                                    onPointerDown={startDragAt(i, points)}
                                    onMouseDown={startDragAt(i, points)}
                                    onDoubleClick={!isEndpoint ? () => removeAt(i) : undefined}
                                />
                            );
                        })}
                    </g>
                )}
            </svg>

            {/* 表示モード: 右上のツールボタン（色設定・線編集トグル・リセット）＋操作ヒント */}
            {!isEdit && opts.allowViewEdit && (
                <>
                    <div
                        style={{
                            position: 'absolute',
                            top: 6,
                            right: 8,
                            display: 'flex',
                            gap: 6,
                            zIndex: 10,
                        }}
                    >
                        {lineEditActive && (
                            <div data-role="reset-line" onClick={resetPoints} style={chipStyle}>
                                線をリセット
                            </div>
                        )}
                        <div
                            data-role="color-toggle"
                            onClick={toggleColorEditor}
                            title="値の範囲→線の色を設定します（標準の動的色設定に相当）"
                            style={{
                                ...chipStyle,
                                border: `1px solid ${colorEditorOpen ? color : chromeBorder}`,
                                opacity: colorEditorOpen ? 1 : 0.55,
                            }}
                        >
                            🎨 色を設定
                        </div>
                        <div
                            data-role="edit-toggle"
                            onClick={() => setUnlocked((v) => !v)}
                            title={
                                lineEditActive
                                    ? '線の編集を終了します'
                                    : '線の形をこの画面でドラッグ編集します（確定はダッシュボードの「編集」→「保存」）'
                            }
                            style={{
                                ...chipStyle,
                                border: `1px solid ${lineEditActive ? color : chromeBorder}`,
                                opacity: lineEditActive ? 1 : 0.55,
                            }}
                        >
                            {lineEditActive ? '✓ 編集を終了' : '✎ 線を編集'}
                        </div>
                    </div>

                    {lineEditActive && (
                        <div
                            data-role="edit-hint"
                            style={{
                                position: 'absolute',
                                bottom: 4,
                                left: 0,
                                right: 0,
                                textAlign: 'center',
                                fontSize: 10.5,
                                color: hintColor,
                                pointerEvents: 'none',
                                userSelect: 'none',
                            }}
                        >
                            点をドラッグ＝移動 ／ ＋＝点を追加 ／ 点をダブルクリック＝削除 ｜
                            確定はダッシュボードの「編集」→「保存」
                        </div>
                    )}

                    {/* 動的色設定パネル（標準の動的色設定 UI を再現: 範囲/一致・プリセットパレット） */}
                    {colorEditorOpen &&
                        (() => {
                            const cd = colorDraft || buildColorState();
                            const ramps = getRamps(paletteDark);
                            const ramp = ramps[clamp(rampIdx, 0, ramps.length - 1)];
                            const thresholds = cd.bands.filter((b) => b.from !== null).map((b) => b.from);
                            const minFrom = thresholds.length ? Math.min(...thresholds) : '';
                            const seg = (active, left) => ({
                                flex: 1,
                                textAlign: 'center',
                                padding: '5px 0',
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: 'pointer',
                                userSelect: 'none',
                                border: `1px solid ${active ? '#5c8bff' : chromeBorder}`,
                                borderRadius: left ? '4px 0 0 4px' : '0 4px 4px 0',
                                background: active ? withAlpha('#5c8bff', 0.15) : 'transparent',
                                color: hintColor,
                                position: 'relative',
                                zIndex: active ? 1 : 0,
                                marginLeft: left ? 0 : -1,
                            });
                            const swatchStyle = {
                                width: 28,
                                height: 22,
                                padding: 0,
                                border: `1px solid ${chromeBorder}`,
                                borderRadius: 4,
                                background: 'transparent',
                                cursor: 'pointer',
                            };
                            const inputStyle = {
                                width: 64,
                                fontSize: 11,
                                padding: '3px 4px',
                                borderRadius: 4,
                                border: `1px solid ${chromeBorder}`,
                                background: 'transparent',
                                color: hintColor,
                            };
                            const xStyle = { cursor: 'pointer', padding: '0 4px', opacity: 0.8 };
                            return (
                                <div
                                    data-role="color-editor"
                                    style={{
                                        position: 'absolute',
                                        top: 34,
                                        right: 8,
                                        width: 252,
                                        maxHeight: 'calc(100% - 44px)',
                                        overflowY: 'auto',
                                        boxSizing: 'border-box',
                                        padding: 10,
                                        borderRadius: 8,
                                        background: panelBg,
                                        border: `1px solid ${chromeBorder}`,
                                        color: hintColor,
                                        fontSize: 11,
                                        zIndex: 20,
                                    }}
                                >
                                    <div style={{ fontWeight: 700, marginBottom: 8 }}>動的色設定：メジャー値</div>

                                    {/* 方式（範囲 / 一致） */}
                                    <div style={{ display: 'flex', marginBottom: 10 }}>
                                        <div
                                            data-role="method-range"
                                            onClick={() => colorMutate((d) => ({ ...d, method: 'range' }))}
                                            style={seg(cd.method === 'range', true)}
                                        >
                                            範囲
                                        </div>
                                        <div
                                            data-role="method-match"
                                            onClick={() => colorMutate((d) => ({ ...d, method: 'match' }))}
                                            style={seg(cd.method === 'match', false)}
                                        >
                                            一致
                                        </div>
                                    </div>

                                    {cd.method === 'range' ? (
                                        <>
                                            <div style={{ marginBottom: 6 }}>プリセットパレット</div>
                                            <div style={{ display: 'flex', marginBottom: 8 }}>
                                                <div
                                                    data-role="palette-dark"
                                                    onClick={() => setPaletteDark(true)}
                                                    style={seg(paletteDark, true)}
                                                >
                                                    ダークカラー
                                                </div>
                                                <div
                                                    data-role="palette-light"
                                                    onClick={() => setPaletteDark(false)}
                                                    style={seg(!paletteDark, false)}
                                                >
                                                    ライトカラー
                                                </div>
                                            </div>

                                            {/* パレットバー（クリックで各範囲へ適用）＋ ▾ で他のパレット */}
                                            <div
                                                style={{
                                                    position: 'relative',
                                                    display: 'flex',
                                                    alignItems: 'stretch',
                                                    gap: 4,
                                                    marginBottom: 8,
                                                }}
                                            >
                                                <div
                                                    data-role="palette-bar"
                                                    title="クリックで各範囲に適用"
                                                    onClick={() =>
                                                        colorMutate((d) => ({ ...d, bands: applyRampToBands(d.bands, ramp) }))
                                                    }
                                                    style={{
                                                        flex: 1,
                                                        display: 'flex',
                                                        border: `1px solid ${chromeBorder}`,
                                                        borderRadius: 4,
                                                        overflow: 'hidden',
                                                        cursor: 'pointer',
                                                    }}
                                                >
                                                    {ramp.map((c, k) => (
                                                        <div
                                                            key={`sw${k}`}
                                                            style={{
                                                                flex: 1,
                                                                height: 22,
                                                                background: c,
                                                                color: 'rgba(255,255,255,0.9)',
                                                                fontSize: 10,
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                            }}
                                                        >
                                                            {k === 0 ? '↓' : k === ramp.length - 1 ? '↑' : ''}
                                                        </div>
                                                    ))}
                                                </div>
                                                <div
                                                    data-role="palette-menu-toggle"
                                                    onClick={() => setRampMenuOpen((v) => !v)}
                                                    style={{ ...chipStyle, padding: '0 8px', display: 'flex', alignItems: 'center' }}
                                                >
                                                    ▾
                                                </div>
                                                {rampMenuOpen && (
                                                    <div
                                                        data-role="palette-menu"
                                                        style={{
                                                            position: 'absolute',
                                                            top: 26,
                                                            left: 0,
                                                            right: 0,
                                                            background: panelBg,
                                                            border: `1px solid ${chromeBorder}`,
                                                            borderRadius: 6,
                                                            padding: 6,
                                                            zIndex: 30,
                                                        }}
                                                    >
                                                        {ramps.map((r, ri) => (
                                                            <div
                                                                key={`ramp${ri}`}
                                                                data-role="palette-item"
                                                                onClick={() => {
                                                                    setRampIdx(ri);
                                                                    setRampMenuOpen(false);
                                                                    colorMutate((d) => ({
                                                                        ...d,
                                                                        bands: applyRampToBands(d.bands, r),
                                                                    }));
                                                                }}
                                                                style={{
                                                                    display: 'flex',
                                                                    marginBottom: 4,
                                                                    borderRadius: 3,
                                                                    overflow: 'hidden',
                                                                    cursor: 'pointer',
                                                                    border: `1px solid ${chromeBorder}`,
                                                                }}
                                                            >
                                                                {r.map((c, k) => (
                                                                    <div key={`c${k}`} style={{ flex: 1, height: 14, background: c }} />
                                                                ))}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>

                                            {/* ⇄ 反転・＋範囲の追加 */}
                                            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                                                <div
                                                    data-role="band-invert"
                                                    title="色の並びを反転"
                                                    onClick={() =>
                                                        colorMutate((d) => {
                                                            const colors = d.bands.map((b) => b.color).reverse();
                                                            return {
                                                                ...d,
                                                                bands: d.bands.map((b, k) => ({ ...b, color: colors[k] })),
                                                            };
                                                        })
                                                    }
                                                    style={{ ...chipStyle, padding: '4px 9px' }}
                                                >
                                                    ⇄
                                                </div>
                                                <div
                                                    data-role="band-add"
                                                    onClick={() =>
                                                        colorMutate((d) => {
                                                            const ts = d.bands
                                                                .filter((x) => x.from !== null)
                                                                .map((x) => x.from);
                                                            const top = d.bands.find((x) => x.from !== null);
                                                            return {
                                                                ...d,
                                                                bands: [
                                                                    ...d.bands,
                                                                    {
                                                                        from: ts.length ? Math.max(...ts) + 20 : 50,
                                                                        color: top ? top.color : ramp[ramp.length - 1],
                                                                    },
                                                                ],
                                                            };
                                                        })
                                                    }
                                                    style={chipStyle}
                                                >
                                                    ＋ 範囲の追加
                                                </div>
                                            </div>

                                            {/* 範囲行（80 以上 / 60 〜 80 / … / より小さい 20） */}
                                            {cd.bands.map((b, i) => (
                                                <div
                                                    key={`band${i}`}
                                                    data-role="color-band-row"
                                                    style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}
                                                >
                                                    <input
                                                        type="color"
                                                        data-role="band-color"
                                                        value={b.color}
                                                        onChange={(e) =>
                                                            colorMutate((d) => {
                                                                d.bands[i].color = e.target.value;
                                                                return d;
                                                            })
                                                        }
                                                        style={swatchStyle}
                                                    />
                                                    {b.from === null ? (
                                                        <span style={{ flex: 1 }}>より小さい {minFrom}</span>
                                                    ) : (
                                                        <>
                                                            <input
                                                                type="number"
                                                                data-role="band-from"
                                                                value={b.from}
                                                                onChange={(e) => {
                                                                    const n = parseNum(e.target.value);
                                                                    if (!Number.isFinite(n)) return;
                                                                    colorMutate((d) => {
                                                                        d.bands[i].from = n;
                                                                        return d;
                                                                    });
                                                                }}
                                                                style={inputStyle}
                                                            />
                                                            <span style={{ flex: 1 }}>
                                                                {i === 0 ? '以上' : `〜 ${cd.bands[i - 1].from}`}
                                                            </span>
                                                            <span
                                                                data-role="band-remove"
                                                                onClick={() =>
                                                                    colorMutate((d) => ({
                                                                        ...d,
                                                                        bands: d.bands.filter((_, k) => k !== i),
                                                                    }))
                                                                }
                                                                title="この範囲を削除"
                                                                style={xStyle}
                                                            >
                                                                ×
                                                            </span>
                                                        </>
                                                    )}
                                                </div>
                                            ))}
                                        </>
                                    ) : (
                                        <>
                                            {/* 一致行（値の完全一致 → 色） */}
                                            {cd.matches.map((m, i) => (
                                                <div
                                                    key={`match${i}`}
                                                    data-role="color-match-row"
                                                    style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}
                                                >
                                                    <input
                                                        type="color"
                                                        data-role="match-color"
                                                        value={m.color}
                                                        onChange={(e) =>
                                                            colorMutate((d) => {
                                                                d.matches[i].color = e.target.value;
                                                                return d;
                                                            })
                                                        }
                                                        style={swatchStyle}
                                                    />
                                                    <input
                                                        type="text"
                                                        data-role="match-key"
                                                        value={m.key}
                                                        placeholder="値（完全一致）"
                                                        onChange={(e) =>
                                                            colorMutate((d) => {
                                                                d.matches[i].key = e.target.value;
                                                                return d;
                                                            })
                                                        }
                                                        style={{ ...inputStyle, flex: 1, width: 'auto' }}
                                                    />
                                                    <span
                                                        data-role="match-remove"
                                                        onClick={() =>
                                                            colorMutate((d) => ({
                                                                ...d,
                                                                matches: d.matches.filter((_, k) => k !== i),
                                                            }))
                                                        }
                                                        title="この一致を削除"
                                                        style={xStyle}
                                                    >
                                                        ×
                                                    </span>
                                                </div>
                                            ))}
                                            <div
                                                data-role="match-add"
                                                onClick={() =>
                                                    colorMutate((d) => ({
                                                        ...d,
                                                        matches: [...d.matches, { key: '', color: ramp[0] }],
                                                    }))
                                                }
                                                style={{ ...chipStyle, display: 'inline-block', marginTop: 2 }}
                                            >
                                                ＋ 一致の追加
                                            </div>
                                            <div style={{ marginTop: 6, fontSize: 9.5, opacity: 0.7 }}>
                                                値がいずれにも一致しない場合はグレー表示
                                            </div>
                                        </>
                                    )}

                                    <div
                                        style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginTop: 10,
                                        }}
                                    >
                                        <div data-role="band-revert" onClick={revertColorToDefault} style={{ ...chipStyle, opacity: 0.8 }}>
                                            既定に戻す
                                        </div>
                                        <span style={{ opacity: 0.55, fontSize: 9.5 }}>v{VIZ_VERSION}</span>
                                    </div>
                                    <div style={{ marginTop: 8, fontSize: 9.5, opacity: 0.7, lineHeight: 1.5 }}>
                                        変更は即時反映。確定はダッシュボードの「編集」→「保存」。
                                    </div>
                                </div>
                            );
                        })()}
                </>
            )}

            {/* 編集モード: 案内のみ（ホストが iframe への入力を遮断するためドラッグ UI は動かない） */}
            {isEdit && opts.allowViewEdit && (
                <div
                    data-role="edit-mode-note"
                    style={{
                        position: 'absolute',
                        bottom: 4,
                        left: 0,
                        right: 0,
                        textAlign: 'center',
                        fontSize: 10.5,
                        color: hintColor,
                        pointerEvents: 'none',
                        userSelect: 'none',
                    }}
                >
                    線の形・色の範囲は表示画面の「✎ 線を編集」「🎨 色を設定」で調整します（編集モード中はドラッグ不可） v{VIZ_VERSION}
                </div>
            )}

            {/* ローディング（線は消さず、隅に小さく表示） */}
            {loading && (
                <div data-role="loading" style={{ position: 'absolute', top: 6, left: 6, opacity: 0.7 }}>
                    <WaitSpinner size="small" />
                </div>
            )}

            {/* デバッグ */}
            {opts.debug && (
                <pre
                    data-role="debug"
                    style={{
                        position: 'absolute',
                        left: 4,
                        top: 4,
                        maxWidth: '95%',
                        maxHeight: '90%',
                        overflow: 'auto',
                        margin: 0,
                        padding: 6,
                        fontSize: 9,
                        lineHeight: 1.3,
                        background: chromeBg,
                        color: hintColor,
                        border: `1px solid ${chromeBorder}`,
                        borderRadius: 6,
                        zIndex: 20,
                    }}
                >
                    {JSON.stringify(
                        {
                            version: VIZ_VERSION,
                            fields: fieldNames,
                            valIdx: extracted.valIdx,
                            value,
                            rawValue,
                            color,
                            colorState,
                            points,
                            mode: modeApi?.mode,
                            options,
                            normalized: opts,
                        },
                        null,
                        1
                    )}
                </pre>
            )}
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
            <LinkLine mode={mode} />
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
