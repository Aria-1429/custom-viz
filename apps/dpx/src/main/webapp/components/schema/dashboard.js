// ── DPX ダッシュボードスキーマ v2（Zod）─────────────────────────
//
// **ダッシュボードの状態を React コンポーネントに持たせず、
//   バージョン付き JSON として管理する**ための定義。
//
// ⚠ **v1 との互換は意図的に持たない**（2026-08-13 ユーザー決定「これは移行ではない」）。
//   旧形式フォールバックを書かないぶん、スキーマを最善の形にできる。
//   v1 の定義を読ませたい場合は `parse.js` が**理由付きで拒否**する（黙って壊さない）。
//
// ## v1 から変えた点（なぜ変えたか）
//
// | v1 | v2 | 理由 |
// |---|---|---|
// | `version: 1` | `schemaVersion: 2` | `version` は viz のオプション名と衝突しやすい。Studio も `schemaVersion` 系の名前を使う |
// | `grid` が直下 | `layout: { type, grid }` | **Layout Engine を差し替え可能にする**（Phase 3）。grid 固有の設定は grid の中へ |
// | `search.spl` 直書き可 | **`dataSources` 参照のみ** | 同じサーチが散らばると管理が破綻する。v1 でも実質廃止済みだったのを**スキーマで強制**する |
// | 既定値がコード側 | **`.default()` で宣言** | 二重定義による UI と実物の食い違いを構造的に防ぐ（§8.dd） |
//
// ## 既定値の扱い（重要）
//
// **`parse()` を通した定義は「既定値が埋まった状態」**になる。
// コンポーネント側で `?? 'noc'` のようなフォールバックを書かないこと。
// 書くと**ここと二重定義**になり、片方を変えたときにズレる。
//
// ## ⚠ 入れ子のオブジェクトは `.default({})` ではなく `.prefault({})`（Zod 4）
//
// **`.default({})` は「値が無いときにその値を*そのまま*入れる」**ので、
// 入れ子の既定値が**走らない**（実測）:
//
//   z.object({ i: Inner.default({})  }).parse({})  // → { i: {} }          ⚠ 空のまま
//   z.object({ i: Inner.prefault({}) }).parse({})  // → { i: { a: 5 } }    ✓ 既定が入る
//
// `prefault` は「入力が無いときに `{}` を**入力として流す**」＝ Inner の
// `.default()` が評価される。**このスキーマの既定値はすべて prefault 前提**。
// ここを `default` に書き換えると、`layout.grid.columns` などが
// **undefined のまま描画層に届く**（グリッドが崩れる形で表面化する）。
//
// ⚠ ただし **`z.record()` は `.default({})` のままでよい**
//   （`dataSources` / `options` / `setTokens`）。空のマップは本当に空であって、
//   埋めるべき既定のキーが無いため。
// ────────────────────────────────────────────────────────────────

import { z } from 'zod';

import {
    AMBIENT_VALUES,
    BRUSH_VALUES,
    MOTION_VALUES,
    CHROME_VALUES,
    DEFAULTS,
    ENTRANCE_VALUES,
    GROUP_VARIANT_VALUES,
    INPUT_TYPES,
    LAYOUT_TYPES,
    PANEL_VARIANT_VALUES,
    SCHEMA_VERSION,
    TAB_POSITIONS,
    THEME_PRESETS,
    TITLE_ALIGNS,
} from './vocab.js';

// ── 部品 ───────────────────────────────────────────────────────

/** 識別子（パネル ID・トークン名など）。空文字を弾く。 */
const Id = z.string().min(1);

/**
 * 色。`#rgb` / `#rrggbb` / `rgba(...)` を許す。
 *
 * ⚠ **厳しくしすぎない。** テーマ由来の色をそのまま入れる導線があり、
 *   ここで弾くと「保存できない」だけの障害になる。
 *   空文字は「未設定」を意味するので許可する（`<input type=color>` は
 *   未設定を表現できないため、空文字が実際に流通する）。
 */
const Color = z.string();

/**
 * 列挙。**未知の値は既定へ落とす**（弾かない）。
 *
 * ⚠ **未知の質感で保存できなくなる事態を避ける。** 質感を消したり
 *   リネームしたときに、古い定義が「開けない」になるのが最悪。
 *   `catch()` で既定へ倒し、**描画は必ず成立させる**。
 */
