import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// Spotlight Frame（データ駆動のステータス枠）
//
// 単体では中身をほとんど持たない「脇役」viz。パネルの外周を色付きの枠＋発光＋
// 状態バッジで縁取り、サーチ結果の状態値（severity / status / 件数）に応じて
// 色・点滅・バッジが変わる。ダッシュボード上で他パネルに重ねる／隣に置くことで
// 「今どこが危険か」を視線を上げた瞬間に伝える。link-line と同じく、それ自体が
// 主役ではなくダッシュボード全体の意味づけを強化する部品。
//
// データモデル（1行 = 1つの判定対象）:
//   状態値列 = severity 文字列（critical/warn/ok…）または数値（既定は最終列）
//   ラベル列 = 対象名（任意。バッジの補足に使用。既定は第1列）
//   ・複数行は「最悪の状態」に丸めて枠色を決める（1件でも Critical があれば赤）
//   ・各状態の件数を集計し、バッジに「CRITICAL · Crit 3 / Warn 12」と内訳表示
//   1列だけのデータは状態値のみの系列として扱う。
//
// 状態判定は3モード（判定モード option）:
//   auto    = 自動: 値が数値なら「値の範囲と色」、文字列なら既知キーワードで判定
//   numeric = 数値: 「値の範囲と色」（editor.threshold）の帯で判定
//   string  = 文字列一致: critical/error/fatal → 危険、warn/warning → 警告、他 → 正常
//
// 【色の決め方】v1.2.0 で固定3色（okColor/warnColor/critColor）を廃止した。
//   数値パス : editor.threshold の「値の範囲と色」（colorBands）。帯を何段でも
//              追加でき、各帯が自分の色を持つ。旧 warnThreshold / critThreshold /
//              higherIsWorse の3オプションはこれ1つに置き換わった
//              （降順の帯を作れば「小さいほど悪い」も表現できる）。
//   文字列パス: editor.seriesColors の statusColors パレット（正常→警告→危険の
//              深刻度順に上から適用）。数値レンジで表せないカテゴリなので
//              threshold ではなく順序付きパレットを使う。
//
// 表示はコンテナ実寸に自動フィット（ResizeObserver、無い環境は初回計測）。
// 枠だけ表示（frameOnly）にすると中央を透明化して他パネルへの重ね置きに向く。
// ---------------------------------------------------------------------------

const VIZ_VERSION = '1.2.2';

// 列挙型オプションの許容値（未知値は既定へ丸める。旧バージョンの数値コードは復元しない）
const MATCH_MODES = ['auto', 'numeric', 'string'];
const PULSE_MODES = ['none', 'warn', 'crit', 'always'];

// 状態レベル（数値が大きいほど深刻）
const LV_OK = 0;
const LV_WARN = 1;
const LV_CRIT = 2;

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    valueField: '', // 状態値フィールド（'' = 最終列）
    labelField: '', // ラベルフィールド（'' = 第1列）

    titleText: '', // タイトル（'' = パネル名／状態値フィールド名）
    showTitle: true, // タイトルを表示
    showBadge: true, // 状態バッジを表示
    showCounts: true, // 件数の内訳を表示

    matchMode: 'auto', // auto=自動 / numeric=数値 / string=文字列一致

    okLabel: 'OK', // 正常のラベル
    warnLabel: 'WARNING', // 警告のラベル
    critLabel: 'CRITICAL', // 危険のラベル

    borderWidth: 4, // 枠の太さ（px）
    cornerRadius: 12, // 角丸（px）
    showGlow: true, // 発光（グロー）
    glowStrength: 60, // 発光の強さ（0〜100）
    frameOnly: false, // 枠だけ表示（中を透明に）
    fillOpacity: 8, // 背景の塗り不透明度（%）

    pulseMode: 'crit', // none=点滅しない / warn=警告以上 / crit=危険のみ / always=常時
    pulsePeriod: 1.6, // 点滅の周期（秒、0で停止）
};

