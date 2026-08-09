import {
    useDataSources,
    useTheme,
    useOptions,
    useMode,
} from '@splunk/dashboard-studio-extension/react';
// ドリルダウン（編集画面の「インタラクション」）は /react にフックが無いので、
// コアの /visualization から関数を直接 import する。
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './visualization.css';
import chartIcon from './assets/ChartColumnSquare.svg';

// -----------------------------------------------------------------------------
// 重要度(severity)テーブル
//
// ★v2.0.0 の方針：判定ルールをコードに埋め込まない。
//   「どの列を見るか」「どの値がどの順位か」「別名は何か」「何色にするか」
//   「一覧に無い値をどう扱うか」「範囲外の数値をどう扱うか」は
//   すべて編集画面のオプションで決まる。viz 側にハードコードされた
//   深刻度の知識(critical > high > ... / warning は medium 扱い 等)は
//   「オプションの既定値」としてのみ存在し、ユーザーが上書きできる。
//
//   - 文字列モード：severityOrder(順位一覧) + severityColors(パレット)
//       順位一覧の i 行目の深刻度 → パレットの i 番目の色（足りなければ繰り返し）
//       ★データの中身によって同じ値の色が変わることは無い（v1 系はあった）
//   - 数値モード  ：severityBands(editor.threshold) の範囲と色をそのまま使う
//   - どちらでも一覧/範囲に当たらない値は「一覧にない値」の設定に従う
//
// ★v2.2.0：列幅をドラッグで自由に変えられるようにした（保存の仕組みは link-line と同じ）。
//   - 列見出しの境界をドラッグして決める。★モードの切替は無く、表示画面で常に掴める。
//     （編集モード中はホストが iframe への入力を遮断するのでドラッグは効かない。
//     　これは仕様上の制約で、表示モードで調整して編集モードで保存する流れになる）
//   - 保存先は options の `colWidths`（フィールド名 → 幅の割合の JSON）。
//     ★このキーは config.json の optionsSchema に載せていない。スキーマ外のキーも
//     ダッシュボード定義に永続化されて viz に届くことは実機確認済みで、
//     config.json を触らなければ splunkd の再起動なしで反映できるため
//     （編集パネルに出す必要が無い＝ドラッグでしか決まらない値なので載せる意味も無い）。
// -----------------------------------------------------------------------------

const VIZ_VERSION = '2.2.2';

// ドリルダウンで発火するイベント名。config.json の `events` に宣言した名前と一致させる。
// ホストは宣言済みの名前しか認識しないので、両方を同時に直すこと。
const CLICK_ACTION = 'cell.click';

// 深刻度の順位一覧の既定値。1 行 = 1 段階、上ほど重大。
// 同じ段階に畳む別名は `|` で区切る（先頭の語がその段階の代表値）。
const DEFAULT_SEVERITY_ORDER = [
    'critical|crit|fatal|emergency|severe',
    'high|error|major',
    'medium|warning|warn|moderate',
    'low|minor|notice',
    'info|informational|information|debug|ok|normal',
];

// 順位一覧と同じ並びで使う色（上＝最も重大）。
const DEFAULT_SEVERITY_COLORS = ['#ff5c3d', '#ffab2e', '#f2c14b', '#4dcf6e', '#4fa8f0'];

// 深刻度フィールドの自動判定に使う列名（上ほど優先）。
const DEFAULT_FIELD_CANDIDATES = ['severity', 'sev', 'priority', 'urgency', 'level', 'risk'];

// 数値モードのバンド（editor.threshold）の既定値。並びは昇順（低い値→高い値）。
const DEFAULT_SEVERITY_BANDS = [
    { from: 0, to: 1, value: '#4fa8f0' },
    { from: 1, to: 2, value: '#4dcf6e' },
    { from: 2, to: 3, value: '#f2c14b' },
    { from: 3, to: 4, value: '#ffab2e' },
    { from: 4, to: 5, value: '#ff5c3d' },
];

// ランクの定数。数値が小さいほど重大。
//   既知の段階 : 0 .. (段階数-1)
//   一覧にない値: 最上位なら UNKNOWN_FIRST / 最下位なら UNKNOWN_LAST
//   値が空の行 : 常に最後（深刻度そのものが無いため並べ替えの対象外）
const UNKNOWN_FIRST = -1;
const UNKNOWN_LAST = 1e6;

// 等幅数字にする列(時刻・時間系・数値系)。表示上の体裁のみで意味は持たない。
const TIME_FIELD_PATTERN = /(^_?time$|time|date|count|total|score|_num$)/i;

// -----------------------------------------------------------------------------
// 小さな型ユーティリティ
// -----------------------------------------------------------------------------
function clampInt(v, lo, hi, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

function asBool(v, fallback) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    return fallback;
}

function asColor(v, fallback) {
    if (typeof v !== 'string') return fallback;
    const s = v.trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : fallback;
}

function asEnum(v, allowed, fallback) {
    return allowed.includes(v) ? v : fallback;
}

// 文字列配列オプション（editor.arrayOfStrings）を正規化する。
// 配列でない / 空 / 中身が全部空文字なら既定値へ倒す。
function asStringList(v, fallback) {
    if (!Array.isArray(v)) return fallback;
    const out = v.filter((s) => typeof s === 'string').map((s) => s.trim()).filter((s) => s !== '');
    return out.length > 0 ? out : fallback;
}

// 色パレット（editor.seriesColors）を正規化する。不正な要素は捨てる。
function asColorList(v, fallback) {
    if (!Array.isArray(v)) return fallback;
    const out = v.map((c) => asColor(c, null)).filter(Boolean);
    return out.length > 0 ? out : fallback;
}

// -----------------------------------------------------------------------------
// 深刻度の順位一覧（severityOrder）のパース
//   入力: ["critical|crit", "high|error", …]（上ほど重大）
//   出力: { stages: [{canonical, tokens}], lookup: Map<小文字の値, 段階index> }
//   - 同じ値が複数段階に出てきた場合は「先に書かれた（より重大な）段階」を採用する
//   - 空・配列でない・全部空文字 → 既定の順位一覧にフォールバックする
// -----------------------------------------------------------------------------
function parseSeverityOrder(raw) {
    const list = asStringList(raw, DEFAULT_SEVERITY_ORDER);
    const stages = [];
    const lookup = new Map();
    list.forEach((entry) => {
        const tokens = String(entry)
            .split('|')
            .map((t) => t.trim())
            .filter((t) => t !== '');
        if (tokens.length === 0) return;
        const index = stages.length;
        stages.push({ canonical: tokens[0], tokens });
        tokens.forEach((t) => {
            const k = t.toLowerCase();
            if (!lookup.has(k)) lookup.set(k, index);
        });
    });
    if (stages.length === 0) {
        // ここに来るのは "|||" のような入力だけ。既定へ倒す（再帰は1回で必ず止まる）。
        return parseSeverityOrder(DEFAULT_SEVERITY_ORDER);
    }
    return { stages, lookup };
}

// 段階 index → 色。パレットが足りなければ先頭から繰り返す。
function stageColor(index, colors) {
    if (!colors || colors.length === 0) return DEFAULT_SEVERITY_COLORS[0];
    return colors[index % colors.length];
}

// -----------------------------------------------------------------------------
// 数値モードのバンド正規化（防御的）
//   - 配列でない / 空 / 全滅 → 既定バンドへフォールバック
//   - from/to は null(開区間)を許容し、-Infinity / +Infinity に展開する
//   - from > to は入れ替える。色が不正な行は捨てる
//   - 最後に from 昇順へソートする(未ソートで届いても正しく判定できるように)
// -----------------------------------------------------------------------------
function bandBound(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function normalizeBands(raw) {
    if (!Array.isArray(raw)) return DEFAULT_SEVERITY_BANDS;
    const out = [];
    raw.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        const color = asColor(b.value, null);
        if (!color) return;
        let lo = bandBound(b.from);
        let hi = bandBound(b.to);
        if (lo === null) lo = -Infinity;
        if (hi === null) hi = Infinity;
        if (lo > hi) {
            const t = lo;
            lo = hi;
            hi = t;
        }
        out.push({ from: lo, to: hi, value: color });
    });
    if (out.length === 0) return DEFAULT_SEVERITY_BANDS;
    out.sort((a, b) => (a.from !== b.from ? a.from - b.from : a.to - b.to));
    return out;
}

