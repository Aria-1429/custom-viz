// ── DPX スキーマの語彙（列挙値と既定値の唯一の出どころ）─────────────
//
// ⚠ **このファイルの目的は「二重定義をなくすこと」。**
//
// 旧実装では同じ既定値が複数箇所にベタ書きされており、実際に不具合になった:
//   - 描画側 `DpxDashboard`: panel.style?.variant ?? 'noc'
//   - インスペクタ `Select`: p.style?.variant ?? 'card'   ← 直し忘れ
//   → **インスペクタが「カード」を選択済みに見えるのに実物は NOC** という
//     食い違いが実機で発生した（dpx-platform.md §8.dd）。
//
// 対策は「既定値を1か所に集約し、描画もインスペクタも同じ定数を読む」こと。
// **ここに無い既定値をコンポーネント側に書かない。**
//
// ⚠ **依存ゼロで保つこと。** zod も React も import しない。
//   素の Node からテストできる状態を維持する（schema/*.test.mjs が直接読む）。
//
// ⚠ **列挙の値（value）は保存される識別子なので変えない。**
//   表示名（label）だけを変える。値を変えると保存済み定義が解決できなくなる。
//   （命名の見直しでも「表示名だけ変える」を貫いてきた経緯がある）
// ────────────────────────────────────────────────────────────────

/** スキーマのバージョン。定義の互換性判定に使う。 */
export const SCHEMA_VERSION = 2;

// ── 配色プリセット ──────────────────────────────────────────────
// ⚠ 表示順は UI の並び。`themes.js` の DPX_PRESETS と対応する。
//   プリセットを足したらここにも足す（テストが突き合わせる）。
export const THEME_PRESETS = [
    // 暗い画面（発光系）
    'midnight',
    'slate',
    'carbon',
    'neon',
    'aurora',
    'matrix',
    'amber',
    'thermal',
    // 明るい地・紙もの
    'light',
    'paper',
    'eink',
    'letterpress',
    'blueprint',
    // 手描きの画材
    'watercolor',
    'inkwash',
    'pencil',
    'crayon',
    // ガラス
    'liquidGlass',
];

// ── パネル質感（Material）────────────────────────────────────────
// value は保存される識別子、label は UI の表示名。
//
// ⚠ **`polaroid` / `punchCard` は区画（グループ）では使えない。**
//   どちらも「中身がある箱」前提の造りで、中身を持たない区画に当てると
//   パネルを覆い隠す（CSS の戻り値は同一なのに実機で破綻した。
//   JSON 比較のテストでは検出できず、スクリーンショットで気づいた経緯がある）。
export const PANEL_VARIANTS = [
    // 基本形
    { value: 'frameless', label: '枠なし' },
    { value: 'outline', label: '枠線' },
    { value: 'card', label: 'カード' },
    { value: 'solid', label: '不透明' },
    { value: 'glass', label: 'すりガラス' },
    { value: 'underline', label: '上線' },
    { value: 'sideAccent', label: '左線' },
    { value: 'inset', label: '沈み込み' },
    { value: 'elevated', label: '浮き上がり' },
    // 管制・光り物
    { value: 'noc', label: 'コーナーフレーム' },
    { value: 'bracketSolid', label: 'コーナーフレーム＋地' },
    { value: 'neonEdge', label: 'ネオン管' },
    { value: 'holo', label: 'ホログラム' },
    { value: 'liquidGlass', label: 'Liquid Glass' },
    // 紙もの・図面
    { value: 'blueprint', label: '方眼紙' },
    { value: 'titleBlock', label: '表題欄' },
    { value: 'letterpress', label: '活版' },
    { value: 'ticket', label: '伝票' },
    { value: 'punchCard', label: 'パンチカード' },
    { value: 'polaroid', label: '印画紙' },
    { value: 'eink', label: '電子ペーパー' },
    // 手描きの画材
    { value: 'watercolor', label: '水彩' },
    { value: 'inkwash', label: 'インク＋水彩' },
    { value: 'pencil', label: '色鉛筆' },
    { value: 'crayon', label: 'クレヨン' },
];

export const PANEL_VARIANT_VALUES = PANEL_VARIANTS.map((v) => v.value);

/** 区画（グループ）に使えない質感。中身がある前提の造りのため。 */
export const GROUP_INCOMPATIBLE_VARIANTS = ['polaroid', 'punchCard'];

export const GROUP_VARIANT_VALUES = PANEL_VARIANT_VALUES.filter(
    (v) => !GROUP_INCOMPATIBLE_VARIANTS.includes(v)
).concat('rule'); // 'rule' は区画専用（上辺の罫）