// --- 数値パスの「値の範囲と色」（editor.threshold）------------------------------
// config.json の colorBands.default と一致させること。
// 既定は v1.1.0 の見た目（warn=1 / crit=1、大きいほど悪い）に近い3段:
//   0 未満なし〜1 未満 = 正常(緑) / 1〜10 = 警告(橙) / 10 以上 = 危険(赤)
// 帯は上限なし（to:null）・下限なし（from:null）を許すため、消費側では null を
// ±Infinity として扱う。
const COLOR_BAND_DEFAULTS = [
    { from: null, to: 1, value: '#22c55e' },
    { from: 1, to: 10, value: '#f59e0b' },
    { from: 10, to: null, value: '#ef4444' },
];

// --- 文字列パスの色（editor.seriesColors）---------------------------------------
// 深刻度の低い順（正常 → 警告 → 危険）に上から適用する順序付きパレット。
// config.json の statusColors.default と一致させること。
// 文字列カテゴリは数値レンジで表せないため threshold ではなくパレットを使う。
const STATUS_COLOR_DEFAULTS = ['#22c55e', '#f59e0b', '#ef4444'];

// editor.seriesColors は hex 文字列の配列を生で渡してくる。解釈できない要素は落とし、
// 空なら既定パレットへ倒す。旧 okColor/warnColor/critColor へのフォールバックは
// 意図的に行わない（既定値は options に載らないため、読み替えると「既定値を
// 選んだときだけ直らない」不具合になる）。
function statusPaletteOf(raw) {
    const list = Array.isArray(raw) ? raw.filter((c) => hexToRgb(c) !== null) : [];
    return list.length > 0 ? list : STATUS_COLOR_DEFAULTS;
}

/**
 * editor.threshold の生値（[{from,to,value}]）を正規化する。
 * - 配列でない / 空 / 全要素が壊れている → 既定の帯へ倒す
 * - from/to は null・欠落・非数値のいずれも「境界なし」(±Infinity) とみなす
 * - value（色）が解釈できない要素は落とす
 * - from > to の逆転は入れ替えて救済し、from 昇順に並べ直す（未ソート入力も可）
 * 重なりは許容する（先に一致した帯が勝つ = 配列の先頭側が優先）。
 */
function normalizeBands(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const out = [];
    src.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        if (!hexToRgb(b.value)) return;
        const f = parseNum(b.from);
        const t = parseNum(b.to);
        let lo = Number.isFinite(f) ? f : -Infinity;
        let hi = Number.isFinite(t) ? t : Infinity;
        if (lo > hi) [lo, hi] = [hi, lo];
        out.push({ from: lo, to: hi, value: b.value });
    });
    if (out.length === 0) {
        return COLOR_BAND_DEFAULTS.map((b) => ({
            from: b.from === null ? -Infinity : b.from,
            to: b.to === null ? Infinity : b.to,
            value: b.value,
        }));
    }
    out.sort((a, b) => a.from - b.from);
    return out;
}

// 数値 → 帯（[from, to) の半開区間。最上段だけ上端も含む）。外れたら null
function bandFor(n, bands) {
    for (let i = 0; i < bands.length; i += 1) {
        const b = bands[i];
        if (n >= b.from && (n < b.to || (b.to === Infinity && n === Infinity))) return b;
    }
    // どの帯にも入らない場合は最も近い端の帯へ丸める（データが帯の外でも必ず色が付く）
    if (bands.length === 0) return null;
    if (n < bands[0].from) return bands[0];
    return bands[bands.length - 1];
}