const enumWithFallback = (values, fallback) =>
    z.enum(values).catch(fallback);

// ── サーチ（Data Source 層）──────────────────────────────────────

/**
 * 共有データソース（サーチ）。
 *
 * **サーチは必ずここに置く。** パネルは `search.ref` で参照するだけ。
 * Studio の ds.search / ds.chain / ds.test という型分けは採らず、
 * **「共有サーチ＋postSearch（後続パイプ）」の 1 種類に畳んである**
 * （型を増やすほど編集 UI が複雑になるため）。
 */
export const DataSourceSchema = z.object({
    /** インスペクタでの表示名 */
    name: z.string().default(''),
    spl: z.string().default(''),
    earliest: z.string().default(DEFAULTS.search.earliest),
    latest: z.string().default(DEFAULTS.search.latest),
    /** 自動更新の間隔（秒）。0 で自動更新しない */
    refresh: z.number().nonnegative().default(DEFAULTS.search.refresh),
});

/**
 * パネルのサーチ設定。**参照（ref）のみ**。
 *
 * ⚠ v1 にあった `spl` 直書きは**スキーマから外した**。
 *   絞り込みは `postSearch`（後続パイプ）で行う。
 * ⚠ 実測メモ: postSearch の絞り込みは `| where`。
 *   `| search` は 0 行になる（サブサーチではなく後続パイプのため）。
 */
export const PanelSearchSchema = z.object({
    ref: z.string().default(''),
    postSearch: z.string().default(''),
    /** 時間はパネル側が優先（入力から受け取る運用があるため）。空ならデータソース側 */
    earliest: z.string().optional(),
    latest: z.string().optional(),
    refresh: z.number().nonnegative().optional(),
});

// ── 見た目（Material 層が読む）──────────────────────────────────

/**
 * パネル個別の見た目上書き。
 *
 * ⚠ **未指定のキーは触らない**（既定値で上書きしない）。
 *   値を入れたときだけ効く＝`optional()` であって `default()` ではない。
 *   ここを `default()` にすると、質感プリセットが常に上書きされて壊れる。
 */
export const PanelStyleSchema = z.object({
    variant: enumWithFallback(PANEL_VARIANT_VALUES, 'noc').optional(),
    hideTitle: z.boolean().optional(),
    titleAlign: enumWithFallback(TITLE_ALIGNS, 'left').optional(),
    titleSkin: z.string().optional(),
    /** 重ね順。パネルは重ねてよい（Studio の grid では不可能な構図が組める） */
    z: z.number().optional(),
    accent: Color.optional(),
    bg: Color.optional(),
    borderColor: Color.optional(),
    radius: z.number().min(0).max(36).optional(),
    opacity: z.number().min(0).max(1).optional(),
    glow: z.number().min(0).max(1).optional(),
    blur: z.number().min(0).optional(),
    /** ⚠ 傾けると全画面表示とツールチップの位置がずれる（transform が fixed の基準を変える） */
    rotate: z.number().optional(),
    ambient: enumWithFallback(AMBIENT_VALUES, 'none').optional(),
    /** この viz が属する区画（グループ）の ID */
    group: z.string().optional(),
});

