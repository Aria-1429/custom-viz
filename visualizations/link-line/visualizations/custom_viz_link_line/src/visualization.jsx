import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
    useMode,
} from '@splunk/dashboard-studio-extension/react';
// ドリルダウン API は /react ではなくコア側にある（公式 docs の記載は誤り。
// world-map で実機確認済みのパターンをそのまま使う）。
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
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
//   最後の列」）の最終行を採用し、編集画面の「線の色」（editor.threshold）で
//   設定した範囲バンド `[{from,to,value}]` から線の色を決める（v1.9.0 で
//   viz 内の自作色パネルを廃止し、標準の編集パネルに一本化）。
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
// ・流れアニメーションは world-map と同じ「テーパー形状の光の帯」を Canvas に
//   描く（v1.6.0）。以前の SVG stroke-dashoffset で細かい粒を流す方式は
//   点滅感（チカチカ）が強かったため廃止。帯は両端が sin エンベロープで
//   滑らかに窄まるポリゴンを 1 回塗りで描き、下に淡い同色グローを敷く
//   （加算合成は使わない＝白飛びしない）。端点パルスも同じ Canvas の
//   rAF ループに統合し、アニメ停止時は rAF を回さない（CPU 0）。
// ・データが無い/数値が無い場合も線は消さず、ニュートラル色（グレー）で
//   描画し、値ラベルに N/A を表示する（コネクタとしての表示を維持）。
// ---------------------------------------------------------------------------

// バージョン表記（デプロイ確認用。編集モードの案内に表示）
const VIZ_VERSION = '1.10.0';

// 列挙型オプションの許容値（未知値は既定へ丸める。旧バージョンの数値コードは復元しない）
const STYLE_MODES = ['flat', 'shadow', 'neon', 'pipe'];
// 色分けモード: range=値の範囲（editor.threshold）/ match=文字列一致（「値|色」）
const COLOR_MODES = ['range', 'match'];
// 光の帯の向き: forward=始点→終点 / reverse=終点→始点 / both=双方向
const FLOW_DIRECTIONS = ['forward', 'reverse', 'both'];