// 数値をバンドに当てる。返り値は bands のインデックス(該当なしは -1)
//   - 区間は [from, to) 半開。ただし最大バンドの上端のみ閉区間として扱う
//   - 重なりがある場合は「最も高い範囲」を優先(降順に見て最初に当たったもの)
//   - どのバンドにも入らないときの扱いは outOfRange オプションで決まる
//     'clamp'   … 最も近い端のバンドへ丸める（既定）
//     'unknown' … 当てない(-1)。呼び出し側が「一覧にない値」として扱う
function matchBandIndex(num, bands, outOfRange) {
    for (let i = bands.length - 1; i >= 0; i -= 1) {
        const b = bands[i];
        const isTopBand = i === bands.length - 1;
        if (num >= b.from && (isTopBand ? num <= b.to : num < b.to)) return i;
    }
    if (outOfRange !== 'clamp') return -1;
    const first = bands[0];
    const last = bands[bands.length - 1];
    if (num < first.from) return 0;
    if (num > last.to) return bands.length - 1;
    return -1;
}

// バンドの範囲を人が読めるラベルにする(開区間は < / ≧ で表す)
function bandRangeLabel(b) {
    const lo = Number.isFinite(b.from) ? b.from : null;
    const hi = Number.isFinite(b.to) ? b.to : null;
    if (lo === null && hi === null) return 'すべて';
    if (lo === null) return `< ${hi}`;
    if (hi === null) return `≧ ${lo}`;
    return `${lo}–${hi}`;
}

// -----------------------------------------------------------------------------
// 列幅（colWidths）
//   保存形式: {"<フィールド名>": <割合>, …} の JSON 文字列。
//   ・値は「その列が表全体のうち占める割合」。全列ぶんの合計が 1 である必要は無く、
//     描画時に「表示中の列だけ」で正規化して % に落とす。列の表示/非表示が
//     変わっても他の列の相対比が保たれる。
//   ・フィールド名をキーにするのは、並べ替えや列の自動省略で位置が変わっても
//     幅が別の列に付け替わらないようにするため。
//   ・未設定の列は「残り幅の等分」を受け取る（＝既定の見た目のまま）。
// -----------------------------------------------------------------------------

// 1列が取れる幅の下限・上限（表全体に対する割合）。潰れて操作不能になるのを防ぐ。
const MIN_COL_FRACTION = 0.04;
const MAX_COL_FRACTION = 0.9;

// 列境界の掴み代の幅(px)。細い縦線そのものは 2px だが、掴める範囲は広めに取る。
const RESIZER_HIT = 11;

function parseColWidths(json) {
    if (!json || typeof json !== 'string') return {};
    try {
        const obj = JSON.parse(json);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        const out = {};
        Object.keys(obj).forEach((k) => {
            const n = Number(obj[k]);
            if (Number.isFinite(n) && n > 0) {
                out[k] = Math.min(MAX_COL_FRACTION, Math.max(MIN_COL_FRACTION, n));
            }
        });
        return out;
    } catch (e) {
        return {}; // 壊れた JSON は「未設定」として扱う（既定の等分に戻る）
    }
}

function serializeColWidths(map) {
    const keys = Object.keys(map || {});
    if (keys.length === 0) return '';
    const out = {};
    keys.forEach((k) => {
        const n = Number(map[k]);
        if (Number.isFinite(n) && n > 0) out[k] = Math.round(n * 10000) / 10000;
    });
    return Object.keys(out).length > 0 ? JSON.stringify(out) : '';
}

// 表示中の列に対して実際の幅(%)を割り当てる。
//   ・幅が指定済みの列はその割合を使う（合計が 1 を超える場合は比例縮小）
//   ・未指定の列は残りを等分する（最低 MIN_COL_FRACTION は確保）
//   ・最後に合計 100% へ正規化する（tableLayout:fixed の colgroup に渡す前提）
function resolveColumnWidths(shownFieldNames, widthMap) {
    const n = shownFieldNames.length;
    if (n === 0) return [];
    const fixed = shownFieldNames.map((f) => {
        const v = widthMap[f];
        return Number.isFinite(v) && v > 0 ? v : null;
    });
    const fixedSum = fixed.reduce((s, v) => s + (v || 0), 0);
    const freeCount = fixed.filter((v) => v === null).length;

    let scale = 1;
    // 指定済みだけで場所を使い切っている場合は、未指定の列ぶんを残せるよう縮める
    const reserve = freeCount > 0 ? MIN_COL_FRACTION * freeCount : 0;
    if (fixedSum + reserve > 1 && fixedSum > 0) {
        scale = Math.max(0.0001, (1 - reserve) / fixedSum);
    }
    const freeShare =
        freeCount > 0 ? Math.max(MIN_COL_FRACTION, (1 - fixedSum * scale) / freeCount) : 0;

    const raw = fixed.map((v) => (v === null ? freeShare : v * scale));
    const total = raw.reduce((s, v) => s + v, 0) || 1;
    return raw.map((v) => (v / total) * 100);
}

// -----------------------------------------------------------------------------
// オプション既定値と正規化(未設定・型不一致に耐える)
// -----------------------------------------------------------------------------
const SORT_MODES = ['none', 'desc', 'asc'];
const SEVERITY_MODES = ['string', 'number'];
const UNKNOWN_ORDERS = ['last', 'first'];
const OUT_OF_RANGE_MODES = ['clamp', 'unknown'];
const CELL_STYLES = ['pill', 'dot', 'text', 'bar'];
const SUMMARY_LABEL_MODES = ['canonical', 'raw'];
const TOP_ICON_MODES = ['highest', 'top', 'none'];

const DEFAULT_OPTIONS = {
    // データ
    severityField: '', // columnSelector(空なら候補列名で自動判定)
    severityFieldCandidates: DEFAULT_FIELD_CANDIDATES,
    sortMode: 'desc', // none | desc(重大→軽微) | asc(軽微→重大)
    maxRows: 200, // 0=無制限
    // 深刻度の判定と色
    severityMode: 'string', // string(カテゴリ) | number(範囲)
    severityOrder: DEFAULT_SEVERITY_ORDER,
    severityColors: DEFAULT_SEVERITY_COLORS,
    unknownOrder: 'last', // last(最下位) | first(最上位)
    colorUnknown: true,
    unknownColor: '#8b9bb4',
    // 数値モードの範囲
    severityBands: DEFAULT_SEVERITY_BANDS,
    bandOutOfRange: 'clamp', // clamp | unknown
    // 表示
    cellStyle: 'pill',
    rowBar: true,
    zebra: true,
    compact: false,
    showSummary: true,
    summaryLabelMode: 'canonical', // canonical(順位一覧の代表値) | raw(データの値)
    topIcon: 'highest', // highest(データ内で最も重大) | top(順位一覧の1行目) | none
    autoHideColumns: true,
    title: '',
    // 列幅（フィールド名→割合の JSON。'' = 全列を等分＝従来どおり）。
    // ★編集パネルには出さない（optionsSchema に無い）。ドラッグでのみ決まる値。
    colWidths: '',
    // インタラクション（クリックでトークンを設定する等）
    enableDrilldown: true,
};