// ── 画材（Brush Engine）────────────────────────────────────────
// **グラフの線と塗りの質感**。パネルの質感（PANEL_VARIANTS）とは別軸。
//
// ⚠ **`flat` は「画材を使わない」**という意味で、実装を持たない。
//   viz 側は `useBrush()` が null を返すことで**従来の描画経路をそのまま通る**
//   （＝完全な後方互換。`flat` 用の実装を作ると「flat のはずが微妙に違う」が起きる）。
export const BRUSH_VALUES = ['flat', 'pencil', 'crayon', 'watercolor', 'ink', 'marker'];

// ── 動きの性格（Motion Engine）──────────────────────────────────
// ⚠ **既存の ENTRANCE_VALUES を置き換えない。** Motion は「その上の抽象」で、
//   `style.entrance` の明示指定があればそちらが優先される
//   （置き換えると既存ボードの entrance 指定が全部無効になる）。
export const MOTION_VALUES = ['none', 'subtle', 'spring', 'organic'];

// ── 出現アニメーション ──────────────────────────────────────────
// ⚠ 動かすのは transform / opacity だけ。filter / box-shadow /
//   background-position を animate すると毎フレーム再描画になる。
export const ENTRANCE_VALUES = [
    'none',
    'rise',
    'drop',
    'fade',
    'slide',
    'slideRight',
    'zoom',
    'pop',
    'unfold',
    'unfoldX',
    'flip',
    'swing',
    'tilt',
];

/** 常時アニメ（パネル単位）。控えめな動きだけ。 */
export const AMBIENT_VALUES = ['none', 'float', 'breathe'];

// ── 入力の型 ───────────────────────────────────────────────────
// timerange / daterange は `<token>.earliest` / `<token>.latest` の
// **2 トークン**になる（単一トークンではない）。
export const INPUT_TYPES = [
    'dropdown',
    'multiselect',
    'text',
    'number',
    'timerange',
    'date',
    'daterange',
];

/** 2 トークンに展開される入力型。 */
export const RANGE_INPUT_TYPES = ['timerange', 'daterange'];

/** 入力を追加したときの既定ラベル。 */
export const INPUT_LABELS = {
    dropdown: '選択',
    multiselect: '複数選択',
    text: 'キーワード',
    number: '数値',
    timerange: '期間',
    date: '日付',
    daterange: '期間（カレンダー）',
};

// ── タイトル・見出し ────────────────────────────────────────────
export const TITLE_ALIGNS = ['left', 'center', 'right'];
export const TAB_POSITIONS = ['top', 'left'];
export const CHROME_VALUES = ['dpx', 'splunk'];
export const LAYOUT_TYPES = ['grid', 'freeform'];

// ── 既定値（唯一の出どころ）──────────────────────────────────────
//
// ⚠ **ここ以外に既定値を書かない。** 描画側とインスペクタが別々に
//   `?? 'noc'` と書いた結果ズレた前科がある（§8.dd）。
export const DEFAULTS = {
    grid: { columns: 12, rowHeight: 72, gap: 12 },
    /** フリーフォーム（自由配置）。単位は px */
    freeform: { snap: 8 },
    style: { preset: 'midnight', radius: 2, entrance: 'rise' },
    chrome: 'dpx',
    layout: 'grid',
    panel: { w: 6, h: 3, x: 0, y: 0 },
    search: { earliest: '-24h', latest: 'now', refresh: 0 },
};

/**
 * viz のカテゴリごとの既定パネル質感。
 *
 * ⚠ **図形・装飾は必ず枠なし。** 図形は「絵そのもの」なので、パネル側にも
 *   枠を付けると**二重の枠**になる（コーナーフレーム図形で実際に発生した）。
 *
 * @param category viz の category（chart | status | deco | shape | custom）
 */
export function defaultVariantForCategory(category) {
    return category === 'shape' || category === 'deco' ? 'frameless' : 'noc';
}

/** viz ピッカーの並び順。データを見せるものが先、飾りは後。 */
export const CATEGORY_ORDER = ['chart', 'status', 'custom', 'deco', 'shape'];

export const CATEGORY_LABELS = {
    chart: 'チャート',
    status: 'ステータス',
    deco: '装飾',
    shape: '図形',
    custom: 'その他',
};

/**
 * カテゴリの並び順を返す。
 *
 * ⚠ **`indexOf` の結果をそのまま比較キーにしない。** 未知の値は -1 になり
 *   「どれよりも小さい」＝先頭に来てしまう（図形が一番上に出た前例がある）。
 *   見つからないものは末尾に送る。
 */
export function categoryRank(category) {
    const i = CATEGORY_ORDER.indexOf(category ?? 'custom');
    return i < 0 ? CATEGORY_ORDER.length : i;
}