// 文字列 → 状態レベルのキーワード（小文字前方一致／部分一致）
const CRIT_WORDS = ['crit', 'critical', 'fatal', 'error', 'err', 'down', 'fail', 'alert', 'high', 'severe', 'sev1', 'p1', '5', '緊急', '重大', '危険', '異常', '停止'];
const WARN_WORDS = ['warn', 'warning', 'medium', 'minor', 'degrad', 'elevat', 'sev2', 'sev3', 'p2', 'p3', '警告', '注意'];
const OK_WORDS = ['ok', 'up', 'healthy', 'normal', 'good', 'pass', 'green', 'low', 'info', 'success', 'stable', '正常', '成功', '健全'];

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
    if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.round(alpha * 1000) / 1000})`;
    return color;
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
    const strOr = (v, d) => (typeof v === 'string' ? v : d);
    // 列挙値：ホワイトリストに無ければ既定へ丸める。
    // ここで旧バージョンの数値コードを読み替えては「いけない」（既定値と同じ値は
    // options に載らないため、既定を選び直しても旧値が復活してしまう）。
    const enumOr = (v, list, d) => (list.includes(v) ? v : d);

    return {
        valueField: typeof o.valueField === 'string' || Array.isArray(o.valueField) ? o.valueField : '',
        labelField: typeof o.labelField === 'string' || Array.isArray(o.labelField) ? o.labelField : '',

        titleText: strOr(o.titleText, ''),
        showTitle: bool(o.showTitle, DEFAULTS.showTitle),
        showBadge: bool(o.showBadge, DEFAULTS.showBadge),
        showCounts: bool(o.showCounts, DEFAULTS.showCounts),

        matchMode: enumOr(o.matchMode, MATCH_MODES, DEFAULTS.matchMode),
        // 数値パス：値の範囲と色（editor.threshold）。壊れた入力は既定の帯へ倒す
        colorBands: normalizeBands(o.colorBands),
        // 文字列パス：正常→警告→危険の順に配るパレット（editor.seriesColors）
        statusColors: statusPaletteOf(o.statusColors),

        okLabel: strOr(o.okLabel, DEFAULTS.okLabel),
        warnLabel: strOr(o.warnLabel, DEFAULTS.warnLabel),
        critLabel: strOr(o.critLabel, DEFAULTS.critLabel),

        borderWidth: clamp(Math.round(numOr(o.borderWidth, DEFAULTS.borderWidth)), 0, 40),
        cornerRadius: clamp(Math.round(numOr(o.cornerRadius, DEFAULTS.cornerRadius)), 0, 80),
        showGlow: bool(o.showGlow, DEFAULTS.showGlow),
        glowStrength: clamp(Math.round(numOr(o.glowStrength, DEFAULTS.glowStrength)), 0, 100),
        frameOnly: bool(o.frameOnly, DEFAULTS.frameOnly),
        fillOpacity: clamp(Math.round(numOr(o.fillOpacity, DEFAULTS.fillOpacity)), 0, 100),

        pulseMode: enumOr(o.pulseMode, PULSE_MODES, DEFAULTS.pulseMode),
        pulsePeriod: clamp(numOr(o.pulsePeriod, DEFAULTS.pulsePeriod), 0, 30),
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
// 状態判定
// ---------------------------------------------------------------------------

// 文字列 → 状態レベル（未知なら null）
function classifyText(raw) {
    const s = String(raw).trim().toLowerCase();
    if (s === '') return null;
    const hit = (words) => words.some((w) => s === w || s.includes(w));
    // 危険を最優先で判定（"critical" は "cri" などにも一致するので順序が重要）
    if (hit(CRIT_WORDS)) return LV_CRIT;
    if (hit(WARN_WORDS)) return LV_WARN;
    if (hit(OK_WORDS)) return LV_OK;
    return null;
}

// ---------------------------------------------------------------------------
// 「段（tier）」モデル
//
// 数値パスの段数はユーザー次第（editor.threshold の帯の数）なので、固定の
// OK/WARN/CRIT では表せない。両パスを共通の「段」に写して扱う:
//
//   tier = { key, rank, color, label }
//     rank : 0 が最も軽く、大きいほど深刻。帯の並び順（from 昇順）＝ rank。
//     color: その段の色（数値パスは帯の色、文字列パスはパレットの色）。
//     label: バッジ／件数内訳に出す名前。
//
// pulseMode（none/warn/crit/always）は「危険のみ / 警告以上」という 2 つの相対的な
// 境目を指すものとして段数に依存しない形へ読み替える:
//   crit  = 最上段（最も深刻な段）のときだけ点滅
//   warn  = 最上段の 1 つ下以上（＝上位 2 段）のとき点滅
// 段が 1 つしかなければ両者は一致し、段が 5 つあっても意味が保たれる。
// ---------------------------------------------------------------------------

// 文字列パスの段（常に 正常 / 警告 / 危険 の 3 段。色は statusColors パレット順）
function textTiers(opts) {
    const pal = opts.statusColors;
    const at = (i) => pal[i % pal.length];
    // short は件数内訳用の短縮名（v1.1.0 の "Crit 3 / Warn 12 / OK 40" を踏襲）
    return [
        { key: 'ok', rank: LV_OK, color: at(0), label: opts.okLabel, short: 'OK' },
        { key: 'warn', rank: LV_WARN, color: at(1), label: opts.warnLabel, short: 'Warn' },
        { key: 'crit', rank: LV_CRIT, color: at(2), label: opts.critLabel, short: 'Crit' },
    ];
}

// 数値パスの段（editor.threshold の帯そのもの。from 昇順 = rank 昇順）
function bandTiers(opts) {
    return opts.colorBands.map((b, i) => ({
        key: `band${i}`,
        rank: i,
        color: b.value,
        label: bandLabel(b),
        short: bandLabel(b),
        band: b,
    }));
}

// 帯のラベル（バッジ・件数内訳に出す）。開いた端は「〜」で表す
function bandLabel(b) {
    const fin = (v) => (Number.isFinite(v) ? String(v) : '');
    const lo = fin(b.from);
    const hi = fin(b.to);
    if (lo === '' && hi === '') return 'ALL';
    if (lo === '') return `< ${hi}`;
    if (hi === '') return `${lo} +`;
    return `${lo}–${hi}`;
}

// 1 セルの値を段へ。判定モードに従う。判定不能なら null
function classifyCell(raw, opts, tiersNum, tiersText) {
    if (raw === null || raw === undefined) return null;
    const byNumber = () => {
        const n = parseNum(raw);
        if (!Number.isFinite(n)) return null;
        const b = bandFor(n, opts.colorBands);
        if (!b) return null;
        const i = opts.colorBands.indexOf(b);
        return tiersNum[i] || null;
    };
    if (opts.matchMode === 'string') {
        const lv = classifyText(raw);
        return lv === null ? null : tiersText[lv];
    }
    if (opts.matchMode === 'numeric') {
        return byNumber();
    }
    // 自動: 数値なら帯、文字列ならキーワード
    const n = parseNum(raw);
    if (Number.isFinite(n)) return byNumber();
    const lv = classifyText(raw);
    return lv === null ? null : tiersText[lv];
}

// 行群 → { worst, counts, total, samples, tiers }
function buildStatus(rawRows, fieldNames, opts) {
    const rows = expandMultivalueRows(rawRows);
    const colCount = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    if (colCount === 0) return { error: 'empty' };

    let valIdx;
    let labelIdx;
    if (colCount === 1) {
        valIdx = 0;
        labelIdx = -1;
    } else {
        valIdx = resolveFieldIndex(opts.valueField, fieldNames, rows, colCount - 1);
        labelIdx = resolveFieldIndex(opts.labelField, fieldNames, rows, 0);
        if (labelIdx === valIdx) labelIdx = valIdx === 0 ? -1 : 0;
    }

    const tiersNum = bandTiers(opts);
    const tiersText = textTiers(opts);

    // 実際に使われた段だけを集計対象にする（数値と文字列が混在する auto でも
    // 両方の段が同じ counts に載る）
    const counts = new Map(); // tier.key → { tier, n }
    let classified = 0;
    let worst = null; // 全行が未分類なら null
    const critSamples = [];
    // 「最上段」は使われた段の中での最大 rank ではなく、その系列で **定義されている**
    // 段の最大 rank（数値なら帯の最終段、文字列なら危険）を指す。データに最上段が
    // 無ければ点滅しない、という v1.1.0 の挙動を段数可変のまま保つため。
    // auto モードでは数値・文字列の両方が来うるので両者の最大を取る。
    const topRankNum = tiersNum.length > 0 ? tiersNum[tiersNum.length - 1].rank : LV_CRIT;
    const topRank =
        opts.matchMode === 'string'
            ? LV_CRIT
            : opts.matchMode === 'numeric'
              ? topRankNum
              : Math.max(topRankNum, LV_CRIT);

    rows.forEach((row) => {
        if (!Array.isArray(row)) return;
        const tier = classifyCell(row[valIdx], opts, tiersNum, tiersText);
        if (!tier) return;
        classified += 1;
        const e = counts.get(tier.key);
        if (e) e.n += 1;
        else counts.set(tier.key, { tier, n: 1 });
        if (worst === null || tier.rank > worst.rank) worst = tier;
    });

    if (classified === 0) return { error: 'noclass', valIdx, labelIdx };

    // 最上段に該当した行のラベルを拾う（バッジ下部の内訳に出す対象名）
    if (labelIdx >= 0 && worst) {
        rows.forEach((row) => {
            if (!Array.isArray(row) || critSamples.length >= 6) return;
            const tier = classifyCell(row[valIdx], opts, tiersNum, tiersText);
            if (!tier || tier.key !== worst.key) return;
            const lab = row[labelIdx];
            if (lab !== null && lab !== undefined && String(lab).trim() !== '') critSamples.push(String(lab));
        });
    }

    // 内訳は深刻な段から順に並べる
    const breakdown = [...counts.values()].sort((a, b) => b.tier.rank - a.tier.rank);

    return {
        worst,
        breakdown,
        total: classified,
        critSamples,
        valIdx,
        labelIdx,
        // pulse 判定に使う「その系列で最も深刻な段の rank」
        topRank,
    };
}

// ---------------------------------------------------------------------------
// 配色（テーマ×状態）
// ---------------------------------------------------------------------------

function framePalette(mode, statusColor, opts) {
    const dark = mode === 'dark';
    const fillA = opts.fillOpacity / 100;
    return {
        // 枠・発光は状態色そのまま（可読性のため透過しない）
        border: statusColor,
        glow: withAlpha(statusColor, (opts.glowStrength / 100) * (dark ? 0.55 : 0.4)),
        glowInset: withAlpha(statusColor, (opts.glowStrength / 100) * (dark ? 0.22 : 0.14)),
        // 中央の塗り（frameOnly でなければ状態色の薄いグラデ＋ベース）
        fillBase: dark ? withAlpha('#0d1020', clamp01(0.9 + fillA)) : withAlpha('#ffffff', clamp01(0.9 + fillA)),
        fillGrad: `linear-gradient(150deg, ${withAlpha(statusColor, 0.35 * fillA)} 0%, ${withAlpha(
            statusColor,
            0.08 * fillA
        )} 45%, ${dark ? 'rgba(10,12,24,0)' : 'rgba(255,255,255,0)'} 75%)`,
        badgeBg: dark ? withAlpha(statusColor, 0.2) : withAlpha(statusColor, 0.14),
        badgeBorder: withAlpha(statusColor, dark ? 0.7 : 0.55),
        badgeText: dark ? mixColor(statusColor, '#ffffff', 0.35) : mixColor(statusColor, '#000000', 0.15),
        title: dark ? '#c9d1d9' : '#3d444d',
        sub: dark ? '#8b98a5' : '#5c6773',
    };
}

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// パルス（明滅）用の keyframes を1度だけ head に注入する
const PULSE_STYLE_ID = 'spotlight-frame-pulse-keyframes';
function ensurePulseKeyframes() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(PULSE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PULSE_STYLE_ID;
    style.textContent =
        '@keyframes spotlightFramePulse{0%,100%{opacity:1}50%{opacity:0.32}}' +
        '@keyframes spotlightBadgeBlink{0%,100%{opacity:1}50%{opacity:0.45}}';
    try {
        document.head.appendChild(style);
    } catch (e) {
        /* head が無い環境でも落とさない */
    }
}

// ---------------------------------------------------------------------------
// メッセージ表示（ガード用）
// ---------------------------------------------------------------------------

function CenterMessage({ children }) {
    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxSizing: 'border-box',
                padding: 12,
            }}
        >
            <Paragraph>{children}</Paragraph>
        </div>
    );
}

// 状態インジケータのドット
function StatusDot({ color, size }) {
    return (
        <span
            style={{
                display: 'inline-block',
                width: size,
                height: size,
                borderRadius: '50%',
                background: color,
                boxShadow: `0 0 ${Math.round(size * 0.8)}px ${withAlpha(color, 0.7)}`,
                flex: 'none',
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function SpotlightFrame({ mode }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const options = optionsApi?.options;

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const status = useMemo(() => buildStatus(rows, fieldNames, opts), [rows, fieldNames, opts]);

    useEffect(() => {
        ensurePulseKeyframes();
    }, []);

    // コンテナ実寸の計測（オートフィット）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 400, h: 260 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 400;
        const h = el.clientHeight || 260;
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

    // --- ガード（フックはすべて呼び終えてから return する） ---
    if (loading) {
        return (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WaitSpinner size="medium" />
            </div>
        );
    }
    if (!rawData || rows.length === 0) {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }
    if (status.error === 'noclass') {
        return (
            <CenterMessage>
                状態を判定できませんでした。状態値フィールドの選択や判定モード（自動 / 数値 / 文字列一致）を確認してください。
            </CenterMessage>
        );
    }
    if (status.error) {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }

    const { w, h } = dims;
    // 最悪の段。1 行も分類できないケースは上のガードで弾いているが、
    // 万一 null でも最下段（最も軽い段）に倒して必ず描画する
    const worstTier =
        status.worst || bandTiers(opts)[0] || textTiers(opts)[0];
    const statusColor = worstTier.color;
    const statusLabel = worstTier.label;
    const pal = framePalette(mode, statusColor, opts);

    // --- サイズ計算（スケール clamp） ---
    const s = clamp(Math.min(w / 380, h / 240), 0.5, 2.6);
    const pad = Math.round(clamp(14 * s, 8, 34));
    const border = opts.borderWidth;
    const radius = opts.cornerRadius;
    const titleFont = Math.round(clamp(13 * s, 10, 26));
    const badgeFont = Math.round(clamp(13 * s, 10, 26));
    const dotSize = Math.round(clamp(9 * s, 7, 16));

    // --- 点滅（pulse）判定 ---
    // 段数は可変なので「危険のみ / 警告以上」を最上段からの相対位置で解釈する:
    //   crit = 最上段のときだけ / warn = 最上段の1つ下以上（上位2段）のとき
    // 段が3段（文字列パス既定）なら v1.1.0 と完全に同じ挙動になる。
    const pulseActive =
        opts.pulsePeriod > 0 &&
        (opts.pulseMode === 'always' ||
            (opts.pulseMode === 'crit' && worstTier.rank >= status.topRank) ||
            (opts.pulseMode === 'warn' && worstTier.rank >= status.topRank - 1));
    // data-status も段数可変のため相対位置で表す（最上段=crit / 1つ下=warn / 他=ok）
    const statusAttr =
        worstTier.rank >= status.topRank
            ? 'crit'
            : worstTier.rank >= status.topRank - 1
              ? 'warn'
              : 'ok';
    const pulseAnim = pulseActive ? `spotlightFramePulse ${opts.pulsePeriod}s ease-in-out infinite` : 'none';
    const badgeAnim = pulseActive ? `spotlightBadgeBlink ${opts.pulsePeriod}s ease-in-out infinite` : 'none';

    // --- 発光（グロー） ---
    const glowPx = Math.round((opts.glowStrength / 100) * 34 * s);
    const boxShadow = opts.showGlow && opts.glowStrength > 0
        ? `0 0 ${glowPx}px ${pal.glow}, inset 0 0 ${Math.round(glowPx * 0.9)}px ${pal.glowInset}`
        : 'none';

    // --- 件数の内訳テキスト（深刻な段から順に。各段は自分の色のドットを持つ）---
    const countParts = status.breakdown.map((e) => ({
        color: e.tier.color,
        text: `${e.tier.short} ${e.n}`,
    }));

    const titleVisible = opts.showTitle && h >= 52 && w >= 120;
    const badgeVisible = opts.showBadge && w >= 96;
    const countsVisible = opts.showCounts && status.total > 1 && w >= 160 && h >= 52;
    const titleStr = opts.titleText || fieldNames[status.valIdx] || 'STATUS';

    // 中央の塗り（frameOnly なら透明）
    const centerBg = opts.frameOnly ? 'transparent' : `${pal.fillGrad}, ${pal.fillBase}`;

    return (
        <div
            ref={setContainer}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden',
                fontFamily: FONT_STACK,
                background: 'transparent',
            }}
        >
            {/* 枠本体（外周のボーダー＋発光。点滅はこの層に乗せる） */}
            <div
                data-role="frame"
                data-status={statusAttr}
                data-tier={worstTier.key}
                style={{
                    position: 'absolute',
                    inset: 0,
                    boxSizing: 'border-box',
                    border: border > 0 ? `${border}px solid ${pal.border}` : 'none',
                    borderRadius: radius,
                    background: centerBg,
                    boxShadow,
                    animation: pulseAnim,
                    pointerEvents: 'none',
                }}
            />

            {/* 上部の情報帯（タイトル・状態バッジ・件数） */}
            {(titleVisible || badgeVisible) && (
                <div
                    style={{
                        position: 'absolute',
                        top: pad + border,
                        left: pad + border,
                        right: pad + border,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: titleVisible ? 'space-between' : 'flex-start',
                        gap: 10,
                        pointerEvents: 'none',
                    }}
                >
                    {titleVisible && (
                        <div
                            style={{
                                color: pal.title,
                                fontSize: titleFont,
                                fontWeight: 700,
                                letterSpacing: 0.3,
                                lineHeight: 1.2,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                            }}
                            title={titleStr}
                        >
                            {titleStr}
                        </div>
                    )}

                    {badgeVisible && (
                        <div
                            data-role="status-badge"
                            style={{
                                flex: 'none',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 7,
                                padding: `${Math.round(clamp(4 * s, 3, 8))}px ${Math.round(clamp(10 * s, 7, 16))}px`,
                                borderRadius: 999,
                                background: pal.badgeBg,
                                border: `1px solid ${pal.badgeBorder}`,
                                color: pal.badgeText,
                                fontSize: badgeFont,
                                fontWeight: 800,
                                letterSpacing: 0.6,
                                whiteSpace: 'nowrap',
                                animation: badgeAnim,
                            }}
                        >
                            <StatusDot color={statusColor} size={dotSize} />
                            <span>{statusLabel}</span>
                        </div>
                    )}
                </div>
            )}

            {/* 件数の内訳（下部） */}
            {countsVisible && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: pad + border,
                        left: pad + border,
                        right: pad + border,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        flexWrap: 'wrap',
                        pointerEvents: 'none',
                    }}
                >
                    {countParts.map((c) => (
                        <span
                            key={c.text}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                color: pal.sub,
                                fontSize: Math.round(clamp(12 * s, 9, 22)),
                                fontWeight: 600,
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            <StatusDot color={c.color} size={Math.round(dotSize * 0.78)} />
                            {c.text}
                        </span>
                    ))}
                    {status.critSamples.length > 0 && w >= 300 && (
                        <span
                            style={{
                                color: pal.sub,
                                fontSize: Math.round(clamp(11.5 * s, 9, 20)),
                                fontWeight: 500,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                                flex: 1,
                            }}
                            title={status.critSamples.join(', ')}
                        >
                            {status.critSamples.join(', ')}
                        </span>
                    )}
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
            <SpotlightFrame mode={mode} />
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