function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const d = DEFAULT_OPTIONS;
    return {
        severityField: typeof o.severityField === 'string' ? o.severityField : d.severityField,
        severityFieldCandidates: asStringList(
            o.severityFieldCandidates,
            d.severityFieldCandidates
        ),
        sortMode: asEnum(o.sortMode, SORT_MODES, d.sortMode),
        maxRows: clampInt(o.maxRows, 0, 100000, d.maxRows),
        severityMode: asEnum(o.severityMode, SEVERITY_MODES, d.severityMode),
        severityOrder: asStringList(o.severityOrder, d.severityOrder),
        severityColors: asColorList(o.severityColors, d.severityColors),
        unknownOrder: asEnum(o.unknownOrder, UNKNOWN_ORDERS, d.unknownOrder),
        colorUnknown: asBool(o.colorUnknown, d.colorUnknown),
        unknownColor: asColor(o.unknownColor, d.unknownColor),
        // ★旧キー(sortBySeverity / numericSeverity / showTitle / criticalColor 等)は一切読まない。
        //   既定値と同じ値が options に載らない仕様のため、旧キーへフォールバックすると
        //   「既定値を選んだときだけ直らない」不具合になる。旧設定は既定へ戻る(README 参照)。
        severityBands: normalizeBands(o.severityBands),
        bandOutOfRange: asEnum(o.bandOutOfRange, OUT_OF_RANGE_MODES, d.bandOutOfRange),
        cellStyle: asEnum(o.cellStyle, CELL_STYLES, d.cellStyle),
        rowBar: asBool(o.rowBar, d.rowBar),
        zebra: asBool(o.zebra, d.zebra),
        compact: asBool(o.compact, d.compact),
        showSummary: asBool(o.showSummary, d.showSummary),
        summaryLabelMode: asEnum(o.summaryLabelMode, SUMMARY_LABEL_MODES, d.summaryLabelMode),
        topIcon: asEnum(o.topIcon, TOP_ICON_MODES, d.topIcon),
        autoHideColumns: asBool(o.autoHideColumns, d.autoHideColumns),
        title: typeof o.title === 'string' ? o.title : d.title,
        colWidths: typeof o.colWidths === 'string' ? o.colWidths : d.colWidths,
        enableDrilldown: asBool(o.enableDrilldown, d.enableDrilldown),
    };
}

// -----------------------------------------------------------------------------
// 値 -> { key, label, color, rank, unknown }
//   文字列モード: 順位一覧に一致すれば その段階の色（データの中身には依存しない）
//   数値モード  : バンドに当たればそのバンドの色
//   どちらも当たらなければ「一覧にない値」の設定に従う
//   値が空なら null（プレーンテキスト表示・並べ替えの対象外）
// -----------------------------------------------------------------------------
function unknownSeverity(text, opts) {
    return {
        key: `unknown:${text.toLowerCase()}`,
        label: text,
        color: opts.colorUnknown ? opts.unknownColor : null,
        rank: opts.unknownOrder === 'first' ? UNKNOWN_FIRST : UNKNOWN_LAST,
        unknown: true,
    };
}

function valueToSeverity(raw, opts, order) {
    const text = cellToText(raw).trim();
    if (text === '') return null;

    if (opts.severityMode === 'number') {
        const num = Number(text.replace(/,/g, ''));
        if (!Number.isFinite(num)) return unknownSeverity(text, opts);
        const bands = opts.severityBands;
        const idx = matchBandIndex(num, bands, opts.bandOutOfRange);
        if (idx < 0) return unknownSeverity(text, opts);
        const b = bands[idx];
        return {
            key: `band:${idx}`,
            label: bandRangeLabel(b),
            color: b.value,
            rank: bands.length - 1 - idx, // 高い範囲ほど上位(0が最重大)
            unknown: false,
        };
    }

    const stage = order.lookup.get(text.toLowerCase());
    if (stage === undefined) return unknownSeverity(text, opts);
    return {
        key: `stage:${stage}`,
        label: opts.summaryLabelMode === 'raw' ? text : order.stages[stage].canonical,
        color: stageColor(stage, opts.severityColors),
        rank: stage,
        unknown: false,
    };
}

// -----------------------------------------------------------------------------
// テーマ別パレット
// -----------------------------------------------------------------------------
function getPalette(colorScheme) {
    const isDark = colorScheme !== 'light';
    return isDark
        ? {
              isDark: true,
              text: '#e8eef7',
              mutedText: '#8b9bb4',
              headerBg: 'rgba(255, 255, 255, 0.04)',
              cardBg: 'rgba(255, 255, 255, 0.02)',
              zebraBg: 'rgba(255, 255, 255, 0.022)',
              border: 'rgba(255, 255, 255, 0.08)',
              rowBorder: 'rgba(255, 255, 255, 0.06)',
              rowHover: 'rgba(79, 168, 240, 0.09)',
              accent: '#ff5c3d',
          }
        : {
              isDark: false,
              text: '#1a2733',
              mutedText: '#5c6f8a',
              headerBg: 'rgba(0, 0, 0, 0.03)',
              cardBg: '#ffffff',
              zebraBg: 'rgba(0, 0, 0, 0.022)',
              border: 'rgba(0, 0, 0, 0.10)',
              rowBorder: 'rgba(0, 0, 0, 0.06)',
              rowHover: 'rgba(0, 105, 194, 0.06)',
              accent: '#d43f21',
          };
}

// -----------------------------------------------------------------------------
// コンテナ実寸の計測フック(ResizeObserver)
//   - パネルを小さくした際に密度・列数を段階的に落とすため実寸が必要
//   - ★等値ガード:スクロールバー出現などで 1px 未満の揺れが起きても
//     setState を呼ばない(呼ぶと再描画→バー再判定→…の振動ループになる)
//   - 計測対象は外側ラッパ(パネルと同寸)。横スクロールは内側で起きるので、
//     外側は overflow:hidden にしてサイズが変動しない要素を測る
// -----------------------------------------------------------------------------
function useContainerSize() {
    const ref = useRef(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    const measure = useCallback((node) => {
        if (!node) return;
        const w = node.clientWidth;
        const h = node.clientHeight;
        setSize((prev) => {
            // 1px 未満の差は無視(振動ループ防止の等値ガード)
            if (Math.abs(prev.width - w) < 1 && Math.abs(prev.height - h) < 1) {
                return prev;
            }
            return { width: w, height: h };
        });
    }, []);

    const attach = useCallback(
        (node) => {
            // 直前の監視を解除
            if (ref.current && ref.current.__ro) {
                ref.current.__ro.disconnect();
                ref.current.__ro = null;
            }
            ref.current = node;
            if (!node) return;
            measure(node);
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => measure(node));
                ro.observe(node);
                node.__ro = ro;
            }
        },
        [measure]
    );

    return [attach, size];
}

// -----------------------------------------------------------------------------
// レスポンシブ密度:実寸から表示パラメータ(余白・フォント・列数上限)を導出
// -----------------------------------------------------------------------------
function getDensity(width, height, opts) {
    // width 0(初回計測前)は通常サイズとして扱い、既存の見た目を壊さない
    const w = width > 0 ? width : 9999;
    const h = height > 0 ? height : 9999;

    const veryCompact = w < 300;
    const compact = w < 420;
    const short = h < 180;

    // 水平パディング(th/td)
    const padH = veryCompact ? 6 : compact ? 8 : 16;
    // 垂直パディング:short や compact でさらに詰める。opts.compact も加味
    const basePadV = opts.compact ? 7 : 11;
    const padV = veryCompact || short ? 5 : compact ? 7 : basePadV;

    return {
        veryCompact,
        compact,
        short,
        padH,
        padV,
        // フォント
        tableFont: veryCompact ? 11 : compact ? 12 : 14,
        thFont: compact ? 10 : 11,
        pillFont: veryCompact ? 10 : 12,
        titleFont: veryCompact ? 11 : compact ? 12 : 13,
        summaryFont: veryCompact ? 10 : compact ? 11 : 12,
        // コンテナ余白
        containerPad: veryCompact ? 4 : compact ? 8 : 16,
        // マージン類
        titleMargin: compact ? 8 : 14,
        summaryGap: compact ? 6 : 8,
        summaryMargin: compact ? 8 : 12,
        // pill パディング
        pillPadH: veryCompact ? 8 : 12,
        pillPadV: veryCompact ? 2 : 3,
    };
}