// 「値|色」の手入力で使われやすい CSS 色名（world-map と同じ集合）。
// hexToRgb は hex しか読めないため、ここで自前解決する
const NAMED_COLORS = {
    red: '#ff0000', crimson: '#dc143c', orange: '#ffa500', gold: '#ffd700',
    yellow: '#ffff00', lime: '#00ff00', green: '#008000', teal: '#008080',
    cyan: '#00ffff', aqua: '#00ffff', blue: '#0000ff', navy: '#000080',
    purple: '#800080', magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb',
    brown: '#a52a2a', white: '#ffffff', black: '#000000', gray: '#808080',
    grey: '#808080', silver: '#c0c0c0',
};

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    valueField: '', // 値フィールド（'' = 数値を含む最後の列）

    linePoints: '', // 線の点列 JSON（'' = 既定の水平線。表示モードの線編集で setOptions 保存）
    cornerRadius: 14, // 折れ角の丸み（px）
    allowViewEdit: true, // 表示モードでの線編集（✎ボタン）を許可

    styleMode: 'flat', // flat=フラット / shadow=ソフトシャドウ / neon=ネオン発光 / pipe=立体パイプ
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
    unitLabel: '', // 値の後ろに付ける単位（例: ms / % / Mbps。空で非表示）
    linkLabel: '', // 接続名（例: DB → App。値チップの先頭に表示。空で非表示）
    flowDirection: 'forward', // 光の帯の向き（forward / reverse / both）

    // 色分けモードと文字列一致マッピング
    colorMode: 'range', // range=値の範囲 / match=文字列一致
    matchColors: [], // 「値|色」の行配列（editor.arrayOfStrings）。match モードで使用

    // 値→色の範囲バンド（editor.threshold が [{from,to,value}] の配列を生で渡してくる）。
    // config.json の optionsSchema.colorBands.default と一致させること。
    colorBands: [
        { from: 0, to: 40, value: '#53a051' },
        { from: 40, to: 70, value: '#f8be34' },
        { from: 70, to: 90, value: '#f1813f' },
        // 最上位は上限なし [90, ∞)。旧実装の threshold3（90 以上すべて赤）と揃える。
        // 上限を 100 にすると 100 超の値がどのバンドにも入らず灰色になってしまう。
        { from: 90, to: null, value: '#dc4e41' },
    ],
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
    // 列挙値：ホワイトリストに無ければ既定へ丸める。
    // ここで旧バージョンの数値コードを読み替えては「いけない」（既定値と同じ値は
    // options に載らないため、既定を選び直しても旧値が復活してしまう）。
    const enumOr = (v, list, d) => (list.includes(v) ? v : d);

    return {
        valueField: typeof o.valueField === 'string' || Array.isArray(o.valueField) ? o.valueField : '',

        linePoints: typeof o.linePoints === 'string' ? o.linePoints : '',
        cornerRadius: clamp(numOr(o.cornerRadius, DEFAULTS.cornerRadius), 0, 300),
        allowViewEdit: bool(o.allowViewEdit, DEFAULTS.allowViewEdit),

        styleMode: enumOr(o.styleMode, STYLE_MODES, DEFAULTS.styleMode),
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
        unitLabel: typeof o.unitLabel === 'string' ? o.unitLabel.trim() : '',
        linkLabel: typeof o.linkLabel === 'string' ? o.linkLabel.trim() : '',
        flowDirection: enumOr(o.flowDirection, FLOW_DIRECTIONS, DEFAULTS.flowDirection),

        colorMode: enumOr(o.colorMode, COLOR_MODES, DEFAULTS.colorMode),
        matchColors: Array.isArray(o.matchColors) ? o.matchColors : [],

        // editor.threshold の生配列。ここでは「配列でなければ既定へ倒す」だけに留め、
        // 個々の行の検証は colorForValue() 側で行う（1 行だけ壊れていても他は活かす）。
        // ⚠ 旧バージョンの文字列 colorBands（自作パネルのシリアライズ形式）や
        //    threshold1/color1 等へのフォールバックは意図的に実装しない。
        colorBands: Array.isArray(o.colorBands) ? o.colorBands : DEFAULTS.colorBands,
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
// 値→色（編集画面の「線の色」＝ editor.threshold）
//
// editor.threshold は `[{ from, to, value }]` の配列を **生のまま** options に
// 渡してくる（DOS 文字列を経由しない数少ない色系 editor 型）。v1.9.0 で
// viz 内の自作色パネル（🎨 色を設定）を廃止し、この標準パネルに一本化した。
//
// ホストから来る配列は次のどれもありうるので、すべて壊れずに処理する:
//   ・未ソート／範囲の重なり
//   ・openRanges:true による開区間（from または to が null / undefined）
//   ・空配列・配列以外・行が object でない・色が不正な文字列
// ---------------------------------------------------------------------------

// 1 行を { from, to, color } へ正規化。使えない行は null（＝スキップ）を返す。
// from/to が欠けている（開区間）場合は ∓Infinity として扱う。
function normalizeBand(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const color = row.value;
    if (!hexToRgb(color)) return null; // 色が読めない行は無視（部分的に壊れていても他は活かす）
    const rawFrom = row.from;
    const rawTo = row.to;
    const from =
        rawFrom === null || rawFrom === undefined || rawFrom === '' ? -Infinity : parseNum(rawFrom);
    const to = rawTo === null || rawTo === undefined || rawTo === '' ? Infinity : parseNum(rawTo);
    if (Number.isNaN(from) || Number.isNaN(to)) return null;
    if (from > to) return null; // 逆転した範囲は無視
    return { from, to, color: String(color).trim() };
}

// 値がバンドに入るか。**半開区間 [from, to)** で判定する
// （標準 viz の「40 〜 70」表記＝ 40 は含み 70 は含まない、と同じ）。
// ただし上限が Infinity（開区間）のときだけは to も含む＝ [from, ∞)。
function bandContains(band, value) {
    if (value < band.from) return false;
    if (band.to === Infinity) return true;
    return value < band.to;
}

// 値→色。
//
// 【重なりの決定規則】複数のバンドが同じ値を含む場合は
//   ① from が大きい方（＝より狭く・より高い範囲を指す方）を優先
//   ② from が同じなら to が小さい方（＝より狭い方）を優先
//   ③ それも同じなら配列で先に現れた方を優先
// を安定な順序で適用する。これで並び順に依存せず常に同じ色が出る。
//
// どのバンドにも入らない／有効なバンドが 1 つも無い／値が数値でない場合は
// ニュートラル色へ倒す（例外は投げない）。
function colorForValue(value, opts) {
    if (!Number.isFinite(value)) return NEUTRAL_COLOR;
    const raw = Array.isArray(opts && opts.colorBands) ? opts.colorBands : [];
    let best = null;
    for (let i = 0; i < raw.length; i += 1) {
        const band = normalizeBand(raw[i]);
        if (!band || !bandContains(band, value)) continue;
        if (
            best === null ||
            band.from > best.from ||
            (band.from === best.from && band.to < best.to)
        ) {
            best = band;
        }
    }
    if (best) return best.color;
    return NEUTRAL_COLOR;
}

// ---------------------------------------------------------------------------
// 文字列一致→色（colorMode='match'。editor.arrayOfStrings の「値|色」）
//
// v1.9.0 で自作パネルごと廃止した「一致」方式の復活。UI は world-map の
// 「カテゴリ名|色」と同じ書式に統一する（区切りは半角 |、大文字小文字は同一視、
// 解釈できない行は黙って捨てる＝描画を壊さない）。
// ---------------------------------------------------------------------------

// 色文字列を hex に解決（CSS 色名も許容）。読めなければ null
function resolveColorString(color) {
    const s = String(color || '').trim().toLowerCase();
    const hex = NAMED_COLORS[s] || s;
    return hexToRgb(hex) ? hex : null;
}

// 「値|色」の行配列 → Map<小文字の値, hex色>
function parseMatchColors(raw) {
    const map = new Map();
    if (!Array.isArray(raw)) return map;
    for (const line of raw) {
        if (typeof line !== 'string') continue;
        const sep = line.indexOf('|');
        if (sep < 0) continue;
        const name = line.slice(0, sep).trim();
        const color = resolveColorString(line.slice(sep + 1));
        if (name === '' || !color) continue;
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, color);
    }
    return map;
}

