import {
    VisualizationExtensionProvider,
    useDataSources,
    useTheme,
    useOptions,
    useTokens,
} from '@splunk/dashboard-studio-extension/react';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';

// ---------------------------------------------------------------------------
// Gauge Arc（単一値のアークゲージ＋サブ情報パネル）
//
// 主役は「1つの数値」。左（または上）に円弧ゲージ、右（左/下）に副次情報を並べる。
// 標準の SingleValueRadial は単色リング1本で色帯を持てず、MarkerGauge は横長の棒。
// ここでは以下を1枚にまとめる:
//
//   ・円弧ゲージ 2 種（連続 / セグメント）
//       連続      = なめらかな1本の弧。値の位置まで塗る
//       セグメント= 弧を N 個の小片に割り、値の位置まで点灯（イコライザ風）
//   ・値の範囲と色（editor.threshold）で帯ごとに色分け
//   ・前回（直前の行）との比較を差分＋割合で表示
//   ・サブ情報パネルは 4 スロット。各スロットの内容をドロップダウンで選ぶ
//
// データモデル:
//   1行 = 時系列またはカテゴリの 1 ポイント（行順が古 → 新）
//   値列   = 数値（既定は最終列）
//   ラベル列 = 名前・時刻（任意。既定は第1列。ランキング／推移のツールチップに使用）
//   ゲージの値は「値の決め方」（最終行 / 先頭行 / 合計 / 平均 / 最大 / 最小 / 件数）で決まる。
//
// 【色の決め方】固定3色は持たない。editor.threshold の colorBands（帯を何段でも
// 追加でき、各帯が自分の色を持つ）か、単色（fixedColor）かを colorMode で選ぶ。
// editor.dynamicColor はカスタム viz では配列が届かないため使えない。
//
// 表示はコンテナ実寸に自動フィット（ResizeObserver、無い環境は初回計測）。
// 幅が狭いときはサブパネルを自動的に下へ回し、さらに狭ければ段階的に隠す。
// ---------------------------------------------------------------------------

const VIZ_VERSION = '1.4.0';

// 列挙型オプションの許容値（未知値は既定へ丸める。旧バージョンの値は復元しない）
const AGG_MODES = ['last', 'first', 'sum', 'avg', 'max', 'min', 'count'];
const GAUGE_STYLES = ['continuous', 'segmented', 'tachometer'];
const LIT_MODES = ['band', 'current'];
// band=帯ごとに階段状 / gradient=帯の色を滑らかに補間 / fixed=単色
const COLOR_MODES = ['band', 'gradient', 'fixed'];
// 中央の数値の色: band=ゲージと同じ（帯／単色）の色 / fixed=指定した固定色 / auto=テーマの文字色
const VALUE_COLOR_MODES = ['band', 'fixed', 'auto'];
const COMPARE_MODES = ['prev', 'first', 'avg', 'field', 'fixed', 'none'];
const DELTA_FORMATS = ['both', 'absolute', 'percent'];
const GOOD_DIRECTIONS = ['up', 'down', 'none'];
const PANEL_POSITIONS = ['right', 'left', 'bottom', 'none'];
const SLOT_KINDS = [
    'none',
    'delta',
    'stats',
    'breakdown',
    'ranking',
    'sparkline',
    'target',
    'legend',
    'period',
    'note',
];
// サブ指標（statList）に指定できる統計。未知の語は落とす
const STAT_KEYS = ['sum', 'avg', 'max', 'min', 'count', 'last', 'first'];
const STAT_LABELS = {
    sum: '合計',
    avg: '平均',
    max: '最大',
    min: '最小',
    count: '件数',
    last: '最新',
    first: '最初',
};

// オプションのデフォルト（config.json の optionsSchema.default と一致させる）
const DEFAULTS = {
    valueField: '', // 値フィールド（'' = 最終列）
    labelField: '', // ラベルフィールド（'' = 第1列）

    aggMode: 'last', // ゲージの値の決め方
    minValue: 0, // ゲージ最小値
    maxValue: 100, // ゲージ最大値
    autoScale: false, // データから自動で範囲を決める

    gaugeStyle: 'continuous', // continuous=連続 / segmented=セグメント
    sweepAngle: 240, // 開き角（度）
    arcThickness: 18, // 円弧の太さ（px）
    segmentCount: 28, // セグメントの数
    segmentGap: 30, // セグメントの隙間（%）
    litMode: 'band', // band=位置の帯色 / current=現在値の色で統一
    showTrack: true, // 下地（トラック）
    showGlow: true, // 発光
    glowStrength: 55, // 発光の強さ（0〜100）
    showTicks: true, // 目盛り
    showRangeLabels: true, // 最小値・最大値ラベル
    showBoundaryValues: true, // 帯の境界（色が切り替わる位置）の数値
    showNeedle: false, // 針
    animate: true, // アニメーション
    animateDuration: 0.9, // アニメーションの長さ（秒）

    colorMode: 'band', // band=値の範囲で色分け / fixed=単色
    fixedColor: '#22d3ee', // 単色のときの色

    titleText: '', // タイトル（'' = フィールド名）
    unitText: '', // 単位
    decimals: 0, // 小数点以下の桁数
    compactNumbers: false, // 大きな数を省略表記
    showTitle: true, // タイトルを表示
    // 帯の名前（"80 +" のようなバッジ）。ゲージの外側に境界値を描くようになったため
    // 既定は非表示（冗長なので）。必要な人だけ編集画面で ON にする。
    showBandLabel: false,
    valueColorMode: 'band', // 中央の数値の色: band=ゲージと同じ / fixed=固定色 / auto=テーマ標準
    valueFixedColor: '#22d3ee', // 中央の数値の固定色（valueColorMode=fixed のとき）

    compareMode: 'prev', // 比較の相手
    compareValue: 0, // 固定値
    compareField: '', // 比較フィールド
    deltaFormat: 'both', // 差分の表し方
    deltaLabel: '前回比', // 比較のラベル
    goodDirection: 'up', // 望ましい変化の向き
    upColor: '#22c55e', // 良い変化の色
    downColor: '#ef4444', // 悪い変化の色
    showDelta: true, // 比較を表示

    panelPosition: 'right', // サブパネルの位置
    panelWidth: 0.4, // パネルの幅（比率）
    slot1: 'delta',
    slot2: 'stats',
    slot3: 'sparkline',
    slot4: 'none',
    rankCount: 4, // ランキングの表示件数
    noteText: '', // 自由テキスト
    targetValue: 0, // 目標値
    showTarget: false, // 目標線を表示
};

// サブ指標（editor.arrayOfStrings）の既定。config.json の statList.default と一致させる
const STAT_LIST_DEFAULTS = ['max', 'min', 'avg'];

// 値の範囲と色（editor.threshold）の既定。config.json の colorBands.default と一致させる。
// 帯は上限なし（to:null）・下限なし（from:null）を許すため、消費側では null を
// ±Infinity として扱う。既定は「0〜60=正常 / 60〜85=警告 / 85以上=危険」。
const COLOR_BAND_DEFAULTS = [
    { from: null, to: 60, value: '#22c55e' },
    { from: 60, to: 85, value: '#f59e0b' },
    { from: 85, to: null, value: '#ef4444' },
];

// 開き角として受け付ける値。editor.select の value が数値でも文字列でも通す
const SWEEP_ANGLES = [180, 240, 280, 320];

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