// 幅から表示可能な列数を概算(severity 列は常に含める)
//   - 「幅が狭いときに列を自動で省略」がOFFなら常に全列表示(null)
//   - 1 列あたりの概算実効幅 = 平均文字幅×代表文字数 + 左右パディング
function computeVisibleColumns(fieldNames, severityIndex, width, density, enabled) {
    const total = fieldNames.length;
    if (!enabled) return null;
    // 通常サイズ(compact でない)は全列表示
    if (!density.compact || width <= 0 || total <= 1) {
        return null; // null = 全列表示
    }

    const charW = density.tableFont * 0.62; // 概算平均文字幅(px)
    const minCellText = 8; // 1 セルあたり最低でもこの文字数ぶんは確保
    const perColMin = charW * minCellText + density.padH * 2;
    const barW = 6; // 行頭カラーバー列の概算
    const usable = Math.max(0, width - density.containerPad * 2 - barW);

    // severity 列を必ず含めるため、最低 2 列は確保
    const fit = Math.max(2, Math.floor(usable / perColMin));
    if (fit >= total) return null; // 全部入るなら全列表示

    // 表示する列インデックス集合を決める:
    //   優先度 = 先頭列(時刻等)→ severity 列 → その後は左から詰める。
    //   溢れた列はデータ欠落ではなく横スクロールで到達可能(段階的縮退)。
    const chosen = [];
    const push = (idx) => {
        if (idx >= 0 && idx < total && !chosen.includes(idx)) chosen.push(idx);
    };
    push(0); // 先頭列(時刻/最初の有用列)を優先
    if (severityIndex >= 0) push(severityIndex); // severity 列は必ず
    for (let i = 0; i < total && chosen.length < fit; i += 1) push(i);

    chosen.sort((a, b) => a - b);
    return chosen;
}

// -----------------------------------------------------------------------------
// 最小限のCSS(ホバー効果のみ。インラインスタイルでは :hover が書けないため)
// -----------------------------------------------------------------------------
function HoverStyle({ palette }) {
    const css = `
        .sviz-row { transition: background-color 0.12s ease; }
        .sviz-row:hover { background-color: ${palette.rowHover} !important; }
        /* 列幅の掴み代：普段は控えめに、ホバー中だけはっきり見せる */
        .sviz-resizer-line { opacity: 0.28; transition: opacity 0.12s ease, background-color 0.12s ease; }
        .sviz-resizer:hover .sviz-resizer-line { opacity: 1; background-color: ${palette.accent} !important; }
    `;
    return <style>{css}</style>;
}

// 最重大の値に付けるアイコン(インラインSVG・外部通信なし)
function CriticalIcon({ color }) {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="2" />
            <rect x="7.1" y="4" width="1.8" height="5" rx="0.9" fill={color} />
            <circle cx="8" cy="11.2" r="1" fill={color} />
        </svg>
    );
}

// -----------------------------------------------------------------------------
// データ整形(rows / columns 両形式・マルチバリューセルに耐える)
// -----------------------------------------------------------------------------
function normalizeData(data) {
    try {
        if (data.rows && data.rows.length > 0) return data.rows;
        if (data.columns && data.columns.length > 0) {
            const numRows = data.columns[0].length;
            return Array.from({ length: numRows }, (_, i) => data.columns.map((col) => col[i]));
        }
    } catch (e) {
        /* 想定外形式でも落とさない */
    }
    return [];
}

// セルが配列(マルチバリュー)で届いた場合は先頭要素を代表値にする
function cellToText(cell) {
    if (cell === null || cell === undefined) return '';
    if (Array.isArray(cell)) return cell.length > 0 ? String(cell[0]) : '';
    return String(cell);
}

function toFieldLabel(field) {
    return String(field).replace(/^_+/, '').replace(/[_-]+/g, ' ');
}

// -----------------------------------------------------------------------------
// フィールドインデックス解決(columnSelector の DOS 文字列 / 生名 / 配列に対応)
//   参照実装: chord-flow resolveFieldIndex()
// -----------------------------------------------------------------------------
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

// severity列の自動判定(候補列名はオプション。先に書かれた名前ほど優先)
function autoSeverityIndex(fieldNames, candidates) {
    const lowered = candidates.map((c) => c.toLowerCase());
    let best = -1;
    let bestRank = Infinity;
    fieldNames.forEach((f, i) => {
        const rank = lowered.indexOf(String(f).trim().toLowerCase());
        if (rank >= 0 && rank < bestRank) {
            bestRank = rank;
            best = i;
        }
    });
    return best;
}

// -----------------------------------------------------------------------------
// 表示用コンポーネント
// -----------------------------------------------------------------------------
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
                <Paragraph>データがありません。サーチ結果を確認してください。</Paragraph>
            </div>
        </div>
    );
}

// severity セルの描画(スタイルはオプションで切替)
//   color は「順位一覧の色」か「当たったバンドの色」か「一覧にない値の色」。
//   色が無い(null)ときはプレーンテキストで出す。
function SeverityCell({ rawValue, color, showIcon, opts, density }) {
    const text = cellToText(rawValue);
    if (!color) return <>{text}</>;

    // density 未指定(通常サイズ)は従来の pill 値にフォールバック
    const pillFont = density ? density.pillFont : 12;
    const pillPadH = density ? density.pillPadH : 12;
    const pillPadV = density ? density.pillPadV : 3;

    if (opts.cellStyle === 'text') {
        return <span style={{ color, fontWeight: 700 }}>{text}</span>;
    }
    if (opts.cellStyle === 'dot') {
        return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <span
                    style={{
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: color,
                        boxShadow: `0 0 0 3px ${color}22`,
                        flexShrink: 0,
                    }}
                />
                <span style={{ color, fontWeight: 700 }}>{text}</span>
            </span>
        );
    }
    if (opts.cellStyle === 'bar') {
        return (
            <span
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    borderLeft: `4px solid ${color}`,
                    paddingLeft: '9px',
                    color,
                    fontWeight: 700,
                }}
            >
                {text}
            </span>
        );
    }
    // pill(既定)
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: `${pillPadV}px ${pillPadH}px`,
                borderRadius: '999px',
                backgroundColor: `${color}24`,
                border: `1px solid ${color}44`,
                color,
                fontSize: `${pillFont}px`,
                fontWeight: 700,
                letterSpacing: '0.02em',
                whiteSpace: 'nowrap',
            }}
        >
            {showIcon ? <CriticalIcon color={color} /> : null}
            {text}
        </span>
    );
}

// 件数サマリ(深刻度ごとの件数を上部に表示・完全にデータ駆動)
//   items: [{ key, label, color, count }] を重大度の高い順に受け取る。
function SeveritySummary({ items, palette, density }) {
    if (!items || items.length === 0) return null;
    // density 未指定(通常サイズ)は従来値にフォールバック
    const font = density ? density.summaryFont : 12;
    const gap = density ? density.summaryGap : 8;
    const marginBottom = density ? density.summaryMargin : 12;
    const compact = density ? density.compact : false;
    const chipPad = compact ? '3px 8px 3px 7px' : '5px 12px 5px 10px';
    return (
        <div
            style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: `${gap}px`,
                marginBottom: `${marginBottom}px`,
                minWidth: 0,
            }}
        >
            {items.map((item) => {
                const color = item.color || palette.mutedText;
                return (
                    <span
                        key={item.key}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: compact ? '5px' : '7px',
                            padding: chipPad,
                            borderRadius: '8px',
                            backgroundColor: `${color}1c`,
                            border: `1px solid ${color}3a`,
                            fontSize: `${font}px`,
                            color: palette.text,
                        }}
                    >
                        <span
                            style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                backgroundColor: color,
                                flexShrink: 0,
                            }}
                        />
                        <span
                            style={{
                                color,
                                fontWeight: 700,
                                maxWidth: '160px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                            title={item.label}
                        >
                            {item.label}
                        </span>
                        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                            {item.count.toLocaleString()}
                        </span>
                    </span>
                );
            })}
        </div>
    );
}