/** ダッシュボード全体の見た目。 */
export const DashboardStyleSchema = z.object({
    preset: enumWithFallback(THEME_PRESETS, 'midnight').default(DEFAULTS.style.preset),
    /** 差し色の上書き（未設定ならプリセットの色） */
    accent: Color.default(''),
    /** 背景エフェクト（BackgroundLayer の BACKGROUND_OPTIONS）。'none' で無し */
    background: z.string().default('none'),
    entrance: enumWithFallback(ENTRANCE_VALUES, 'rise').default(DEFAULTS.style.entrance),
    /** 角の丸み。丸すぎると「アプリの UI」に見えて管制画面の硬質さが出ない */
    radius: z.number().min(0).max(36).default(DEFAULTS.style.radius),
    bracketColor: Color.default(''),
    /**
     * Material の品質レベル（`full` / `reduced` / `minimal`）。
     *
     * 未指定なら**パネル数と `prefers-reduced-motion` から自動判定**する。
     * 明示すると自動判定より優先される（壁面表示で必ず full にしたい等）。
     */
    quality: z.enum(['auto', 'full', 'reduced', 'minimal']).catch('auto').default('auto'),
    /**
     * 画材（Brush Engine）。**グラフの線と塗りの質感**を決める。
     *
     * ⚠ パネルの質感（`panel.style.variant`）とは**別軸**。
     *   既定の `flat` では viz が従来の描画経路をそのまま通る（完全な後方互換）。
     */
    brush: z.enum(BRUSH_VALUES).catch('flat').default('flat'),
    /**
     * 画材の強度（0〜1）。
     * ⚠ **フィルタ経路は文字も歪ませる**ので、既定は「文字が耐えられる上限」。
     *   上げるほど手描きらしくなるが、ラベルが読みにくくなる。
     */
    brushIntensity: z.number().min(0).max(1).catch(1).default(1),
    /**
     * 動きの性格（Motion Engine）。
     * ⚠ `entrance` の明示指定があれば**そちらが優先**（既存ボードを壊さない）。
     */
    motion: z.enum(MOTION_VALUES).catch('subtle').default('subtle'),
    /** 見出しの意匠 */
    header: z
        .object({
            align: enumWithFallback(TITLE_ALIGNS, 'left').default('left'),
            size: z.number().optional(),
            skin: z.string().optional(),
            stamp: z.boolean().optional(),
        })
        .prefault({}),
});

// ── レイアウト（Layout Engine 層が読む）──────────────────────────

/**
 * レイアウト設定。
 *
 * ⭐ **`type` で Layout Engine を差し替える**（Phase 3 の受け皿）。
 *   grid 固有の設定を `grid` の下に閉じ込めてあるので、freeform を足すときに
 *   トップレベルを汚さずに済む。
 */
export const LayoutSchema = z.object({
    type: enumWithFallback(LAYOUT_TYPES, 'grid').default(DEFAULTS.layout),
    grid: z
        .object({
            columns: z.number().int().min(1).max(48).default(DEFAULTS.grid.columns),
            rowHeight: z.number().min(8).default(DEFAULTS.grid.rowHeight),
            gap: z.number().min(0).default(DEFAULTS.grid.gap),
        })
        .prefault({}),
    /**
     * フリーフォーム（自由配置）の設定。
     *
     * ⚠ `type: 'freeform'` のとき **`panel.x/y/w/h` の単位が px に変わる**
     *   （キーは共有する。別キーを足すと移動・複製・区画・undo を全部
     *   二重に実装することになるため）。切替時は座標を変換する。
     */
    freeform: z
        .object({
            /** スナップ幅（px）。0 でスナップ無し */
            snap: z.number().min(0).max(100).default(DEFAULTS.freeform.snap),
        })
        .prefault({}),
});

// ── パネル ─────────────────────────────────────────────────────

/** クリック時の挙動（トークン設定・ドリルダウン）。 */
export const PanelEventSchema = z.object({
    /** { トークン名: payload のキー }。payload の慣例は value / name / row.<field>.value */
    setTokens: z.record(z.string(), z.string()).default({}),
    drilldown: z
        .object({
            enabled: z.boolean().default(false),
            /** `$click.value$` で押した要素の値が使える。ダッシュボードのトークンも展開される */
            url: z.string().default(''),
            newTab: z.boolean().default(true),
        })
        .optional(),
});

export const PanelSchema = z.object({
    id: Id,
    /** viz の識別子（例 `dpx.line` / `custom_viz_worldmap.custom_viz_worldmap`） */
    viz: z.string().min(1),
    title: z.string().default(''),
    /** 所属タブ。省略時は先頭タブ */
    tab: z.string().optional(),
    // グリッド座標（列 / 行単位）
    x: z.number().int().min(0).default(DEFAULTS.panel.x),
    y: z.number().int().min(0).default(DEFAULTS.panel.y),
    w: z.number().int().min(1).default(DEFAULTS.panel.w),
    h: z.number().int().min(1).default(DEFAULTS.panel.h),
    style: PanelStyleSchema.prefault({}),
    search: PanelSearchSchema.prefault({}),
    /**
     * viz ごとのオプション。
     *
     * ⚠ **スキーマで中身を縛らない。** viz の optionsSchema に無いキーも
     *   保存されて viz に届く仕様で、これは**キャンバス上のドラッグで決まる値**
     *   （点列・ラベル位置）を保存する正当な経路になっている。
     *   ここで弾くと canvasEdit 系の viz が壊れる。
     */
    options: z.record(z.string(), z.unknown()).default({}),
    onEvent: PanelEventSchema.prefault({}),
});