// 数値の表示整形（桁区切り／省略表記／小数桁）
function formatNumber(n, opts) {
    if (!Number.isFinite(n)) return '—';
    const d = opts.decimals;
    if (opts.compactNumbers) {
        const abs = Math.abs(n);
        const units = [
            { v: 1e12, s: 'T' },
            { v: 1e9, s: 'B' },
            { v: 1e6, s: 'M' },
            { v: 1e3, s: 'K' },
        ];
        for (const u of units) {
            if (abs >= u.v) {
                const q = n / u.v;
                // 省略表記では小数1桁までにして横幅を抑える
                return `${q.toFixed(Math.abs(q) >= 100 ? 0 : 1)}${u.s}`;
            }
        }
    }
    // 1e15 以上はカンマ区切りだと桁が崩れるので指数表記に逃がす
    if (Math.abs(n) >= 1e15) return n.toExponential(2);
    const fixed = n.toFixed(clamp(d, 0, 6));
    const [int, frac] = fixed.split('.');
    const withComma = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${withComma}.${frac}` : withComma;
}

// ---------------------------------------------------------------------------
// 帯（editor.threshold）
// ---------------------------------------------------------------------------

/**
 * editor.threshold の生値（[{from,to,value}]）を正規化する。
 * - 配列でない / 空 / 全要素が壊れている → 既定の帯へ倒す
 * - from/to は null・欠落・非数値のいずれも「境界なし」(±Infinity) とみなす
 * - value（色）が解釈できない要素は落とす
 * - from > to の逆転は入れ替えて救済し、from 昇順に並べ直す（未ソート入力も可）
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

// 数値 → 帯（[from, to) の半開区間）。外れたら最も近い端の帯へ丸める
function bandFor(n, bands) {
    if (!Number.isFinite(n) || bands.length === 0) return null;
    for (let i = 0; i < bands.length; i += 1) {
        const b = bands[i];
        if (n >= b.from && n < b.to) return b;
    }
    if (n < bands[0].from) return bands[0];
    return bands[bands.length - 1];
}

// 帯のラベル（凡例・内訳に出す）。開いた端は「〜」で表す
function bandLabel(b) {
    const fin = (v) => (Number.isFinite(v) ? String(v) : '');
    const lo = fin(b.from);
    const hi = fin(b.to);
    if (lo === '' && hi === '') return 'ALL';
    if (lo === '') return `< ${hi}`;
    if (hi === '') return `${lo} +`;
    return `${lo}–${hi}`;
}

// 値 → 色（colorMode に従う）
/**
 * 値 → 色。colorMode に従う。
 * gradient のときは帯の色を滑らかに補間する（開いた帯のアンカーに使う範囲は
 * lo/hi で渡す。省略時は帯の有限な端から推定する）。
 */
function colorForValue(n, opts, lo, hi) {
    if (opts.colorMode === 'fixed') return opts.fixedColor;
    if (opts.colorMode === 'gradient') {
        const r = resolveBandRange(opts.colorBands, lo, hi);
        return gradientColorForValue(n, opts, r.lo, r.hi);
    }
    const b = bandFor(n, opts.colorBands);
    return b ? b.value : opts.fixedColor;
}

// 開いた帯（±Infinity）のアンカー算出に使う範囲を決める。
// 明示的な lo/hi があればそれを使い、無ければ帯の有限な端から推定する。
function resolveBandRange(bands, lo, hi) {
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return { lo, hi };
    const fin = [];
    bands.forEach((b) => {
        if (Number.isFinite(b.from)) fin.push(b.from);
        if (Number.isFinite(b.to)) fin.push(b.to);
    });
    if (fin.length === 0) return { lo: 0, hi: 1 };
    const mn = Math.min(...fin);
    const mx = Math.max(...fin);
    // 有限な端が1点しかない場合は、その周辺に幅を持たせる
    if (mn === mx) return { lo: mn - 1, hi: mx + 1 };
    return { lo: mn, hi: mx };
}

/**
 * 帯の色を「滑らかに補間した」色を返す（グラデーション用）。
 *
 * 帯は範囲（from〜to）に対して1色を持つので、そのままでは境界で色が階段状に変わる。
 * ここでは **各帯の中央を「その色のアンカー点」** とみなし、隣り合うアンカーの間を
 * 線形補間する。こうすると「帯のど真ん中の値＝その帯の色ちょうど」になり、
 * 境界付近では隣の帯の色へ half-half で寄った色になる。
 *
 * - アンカーは帯の中央。ただし開いた端（±Infinity）は範囲の端（lo / hi）で代用する
 * - 最初のアンカーより手前／最後のアンカーより先はクランプ（端の色のまま）
 * - 帯が1つしかない場合はその色を返す
 *
 * @param {number} n     値
 * @param {object} opts  正規化済みオプション
 * @param {number} lo    ゲージ範囲の下限（開いた帯のアンカー算出に使う）
 * @param {number} hi    ゲージ範囲の上限
 */
function gradientColorForValue(n, opts, lo, hi) {
    if (opts.colorMode === 'fixed') return opts.fixedColor;
    const bands = opts.colorBands;
    if (bands.length === 0) return opts.fixedColor;
    if (bands.length === 1) return bands[0].value;

    // 各帯の代表点（中央）を求める。開いた端は範囲の端で閉じて扱う
    const anchors = bands.map((b) => {
        const f = Number.isFinite(b.from) ? b.from : lo;
        const tt = Number.isFinite(b.to) ? b.to : hi;
        return { at: (f + tt) / 2, color: b.value };
    });
    anchors.sort((a, b) => a.at - b.at);

    if (!Number.isFinite(n) || n <= anchors[0].at) return anchors[0].color;
    if (n >= anchors[anchors.length - 1].at) return anchors[anchors.length - 1].color;

    for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        if (n >= a.at && n <= b.at) {
            const span = b.at - a.at;
            const u = span <= 0 ? 0 : (n - a.at) / span;
            return lerpColor(a.color, b.color, u);
        }
    }
    return anchors[anchors.length - 1].color;
}

// 2色を線形補間して 'rgb(r,g,b)' を返す
function lerpColor(hexA, hexB, u) {
    const a = hexToRgb(hexA) || parseRgb(hexA);
    const b = hexToRgb(hexB) || parseRgb(hexB);
    if (!a || !b) return hexA;
    const k = clamp01(u);
    return `rgb(${Math.round(a.r + (b.r - a.r) * k)},${Math.round(a.g + (b.g - a.g) * k)},${Math.round(
        a.b + (b.b - a.b) * k
    )})`;
}

// ---------------------------------------------------------------------------
// オプション正規化（型・範囲を安全側へ）
// ---------------------------------------------------------------------------

// editor.arrayOfStrings は文字列配列を生で渡してくる。既知の統計名だけ拾う
function statListOf(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const out = [];
    src.forEach((s) => {
        const k = String(s || '').trim().toLowerCase();
        if (STAT_KEYS.includes(k) && !out.includes(k)) out.push(k);
    });
    return out.length > 0 ? out : STAT_LIST_DEFAULTS;
}

function normalizeOptions(raw) {
    const o = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const bool = (v, d) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);
    const numOr = (v, d) => {
        const n = parseNum(v);
        return Number.isFinite(n) ? n : d;
    };
    const strOr = (v, d) => (typeof v === 'string' ? v : d);
    // 列挙値：ホワイトリストに無ければ既定へ丸める。
    // ここで旧バージョンの値を読み替えては「いけない」（既定値と同じ値は options に
    // 載らないため、既定を選び直しても旧値が復活してしまう）。
    const enumOr = (v, list, d) => (list.includes(v) ? v : d);
    const colorOr = (v, d) => (hexToRgb(v) ? v : d);

    // 開き角は editor.select の value。数値／文字列のどちらで届いても受ける
    const sweepRaw = parseNum(o.sweepAngle);
    const sweepAngle = SWEEP_ANGLES.includes(sweepRaw)
        ? sweepRaw
        : Number.isFinite(sweepRaw)
          ? clamp(sweepRaw, 60, 350)
          : DEFAULTS.sweepAngle;

    // 最小 > 最大 の入力は入れ替えて救済。同値ならゲージが潰れるので最大側を +1
    let minValue = numOr(o.minValue, DEFAULTS.minValue);
    let maxValue = numOr(o.maxValue, DEFAULTS.maxValue);
    if (minValue > maxValue) [minValue, maxValue] = [maxValue, minValue];
    if (minValue === maxValue) maxValue = minValue + 1;

    return {
        valueField: typeof o.valueField === 'string' || Array.isArray(o.valueField) ? o.valueField : '',
        labelField: typeof o.labelField === 'string' || Array.isArray(o.labelField) ? o.labelField : '',
        compareField:
            typeof o.compareField === 'string' || Array.isArray(o.compareField) ? o.compareField : '',

        aggMode: enumOr(o.aggMode, AGG_MODES, DEFAULTS.aggMode),
        minValue,
        maxValue,
        autoScale: bool(o.autoScale, DEFAULTS.autoScale),

        gaugeStyle: enumOr(o.gaugeStyle, GAUGE_STYLES, DEFAULTS.gaugeStyle),
        sweepAngle,
        arcThickness: clamp(Math.round(numOr(o.arcThickness, DEFAULTS.arcThickness)), 2, 90),
        segmentCount: clamp(Math.round(numOr(o.segmentCount, DEFAULTS.segmentCount)), 3, 120),
        segmentGap: clamp(Math.round(numOr(o.segmentGap, DEFAULTS.segmentGap)), 0, 80),
        litMode: enumOr(o.litMode, LIT_MODES, DEFAULTS.litMode),
        showTrack: bool(o.showTrack, DEFAULTS.showTrack),
        showGlow: bool(o.showGlow, DEFAULTS.showGlow),
        glowStrength: clamp(Math.round(numOr(o.glowStrength, DEFAULTS.glowStrength)), 0, 100),
        showTicks: bool(o.showTicks, DEFAULTS.showTicks),
        showRangeLabels: bool(o.showRangeLabels, DEFAULTS.showRangeLabels),
        showBoundaryValues: bool(o.showBoundaryValues, DEFAULTS.showBoundaryValues),
        showNeedle: bool(o.showNeedle, DEFAULTS.showNeedle),
        animate: bool(o.animate, DEFAULTS.animate),
        animateDuration: clamp(numOr(o.animateDuration, DEFAULTS.animateDuration), 0, 10),

        colorMode: enumOr(o.colorMode, COLOR_MODES, DEFAULTS.colorMode),
        colorBands: normalizeBands(o.colorBands),
        fixedColor: colorOr(o.fixedColor, DEFAULTS.fixedColor),

        titleText: strOr(o.titleText, ''),
        unitText: strOr(o.unitText, ''),
        decimals: clamp(Math.round(numOr(o.decimals, DEFAULTS.decimals)), 0, 6),
        compactNumbers: bool(o.compactNumbers, DEFAULTS.compactNumbers),
        showTitle: bool(o.showTitle, DEFAULTS.showTitle),
        showBandLabel: bool(o.showBandLabel, DEFAULTS.showBandLabel),
        valueColorMode: enumOr(o.valueColorMode, VALUE_COLOR_MODES, DEFAULTS.valueColorMode),
        valueFixedColor: colorOr(o.valueFixedColor, DEFAULTS.valueFixedColor),

        compareMode: enumOr(o.compareMode, COMPARE_MODES, DEFAULTS.compareMode),
        compareValue: numOr(o.compareValue, DEFAULTS.compareValue),
        deltaFormat: enumOr(o.deltaFormat, DELTA_FORMATS, DEFAULTS.deltaFormat),
        deltaLabel: strOr(o.deltaLabel, DEFAULTS.deltaLabel),
        goodDirection: enumOr(o.goodDirection, GOOD_DIRECTIONS, DEFAULTS.goodDirection),
        upColor: colorOr(o.upColor, DEFAULTS.upColor),
        downColor: colorOr(o.downColor, DEFAULTS.downColor),
        showDelta: bool(o.showDelta, DEFAULTS.showDelta),

        panelPosition: enumOr(o.panelPosition, PANEL_POSITIONS, DEFAULTS.panelPosition),
        panelWidth: clamp(numOr(o.panelWidth, DEFAULTS.panelWidth), 0.2, 0.6),
        slot1: enumOr(o.slot1, SLOT_KINDS, DEFAULTS.slot1),
        slot2: enumOr(o.slot2, SLOT_KINDS, DEFAULTS.slot2),
        slot3: enumOr(o.slot3, SLOT_KINDS, DEFAULTS.slot3),
        slot4: enumOr(o.slot4, SLOT_KINDS, DEFAULTS.slot4),
        statList: statListOf(o.statList),
        rankCount: clamp(Math.round(numOr(o.rankCount, DEFAULTS.rankCount)), 1, 20),
        noteText: strOr(o.noteText, ''),
        targetValue: numOr(o.targetValue, DEFAULTS.targetValue),
        showTarget: bool(o.showTarget, DEFAULTS.showTarget),
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
// 集計（ゲージの値・比較値・サブ指標）
// ---------------------------------------------------------------------------

function aggregate(nums, mode) {
    if (nums.length === 0) return NaN;
    switch (mode) {
        case 'first':
            return nums[0];
        case 'sum':
            return nums.reduce((a, b) => a + b, 0);
        case 'avg':
            return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'max':
            return Math.max(...nums);
        case 'min':
            return Math.min(...nums);
        case 'count':
            return nums.length;
        case 'last':
        default:
            return nums[nums.length - 1];
    }
}

/**
 * 行群 → 表示に必要な一式を組み立てる。
 * 返すもの: value（ゲージの値）/ points（ラベル+値の系列）/ compare（比較値）/
 *           stats（統計）/ breakdown（帯ごとの件数）/ ranking（上位N）
 */
function buildModel(rawRows, fieldNames, opts) {
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
    const cmpIdx =
        opts.compareMode === 'field'
            ? resolveFieldIndex(opts.compareField, fieldNames, rows, -1)
            : -1;

    // 数値として読める行だけを系列にする
    const points = [];
    rows.forEach((row) => {
        if (!Array.isArray(row)) return;
        const n = parseNum(row[valIdx]);
        if (!Number.isFinite(n)) return;
        const lab = labelIdx >= 0 ? row[labelIdx] : null;
        const cmp = cmpIdx >= 0 ? parseNum(row[cmpIdx]) : NaN;
        points.push({
            label: lab === null || lab === undefined ? '' : String(lab),
            value: n,
            compare: cmp,
        });
    });

    if (points.length === 0) return { error: 'nonumeric', valIdx, labelIdx };

    const nums = points.map((p) => p.value);
    const value = aggregate(nums, opts.aggMode);

    // --- 比較値 ---
    // prev  : 最終行の1つ前（「前回」の素直な定義）
    // first : 系列の先頭
    // avg   : 現在（最終行）を除いた平均
    // field : 指定フィールドの最終行の値
    // fixed : ユーザー指定の固定値
    let compare = NaN;
    if (opts.compareMode === 'prev') {
        if (points.length >= 2) compare = nums[nums.length - 2];
    } else if (opts.compareMode === 'first') {
        if (points.length >= 2) compare = nums[0];
    } else if (opts.compareMode === 'avg') {
        if (points.length >= 2) {
            const rest = nums.slice(0, -1);
            compare = rest.reduce((a, b) => a + b, 0) / rest.length;
        }
    } else if (opts.compareMode === 'field') {
        const last = points[points.length - 1];
        if (last && Number.isFinite(last.compare)) compare = last.compare;
    } else if (opts.compareMode === 'fixed') {
        compare = opts.compareValue;
    }

    // --- 統計（サブ指標） ---
    const stats = {};
    STAT_KEYS.forEach((k) => {
        stats[k] = aggregate(nums, k);
    });

    // --- 帯ごとの件数内訳（各行を帯へ分類） ---
    const bandCounts = new Map(); // band index → n
    if (opts.colorMode === 'band') {
        points.forEach((p) => {
            const b = bandFor(p.value, opts.colorBands);
            if (!b) return;
            const i = opts.colorBands.indexOf(b);
            bandCounts.set(i, (bandCounts.get(i) || 0) + 1);
        });
    }
    const breakdown = [...bandCounts.entries()]
        .map(([i, n]) => ({ band: opts.colorBands[i], n }))
        .filter((e) => e.band)
        .sort((a, b) => b.band.from - a.band.from);

    // --- 上位ランキング（値の大きい順） ---
    const ranking = points
        .filter((p) => p.label !== '')
        .slice()
        .sort((a, b) => b.value - a.value)
        .slice(0, opts.rankCount);

    // --- ゲージの範囲（autoScale ならデータの min/max から決める） ---
    let lo = opts.minValue;
    let hi = opts.maxValue;
    if (opts.autoScale) {
        const dMin = Math.min(...nums);
        const dMax = Math.max(...nums);
        // 全同値だと範囲が潰れるので、値を中心に ±10%（0 なら ±1）のレンジを作る
        if (dMin === dMax) {
            const pad = Math.abs(dMin) > 0 ? Math.abs(dMin) * 0.1 : 1;
            lo = dMin - pad;
            hi = dMax + pad;
        } else {
            lo = dMin;
            hi = dMax;
        }
    }
    if (lo === hi) hi = lo + 1;

    // --- 色帯とゲージ範囲の噛み合わせ判定 ---
    // ★既定の色帯は 0〜100 想定（<60 緑 / 60-85 橙 / 85+ 赤）。範囲を -20〜20 などに
    //   変えても色帯は追従しないため、「全部緑」のまま気づけないことがある
    //   （-15℃ が安全色で塗られる、という実機で見つけた問題）。
    //   色帯の内側の境界が範囲内に1つも無い＝実質1色でしか塗られない状態を検出する。
    let bandMismatch = false;
    if (opts.colorMode === 'band' && opts.colorBands.length > 1) {
        // 内側の境界（帯と帯の切れ目）が範囲 [lo,hi] に入っているか
        const edges = [];
        opts.colorBands.forEach((b) => {
            if (Number.isFinite(b.to)) edges.push(b.to);
            if (Number.isFinite(b.from)) edges.push(b.from);
        });
        bandMismatch = !edges.some((e) => e > lo && e < hi);
    }

    return {
        value,
        points,
        compare,
        stats,
        breakdown,
        ranking,
        total: points.length,
        lo,
        hi,
        valIdx,
        labelIdx,
        bandMismatch,
    };
}

// ---------------------------------------------------------------------------
// 円弧の幾何
//
// 角度は「真下を起点に時計回り」ではなく、開き角 sweep を上向き中心に左右対称へ
// 配置する。sweep=240 なら -120°〜+120°（0° が真上）。SVG 座標は y が下向きなので
// 変換時に sin/cos を入れ替えて上向きを 0 にしている。
// ---------------------------------------------------------------------------

// t（0..1）→ 角度（度）。開き角の左端から右端へ
function angleAt(t, sweep) {
    return -sweep / 2 + clamp01(t) * sweep;
}

// 角度（度）＋半径 → SVG 座標。0° が真上、正が時計回り
function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// 円弧のパス（太さを持つドーナツ状のセクター）
function arcPath(cx, cy, rOuter, rInner, deg0, deg1) {
    const a0 = Math.min(deg0, deg1);
    const a1 = Math.max(deg0, deg1);
    // ほぼ 0 幅なら空パス（描画すると点が残る）
    if (a1 - a0 < 0.01) return '';
    const large = a1 - a0 > 180 ? 1 : 0;
    const o0 = polar(cx, cy, rOuter, a0);
    const o1 = polar(cx, cy, rOuter, a1);
    const i1 = polar(cx, cy, rInner, a1);
    const i0 = polar(cx, cy, rInner, a0);
    return [
        `M ${o0.x.toFixed(2)} ${o0.y.toFixed(2)}`,
        `A ${rOuter.toFixed(2)} ${rOuter.toFixed(2)} 0 ${large} 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
        `L ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
        `A ${rInner.toFixed(2)} ${rInner.toFixed(2)} 0 ${large} 0 ${i0.x.toFixed(2)} ${i0.y.toFixed(2)}`,
        'Z',
    ].join(' ');
}

// ---------------------------------------------------------------------------
// 配色（テーマ）
// ---------------------------------------------------------------------------

function palette(mode) {
    const dark = mode === 'dark';
    return {
        text: dark ? '#e6edf3' : '#1a1c20',
        title: dark ? '#c9d1d9' : '#3d444d',
        sub: dark ? '#8b98a5' : '#5c6773',
        faint: dark ? '#6b7785' : '#8b98a5',
        track: dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)',
        trackLit: dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)',
        divider: dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.09)',
        panelBg: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        tick: dark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.25)',
        needle: dark ? '#e6edf3' : '#2b3038',
        // タコメーターの針の軸（ハブ）の中心。針色に対して抜けて見える色
        hubInner: dark ? '#12151c' : '#f5f7fa',
        // 設定の不整合を知らせるバッジ（琥珀系。データの色分けとは別系統にする）
        warnInk: dark ? '#f0b429' : '#8a5a00',
        warnBg: dark ? 'rgba(240,180,41,0.12)' : 'rgba(240,180,41,0.16)',
        warnBorder: dark ? 'rgba(240,180,41,0.42)' : 'rgba(160,110,0,0.36)',
    };
}

const FONT_STACK =
    "'Splunk Platform Sans', 'Proxima Nova', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif";

// アニメーション用の keyframes を1度だけ head に注入する
const STYLE_ID = 'gauge-arc-keyframes';
function ensureKeyframes() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '@keyframes gaugeArcFadeIn{from{opacity:0}to{opacity:1}}';
    try {
        document.head.appendChild(style);
    } catch (e) {
        /* head が無い環境でも落とさない */
    }
}

// ---------------------------------------------------------------------------
// メッセージ表示（ガード用）
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
                boxSizing: 'border-box',
                padding: 12,
                textAlign: 'center',
            }}
        >
            <Paragraph>{children}</Paragraph>
            {sub && (
                <div style={{ opacity: 0.7, fontSize: 12, marginTop: 4, fontFamily: FONT_STACK }}>{sub}</div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 値のアニメーション（0 → 目標値へイージング）
//
// rAF で数値を補間する。opts.animate が false / duration が 0 のときは即時。
// データやオプションが変わったら現在の表示値から新しい目標へ繋ぐ（飛ばない）。
// ---------------------------------------------------------------------------

function useAnimatedValue(target, enabled, durationSec) {
    const [shown, setShown] = useState(enabled ? 0 : target);
    const fromRef = useRef(enabled ? 0 : target);
    const rafRef = useRef(0);

    useEffect(() => {
        if (!Number.isFinite(target)) return undefined;
        if (!enabled || durationSec <= 0) {
            fromRef.current = target;
            setShown(target);
            return undefined;
        }
        const from = Number.isFinite(fromRef.current) ? fromRef.current : 0;
        const start =
            typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        const dur = durationSec * 1000;
        const ease = (u) => 1 - Math.pow(1 - u, 3); // easeOutCubic

        const step = () => {
            const now =
                typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
            const u = clamp01((now - start) / dur);
            const v = from + (target - from) * ease(u);
            fromRef.current = v;
            setShown(v);
            if (u < 1) {
                rafRef.current = requestAnimationFrame(step);
            } else {
                fromRef.current = target;
                setShown(target);
            }
        };
        rafRef.current = requestAnimationFrame(step);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [target, enabled, durationSec]);

    return Number.isFinite(shown) ? shown : target;
}

// ---------------------------------------------------------------------------
// ゲージ本体（SVG）
// ---------------------------------------------------------------------------

function GaugeArc({ w, h, value, shownValue, opts, pal, model, boundaryFont, density }) {
    const sweep = opts.sweepAngle;
    const { lo, hi } = model;
    const isTacho = opts.gaugeStyle === 'tachometer';
    // 狭いパネルでの退避（density は呼び出し側が実寸から決める）。
    // 目盛りは情報量が少ないので先に消し、端の数値ラベルはぎりぎりまで残す。
    const dense = density || { tiny: false, small: false };
    const showTicks = opts.showTicks && !dense.small;
    const showRangeLabels = opts.showRangeLabels && !dense.tiny;
    const showBoundaryValues = opts.showBoundaryValues && !dense.small;

    // 値 → t（0..1）。範囲外は端に張り付く
    const tOf = (v) => clamp01((v - lo) / (hi - lo));
    const t = tOf(shownValue);

    // --- レイアウト ---
    // 弧が実際に占める矩形を角度から求め、その内側に収まる半径を採る。
    // 端の数値ラベル（最小/最大・境界値）を外側に描くので、その分の余白も確保する。
    const halfRad = ((sweep / 2) * Math.PI) / 180;
    // 端点の方向ベクトル（0° が真上、左右対称）
    const endDx = Math.sin(halfRad);
    const endDy = -Math.cos(halfRad);

    // 弧の外接矩形（半径 1 のとき）を「実際に弧が通る範囲」から求める。
    // 真上(0°)は常に通るので上端は -1。下端・左右端は、その方向の極値角
    // （下=180°, 左右=±90°）が開き角の内側に入るときだけ 1 に達する。
    // ここを sweep>=180 で一律 1 にすると、例えば 240° では実際の下端が 0.5 なのに
    // 1 として場所を取り、**下に大きな余白ができて弧も小さくなる**（v1.1.0 の不具合）。
    const half = sweep / 2;
    const top = -1; // 0°（真上）は必ず含まれる
    const bottom = half >= 180 ? 1 : endDy;
    const halfWidth = half >= 90 ? 1 : endDx; // ±90° を含むなら左右いっぱい
    const wSpan = halfWidth * 2;
    const hSpan = clamp(bottom - top, 0.35, 2);

    // ラベル用の余白（弧の外側に文字を出すので、その分を上下左右に確保する）。
    // ラベルは rOuter + boundaryFont*0.75 の位置に描くので、それ以上を見込む。
    const hasOuterLabels = showRangeLabels || showBoundaryValues;
    const labelPad = hasOuterLabels ? boundaryFont * 2.0 : 4;
    const padX = 8 + (hasOuterLabels ? boundaryFont * 1.6 : 0);
    const padY = 8;

    const rByW = (w - padX * 2) / wSpan;
    // 高さ方向は「弧の縦幅 + 上下に出るラベル」を見込む。
    // 上端ラベル（例: 開き角 240° の頂点に来る境界値）も外へ出るため、上下ぶん確保する。
    const rByH = (h - padY * 2 - labelPad * 2) / hSpan;
    const rOuter = Math.max(18, Math.min(rByW, rByH));
    const thickness = clamp(opts.arcThickness, 2, rOuter * 0.55);
    const rInner = Math.max(4, rOuter - thickness);

    // 弧＋ラベルの実際の縦幅を求め、その塊をゲージ領域の中央に置く。
    // （上に labelPad を必ず確保するので、頂点のラベルが見切れない）
    const arcTopY = -rOuter; // 中心からの相対
    const arcBottomY = bottom * rOuter;
    const blockTop = arcTopY - labelPad;
    const blockBottom = arcBottomY + labelPad;
    const blockH = blockBottom - blockTop;
    const cx = w / 2;
    // 中心 = 上余白 + 塊の中で「中心」が占める位置
    const cy = (h - blockH) / 2 - blockTop;

    const curColor = colorForValue(value, opts, lo, hi);
    const glow = opts.showGlow && opts.glowStrength > 0 ? (opts.glowStrength / 100) * 0.9 : 0;

    // --- トラック（下地）---
    const trackPath = arcPath(cx, cy, rOuter, rInner, angleAt(0, sweep), angleAt(1, sweep));

    // --- 塗り（連続 / セグメント）---
    // タコメーターは「帯を全周ぶん常時塗り、針で現在値を指す」方式なので
    // 連続の「値まで塗る」とは別扱いにする。
    const segments = [];
    if (opts.gaugeStyle === 'segmented') {
        const n = opts.segmentCount;
        const stepDeg = sweep / n;
        const gapDeg = stepDeg * (opts.segmentGap / 100);
        for (let i = 0; i < n; i += 1) {
            const t0 = i / n;
            const t1 = (i + 1) / n;
            const a0 = angleAt(t0, sweep) + gapDeg / 2;
            const a1 = angleAt(t1, sweep) - gapDeg / 2;
            if (a1 <= a0) continue;
            // 点灯判定はセグメントの中心が値を下回るか
            const mid = (t0 + t1) / 2;
            const lit = mid <= t;
            // 各セグメントの色：位置の帯色（band）か、現在値の色で統一（current）
            // gradient のときは colorForValue が補間色を返すので、セグメントも
            // 自然に「隣の小片へ色が少しずつ移る」表現になる
            const segValue = lo + mid * (hi - lo);
            const litColor = opts.litMode === 'current' ? curColor : colorForValue(segValue, opts, lo, hi);
            segments.push({
                key: `seg${i}`,
                d: arcPath(cx, cy, rOuter, rInner, a0, a1),
                lit,
                color: litColor,
            });
        }
    }

    // グラデーションは「弧に沿って色が変わる」ため SVG の linearGradient では表現
    // できない（直線方向にしか効かない）。細かい小片に分割し、各片を補間色で塗る。
    // 分割数は弧長に比例させ、1片あたり約 2° 以下になるようにする（継ぎ目が見えない）。
    const gradSteps = clamp(Math.ceil(sweep / 2), 24, 180);

    // 0..tEnd の弧を、帯の境界（band）または細かい等分（gradient）で塗り分ける。
    // 単色（fixed）なら 1 本で済む。
    const buildParts = (tEnd, keyPrefix) => {
        const parts = [];
        if (tEnd <= 0) return parts;
        if (opts.colorMode === 'fixed') {
            parts.push({
                key: keyPrefix,
                d: arcPath(cx, cy, rOuter, rInner, angleAt(0, sweep), angleAt(tEnd, sweep)),
                color: opts.fixedColor,
            });
            return parts;
        }
        if (opts.colorMode === 'gradient') {
            // 等分した小片ごとに、その中央の値の補間色を塗る。
            // 隣接片が僅かに重なるよう半ステップ伸ばし、アンチエイリアスの隙間を防ぐ。
            const n = Math.max(1, Math.round(gradSteps * tEnd));
            const step = tEnd / n;
            for (let i = 0; i < n; i += 1) {
                const t0 = i * step;
                const t1 = (i + 1) * step;
                const overlap = i < n - 1 ? step * 0.5 : 0;
                const midV = lo + ((t0 + t1) / 2) * (hi - lo);
                parts.push({
                    key: `${keyPrefix}${i}`,
                    d: arcPath(cx, cy, rOuter, rInner, angleAt(t0, sweep), angleAt(t1 + overlap, sweep)),
                    color: gradientColorForValue(midV, opts, lo, hi),
                });
            }
            return parts;
        }
        // band: 帯の境界を 0..tEnd の範囲で拾い、区間ごとにその帯の色で塗る
        const edges = [0];
        opts.colorBands.forEach((b) => {
            [b.from, b.to].forEach((e) => {
                if (!Number.isFinite(e)) return;
                const te = (e - lo) / (hi - lo);
                if (te > 0 && te < tEnd) edges.push(te);
            });
        });
        edges.push(tEnd);
        const uniq = [...new Set(edges.map((x) => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b);
        for (let i = 0; i < uniq.length - 1; i += 1) {
            const t0 = uniq[i];
            const t1 = uniq[i + 1];
            if (t1 - t0 <= 0) continue;
            const midV = lo + ((t0 + t1) / 2) * (hi - lo);
            parts.push({
                key: `${keyPrefix}${i}`,
                d: arcPath(cx, cy, rOuter, rInner, angleAt(t0, sweep), angleAt(t1, sweep)),
                color: colorForValue(midV, opts, lo, hi),
            });
        }
        return parts;
    };

    const fillParts = opts.gaugeStyle === 'continuous' ? buildParts(t, 'fill') : [];

    // --- タコメーター：帯を全周ぶん塗る（現在値は針が指す）---
    // 連続と同じ塗り分けロジックを、値までではなくレンジ全体（t=1）に適用する。
    const tachoParts = isTacho ? buildParts(1, 'tacho') : [];

    // --- 目盛り ---
    const ticks = [];
    if (showTicks) {
        const n = 10;
        for (let i = 0; i <= n; i += 1) {
            const tt = i / n;
            const major = i % 5 === 0;
            const a = angleAt(tt, sweep);
            const r1 = rInner - 3;
            const r2 = rInner - (major ? 10 : 6);
            if (r2 < 4) break;
            const p1 = polar(cx, cy, r1, a);
            const p2 = polar(cx, cy, r2, a);
            ticks.push({ key: `tick${i}`, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, major });
        }
    }

    // --- 帯の境界の数値ラベル（色が切り替わる位置に値を出す）---
    // 弧の外側に、その角度の方向へ押し出して置く。両端（最小/最大）と近すぎるもの、
    // ラベル同士が重なるものは間引く。
    const boundaryLabels = [];
    if (showBoundaryValues && opts.colorMode === 'band') {
        const seen = new Set();
        const cand = [];
        opts.colorBands.forEach((b) => {
            [b.from, b.to].forEach((e) => {
                if (!Number.isFinite(e)) return;
                const te = (e - lo) / (hi - lo);
                // レンジ外や両端に重なる境界は出さない（最小/最大ラベルと衝突するため）
                if (te <= 0.04 || te >= 0.96) return;
                const k = Math.round(te * 1e4);
                if (seen.has(k)) return;
                seen.add(k);
                cand.push({ t: te, value: e });
            });
        });
        cand.sort((a, b) => a.t - b.t);
        // 角度が近すぎるラベルは間引く（弧長ベースで最小間隔を確保）
        const minGapT = clamp((boundaryFont * 2.6) / (Math.PI * rOuter * (sweep / 180)), 0.04, 0.5);
        let lastT = -1;
        cand.forEach((c, i) => {
            if (lastT >= 0 && c.t - lastT < minGapT) return;
            lastT = c.t;
            const a = angleAt(c.t, sweep);
            const p = polar(cx, cy, rOuter + boundaryFont * 0.75, a);
            const rad = ((a - 90) * Math.PI) / 180;
            boundaryLabels.push({
                key: `bl${i}`,
                x: p.x,
                y: p.y,
                // 角度に応じて基準位置を変え、弧から放射状に離す
                anchor: Math.cos(rad) > 0.25 ? 'start' : Math.cos(rad) < -0.25 ? 'end' : 'middle',
                dy: Math.sin(rad) > 0.25 ? boundaryFont * 0.85 : Math.sin(rad) < -0.25 ? -boundaryFont * 0.2 : boundaryFont * 0.35,
                text: formatNumber(c.value, opts),
            });
        });
    }

    // --- 目標線 ---
    let targetMark = null;
    if (opts.showTarget) {
        const tt = tOf(opts.targetValue);
        const a = angleAt(tt, sweep);
        const p1 = polar(cx, cy, rOuter + 3, a);
        const p2 = polar(cx, cy, rInner - 3, a);
        targetMark = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }

    // --- 針 ---
    // タコメーターは針が主役なので常に出す（showNeedle に関係なく）
    let needle = null;
    if (opts.showNeedle || isTacho) {
        const a = angleAt(t, sweep);
        // ★針は弧の内縁まで伸ばさず、少し手前で止める。内縁ぴったりだと帯に触れて
        //   「どの色を指しているか」が読みにくく、中央の数値にも近づきすぎる。
        const needleR = isTacho ? rInner * 0.9 : rInner - 2;
        const tip = polar(cx, cy, needleR, a);
        // タコメーターは根元に少し幅を持たせた三角形の針にする
        const backA1 = a + 90;
        const backA2 = a - 90;
        const hubR = clamp(thickness * 0.3, 3, 8);
        const b1 = polar(cx, cy, hubR * 0.75, backA1);
        const b2 = polar(cx, cy, hubR * 0.75, backA2);
        needle = {
            x: tip.x,
            y: tip.y,
            hubR,
            poly: `${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${b1.x.toFixed(2)},${b1.y.toFixed(2)} ${b2.x.toFixed(2)},${b2.y.toFixed(2)}`,
        };
    }

    // --- 最小/最大ラベル ---
    // 弧の端点の外側へ、放射方向に押し出して置く（見切れ防止）。
    const endAngleLo = angleAt(0, sweep);
    const endAngleHi = angleAt(1, sweep);
    const labelR = rOuter + boundaryFont * 0.75;
    const loPt = polar(cx, cy, labelR, endAngleLo);
    const hiPt = polar(cx, cy, labelR, endAngleHi);
    const radLo = ((endAngleLo - 90) * Math.PI) / 180;
    const radHi = ((endAngleHi - 90) * Math.PI) / 180;
    const endLabel = (pt, rad) => ({
        x: pt.x,
        y: pt.y,
        anchor: Math.cos(rad) > 0.25 ? 'start' : Math.cos(rad) < -0.25 ? 'end' : 'middle',
        dy: Math.sin(rad) > 0.25 ? boundaryFont * 0.85 : Math.sin(rad) < -0.25 ? -boundaryFont * 0.2 : boundaryFont * 0.35,
    });
    const loLabel = endLabel(loPt, radLo);
    const hiLabel = endLabel(hiPt, radHi);


    return (
        <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            style={{ display: 'block', overflow: 'visible' }}
            role="img"
            aria-label={`gauge ${formatNumber(value, opts)}`}
        >
            <defs>
                {glow > 0 && (
                    <filter id="gaugeArcGlow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation={clamp(thickness * 0.28, 1.5, 9)} result="b" />
                        <feMerge>
                            <feMergeNode in="b" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                )}
            </defs>

            {/* 下地（トラック） */}
            {opts.showTrack && trackPath && <path d={trackPath} fill={pal.track} data-role="track" />}

            {/* セグメント（消灯分も薄く描いてイコライザ感を出す） */}
            {opts.gaugeStyle === 'segmented' &&
                segments.map((s) =>
                    s.d ? (
                        <path
                            key={s.key}
                            d={s.d}
                            fill={s.lit ? s.color : pal.trackLit}
                            opacity={s.lit ? 1 : 0.5}
                            filter={s.lit && glow > 0 ? 'url(#gaugeArcGlow)' : undefined}
                            data-role="segment"
                            data-lit={s.lit ? '1' : '0'}
                        />
                    ) : null
                )}

            {/* 連続の塗り */}
            {opts.gaugeStyle === 'continuous' &&
                fillParts.map((p) =>
                    p.d ? (
                        <path
                            key={p.key}
                            d={p.d}
                            fill={p.color}
                            filter={glow > 0 ? 'url(#gaugeArcGlow)' : undefined}
                            data-role="fill"
                        />
                    ) : null
                )}

            {/* タコメーター：帯を全周ぶん常時塗る（現在値は針が指す） */}
            {isTacho &&
                tachoParts.map((p) =>
                    p.d ? (
                        <path
                            key={p.key}
                            d={p.d}
                            fill={p.color}
                            opacity={0.92}
                            data-role="tacho-band"
                        />
                    ) : null
                )}

            {/* 目盛り */}
            {ticks.map((tk) => (
                <line
                    key={tk.key}
                    x1={tk.x1}
                    y1={tk.y1}
                    x2={tk.x2}
                    y2={tk.y2}
                    stroke={pal.tick}
                    strokeWidth={tk.major ? 1.6 : 1}
                    strokeLinecap="round"
                />
            ))}

            {/* 目標線 */}
            {targetMark && (
                <line
                    x1={targetMark.x1}
                    y1={targetMark.y1}
                    x2={targetMark.x2}
                    y2={targetMark.y2}
                    stroke={pal.needle}
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    data-role="target"
                />
            )}

            {/* 針（タコメーターは三角形＋ハブ、それ以外は細い線） */}
            {needle && (
                <g data-role="needle">
                    {isTacho ? (
                        <>
                            <polygon points={needle.poly} fill={pal.needle} />
                            <circle cx={cx} cy={cy} r={needle.hubR} fill={pal.needle} />
                            <circle cx={cx} cy={cy} r={needle.hubR * 0.45} fill={pal.hubInner} />
                        </>
                    ) : (
                        <>
                            <line
                                x1={cx}
                                y1={cy}
                                x2={needle.x}
                                y2={needle.y}
                                stroke={pal.needle}
                                strokeWidth={2.2}
                                strokeLinecap="round"
                            />
                            <circle cx={cx} cy={cy} r={clamp(thickness * 0.22, 2.5, 6)} fill={pal.needle} />
                        </>
                    )}
                </g>
            )}

            {/* 帯の境界の数値（色が切り替わる位置） */}
            {boundaryLabels.length > 0 && (
                <g fill={pal.sub} fontSize={boundaryFont} fontFamily={FONT_STACK} fontWeight={600}>
                    {boundaryLabels.map((b) => (
                        <text key={b.key} x={b.x} y={b.y + b.dy} textAnchor={b.anchor} data-role="boundary-label">
                            {b.text}
                        </text>
                    ))}
                </g>
            )}

            {/* 最小・最大ラベル（弧の外側へ放射方向に押し出して見切れを防ぐ） */}
            {showRangeLabels && (
                <g fill={pal.faint} fontSize={boundaryFont} fontFamily={FONT_STACK}>
                    <text x={loLabel.x} y={loLabel.y + loLabel.dy} textAnchor={loLabel.anchor} data-role="range-lo">
                        {formatNumber(lo, opts)}
                    </text>
                    <text x={hiLabel.x} y={hiLabel.y + hiLabel.dy} textAnchor={hiLabel.anchor} data-role="range-hi">
                        {formatNumber(hi, opts)}
                    </text>
                </g>
            )}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// 差分（前回比）の計算と表示
// ---------------------------------------------------------------------------

function computeDelta(value, compare, opts) {
    if (!Number.isFinite(value) || !Number.isFinite(compare)) return null;
    const diff = value - compare;
    // 比較値が 0 のとき割合は定義できない（0 除算）。値のみ出す
    const pct = compare === 0 ? NaN : (diff / Math.abs(compare)) * 100;
    let good = null; // true=良い変化 / false=悪い変化 / null=色分けしない・変化なし
    if (opts.goodDirection !== 'none' && diff !== 0) {
        good = opts.goodDirection === 'up' ? diff > 0 : diff < 0;
    }
    const color = good === null ? null : good ? opts.upColor : opts.downColor;
    return { diff, pct, good, color };
}

function deltaText(d, opts) {
    if (!d) return '';
    const sign = d.diff > 0 ? '+' : d.diff < 0 ? '−' : '±';
    const absStr = formatNumber(Math.abs(d.diff), opts);
    const pctStr = Number.isFinite(d.pct)
        ? `${d.pct > 0 ? '+' : d.pct < 0 ? '−' : '±'}${Math.abs(d.pct).toFixed(1)}%`
        : '—';
    if (opts.deltaFormat === 'absolute') return `${sign}${absStr}`;
    if (opts.deltaFormat === 'percent') return pctStr;
    return `${sign}${absStr} (${pctStr})`;
}

// 上下を示す三角形。変化なしのときは横棒
function DeltaArrow({ diff, color, size }) {
    const c = color || 'currentColor';
    if (diff === 0) {
        return (
            <svg width={size} height={size} viewBox="0 0 10 10" style={{ flex: 'none' }} aria-hidden="true">
                <rect x="1" y="4.2" width="8" height="1.6" rx="0.8" fill={c} />
            </svg>
        );
    }
    const up = diff > 0;
    return (
        <svg width={size} height={size} viewBox="0 0 10 10" style={{ flex: 'none' }} aria-hidden="true">
            <path d={up ? 'M5 1.5 L9 8 L1 8 Z' : 'M5 8.5 L1 2 L9 2 Z'} fill={c} />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// サブ情報パネルの各スロット
// ---------------------------------------------------------------------------

function SlotShell({ title, pal, fs, compact, children }) {
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: Math.round(fs * 0.3),
            minWidth: 0,
            // 下パネルでは各スロットを中央揃えにする
            alignItems: compact ? 'center' : 'stretch',
            textAlign: compact ? 'center' : 'left',
        }}>
            {title && (
                <div
                    style={{
                        color: pal.faint,
                        fontSize: Math.round(fs * 0.82),
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {title}
                </div>
            )}
            {children}
        </div>
    );
}

// 前回比
function DeltaSlot({ model, opts, pal, fs, compact }) {
    const d = computeDelta(model.value, model.compare, opts);
    if (!d) {
        return (
            <SlotShell title={opts.deltaLabel} pal={pal} fs={fs} compact={compact}>
                <div style={{ color: pal.faint, fontSize: fs }}>比較対象がありません</div>
            </SlotShell>
        );
    }
    return (
        <SlotShell title={opts.deltaLabel} pal={pal} fs={fs} compact={compact}>
            <div
                data-role="delta"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: Math.round(fs * 0.4),
                    color: d.color || pal.text,
                    fontSize: Math.round(fs * 1.22),
                    fontWeight: 800,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                }}
            >
                <DeltaArrow diff={d.diff} color={d.color || pal.sub} size={Math.round(fs * 0.95)} />
                <span>{deltaText(d, opts)}</span>
            </div>
            <div style={{ color: pal.faint, fontSize: Math.round(fs * 0.85), fontVariantNumeric: 'tabular-nums' }}>
                前回 {formatNumber(model.compare, opts)}
                {opts.unitText ? ` ${opts.unitText}` : ''}
            </div>
        </SlotShell>
    );
}

// サブ指標（合計・平均・最大…）
function StatsSlot({ model, opts, pal, fs, compact }) {
    return (
        <SlotShell title="サブ指標" pal={pal} fs={fs} compact={compact}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(fs * 0.22) }}>
                {opts.statList.map((k) => (
                    <div
                        key={k}
                        data-role="stat"
                        data-stat={k}
                        style={{
                            display: 'flex',
                            alignItems: 'baseline',
                            // 下パネルは横に広いので、両端に離すと視線移動が大きい。中央に寄せる
                            justifyContent: compact ? 'center' : 'space-between',
                            gap: compact ? 6 : 10,
                            minWidth: 0,
                        }}
                    >
                        <span style={{ color: pal.sub, fontSize: Math.round(fs * 0.92), whiteSpace: 'nowrap' }}>
                            {STAT_LABELS[k] || k}
                        </span>
                        <span
                            style={{
                                color: pal.text,
                                fontSize: fs,
                                fontWeight: 700,
                                fontVariantNumeric: 'tabular-nums',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {formatNumber(model.stats[k], opts)}
                        </span>
                    </div>
                ))}
            </div>
        </SlotShell>
    );
}

// 帯ごとの件数内訳
function BreakdownSlot({ model, opts, pal, fs, compact }) {
    if (opts.colorMode !== 'band' || model.breakdown.length === 0) {
        return (
            <SlotShell title="内訳" pal={pal} fs={fs} compact={compact}>
                <div style={{ color: pal.faint, fontSize: fs }}>
                    {opts.colorMode === 'band' ? '該当なし' : '「値の範囲で色分け」で使えます'}
                </div>
            </SlotShell>
        );
    }
    return (
        <SlotShell title="内訳" pal={pal} fs={fs} compact={compact}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(fs * 0.22) }}>
                {model.breakdown.map((e, i) => (
                    <div
                        key={`bd${i}`}
                        data-role="breakdown"
                        style={{ display: 'flex', alignItems: 'center', gap: Math.round(fs * 0.4), minWidth: 0 }}
                    >
                        <span
                            style={{
                                width: Math.round(fs * 0.6),
                                height: Math.round(fs * 0.6),
                                borderRadius: '50%',
                                background: e.band.value,
                                flex: 'none',
                                boxShadow: `0 0 ${Math.round(fs * 0.5)}px ${withAlpha(e.band.value, 0.6)}`,
                            }}
                        />
                        <span
                            style={{
                                color: pal.sub,
                                fontSize: Math.round(fs * 0.9),
                                flex: 1,
                                minWidth: 0,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {bandLabel(e.band)}
                        </span>
                        <span
                            style={{
                                color: pal.text,
                                fontSize: fs,
                                fontWeight: 700,
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            {e.n}
                        </span>
                    </div>
                ))}
            </div>
        </SlotShell>
    );
}

// 上位ランキング（ミニバー付き）
function RankingSlot({ model, opts, pal, fs, compact }) {
    const list = model.ranking;
    if (list.length === 0) {
        return (
            <SlotShell title="上位" pal={pal} fs={fs} compact={compact}>
                <div style={{ color: pal.faint, fontSize: fs }}>ラベル列がありません</div>
            </SlotShell>
        );
    }
    const top = Math.max(...list.map((p) => Math.abs(p.value)), 1);
    return (
        <SlotShell title="上位" pal={pal} fs={fs} compact={compact}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(fs * 0.32) }}>
                {list.map((p, i) => (
                    <div key={`rk${i}`} data-role="rank" style={{ minWidth: 0 }}>
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                justifyContent: compact ? 'center' : 'space-between',
                                gap: compact ? 6 : 8,
                                minWidth: 0,
                            }}
                        >
                            <span
                                style={{
                                    color: pal.sub,
                                    fontSize: Math.round(fs * 0.88),
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    minWidth: 0,
                                }}
                                title={p.label}
                            >
                                {p.label}
                            </span>
                            <span
                                style={{
                                    color: pal.text,
                                    fontSize: Math.round(fs * 0.92),
                                    fontWeight: 700,
                                    fontVariantNumeric: 'tabular-nums',
                                    flex: 'none',
                                }}
                            >
                                {formatNumber(p.value, opts)}
                            </span>
                        </div>
                        <div
                            style={{
                                height: Math.round(fs * 0.28),
                                borderRadius: 999,
                                background: pal.track,
                                overflow: 'hidden',
                                marginTop: 2,
                            }}
                        >
                            <div
                                style={{
                                    width: `${clamp01(Math.abs(p.value) / top) * 100}%`,
                                    height: '100%',
                                    borderRadius: 999,
                                    background: colorForValue(p.value, opts),
                                }}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </SlotShell>
    );
}

// 推移（スパークライン）
function SparklineSlot({ model, opts, pal, fs, width, compact }) {
    const pts = model.points;
    if (pts.length < 2) {
        return (
            <SlotShell title="推移" pal={pal} fs={fs} compact={compact}>
                <div style={{ color: pal.faint, fontSize: fs }}>データが1点のみです</div>
            </SlotShell>
        );
    }
    const w = Math.max(40, width);
    const h = Math.round(clamp(fs * 2.6, 26, 64));
    const vals = pts.map((p) => p.value);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const span = mx - mn || 1;
    const stepX = w / (vals.length - 1);
    const yOf = (v) => h - 2 - ((v - mn) / span) * (h - 4);
    const line = vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * stepX).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' ');
    const area = `${line} L ${w.toFixed(1)} ${h} L 0 ${h} Z`;
    const lastColor = colorForValue(vals[vals.length - 1], opts);

    return (
        <SlotShell title="推移" pal={pal} fs={fs} compact={compact}>
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} data-role="sparkline">
                <path d={area} fill={withAlpha(lastColor, 0.16)} />
                <path d={line} fill="none" stroke={lastColor} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={w} cy={yOf(vals[vals.length - 1])} r={2.6} fill={lastColor} />
            </svg>
        </SlotShell>
    );
}

// 目標との比較
function TargetSlot({ model, opts, pal, fs, compact }) {
    const tv = opts.targetValue;
    const v = model.value;
    if (!Number.isFinite(v) || !Number.isFinite(tv) || tv === 0) {
        return (
            <SlotShell title="目標" pal={pal} fs={fs} compact={compact}>
                <div style={{ color: pal.faint, fontSize: fs }}>目標値を設定してください</div>
            </SlotShell>
        );
    }
    const rate = (v / tv) * 100;
    const diff = v - tv;
    const good = opts.goodDirection === 'down' ? diff <= 0 : diff >= 0;
    const c = opts.goodDirection === 'none' ? pal.text : good ? opts.upColor : opts.downColor;
    return (
        <SlotShell title="目標" pal={pal} fs={fs} compact={compact}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: compact ? 'center' : 'space-between', gap: compact ? 6 : 8 }}>
                <span style={{ color: pal.sub, fontSize: Math.round(fs * 0.92) }}>目標値</span>
                <span style={{ color: pal.text, fontSize: fs, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {formatNumber(tv, opts)}
                </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: compact ? 'center' : 'space-between', gap: compact ? 6 : 8 }}>
                <span style={{ color: pal.sub, fontSize: Math.round(fs * 0.92) }}>達成率</span>
                <span
                    data-role="target-rate"
                    style={{ color: c, fontSize: Math.round(fs * 1.1), fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}
                >
                    {rate.toFixed(1)}%
                </span>
            </div>
            <div
                style={{
                    height: Math.round(fs * 0.34),
                    borderRadius: 999,
                    background: pal.track,
                    overflow: 'hidden',
                    marginTop: 2,
                }}
            >
                <div style={{ width: `${clamp(rate, 0, 100)}%`, height: '100%', borderRadius: 999, background: c }} />
            </div>
        </SlotShell>
    );
}

// 帯の凡例
function LegendSlot({ opts, pal, fs, compact }) {
    if (opts.colorMode !== 'band') {
        return (
            <SlotShell title="凡例" pal={pal} fs={fs} compact={compact}>
                <div style={{ color: pal.faint, fontSize: fs }}>単色モードです</div>
            </SlotShell>
        );
    }
    return (
        <SlotShell title="凡例" pal={pal} fs={fs} compact={compact}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(fs * 0.2) }}>
                {opts.colorBands.map((b, i) => (
                    <div key={`lg${i}`} style={{ display: 'flex', alignItems: 'center', gap: Math.round(fs * 0.4) }}>
                        <span
                            style={{
                                width: Math.round(fs * 0.9),
                                height: Math.round(fs * 0.36),
                                borderRadius: 3,
                                background: b.value,
                                flex: 'none',
                            }}
                        />
                        <span
                            style={{
                                color: pal.sub,
                                fontSize: Math.round(fs * 0.9),
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {bandLabel(b)}
                        </span>
                    </div>
                ))}
            </div>
        </SlotShell>
    );
}

// 対象期間・更新時刻（useTokens から取得。データ不要）
function PeriodSlot({ tokens, pal, fs, compact }) {
    // トークンは入れ子（env / default / submitted）で届く。時間レンジは default/submitted。
    const pick = (key) => {
        const t = tokens || {};
        for (const scope of ['submitted', 'default']) {
            const v = t?.[scope]?.[key];
            if (v !== undefined && v !== null && String(v) !== '') return String(v);
        }
        return '';
    };
    const earliest = pick('global_time.earliest');
    const latest = pick('global_time.latest');
    const row = (k, v) => (
        <div key={k} style={{ display: 'flex', alignItems: 'baseline', justifyContent: compact ? 'center' : 'space-between', gap: compact ? 6 : 8 }}>
            <span style={{ color: pal.sub, fontSize: Math.round(fs * 0.9) }}>{k}</span>
            <span
                style={{
                    color: pal.text,
                    fontSize: Math.round(fs * 0.92),
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
            >
                {v}
            </span>
        </div>
    );
    return (
        <SlotShell title="期間" pal={pal} fs={fs} compact={compact}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(fs * 0.2) }}>
                {earliest || latest ? (
                    <>
                        {earliest && row('開始', earliest)}
                        {latest && row('終了', latest)}
                    </>
                ) : (
                    <div style={{ color: pal.faint, fontSize: fs }}>時間レンジ未取得</div>
                )}
            </div>
        </SlotShell>
    );
}

// 自由テキスト
function NoteSlot({ opts, pal, fs }) {
    if (!opts.noteText) return null;
    return (
        <div
            style={{
                color: pal.sub,
                fontSize: Math.round(fs * 0.95),
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
            }}
        >
            {opts.noteText}
        </div>
    );
}

function renderSlot(kind, ctx) {
    switch (kind) {
        case 'delta':
            return <DeltaSlot {...ctx} />;
        case 'stats':
            return <StatsSlot {...ctx} />;
        case 'breakdown':
            return <BreakdownSlot {...ctx} />;
        case 'ranking':
            return <RankingSlot {...ctx} />;
        case 'sparkline':
            return <SparklineSlot {...ctx} />;
        case 'target':
            return <TargetSlot {...ctx} />;
        case 'legend':
            return <LegendSlot {...ctx} />;
        case 'period':
            return <PeriodSlot {...ctx} />;
        case 'note':
            return <NoteSlot {...ctx} />;
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function GaugeArcViz({ mode }) {
    const { dataSources, loading } = useDataSources();
    const optionsApi = useOptions();
    const options = optionsApi?.options;
    const tokensApi = useTokens();
    const tokens = tokensApi?.tokens;

    const opts = useMemo(() => normalizeOptions(options), [options]);

    const rawData = dataSources?.primary?.data;
    const rows = useMemo(() => normalizeData(rawData), [rawData]);
    const fieldNames = useMemo(() => fieldNamesOf(rawData), [rawData]);
    const model = useMemo(() => buildModel(rows, fieldNames, opts), [rows, fieldNames, opts]);

    useEffect(() => {
        ensureKeyframes();
    }, []);

    // コンテナ実寸の計測（オートフィット）
    const containerRef = useRef(null);
    const [dims, setDims] = useState({ w: 520, h: 300 });
    const measure = useCallback((el) => {
        if (!el) return;
        const w = el.clientWidth || 520;
        const h = el.clientHeight || 300;
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

    // 値のアニメーション（フックはガードより前に必ず呼ぶ）
    const targetValue = Number.isFinite(model?.value) ? model.value : NaN;
    const shownValue = useAnimatedValue(targetValue, opts.animate, opts.animateDuration);

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
    if (model.error === 'nonumeric') {
        return (
            <CenterMessage sub="値フィールドの選択を確認してください。">
                データがありません。サーチ結果を確認してください。
            </CenterMessage>
        );
    }
    if (model.error) {
        return <CenterMessage>データがありません。サーチ結果を確認してください。</CenterMessage>;
    }

    const { w, h } = dims;
    const pal = palette(mode);
    const value = model.value;
    // ゲージと同じ範囲を渡す（gradient のとき弧と中央数値の色を一致させるため）
    const curColor = colorForValue(value, opts, model.lo, model.hi);
    const curBand = opts.colorMode === 'band' ? bandFor(value, opts.colorBands) : null;

    // --- 中央の数値の色 ---
    // band = ゲージと同じ色（帯モードなら現在値が属する帯の色、単色モードならその色）
    // fixed = ユーザー指定の固定色 / auto = テーマ標準の文字色
    // 帯の色をそのまま大きな文字に使うと、濃い色（暗い赤・緑）はダークテーマで沈み、
    // 明るい色（黄）はライトテーマで飛ぶ。可読性を保つため白/黒側へ少し寄せる。
    const valueColor =
        opts.valueColorMode === 'auto'
            ? pal.text
            : mixColor(
                  opts.valueColorMode === 'fixed' ? opts.valueFixedColor : curColor,
                  mode === 'dark' ? '#ffffff' : '#000000',
                  mode === 'dark' ? 0.22 : 0.12
              );

    // --- レイアウト（サブパネルの位置と幅） ---
    // 幅が狭いときは右/左パネルを下へ回し、さらに狭ければゲージのみにする。
    const slots = [opts.slot1, opts.slot2, opts.slot3, opts.slot4].filter((s) => s !== 'none');
    const wantPanel = opts.panelPosition !== 'none' && slots.length > 0;
    const sideCapable = w >= 340 && h >= 150;
    const bottomCapable = h >= 260 && w >= 180;

    let layout = 'none'; // none / left / right / bottom
    if (wantPanel) {
        if (opts.panelPosition === 'bottom') {
            layout = bottomCapable ? 'bottom' : 'none';
        } else if (sideCapable) {
            layout = opts.panelPosition;
        } else if (bottomCapable) {
            layout = 'bottom'; // 横に置けないので下へ退避
        } else {
            layout = 'none';
        }
    }

    const isSide = layout === 'left' || layout === 'right';
    const panelPx = isSide ? Math.round(w * opts.panelWidth) : 0;
    // パネルのフォント・余白（下パネルの高さ見積りに使うのでここで決める）
    const panelFont = Math.round(clamp(Math.min(w, h) * 0.045, 10, 16));
    const gapBase = Math.round(clamp(Math.min(w, h) * 0.03, 6, 18));

    // 下パネルの高さは中身から見積もる。固定比率（旧: 高さの 34〜45%）にすると
    // スロットが1つでも大きな余白ができ、そのぶんゲージが小さくなる。
    // 各スロットは「見出し1行 + 中身 n 行」なので、最も行数の多いスロットに合わせる。
    const bottomRowsOf = (kind) => {
        switch (kind) {
            case 'stats':
                return opts.statList.length;
            case 'breakdown':
                return Math.max(1, model.breakdown.length);
            case 'ranking':
                return Math.max(1, model.ranking.length) * 2; // ラベル行＋バー
            case 'legend':
                return Math.max(1, opts.colorBands.length);
            case 'target':
                return 3; // 目標値・達成率・バー
            case 'period':
                return 2;
            case 'delta':
                return 2; // 差分＋「前回 …」
            case 'sparkline':
                return 3; // スパークラインの高さぶん
            case 'note':
                return 2;
            default:
                return 1;
        }
    };
    const maxRows = layout === 'bottom' ? Math.max(1, ...slots.map(bottomRowsOf)) : 0;
    // 見出し(0.82em) + 行間 + 各行(約1.5em) を font サイズから概算し、上下パディングを足す
    const estPanelH = layout === 'bottom'
        ? Math.round(panelFont * 1.5 + maxRows * panelFont * 1.55 + gapBase * 2)
        : 0;
    // 中身に必要な高さを使うが、ゲージが潰れないよう全体の 45% を上限にする
    const panelH = layout === 'bottom' ? Math.round(clamp(estPanelH, 48, h * 0.45)) : 0;
    const gap = gapBase;

    const gaugeW = Math.max(60, isSide ? w - panelPx - gap : w);
    const gaugeH = Math.max(50, layout === 'bottom' ? h - panelH - gap : h);

    // --- 表示密度（狭いパネルでの段階的な退避）---
    // ★ゲージ領域の実寸から「今どこまで出せるか」を決める。これが無いと小さいパネルで
    //   タイトル・数値・目盛り・前回比がすべて重なって読めなくなる（v1.3.2 の不具合）。
    //   小さい順に tiny → small → normal。抑制の順序は
    //   「前回比 → タイトル → 目盛り → 端の数値ラベル」（情報量の少ないものから消す）。
    // ★しきい値は実機で崩れていたサイズ（パネル 230×150 → viz は約 230×118）に
    //   合わせてある。弧・中央の数値・目盛り・端ラベルが同居できる下限がこのあたり。
    const gaugeMin = Math.min(gaugeW, gaugeH);
    const density = {
        tiny: gaugeMin < 160 || gaugeH < 150,
        small: gaugeMin < 210 || gaugeH < 190,
    };

    // --- 中央の数値サイズ ---
    // ゲージ領域に対して相対に決め、桁数が多いときは縮める
    const valueStr = formatNumber(value, opts);
    const isTachoStyle = opts.gaugeStyle === 'tachometer';
    // タコメーターは針が中心から伸びるので、数値は中心を避けて置く（下記 centerTop）。
    // 針と重ならない領域が狭いぶん、数値も一回り小さくする。
    const baseFont = isTachoStyle
        ? Math.min(gaugeW * 0.13, gaugeH * 0.17)
        : Math.min(gaugeW * 0.19, gaugeH * 0.3);
    const lenAdjust = clamp(6 / Math.max(valueStr.length, 1), 0.5, 1);
    const valueFont = Math.round(clamp(baseFont * (0.72 + lenAdjust * 0.38), 12, 88));
    const titleFont = Math.round(clamp(valueFont * 0.26, 9, 20));
    const unitFont = Math.round(clamp(valueFont * 0.36, 10, 30));
    const bandFont = Math.round(clamp(valueFont * 0.24, 9, 18));

    const titleStr = opts.titleText || fieldNames[model.valIdx] || '';
    // 狭いときはタイトルを落とす（数値と重なるより消す方がまし）
    const titleVisible = opts.showTitle && titleStr !== '' && !density.tiny && gaugeH >= 110;
    const bandVisible = opts.showBandLabel && curBand !== null && !density.small && gaugeH >= 130;

    // 中央テキストの縦位置：弧の中心付近に置く（開き角が大きいほど下寄り）。
    // ★タコメーターは針が中心（cx,cy）から外周へ伸びるため、数値を中心に置くと必ず
    //   針と重なる。針の回転円の外側＝弧の下側の空き領域に置く。
    //   0.78 では下寄りすぎて弧の外へ出かける値があったので、開き角に応じて決める
    //   （開き角が小さいほど弧の下が空くので、より下に置ける）。
    // ★実機で 0.8 は下がりすぎだった（数値が最大値ラベルと重なり、下端にも張り付いた）。
    //   針の軸（弧の中心）より下・端ラベルより上、の中間に収める。
    const tachoCenterTop = opts.sweepAngle >= 280 ? 0.76 : opts.sweepAngle >= 240 ? 0.71 : 0.66;
    const centerTop = isTachoStyle ? tachoCenterTop : opts.sweepAngle >= 280 ? 0.5 : 0.54;
    // 端・境界の数値ラベルのフォント（ゲージ領域の大きさに追従）
    const boundaryFont = Math.round(clamp(Math.min(gaugeW, gaugeH) * 0.042, 9, 15));

    const deltaObj = computeDelta(value, model.compare, opts);

    const slotCtx = {
        model,
        opts,
        pal,
        fs: panelFont,
        tokens,
        width: isSide ? Math.max(40, panelPx - 16) : Math.max(40, Math.round(w * 0.28)),
        // 下パネルは横に広く1スロットあたりの幅が余るため、行を中央寄せにする
        compact: layout === 'bottom',
    };

    // --- 縦積みパネルに入り切るスロットだけを残す ---
    // ★スロットを縮めてはいけない。縮めると各スロットの中身（「前回 …」「平均 …」）が
    //   途中で切れて、かえって読めなくなる（実機で確認）。
    //   入り切らないぶんは**スロットごと落とす**のが正しい。半端に切れた行を見せるより、
    //   出ているものが全部読める方がよい。
    // 1スロットの必要高 ≒ 固定分 + 係数 × panelFont。
    // ★係数は**実機で実測して求めた**（panelFont=16 と 12 の2点から連立で解いた値）:
    //   panelFont=16 → 前回比 70 / サブ指標 96 / 推移 67 / 目標 84 px
    //   panelFont=12 → 前回比 68 / サブ指標 90 / 推移 55 / 目標 78 px
    //   高さは font に単純比例せず**固定分が大きい**（見出しや余白）。
    //   比例だけの式にすると小さいパネルで過大評価になり、入るものまで落としてしまう。
    // ⚠ happy-dom は要素の高さを 0 で返すためローカル検証では確かめられない。
    //    ここを変えたら必ず実機のスクリーンショットで確認すること。
    const SLOT_H = {
        delta: [62, 0.5],
        stats: [72, 1.5],
        breakdown: [72, 1.5],
        ranking: [72, 1.5],
        legend: [72, 1.5],
        sparkline: [19, 3.0],
        target: [60, 1.5],
        period: [30, 0.8],
        note: [30, 0.8],
    };
    const slotNeedH = (k) => {
        const [a, b] = SLOT_H[k] || [62, 0.5];
        return a + b * panelFont;
    };
    const sideSlots = (() => {
        if (!isSide) return slots;
        // 実際にスロットが使える高さ。パネル本体は上下に padding を持たないが、
        // ホスト側のパネル枠（タイトル行など）が h から引かれるため、実測に合わせて
        // 約 8% を差し引く（h=380 の実測で内寸 348 ≒ h*0.92）。
        // ★viz に渡る h は既に「パネル枠を除いた内寸」（ホストがタイトル行ぶん約 32px を
        //   引いた値）。実測: ダッシュボード上 300/380/460/560 → viz の h は 268/348/428/528。
        //   ここでさらに割り引くと二重に引くことになるので、h をそのまま使う。
        const avail = h;
        const kept = [];
        let used = 0;
        for (let i = 0; i < slots.length; i += 1) {
            const need = slotNeedH(slots[i]) + (kept.length > 0 ? gap : 0);
            if (used + need > avail && kept.length > 0) break; // 1つ目は必ず出す
            used += need;
            kept.push(slots[i]);
        }
        return kept;
    })();
    // 落としたスロットの数（利用者に「隠れている」ことを伝えるため）
    const droppedSlots = isSide ? slots.length - sideSlots.length : 0;
    const shownSlots = isSide ? sideSlots : slots;

    // 色帯がゲージ範囲と噛み合っていないときの注意表示（狭すぎるときは出さない）
    const bandWarn = model.bandMismatch && !density.tiny;
    const bandRangeText = (() => {
        if (!bandWarn) return '';
        const es = [];
        opts.colorBands.forEach((b) => {
            if (Number.isFinite(b.from)) es.push(b.from);
            if (Number.isFinite(b.to)) es.push(b.to);
        });
        if (es.length === 0) return '';
        return `${Math.min(...es)}〜${Math.max(...es)}`;
    })();

    // パネル本体（縦積み／下配置では横並び）
    const panelInner = (
        <div
            data-role="panel"
            style={{
                display: 'flex',
                flexDirection: layout === 'bottom' ? 'row' : 'column',
                gap: layout === 'bottom' ? gap * 1.6 : gap,
                // ★縦積みのとき center にしてはいけない。入り切らない量のスロットを
                //   中央寄せすると上下**両方向**にはみ出し、overflow:hidden で
                //   先頭と末尾が切れる（4スロットで「達成率」が切れた不具合）。
                //   入り切るときだけ中央、溢れるときは上詰めにする。
                justifyContent: layout === 'bottom' ? 'space-around' : 'center',
                alignItems: layout === 'bottom' ? 'flex-start' : 'stretch',
                width: '100%',
                height: '100%',
                minWidth: 0,
                overflow: 'hidden',
                boxSizing: 'border-box',
                padding: layout === 'bottom' ? `${gap}px ${gap}px 0` : `0 ${Math.round(gap * 0.6)}px`,
            }}
        >
            {shownSlots.map((kind, i) => {
                const node = renderSlot(kind, slotCtx);
                if (!node) return null;
                return (
                    <div
                        key={`slot${i}-${kind}`}
                        // 縮めない（flex:'none'）。入り切らないものは上で除外済みなので、
                        // ここに残っているスロットは必ず全部表示できる。
                        style={{ minWidth: 0, flex: layout === 'bottom' ? '1 1 0' : 'none' }}
                    >
                        {node}
                    </div>
                );
            })}
            {/* 高さが足りずに隠したスロットがあることを小さく知らせる */}
            {droppedSlots > 0 && (
                <div
                    data-role="slots-hidden"
                    title="パネルの高さが足りないため、一部の情報を隠しています。パネルを高くすると表示されます。"
                    style={{
                        flex: 'none',
                        color: pal.faint,
                        fontSize: Math.round(panelFont * 0.78),
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    ほか {droppedSlots} 件
                </div>
            )}
        </div>
    );

    // ゲージ＋中央テキスト
    const gaugeBlock = (
        <div style={{ position: 'relative', width: gaugeW, height: gaugeH, flex: 'none' }}>
            <GaugeArc
                w={gaugeW}
                h={gaugeH}
                value={value}
                shownValue={shownValue}
                opts={opts}
                pal={pal}
                model={model}
                boundaryFont={boundaryFont}
                density={density}
            />
            {/* 中央の数値（SVG の上に重ねる。ゲージの中心に合わせる） */}
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: `${centerTop * 100}%`,
                    transform: 'translateY(-50%)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 2,
                    pointerEvents: 'none',
                    padding: '0 8%',
                    boxSizing: 'border-box',
                }}
            >
                {titleVisible && (
                    <div
                        style={{
                            color: pal.title,
                            fontSize: titleFont,
                            fontWeight: 700,
                            letterSpacing: 0.4,
                            textTransform: 'uppercase',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '100%',
                        }}
                        title={titleStr}
                    >
                        {titleStr}
                    </div>
                )}
                {/* 数値は常にパネル中央に置き、単位はその右へ「はみ出させて」添える。
                    数値と単位を1つの flex 行にすると、単位の幅のぶん数値が左へずれてしまうため、
                    単位は position:absolute で数値の右に逃がし、数値の中心を動かさない。 */}
                <div
                    data-role="value"
                    data-value-color-mode={opts.valueColorMode}
                    style={{
                        position: 'relative',
                        display: 'inline-block',
                        color: valueColor,
                        lineHeight: 1.05,
                        maxWidth: '100%',
                    }}
                >
                    <span
                        style={{
                            fontSize: valueFont,
                            fontWeight: 800,
                            fontVariantNumeric: 'tabular-nums',
                            letterSpacing: -0.5,
                            textShadow:
                                opts.showGlow && opts.glowStrength > 0
                                    ? `0 0 ${Math.round((opts.glowStrength / 100) * 22)}px ${withAlpha(
                                          // 発光も数値の色に合わせる（auto のときだけゲージ色を使う）
                                          opts.valueColorMode === 'fixed' ? opts.valueFixedColor : curColor,
                                          0.45
                                      )}`
                                    : 'none',
                        }}
                    >
                        {valueStr}
                    </span>
                    {opts.unitText && (
                        <span
                            data-role="unit"
                            style={{
                                position: 'absolute',
                                left: '100%',
                                bottom: 0,
                                marginLeft: Math.round(unitFont * 0.25),
                                fontSize: unitFont,
                                fontWeight: 700,
                                color: pal.sub,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {opts.unitText}
                        </span>
                    )}
                </div>

                {/* 帯の名前（現在値が属する範囲） */}
                {bandVisible && (
                    <div
                        data-role="band-label"
                        style={{
                            marginTop: 2,
                            padding: `2px ${Math.round(bandFont * 0.7)}px`,
                            borderRadius: 999,
                            background: withAlpha(curColor, mode === 'dark' ? 0.18 : 0.13),
                            border: `1px solid ${withAlpha(curColor, 0.5)}`,
                            color: mode === 'dark' ? mixColor(curColor, '#ffffff', 0.3) : mixColor(curColor, '#000000', 0.15),
                            fontSize: bandFont,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {bandLabel(curBand)}
                    </div>
                )}

                {/* パネルを出せない狭い状況でも、比較だけは中央下に出す。
                    ★ただし tiny では出さない。出すと弧の端の数値ラベル（0/100）と
                    重なって両方読めなくなる（実機で確認した不具合）。 */}
                {layout === 'none' && opts.showDelta && deltaObj && !density.tiny && gaugeH >= 96 && (
                    <div
                        data-role="delta-inline"
                        style={{
                            marginTop: 3,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            color: deltaObj.color || pal.sub,
                            fontSize: Math.round(clamp(valueFont * 0.24, 9, 18)),
                            fontWeight: 700,
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <DeltaArrow
                            diff={deltaObj.diff}
                            color={deltaObj.color || pal.sub}
                            size={Math.round(clamp(valueFont * 0.2, 8, 14))}
                        />
                        <span>{deltaText(deltaObj, opts)}</span>
                    </div>
                )}
            </div>
        </div>
    );

    const flexDir = layout === 'bottom' ? 'column' : layout === 'left' ? 'row-reverse' : 'row';

    return (
        <div
            ref={setContainer}
            data-viz-version={VIZ_VERSION}
            style={{
                position: 'relative', // 注意バッジ（絶対配置）の基準
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden',
                fontFamily: FONT_STACK,
                display: 'flex',
                flexDirection: flexDir,
                alignItems: 'stretch',
                gap: layout === 'none' ? 0 : gap,
                animation: 'gaugeArcFadeIn 240ms ease-out',
            }}
        >
            {gaugeBlock}

            {layout !== 'none' && (
                <div
                    style={{
                        flex: 'none',
                        width: isSide ? panelPx : '100%',
                        height: layout === 'bottom' ? panelH : '100%',
                        minWidth: 0,
                        boxSizing: 'border-box',
                        display: 'flex',
                        // 溢れるときは上詰め（center のままだと外枠でも上下に押し出される）
                        alignItems: 'center',
                    }}
                >
                    {panelInner}
                </div>
            )}

            {/* 色帯がゲージ範囲と噛み合っていないときの注意書き。
                「範囲を変えたのに色帯が 0〜100 のまま＝全部同じ色」に気づけるようにする。
                描画は妨げない小さなバッジで、色の設定を直せば自動的に消える。 */}
            {bandWarn && (
                <div
                    data-role="band-warning"
                    title={`色の範囲（${bandRangeText}）がゲージの範囲（${formatNumber(
                        model.lo,
                        opts
                    )}〜${formatNumber(model.hi, opts)}）の外にあります。「値の範囲と色」を設定し直してください。`}
                    style={{
                        position: 'absolute',
                        top: 6,
                        right: 8,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '2px 7px',
                        borderRadius: 6,
                        fontSize: 10.5,
                        fontWeight: 700,
                        lineHeight: 1.4,
                        color: pal.warnInk,
                        background: pal.warnBg,
                        border: `1px solid ${pal.warnBorder}`,
                        pointerEvents: 'auto',
                        zIndex: 5,
                        whiteSpace: 'nowrap',
                    }}
                >
                    色の範囲を確認
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
            <GaugeArcViz mode={mode} />
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