function AlertTable({
    fieldNames,
    rows,
    severityIndex,
    colorScheme,
    opts,
    order,
    width,
    height,
    colWidths,
    onResizeColumns,
    onResetColumns,
    resizable,
}) {
    const palette = getPalette(colorScheme);

    // 実寸から密度パラメータを導出(width<=0 は通常サイズ扱い)
    const density = getDensity(width, height, opts);

    // 表示する列インデックス(null=全列)。狭い時のみ列を絞る(オプションでOFFにできる)
    const visibleCols = useMemo(
        () =>
            computeVisibleColumns(
                fieldNames,
                severityIndex,
                width,
                density,
                opts.autoHideColumns
            ),
        // density はプリミティブの集合。width/severityIndex/列数で十分に依存を表現できる
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [
            fieldNames,
            severityIndex,
            width,
            opts.autoHideColumns,
            density.compact,
            density.veryCompact,
            density.tableFont,
        ]
    );
    const shownCols = visibleCols || fieldNames.map((_f, i) => i);
    const hiddenCount = fieldNames.length - shownCols.length;

    // -------------------------------------------------------------------------
    // 列幅のドラッグ変更
    //
    // 見出しの右端に掴み代（縦線）を置き、押した位置からの移動量を「表全体に対する
    // 割合」に直して、掴んだ列と右隣の列で分け合う（合計は変わらないので他の列は動かない）。
    // ドラッグ中はローカルの draft を描画し、離した時点で親に保存を依頼する。
    // -------------------------------------------------------------------------
    // ドラッグ中と「保存したが options がまだ echo されていない間」の見た目を持つ。
    // ★離した瞬間に null へ戻すと、ホストの反映が1フレーム遅れる環境で列が一瞬
    //   元の幅へ戻って見える。options が追いついたら下の effect で破棄する。
    const [widthDraft, setWidthDraft] = useState(null);
    const resizeRef = useRef(null); // { work, moved }
    const tableWrapRef = useRef(null);

    // options 由来の幅が更新されたらドラフトを捨てて options を正とする
    useEffect(() => {
        if (!resizeRef.current) setWidthDraft(null);
    }, [colWidths]);

    const shownFieldNames = useMemo(
        () => shownCols.map((i) => String(fieldNames[i])),
        [shownCols, fieldNames]
    );

    // 実際に colgroup へ渡す幅(%)。ドラッグ中はドラフト、それ以外は options 由来。
    const activeWidths = widthDraft || colWidths;
    const colPercents = useMemo(
        () => resolveColumnWidths(shownFieldNames, activeWidths),
        [shownFieldNames, activeWidths]
    );

    // 「列幅をリセット」を出すかの判定。
    // ★この画面で実際に幅を触ったときだけ出す。保存済みの幅があるだけの状態
    //   （ダッシュボードを開いただけ）では出さない＝普段は表を邪魔しない。
    //   リセットを押したら false に戻り、また触れば true になる。
    const [widthsTouched, setWidthsTouched] = useState(false);

    const startResize = useCallback(
        (posInShown) => (ev) => {
            // 右隣が無い（最終列）の掴み代は出さないので通常は来ないが、防御的に弾く
            if (!resizable || resizeRef.current) return;
            if (posInShown < 0 || posInShown >= shownFieldNames.length - 1) return;
            if (ev) {
                if (typeof ev.preventDefault === 'function') ev.preventDefault();
                if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
            }
            const w = typeof window !== 'undefined' ? window : null;
            const el = tableWrapRef.current;
            if (!w || !el || typeof el.getBoundingClientRect !== 'function') return;
            const rect = el.getBoundingClientRect();
            const totalPx = rect && rect.width ? rect.width : 0;
            if (!totalPx) return;

            // 掴んだ時点の実効幅（割合）を全列ぶん確定させる。以後はこれを基準に増減する。
            // ★未指定だった列もここで数値になるので、ドラッグ後は「見えているとおり」に固定される。
            const basePct = resolveColumnWidths(shownFieldNames, activeWidths);
            const base = {};
            shownFieldNames.forEach((f, i) => {
                base[f] = basePct[i] / 100;
            });
            const startX = typeof ev.clientX === 'number' ? ev.clientX : 0;
            const leftName = shownFieldNames[posInShown];
            const rightName = shownFieldNames[posInShown + 1];
            const pairSum = base[leftName] + base[rightName];

            resizeRef.current = { work: { ...activeWidths, ...base }, moved: false };
            setWidthDraft({ ...activeWidths, ...base });

            const onMove = (mv) => {
                const st = resizeRef.current;
                if (!st || typeof mv.clientX !== 'number') return;
                const deltaFrac = (mv.clientX - startX) / totalPx;
                // 2列の合計は保存したまま、境界だけを動かす
                let left = base[leftName] + deltaFrac;
                const lo = MIN_COL_FRACTION;
                const hi = pairSum - MIN_COL_FRACTION;
                if (hi <= lo) return; // 2列とも下限に張り付いていて動かす余地が無い
                left = Math.min(hi, Math.max(lo, left));
                st.work = { ...st.work, [leftName]: left, [rightName]: pairSum - left };
                st.moved = true;
                setWidthDraft({ ...st.work });
            };
            const onUp = () => {
                const st = resizeRef.current;
                ['pointermove', 'mousemove'].forEach((t) => w.removeEventListener(t, onMove));
                ['pointerup', 'mouseup'].forEach((t) => w.removeEventListener(t, onUp));
                resizeRef.current = null;
                // 動かしていなければ保存しない（誤クリックで全列の幅を固定化しない）
                if (st && st.moved && typeof onResizeColumns === 'function') {
                    // ドラフトは残したまま保存する。options が echo された時点で
                    // 上の effect が破棄し、以後は options が正になる。
                    setWidthDraft({ ...st.work });
                    setWidthsTouched(true); // これ以降「列幅をリセット」を出す
                    onResizeColumns(st.work);
                } else {
                    setWidthDraft(null);
                }
            };
            ['pointermove', 'mousemove'].forEach((t) => w.addEventListener(t, onMove));
            ['pointerup', 'mouseup'].forEach((t) => w.addEventListener(t, onUp));
        },
        [resizable, shownFieldNames, activeWidths, onResizeColumns]
    );

    // 掴み代のダブルクリック＝その2列を等分に戻す（線の折れ点削除と同じ操作感）
    const evenOutPair = useCallback(
        (posInShown) => () => {
            if (!resizable || typeof onResizeColumns !== 'function') return;
            if (posInShown < 0 || posInShown >= shownFieldNames.length - 1) return;
            const basePct = resolveColumnWidths(shownFieldNames, activeWidths);
            const base = {};
            shownFieldNames.forEach((f, i) => {
                base[f] = basePct[i] / 100;
            });
            const leftName = shownFieldNames[posInShown];
            const rightName = shownFieldNames[posInShown + 1];
            const half = (base[leftName] + base[rightName]) / 2;
            const next = { ...activeWidths, ...base, [leftName]: half, [rightName]: half };
            setWidthDraft(next); // options の echo までの見た目を保つ
            setWidthsTouched(true); // これ以降「列幅をリセット」を出す
            onResizeColumns(next);
        },
        [resizable, shownFieldNames, activeWidths, onResizeColumns]
    );

    // 行ごとに深刻度を算出 → サマリ集計・ソート・表示制限
    const prepared = useMemo(() => {
        const withSev = rows.map((row, i) => {
            const sev =
                severityIndex >= 0
                    ? valueToSeverity(row[severityIndex], opts, order)
                    : null;
            return { row, sev, origIndex: i };
        });

        // サマリ:出現した深刻度を順位順に集計(段階数は固定ではない)
        const byKey = new Map();
        withSev.forEach((r) => {
            if (!r.sev) return;
            const cur = byKey.get(r.sev.key);
            if (cur) {
                cur.count += 1;
            } else {
                byKey.set(r.sev.key, {
                    key: r.sev.key,
                    label: r.sev.label,
                    color: r.sev.color,
                    rank: r.sev.rank,
                    count: 1,
                    firstIndex: r.origIndex,
                });
            }
        });
        // サマリは常に「重大な順」で並べる(表の並び順オプションとは独立)
        const summaryItems = [...byKey.values()].sort((a, b) =>
            a.rank !== b.rank ? a.rank - b.rank : a.firstIndex - b.firstIndex
        );
        // データ内で最も重大なキー(アイコン表示モード 'highest' で使う)
        const highestKey = summaryItems.length > 0 ? summaryItems[0].key : null;

        let ordered = withSev;
        if (opts.sortMode !== 'none' && severityIndex >= 0) {
            const dir = opts.sortMode === 'asc' ? -1 : 1;
            ordered = [...withSev].sort((a, b) => {
                // 深刻度が空の行は並べ替えの対象外。方向によらず常に末尾。
                if (!a.sev && !b.sev) return a.origIndex - b.origIndex;
                if (!a.sev) return 1;
                if (!b.sev) return -1;
                if (a.sev.rank !== b.sev.rank) return (a.sev.rank - b.sev.rank) * dir;
                return a.origIndex - b.origIndex; // 安定ソート(元の順序維持)
            });
        }

        const total = ordered.length;
        const limited = opts.maxRows > 0 ? ordered.slice(0, opts.maxRows) : ordered;
        return { rows: limited, summaryItems, highestKey, total, shown: limited.length };
    }, [rows, severityIndex, opts, order]);

    // -------------------------------------------------------------------------
    // ドリルダウン（編集画面の「インタラクション」）
    //
    // 発火するのは addDrilldownListener に登録した DOM ノードのクリックだけ。
    // triggerDrilldown() を自前の onClick から呼んでも効かない（サイレントに無視される）。
    //
    // ★登録は「ノード1つにつき1回だけ」。API に解除手段が無いため、再レンダリングの
    //   たびに登録し直すと同じノードにリスナーが積み上がり、1クリックで何度も発火する。
    //   そこで payload は WeakMap（ノード → payload）に毎レンダー入れ直し、
    //   payloadCallback はクリック時にそこから読む。こうすると登録は1回で済み、
    //   かつ「今その位置に表示されている行」の値が必ず飛ぶ。
    //   （payloadCallback に行番号を固定で閉じ込めると、並べ替え後に別の行の値が飛ぶ）
    // -------------------------------------------------------------------------
    const clickable = opts.enableDrilldown && typeof addDrilldownListener === 'function';
    const cellPayloads = useRef(new WeakMap());
    const registeredCells = useRef(new WeakSet());

    const attachCell = useCallback((node, payload) => {
        if (!node) return; // ref のデタッチ（null）は何もしない
        cellPayloads.current.set(node, payload);
        if (registeredCells.current.has(node)) return;
        registeredCells.current.add(node);
        try {
            addDrilldownListener({
                node,
                action: CLICK_ACTION,
                payloadCallback: () => cellPayloads.current.get(node) || {},
            });
        } catch (e) {
            /* ドリルダウン未対応のホストでも描画は続ける */
        }
    }, []);

    // 行ごとのトークン（`row.<フィールド名>.value`）。
    // 幅が狭くて非表示になっている列も含めて全フィールドを載せる
    // （見えていない列の値でトークンを設定したいこともあるため）。
    const rowTokens = useMemo(
        () =>
            prepared.rows.map(({ row }) => {
                const t = {};
                fieldNames.forEach((f, i) => {
                    t[`row.${f}.value`] = cellToText(Array.isArray(row) ? row[i] : undefined);
                });
                return t;
            }),
        [prepared.rows, fieldNames]
    );

    // アイコンを付ける対象の判定(モードは明示オプション)
    const iconMatches = useCallback(
        (sev) => {
            if (!sev || opts.topIcon === 'none') return false;
            if (opts.topIcon === 'top') return !sev.unknown && sev.rank === 0;
            return !!prepared.highestKey && sev.key === prepared.highestKey;
        },
        [opts.topIcon, prepared.highestKey]
    );

    const rowPadV = `${density.padV}px`;
    const rowPadH = `${density.padH}px`;
    const title = opts.title.trim();
    const truncated = prepared.total > prepared.shown;
    // 「列幅をリセット」はこの画面で幅を触ったときだけ出す（普段は表を邪魔しない）
    const showResetWidths = resizable && widthsTouched;
    // タイトル行はタイトルが空でも「件数が省略されている」「列幅リセットを出す」ときは出す
    const showTitleRow = title !== '' || truncated || showResetWidths;

    // コンテナ:実コンテンツ。ここで縦横スクロールを担う(到達性の最終担保)。
    const containerStyle = {
        position: 'relative',
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        padding: `${density.containerPad}px`,
        overflow: 'auto',
        color: palette.text,
        fontFamily:
            '"Splunk Platform Sans", "Proxima Nova", -apple-system, "Segoe UI", Roboto, sans-serif',
    };

    const titleRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: density.compact ? '7px' : '10px',
        marginBottom: `${density.titleMargin}px`,
        fontSize: `${density.titleFont}px`,
        fontWeight: 700,
        letterSpacing: density.veryCompact ? '0.06em' : '0.14em',
        textTransform: 'uppercase',
        color: palette.mutedText,
        minWidth: 0,
    };

    const accentBarStyle = {
        width: '4px',
        height: '16px',
        borderRadius: '2px',
        backgroundColor: palette.accent,
        flexShrink: 0,
    };

    const cardStyle = {
        backgroundColor: palette.cardBg,
        border: `1px solid ${palette.border}`,
        borderRadius: '12px',
        overflow: 'hidden',
    };

    const tableStyle = {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: `${density.tableFont}px`,
        // 固定レイアウト：各列はセル内容ではなくコンテナ幅を分け合う。
        tableLayout: 'fixed',
    };

    const thStyle = {
        padding: `${density.padV}px ${rowPadH}`,
        textAlign: 'left',
        fontSize: `${density.thFont}px`,
        fontWeight: 700,
        letterSpacing: density.compact ? '0.06em' : '0.12em',
        textTransform: 'uppercase',
        color: palette.mutedText,
        backgroundColor: palette.headerBg,
        borderBottom: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    };

    const baseTdStyle = {
        padding: `${rowPadV} ${rowPadH}`,
        borderBottom: `1px solid ${palette.rowBorder}`,
        verticalAlign: 'middle',
        // 固定レイアウト下でセルをはみ出させない：長い値は … で切り詰める。
        maxWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    };

    const hasRowBar = opts.rowBar && severityIndex >= 0;

    return (
        <div style={containerStyle}>
            <HoverStyle palette={palette} />
            {showTitleRow ? (
                <div style={titleRowStyle}>
                    <span style={accentBarStyle} />
                    <span
                        style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {title}
                    </span>
                    {truncated ? (
                        <span
                            style={{
                                fontSize: `${Math.max(9, density.titleFont - 2)}px`,
                                letterSpacing: '0.04em',
                                textTransform: 'none',
                                fontWeight: 600,
                                color: palette.mutedText,
                                flexShrink: 0,
                            }}
                        >
                            {prepared.shown.toLocaleString()} / {prepared.total.toLocaleString()}
                        </span>
                    ) : null}
                    {showResetWidths ? (
                        <span
                            data-role="reset-widths"
                            onClick={() => {
                                setWidthDraft(null); // ドラフトが残っていると等分に戻らない
                                setWidthsTouched(false); // 押したら自身も引っ込む
                                if (typeof onResetColumns === 'function') onResetColumns();
                            }}
                            title="列幅を既定（等分）に戻します"
                            style={{
                                fontSize: `${Math.max(9, density.titleFont - 2)}px`,
                                letterSpacing: '0.02em',
                                textTransform: 'none',
                                fontWeight: 600,
                                color: palette.mutedText,
                                border: `1px solid ${palette.border}`,
                                borderRadius: '6px',
                                padding: '2px 8px',
                                cursor: 'pointer',
                                userSelect: 'none',
                                flexShrink: 0,
                            }}
                        >
                            列幅をリセット
                        </span>
                    ) : null}
                </div>
            ) : null}

            {opts.showSummary ? (
                <SeveritySummary
                    items={prepared.summaryItems}
                    palette={palette}
                    density={density}
                />
            ) : null}

            <div style={cardStyle} ref={tableWrapRef}>
                <table style={tableStyle}>
                    {/* tableLayout:fixed は列幅を colgroup（無ければ先頭行）から決める。
                        行頭カラーバー列に明示幅を与えないと、その列が等分の 1 枠を
                        丸取りして左に巨大な余白ができ、右側の列が見切れる。 */}
                    <colgroup>
                        {hasRowBar ? <col style={{ width: '4px' }} /> : null}
                        {shownCols.map((cellIndex, pos) => (
                            <col
                                key={`col-${fieldNames[cellIndex]}`}
                                style={{ width: `${colPercents[pos].toFixed(3)}%` }}
                            />
                        ))}
                    </colgroup>
                    <thead>
                        <tr>
                            {hasRowBar ? (
                                <th
                                    style={{
                                        ...thStyle,
                                        padding: `${density.padV}px 0`,
                                        width: '4px',
                                    }}
                                />
                            ) : null}
                            {shownCols.map((cellIndex, pos) => {
                                // 掴み代は「右隣の列がある見出し」にだけ置く。
                                // 最終列に置いても分け合う相手が居らず、動かせないため。
                                const canGrab = resizable && pos < shownCols.length - 1;
                                return (
                                    <th
                                        key={fieldNames[cellIndex]}
                                        style={{
                                            ...thStyle,
                                            position: 'relative',
                                            // 掴み代を置く見出しは切り取らない（overflow:hidden だと
                                            // 掴み代がクリップされて押せなくなる）。見出し文字の
                                            // 省略は下の内側 span が担当する。
                                            ...(canGrab
                                                ? { overflow: 'visible', paddingRight: `${RESIZER_HIT}px` }
                                                : null),
                                        }}
                                    >
                                        {/* 見出し文字はここで省略する（th 側は掴み代のために
                                            overflow:visible にしてあるので切り取れない） */}
                                        <span
                                            style={{
                                                display: 'inline-block',
                                                maxWidth: '100%',
                                                verticalAlign: 'bottom',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}
                                            title={toFieldLabel(fieldNames[cellIndex])}
                                        >
                                            {toFieldLabel(fieldNames[cellIndex])}
                                        </span>
                                        {/* 末尾の見出しに省略列のヒントを添える(狭い時のみ) */}
                                        {hiddenCount > 0 &&
                                        cellIndex === shownCols[shownCols.length - 1] ? (
                                            <span
                                                style={{
                                                    marginLeft: '6px',
                                                    fontSize: `${Math.max(9, density.thFont - 1)}px`,
                                                    fontWeight: 600,
                                                    letterSpacing: 'normal',
                                                    textTransform: 'none',
                                                    opacity: 0.75,
                                                }}
                                                title="横スクロールで残りの列を表示できます"
                                            >
                                                +{hiddenCount}列
                                            </span>
                                        ) : null}
                                        {canGrab ? (
                                            <span
                                                data-role="col-resizer"
                                                className="sviz-resizer"
                                                onPointerDown={startResize(pos)}
                                                onMouseDown={startResize(pos)}
                                                onDoubleClick={evenOutPair(pos)}
                                                title="ドラッグで列幅を変更／ダブルクリックで左右を等分"
                                                style={{
                                                    position: 'absolute',
                                                    top: 0,
                                                    // ★見出しの外へはみ出させない。th は overflow:hidden
                                                    //   なので、はみ出した部分は切り取られてクリックが
                                                    //   届かなくなる（実機で掴めない不具合になった）。
                                                    right: 0,
                                                    width: `${RESIZER_HIT}px`,
                                                    height: '100%',
                                                    cursor: 'col-resize',
                                                    userSelect: 'none',
                                                    touchAction: 'none',
                                                    zIndex: 3,
                                                }}
                                            >
                                                {/* 掴み代の中央に出る細い縦線（ホバー時のみ濃くする） */}
                                                <span
                                                    className="sviz-resizer-line"
                                                    style={{
                                                        position: 'absolute',
                                                        top: '18%',
                                                        left: `${RESIZER_HIT / 2 - 1}px`,
                                                        width: '2px',
                                                        height: '64%',
                                                        borderRadius: '1px',
                                                        backgroundColor: palette.mutedText,
                                                    }}
                                                />
                                            </span>
                                        ) : null}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    {/* ★ key に clickable を混ぜて、オプションを切り替えたら行を作り直す。
                        addDrilldownListener に解除手段が無いため、OFF にしたときは
                        「登録済みのノードごと捨てる」以外に止める方法がない。 */}
                    <tbody key={clickable ? 'cells-clickable' : 'cells-plain'}>
                        {prepared.rows.map((item, rowIndex) => {
                            const { row, sev } = item;
                            const rowColor = sev ? sev.color : null;
                            const isLast = rowIndex === prepared.rows.length - 1;
                            const barColor = hasRowBar && rowColor ? rowColor : 'transparent';
                            const zebraBg =
                                opts.zebra && rowIndex % 2 === 1 ? palette.zebraBg : 'transparent';
                            const tokens = rowTokens[rowIndex] || {};
                            return (
                                <tr
                                    key={item.origIndex}
                                    className="sviz-row"
                                    style={{ backgroundColor: zebraBg }}
                                >
                                    {hasRowBar ? (
                                        <td
                                            ref={
                                                clickable
                                                    ? (el) =>
                                                          attachCell(el, {
                                                              ...tokens,
                                                              name: fieldNames[severityIndex],
                                                              value: cellToText(row[severityIndex]),
                                                          })
                                                    : undefined
                                            }
                                            style={{
                                                ...baseTdStyle,
                                                padding: 0,
                                                width: '4px',
                                                ...(clickable ? { cursor: 'pointer' } : null),
                                                ...(isLast ? { borderBottom: 'none' } : null),
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: '4px',
                                                    minHeight: '18px',
                                                    height: '100%',
                                                    backgroundColor: barColor,
                                                }}
                                            />
                                        </td>
                                    ) : null}
                                    {shownCols.map((cellIndex) => {
                                        const cell = row[cellIndex];
                                        const isTimeField = TIME_FIELD_PATTERN.test(
                                            String(fieldNames[cellIndex] ?? '')
                                        );
                                        const tdStyle = {
                                            ...baseTdStyle,
                                            ...(clickable ? { cursor: 'pointer' } : null),
                                            ...(isLast ? { borderBottom: 'none' } : null),
                                            ...(isTimeField
                                                ? {
                                                      fontVariantNumeric: 'tabular-nums',
                                                      fontWeight: 600,
                                                  }
                                                : null),
                                        };
                                        const cellText = cellToText(cell);
                                        return (
                                            <td
                                                key={cellIndex}
                                                ref={
                                                    clickable
                                                        ? (el) =>
                                                              attachCell(el, {
                                                                  ...tokens,
                                                                  name: fieldNames[cellIndex],
                                                                  value: cellText,
                                                              })
                                                        : undefined
                                                }
                                                style={tdStyle}
                                                title={
                                                    cellIndex === severityIndex ? undefined : cellText
                                                }
                                            >
                                                {cellIndex === severityIndex ? (
                                                    <SeverityCell
                                                        rawValue={cell}
                                                        color={rowColor}
                                                        showIcon={iconMatches(sev)}
                                                        opts={opts}
                                                        density={density}
                                                    />
                                                ) : (
                                                    cellText
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// スピナー永久表示（サーチ完了通知の取りこぼし）対策
//
// 公式 useDataSources は「render 時に getDataSources() でシード → useEffect で購読」
// の構造で、シードと購読の間に届いた更新を取り逃す（ホストは購読登録時に現在値を
// 再送しない。実機確認済み）。取り逃したのがサーチ完了の最終通知だと、以後更新が
// 来ないため loading:true のまま固まり、スピナーが回り続ける。
// 対策として、公式フックが loading の間は getDataSources() を定期的に読み直し、
// ホスト側がすでに完了していればその値を採用する。完了後は何もしない（コストゼロ）。
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
                    setRescue(cur); // ホストは完了済み＝最終通知を取り逃していた。回収して終了
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

function AlertVisualization({ colorScheme }) {
    const { dataSources, loading } = useDataSourcesWithRescue() || {};
    const optionsApi = useOptions();
    const options = optionsApi?.options;
    const setOptions = optionsApi?.setOptions;
    const modeApi = useMode();
    const isEdit = modeApi?.mode === 'edit';
    const data = dataSources?.primary?.data || null;

    // ★パネル実寸を計測(この要素はパネルと同寸・overflow:hidden で不変)
    const [measureRef, size] = useContainerSize();

    const opts = useMemo(() => normalizeOptions(options), [options]);
    const order = useMemo(() => parseSeverityOrder(opts.severityOrder), [opts.severityOrder]);

    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(
        () => (data?.fields || []).map((f) => (f && typeof f === 'object' ? f.name : f)),
        [data]
    );
    const severityIndex = useMemo(() => {
        const resolved = resolveFieldIndex(opts.severityField, fieldNames, rows, -2);
        // -2 = 未指定 → 候補列名による自動判定にフォールバック
        return resolved === -2
            ? autoSeverityIndex(fieldNames, opts.severityFieldCandidates)
            : resolved;
    }, [opts.severityField, opts.severityFieldCandidates, fieldNames, rows]);

    // -------------------------------------------------------------------------
    // 列幅の保存（link-line の線編集と同じ流儀）
    //
    // ・保存先は options の `colWidths`（optionsSchema には載せない。→ ファイル冒頭の注記）
    // ・表示モード中の setOptions はホストによってダッシュボード定義に取り込まれないため、
    //   未確定ぶんを pendingRef に持っておき「編集モードに入った瞬間」に再送して確定させる。
    // -------------------------------------------------------------------------
    const colWidths = useMemo(() => parseColWidths(opts.colWidths), [opts.colWidths]);

    const lastSavedRef = useRef(null); // 直近 setOptions した colWidths JSON（echo 判定用）
    const pendingRef = useRef({}); // { colWidths? } 未確定の変更
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const setOptionsRef = useRef(setOptions);
    setOptionsRef.current = setOptions;

    // 外部で colWidths が変わったら（undo・他画面での編集）追従する。
    // 自分の保存の echo なら pending を消し込む
    useEffect(() => {
        const incoming = typeof opts.colWidths === 'string' ? opts.colWidths : '';
        if (pendingRef.current.colWidths !== undefined && incoming === pendingRef.current.colWidths) {
            delete pendingRef.current.colWidths; // ホストに反映された
        } else if (incoming !== lastSavedRef.current) {
            delete pendingRef.current.colWidths; // 外部からの変更が勝つ
        }
    }, [opts.colWidths]);

    // ★編集モードに入った瞬間、表示モードでの未確定の変更を setOptions で再送する
    useEffect(() => {
        if (!isEdit) return;
        const raw = optionsRef.current && typeof optionsRef.current === 'object' ? optionsRef.current : {};
        const pend = pendingRef.current;
        if (
            pend.colWidths !== undefined &&
            pend.colWidths !== (typeof raw.colWidths === 'string' ? raw.colWidths : '') &&
            typeof setOptionsRef.current === 'function'
        ) {
            setOptionsRef.current({ ...raw, colWidths: pend.colWidths });
        }
    }, [isEdit]);

    const saveColWidths = useCallback(
        (map) => {
            const json = serializeColWidths(map);
            lastSavedRef.current = json;
            pendingRef.current.colWidths = json;
            if (typeof setOptions === 'function') {
                setOptions({
                    ...(options && typeof options === 'object' ? options : {}),
                    colWidths: json,
                });
            }
        },
        [setOptions, options]
    );

    const resetColWidths = useCallback(() => saveColWidths({}), [saveColWidths]);

    // 編集モード中はホストが iframe への入力を遮断するのでドラッグは成立しない。
    // 掴み代を出しても動かないだけなので、その間は出さない（誤解を招かないため）。
    const resizable = !isEdit && typeof setOptions === 'function';

    // 計測ラッパは常に描画する(loading/nodata でも寸法を得られるように)
    const measuredWrapperStyle = {
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
    };

    let inner;
    if (loading) {
        inner = <LoadingState />;
    } else if (!data || rows.length === 0 || fieldNames.length === 0) {
        inner = <NoDataState />;
    } else {
        inner = (
            <AlertTable
                fieldNames={fieldNames}
                rows={rows}
                severityIndex={severityIndex}
                colorScheme={colorScheme}
                opts={opts}
                order={order}
                width={size.width}
                height={size.height}
                colWidths={colWidths}
                onResizeColumns={saveColWidths}
                onResetColumns={resetColWidths}
                resizable={resizable}
            />
        );
    }

    return (
        <div ref={measureRef} style={measuredWrapperStyle} data-viz-version={VIZ_VERSION}>
            {inner}
        </div>
    );
}

// -----------------------------------------------------------------------------
// エラーバウンダリ(描画エラーで真っ白になるのを防止)
// -----------------------------------------------------------------------------
class VizErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, message: '' };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, message: String(error?.message || error) };
    }

    render() {
        if (this.state.hasError) {
            return (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        height: '100%',
                        minHeight: '80px',
                        fontFamily: 'sans-serif',
                        fontSize: '12px',
                        opacity: 0.6,
                    }}
                >
                    Visualization error: {this.state.message}
                </div>
            );
        }
        return this.props.children;
    }
}

// -----------------------------------------------------------------------------
// App本体(テーマ確定後のみ実行される)
// -----------------------------------------------------------------------------
function App({ colorScheme }) {
    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <VizErrorBoundary>
                <AlertVisualization colorScheme={colorScheme} />
            </VizErrorBoundary>
        </SplunkThemeProvider>
    );
}

// -----------------------------------------------------------------------------
// テーマは通常マウントゲートで取得済み。万一未着でも light 既定で必ず描画する
// -----------------------------------------------------------------------------
function Root() {
    const themeApi = useTheme();
    const colorScheme = themeApi?.theme || 'light';
    return <App colorScheme={colorScheme} />;
}

// -----------------------------------------------------------------------------
// マウント処理(DOM準備前に実行された場合にも対応し、安定して表示させる)
// -----------------------------------------------------------------------------
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

function mount() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(<Root />);
}

function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mount();
    } else {
        setTimeout(mountWhenReady, 50);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountWhenReady, { once: true });
} else {
    mountWhenReady();
}