// 文字列値→色。どれにも一致しない／値が無い場合はニュートラル
function colorForMatch(rawValue, opts) {
    if (rawValue === null || rawValue === undefined) return NEUTRAL_COLOR;
    const key = String(rawValue).trim().toLowerCase();
    if (key === '') return NEUTRAL_COLOR;
    const map = parseMatchColors(opts.matchColors);
    return map.get(key) || NEUTRAL_COLOR;
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
// 流れる「光の帯」キャンバス（world-map v1.1.1 と同方式）
//   角丸パス（roundedPathD と同じ幾何）を折れ線に平坦化し、弧長でサンプル
//   できる track を作る。帯は「両端が sin エンベロープで窄まるテーパー
//   ポリゴン」を 1 回塗りで描くため、アルファ累積も加算合成の白飛びも無く、
//   以前の破線オフセット方式のような点滅感（チカチカ）が出ない。
//   端点パルスも同じ rAF ループで描き、SVG の毎フレーム属性更新を全廃。
//   アニメが全て停止（flowSpeed=0 かつ pulse 無し）のときはこのコンポーネント
//   自体をマウントしない（rAF ゼロ・CPU 0）。
//
//   v1.7.0 の 2 つの改良:
//   ・端点フェード: パス範囲外のサンプルを単純に捨てるだけだと、境界を跨いだ
//     瞬間にポリゴンの端がサンプル間隔ぶん飛び、始点/終点で段階的な
//     カクつき（デュデュデュ）に見える。端点近傍で幅を smoothstep で 0 に
//     窄めるフェード窓を掛け、消えるサンプルは常に幅ほぼ 0 → 出入りが滑らか。
//   ・パネル間同期: 位相は rAF のローカル経過時間でなく壁時計（Date.now）から
//     算出し、帯の長さもパス長の固定比率にする。これで複数の link-line パネル
//     （別 iframe で状態は共有できない）でも、同じ速度設定なら線の長さに
//     関係なく「同時に出発・同時に終点へ到着」する。
// ---------------------------------------------------------------------------

// 帯を構成するサンプル点の数（多いほど滑らか。1 本×この数なので 60fps 余裕）
const FLOW_SAMPLES = 24;
// 帯の弧長比（パス全体に対する光の帯の長さ。world-map と同じく比率固定に
// することで、どの線でも「出発→到着」が周期内の同じ位相で起きる）
const FLOW_LEN = 0.24;
// 速度1 のときの周期（秒）。周期 = FLOW_PERIOD / flowSpeed。
// 壁時計を同じ周期で割るので、同じ速度設定のパネル同士は自動的に同位相になる
const FLOW_PERIOD = 8;

// 0..1 に丸めた smoothstep（端点フェード窓用）
function smooth01(x) {
    const t = clamp01(x);
    return t * t * (3 - 2 * t);
}

// 角丸ポリラインを「弧長つき折れ線」に平坦化する（roundedPathD と同じ丸め幾何）
function buildFlowTrack(pts, radius) {
    if (!pts || pts.length < 2) return null;
    const prims = [];
    let cur = pts[0];
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
            prims.push({ type: 'L', a: cur, b: p1 });
            cur = p1;
            continue;
        }
        const a = { x: p1.x - (v1.x / len1) * rr, y: p1.y - (v1.y / len1) * rr };
        const b = { x: p1.x + (v2.x / len2) * rr, y: p1.y + (v2.y / len2) * rr };
        prims.push({ type: 'L', a: cur, b: a });
        prims.push({ type: 'Q', a, c: p1, b });
        cur = b;
    }
    prims.push({ type: 'L', a: cur, b: pts[pts.length - 1] });

    const samples = [];
    let total = 0;
    const push = (x, y) => {
        if (samples.length > 0) {
            const s = samples[samples.length - 1];
            const d = Math.hypot(x - s.x, y - s.y);
            if (d < 1e-6) return;
            total += d;
        }
        samples.push({ x, y, d: total });
    };
    push(prims[0].a.x, prims[0].a.y);
    for (const pr of prims) {
        if (pr.type === 'L') {
            push(pr.b.x, pr.b.y);
        } else {
            const STEPS = 8; // 角丸（2次ベジェ）の分割数
            for (let s = 1; s <= STEPS; s += 1) {
                const t = s / STEPS;
                const u = 1 - t;
                push(
                    u * u * pr.a.x + 2 * u * t * pr.c.x + t * t * pr.b.x,
                    u * u * pr.a.y + 2 * u * t * pr.c.y + t * t * pr.b.y
                );
            }
        }
    }
    return samples.length >= 2 ? { samples, total } : null;
}