// ── 区画（グループ）★Studio では原理的に不可能 ────────────────────

/**
 * 複数パネルを 1 つの区画としてくくる。
 *
 * **区画は「入れ物」であって飾りではない**（まとめて移動・複製できる）。
 * 枠はメンバーの外接矩形から計算するので、パネルを動かせば追従する。
 */
export const GroupSchema = z.object({
    id: Id,
    label: z.string().default(''),
    /** メンバーのパネル ID */
    panels: z.array(z.string()).default([]),
    variant: enumWithFallback(GROUP_VARIANT_VALUES, 'rule').default('rule'),
    color: Color.optional(),
});

// ── 入力・トークン ──────────────────────────────────────────────

/** サーチ由来の選択肢（動的ドロップダウン）。 */
const ChoiceSearchSchema = z.object({
    /** 共有データソース参照。または spl に直書き */
    ref: z.string().default(''),
    spl: z.string().default(''),
    /** トークンに入る列（空なら 1 列目） */
    valueField: z.string().default(''),
    /** 画面に出す列（空なら値と同じ） */
    labelField: z.string().default(''),
});

export const InputSchema = z.object({
    id: Id,
    type: enumWithFallback(INPUT_TYPES, 'dropdown'),
    label: z.string().default(''),
    /**
     * トークン名。
     * ⚠ timerange / daterange は `<token>.earliest` / `<token>.latest` の
     *   **2 トークン**に展開される。
     */
    token: z.string().default(''),
    defaultValue: z.string().default(''),
    width: z.number().min(40).default(190),
    /** static（既定）| search */
    choicesMode: enumWithFallback(['static', 'search'], 'static').default('static'),
    /**
     * 選択肢。**値と表示名は別々の欄**で持つ。
     * ⚠ `値|ラベル` のような区切り記法は採らない（区切り記号を覚えさせるのは負担）。
     */
    choices: z
        .array(z.object({ value: z.string().default(''), label: z.string().default('') }))
        .default([]),
    choiceSearch: ChoiceSearchSchema.optional(),
    /** 動的選択肢の先頭に足す固定行 */
    staticChoicesFirst: z
        .array(z.object({ value: z.string().default(''), label: z.string().default('') }))
        .default([]),
});

// ── タブ ───────────────────────────────────────────────────────

export const TabSchema = z.object({
    id: Id,
    label: z.string().default(''),
});

// ── ダッシュボード本体 ──────────────────────────────────────────

export const DashboardSchema = z.object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    title: z.string().default(''),
    description: z.string().default(''),
    /** true で見出し行を消す（全面レイアウト） */
    hideHeader: z.boolean().default(false),
    /** 'dpx' = Splunk ヘッダを隠す / 'splunk' = 残す */
    chrome: enumWithFallback(CHROME_VALUES, 'dpx').default(DEFAULTS.chrome),
    style: DashboardStyleSchema.prefault({}),
    layout: LayoutSchema.prefault({}),
    /** 共有サーチ。**サーチは必ずここに置く** */
    dataSources: z.record(Id, DataSourceSchema).default({}),
    tabs: z.array(TabSchema).default([]),
    tabPosition: enumWithFallback(TAB_POSITIONS, 'top').default('top'),
    tabWidth: z.number().min(80).default(168),
    /** タブ自動送り */
    rotate: z
        .object({
            enabled: z.boolean().default(false),
            intervalSec: z.number().min(1).default(15),
        })
        .prefault({}),
    inputs: z.array(InputSchema).default([]),
    panels: z.array(PanelSchema).default([]),
    groups: z.array(GroupSchema).default([]),
});

/** 空のダッシュボード（新規作成時）。既定値は全て Zod 側から来る。 */
export function emptyDashboard(title = '') {
    return DashboardSchema.parse({ schemaVersion: SCHEMA_VERSION, title });
}