// track 上の弧長位置 dist の点（座標＋単位法線）
function trackPointAt(track, dist) {
    const { samples } = track;
    const d = clamp(dist, 0, track.total);
    let i = 1;
    while (i < samples.length - 1 && samples[i].d < d) i += 1;
    const s0 = samples[i - 1];
    const s1 = samples[i];
    const seg = s1.d - s0.d;
    const t = seg > 1e-6 ? (d - s0.d) / seg : 0;
    const dx = s1.x - s0.x;
    const dy = s1.y - s0.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: s0.x + dx * t, y: s0.y + dy * t, nx: -dy / len, ny: dx / len };
}

function FlowCanvas({ track, color, lineWidth, speed, direction, pulseCaps, caps, capR, width, height, opacity }) {
    const canvasRef = useRef(null);
    // 最新の track / 色 / 速度を rAF ループから参照するための ref
    // （再購読でループを張り直さず、値だけ差し替える）
    const stateRef = useRef(null);
    stateRef.current = { track, color, lineWidth, speed, direction, pulseCaps, caps, capR, width, height, opacity };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !width || !height) return undefined;
        const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        if (!ctx) return undefined;

        // 高精細でも描画量を抑える（world-map と同じく dpr は 2 で頭打ち）
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));

        let raf = 0;

        const frame = () => {
            const st = stateRef.current;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, st.width, st.height);
            // 位相は壁時計から算出（rAF のローカル経過時間だとパネルごとに開始が
            // ずれる。Date.now は iframe 間で共通なので、同じ速度設定のパネルは
            // 何もしなくても同位相＝同時に出発・到着する）
            const nowSec = Date.now() / 1000;

            // --- 光の帯（テーパーポリゴン 1 回塗り × 2 層） ---
            const tr = st.track;
            if (st.speed > 0 && tr && tr.total > 4) {
                const bandLen = tr.total * FLOW_LEN;
                const period = FLOW_PERIOD / st.speed;
                // 帯の末尾が終点を抜けてから次周が始点に入る（途切れないループ）。
                // 帯長がパス長の固定比率なので、先頭の到着位相 1/(1+FLOW_LEN) も
                // 全パネル共通になる
                const s = (nowSec % period) / period;
                const head = s * (tr.total + bandLen);
                // 端点フェード窓の長さ。境界に近いサンプルの幅を smoothstep で
                // 0 へ窄め、サンプルがパス外に出て消える瞬間のジャンプを不可視にする
                const fade = bandLen * 0.5;
                const hwBase = Math.max(2, st.lineWidth * 0.62);
                // 中心線の左右に張り出したテーパーポリゴンを 1 回で塗る。
                // 重ね塗りしないのでアルファが累積せず白飛びしない
                const fillBand = (pts, scale, alpha, fillStyle) => {
                    ctx.beginPath();
                    pts.forEach((p, i) => {
                        const hw = hwBase * scale * p.env;
                        if (i === 0) ctx.moveTo(p.x + p.nx * hw, p.y + p.ny * hw);
                        else ctx.lineTo(p.x + p.nx * hw, p.y + p.ny * hw);
                    });
                    for (let i = pts.length - 1; i >= 0; i -= 1) {
                        const p = pts[i];
                        const hw = hwBase * scale * p.env;
                        ctx.lineTo(p.x - p.nx * hw, p.y - p.ny * hw);
                    }
                    ctx.closePath();
                    ctx.globalAlpha = alpha;
                    ctx.fillStyle = fillStyle;
                    ctx.fill();
                };
                // 帯の向き: forward=始点→終点 / reverse=逆走 / both=両方向を同時に描く。
                // 弧長 d を反転（total - d）するだけで、位相・フェード窓の計算は共通
                const dirs = st.direction === 'both' ? ['forward', 'reverse'] : [st.direction || 'forward'];
                for (const dir of dirs) {
                    const pts = [];
                    for (let k = 0; k <= FLOW_SAMPLES; k += 1) {
                        const u = k / FLOW_SAMPLES; // 0=帯の先頭, 1=帯の末尾
                        const d = head - u * bandLen;
                        if (d < 0 || d > tr.total) continue; // パス外（出発前/到達後）は描かない
                        const p = trackPointAt(tr, dir === 'reverse' ? tr.total - d : d);
                        const env =
                            Math.sin(Math.PI * u) * smooth01(d / fade) * smooth01((tr.total - d) / fade);
                        pts.push({ ...p, env });
                    }
                    if (pts.length < 2) continue;
                    // 線自体が同色で不透明なので、帯は白へ寄せた明色で「線の上を走る光」に見せる
                    fillBand(pts, 2.3, 0.16 * st.opacity, mixColor(st.color, '#ffffff', 0.35)); // 太く淡いグロー
                    fillBand(pts, 1.0, 0.85 * st.opacity, mixColor(st.color, '#ffffff', 0.6)); // 締まった芯
                }
            }

            // --- 端点パルス（広がるリング。これも壁時計位相でパネル間同期） ---
            if (st.pulseCaps && st.caps.length > 0) {
                const period = 2.4;
                const phase = (nowSec % period) / period;
                ctx.globalAlpha = (1 - phase) * 0.5 * st.opacity;
                ctx.strokeStyle = st.color;
                ctx.lineWidth = 1.5;
                for (const c of st.caps) {
                    ctx.beginPath();
                    ctx.arc(c.x, c.y, st.capR + st.capR * 1.7 * phase, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [width, height]);

    return (
        <canvas
            ref={canvasRef}
            data-role="flow-canvas"
            width={width}
            height={height}
            style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
            }}
        />
    );
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

    // 表示モードで行った線の形（linePoints）の変更のうち、まだホストの options に
    // 反映されていないもの。ホストによっては表示モード中の setOptions が保存対象に
    // 取り込まれないため、ここに保持しておき「編集モードに入った瞬間」に再送（flush）して確定させる。
    // ※色（colorBands）は編集画面の editor.threshold で設定するのでこの仕組みは通らない。
    const pendingRef = useRef({}); // { linePoints? }

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

    // 表示モードでの線編集トグル（編集モード中は iframe への入力がホストに遮断されるため、
    // 線のドラッグ編集は表示モードで行う）
    const [unlocked, setUnlocked] = useState(false);
    const lineEditActive = !isEdit && unlocked && opts.allowViewEdit;

    // モードが切り替わったら編集 UI を閉じる。ドラフトは破棄しない（表示モードの変更を
    // 編集モードへ持ち越し、下の flush effect で確定させるため）
    useEffect(() => {
        setUnlocked(false);
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

    // --- 幾何・色の算出 ---
    const { w, h } = dims;
    const pxPts = points.map((p) => ({ x: p.x * w, y: p.y * h }));
    const pathD = roundedPathD(pxPts, opts.cornerRadius);
    const geo = polylineGeometry(pxPts);
    // 色: 「色分けモード」に応じて解決する。
    //   range = 編集画面の「線の色」（editor.threshold）の範囲バンド × 数値
    //   match = 「値と色の対応」（editor.arrayOfStrings「値|色」）× 生の文字列値
    const rawValue = extracted.raw;
    const isMatchMode = opts.colorMode === 'match';
    const color = isMatchMode ? colorForMatch(rawValue, opts) : colorForValue(value, opts);
    const lw = opts.lineWidth;

    // 端点と全体方向（グラデーション・パイプのハイライトオフセットに使用）
    const startPt = pxPts[0];
    const endPt = pxPts[pxPts.length - 1];
    const overallAngle = Math.atan2(endPt.y - startPt.y, endPt.x - startPt.x);
    const perp = { x: Math.sin(overallAngle), y: -Math.cos(overallAngle) }; // 進行方向の左手（≒上）側

    // 破線（静的スタイル）。流れアニメーションは Canvas の光の帯が担う
    const dashGap = Math.max(2, Math.round(opts.dashLength * 0.75));
    const dashArr = opts.dashLength > 0 ? `${opts.dashLength} ${dashGap}` : undefined;

    // 質感ごとのストロークレイヤー（下から順に描画）。
    // strokePaint は始点→終点の淡いグラデーション（立体感）。lineGradient オフで単色
    const strokePaint = opts.lineGradient ? 'url(#llGrad)' : color;
    const layers = [];
    if (opts.styleMode === 'neon') {
        // ネオン発光: ガウスぼかしのハロー2層 + 本体 + 明るい芯
        layers.push({ key: 'halo1', w: lw * 2.6, c: withAlpha(color, 0.5), filter: 'url(#llBlurWide)', opacity: 0.55 });
        layers.push({ key: 'halo2', w: lw * 1.35, c: withAlpha(color, 0.85), filter: 'url(#llBlurTight)', opacity: 0.8 });
        layers.push({ key: 'main', w: lw, c: strokePaint, main: true });
        layers.push({ key: 'core', w: Math.max(1, lw * 0.34), c: mixColor(color, '#ffffff', 0.65), dashed: true });
    } else if (opts.styleMode === 'pipe') {
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
    } else if (opts.styleMode === 'shadow') {
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

    // 値の表示テキスト。
    //   range モード: 数値はカンマ区切り＋小数桁でフォーマット（単位は別スパンで付加）
    //   match モード: 生の文字列値をそのまま表示（OK / NG 等。数値でも整形しない）
    //   どちらも値が無ければ N/A
    const truncate = (s) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);
    const isNumericDisplay = !isMatchMode && Number.isFinite(value);
    const labelText = isMatchMode
        ? rawValue
            ? truncate(rawValue)
            : 'N/A'
        : Number.isFinite(value)
          ? fmtValue(value, opts.valueDecimals)
          : rawValue
            ? truncate(rawValue)
            : 'N/A';
    // 単位は数値表示のときだけ付ける（N/A や文字列ステータスに ms を付けない）
    const unitText = isNumericDisplay && opts.unitLabel !== '' ? opts.unitLabel : '';
    const labelFont = clamp(11.5 + lw * 0.35, 11, 20);
    const chipDotR = Math.max(3, labelFont * 0.26);
    const chipBg = mode === 'dark' ? 'rgba(10,14,26,0.88)' : 'rgba(255,255,255,0.92)';
    // dataviz 原則: テキストは系列色でなくインク色。色の識別はチップ内のドットが担う
    const chipInk = mode === 'dark' ? 'rgba(228,234,244,0.95)' : 'rgba(28,36,48,0.92)';

    const hintColor = mode === 'dark' ? 'rgba(220,228,240,0.75)' : 'rgba(40,50,60,0.7)';
    const chromeBg = mode === 'dark' ? 'rgba(13,16,32,0.85)' : 'rgba(255,255,255,0.9)';
    const chromeBorder = mode === 'dark' ? 'rgba(139,147,161,0.5)' : 'rgba(90,100,110,0.4)';
    const handleFill = mode === 'dark' ? '#0e1424' : '#ffffff';
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

    // --- ドリルダウン（インタラクション） ---------------------------------
    // 線の透明な当たり判定に addDrilldownListener で登録する（world-map で実機
    // 確立済みのパターン。triggerDrilldown は効かない・発火は click のみ・
    // config.json の events 宣言が前提）。トークンへの割り当ては編集画面の
    // 「インタラクション」でユーザーが定義する。
    const drillRef = useRef(null);
    useEffect(() => {
        if (typeof addDrilldownListener !== 'function') return;
        const node = drillRef.current;
        if (!node) return; // 線編集中は当たり判定ごと外している
        try {
            const fieldName = fieldNames[extracted.valIdx] || 'value';
            const display = Number.isFinite(value) ? value : rawValue ?? '';
            addDrilldownListener({
                node,
                action: 'line.click',
                // row.<フィールド名>.value 形式にすると「インタラクション」から
                // フィールド名で参照できる
                payloadCallback: () => ({
                    [`row.${fieldName}.value`]: display,
                    'row.value.value': display,
                    'row.label.value': opts.linkLabel,
                    name: fieldName,
                    value: display,
                }),
            });
        } catch (e) {
            /* ドリルダウン未対応環境でも描画は続ける */
        }
    }, [value, rawValue, opts.linkLabel, fieldNames, extracted.valIdx, lineEditActive]);

    // 流れる光の帯・端点パルス（Canvas）。どちらも無ければ Canvas 自体をマウントしない
    const pulseActive = opts.pulseCaps && opts.showEndCaps;
    const animActive = opts.flowSpeed > 0 || pulseActive;
    const flowTrack = opts.flowSpeed > 0 ? buildFlowTrack(pxPts, opts.cornerRadius) : null;
    const pulseCapPts = pulseActive ? [startPt, ...(opts.arrowHead ? [] : [endPt])] : [];

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

                    {/* 端点コネクタ（ポート風: 淡いハロー＋面フィルのリング＋色のコアドット） */}
                    {opts.showEndCaps &&
                        [startPt, ...(opts.arrowHead ? [] : [endPt])].map((p, i) => (
                            <g key={`cap${i}`} data-role="endcap">
                                {opts.styleMode === 'neon' && (
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

                </g>

                {/* ドリルダウン用の透明な当たり判定（クリックで line.click を発火）。
                    線編集トグル中は外して編集操作を妨げない。SVG 全体は
                    pointerEvents:none だが、この要素だけ auto で受ける */}
                {!lineEditActive && (
                    <path
                        ref={drillRef}
                        d={pathD}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={Math.max(lw * 2.5, 14)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        data-role="drill-hit"
                        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    />
                )}

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

            {/* 流れる光の帯＋端点パルス（Canvas オーバーレイ。線 SVG の上・ラベル/UI の下）。
                アニメーションが無いときはマウントせず rAF ゼロ（CPU 0）。 */}
            {animActive && (
                <FlowCanvas
                    track={flowTrack}
                    color={color}
                    lineWidth={lw}
                    speed={opts.flowSpeed}
                    direction={opts.flowDirection}
                    pulseCaps={pulseActive}
                    caps={pulseCapPts}
                    capR={capR}
                    width={w}
                    height={h}
                    opacity={opts.lineOpacity / 100}
                />
            )}

            {/* 値ラベル（線の中央。インク色テキスト＋色ドットのチップ。Canvas より上に置く）。
                接続名（linkLabel）だけでも表示できる（showValue オフ＋接続名あり） */}
            {(opts.showValue || opts.linkLabel !== '') && (
                <div
                    data-role="value-label"
                    style={{
                        position: 'absolute',
                        left: geo.mid.x,
                        top: geo.mid.y,
                        transform: 'translate(-50%, -50%)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: chipDotR + 3,
                        padding: `${Math.round(labelFont * 0.34)}px ${Math.round(labelFont * 0.85)}px`,
                        borderRadius: 999,
                        background: chipBg,
                        border: `1px solid ${withAlpha(color, 0.45)}`,
                        boxShadow: mode === 'dark' ? '0 1px 4px rgba(0,0,0,0.45)' : '0 1px 4px rgba(20,30,40,0.18)',
                        opacity: opts.lineOpacity / 100,
                        fontSize: labelFont,
                        fontWeight: 650,
                        letterSpacing: 0.2,
                        color: chipInk,
                        whiteSpace: 'nowrap',
                        pointerEvents: 'none',
                        userSelect: 'none',
                    }}
                >
                    <span
                        data-role="value-dot"
                        style={{
                            width: chipDotR * 2,
                            height: chipDotR * 2,
                            borderRadius: '50%',
                            background: color,
                            flex: 'none',
                        }}
                    />
                    {/* 接続名（例: DB → App）。値より一段弱いウェイトで前置する */}
                    {opts.linkLabel !== '' && (
                        <span
                            data-role="link-label"
                            style={{ fontWeight: 500, opacity: 0.78 }}
                        >
                            {opts.linkLabel}
                        </span>
                    )}
                    {opts.showValue && <span data-role="value-text">{labelText}</span>}
                    {/* 単位（数値表示のときだけ。値よりわずかに小さく・弱く） */}
                    {opts.showValue && unitText !== '' && (
                        <span
                            data-role="value-unit"
                            style={{
                                fontSize: Math.max(9, Math.round(labelFont * 0.82)),
                                fontWeight: 500,
                                opacity: 0.75,
                                marginLeft: -Math.max(2, chipDotR),
                            }}
                        >
                            {unitText}
                        </span>
                    )}
                </div>
            )}

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
                    線の形は表示画面の「✎ 線を編集」で調整します（編集モード中はドラッグ不可）。色は右パネルの「線の色」で設定 v{VIZ_VERSION}
                </div>
            )}

            {/* ローディング（線は消さず、隅に小さく表示） */}
            {loading && (
                <div data-role="loading" style={{ position: 'absolute', top: 6, left: 6, opacity: 0.7 }}>
                    <WaitSpinner size="small" />
                </div>
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
