# Dashboard Studio 拡張 viz 実装ナレッジ

`/splunk-viz` スキルで作る **Dashboard Studio カスタムビジュアライゼーション拡張**の実装知見。
SKILL.md 本体から参照される。新規作成・改修の前に関連章を読むこと。

- リポジトリ：モノレポ `Aria-1429/custom-viz`（private / `main`）。各 viz は `custom-viz-<name>/`。
- push はユーザーが手動で行う（Claude は push しない）。
- 別系統（`@splunk/create` の独立アプリ＝Dashboard Framework）は [dashboard-framework.md](dashboard-framework.md) を参照。

---

## 0. 利用できる Splunk UI 公式パッケージ

Splunk UI（splunkui.splunk.com / Splunk Design System）が提供する npm パッケージ群。
バージョンは `npm view @splunk/<pkg> version` で確認できる（数値は目安）。

| パッケージ | 用途 | 拡張 viz 内で使うか |
|---|---|---|
| `@splunk/dashboard-studio-extension` | **カスタム viz 拡張 API**（hook / triggerDrilldown）。このプロジェクトの土台 | 必須 |
| `@splunk/react-ui` | Splunk デザイン言語の UI 部品 85 種（Button/Dropdown/Modal/Table/Slider/ComboBox/Color/Tooltip/Menu/Card/Switch/WaitSpinner 等） | **使える・推奨** |
| `@splunk/react-icons` | アイコン群 | 使える |
| `@splunk/themes` | テーマ変数・mixin（`SplunkThemeProvider` は viz ルートで使用済み） | 使う |
| `@splunk/visualizations` | 標準 viz 32 種（下記）＋ editor 型定義（`*.config.js`） | 参考/editor 調査用 |
| `@splunk/dashboard-core` / `-inputs` / `-presets` / `-context` | ダッシュボードの器・input・preset・状態 API | **Framework 専用**（拡張では使わない） |

- **`@splunk/react-ui` は拡張 viz 内でそのまま使える**。ツールチップ・ドロップダウン・スイッチ等は自前で
  書かず react-ui を使うとテーマ整合も取れる。UI 部品名の一覧: Accordion, Anchor, Avatar, Badge, Button,
  ButtonGroup, Calendar, Card, Checkbox, Chip, Code, CollapsiblePanel, Color, ComboBox, ControlGroup,
  Date, Divider, Drawer, Dropdown, DualListbox, File, Heading, Layer, List, Markdown, Menu, Message,
  MessageBar, Modal, Multiselect, Number, Paginator, Popover, Progress, RadioBar, RadioList, Search,
  Select, Slider, SplitButton, StepBar, Switch, TabBar, Table, Text, TextArea, Tooltip, Tree, TreeGrid,
  Typography, WaitSpinner ほか。
- **標準 viz 32 種**（`@splunk/visualizations`。作る前に「標準で足りるか」の判断材料）: Area, Bar, Bubble,
  ChoroplethSvg, Column, Events, FillerGauge, Image, Line, LinkGraph, Map, Markdown, MarkerGauge,
  NetworkGraph, ParallelCoordinates, Pie, ProcessTree, Punchcard, RichText, Sankey, Scatter, SingleValue,
  SingleValueBasic, SingleValueIcon, SingleValueRadial, SparkLine, Table, Timeline, Treemap ほか。
- `@splunk/dashboard-inputs` の標準 input: text / select / multiselect / number / button / time range。
  カスタム input UI は拡張では作れず Framework 側のみ（[dashboard-framework.md](dashboard-framework.md)）。

---

## 1. プロジェクト構成とスキャフォールド

各 viz は独立フォルダ `custom-viz-<name>/`。CLI でベースを作れる:

```bash
npx @splunk/create@latest --mode=dashboard-studio-extension
```

CLI が生成する JavaScript テンプレートはそのまま使わず、実績のある **React + useOptions
スケルトン**（既存 viz、例 `custom-viz-donut-graph`）を複製して流用する。CLI を非対話実行する
場合は inquirer が改行を取りこぼすので遅延付きで流し込む:

```bash
( for i in $(seq 1 8); do printf '\n'; sleep 2; done ) | \
  timeout 300 npx @splunk/create@latest --mode=dashboard-studio-extension
```

### スケルトン複製の手順（cp を使う）

```bash
cd <リポジトリルート>
mkdir -p custom-viz-<new>
cd custom-viz-<base>   # 例: custom-viz-donut-graph（React+useOptions版）
cp -r build-plugins build.mjs package.mjs package.json yarn.lock .gitignore README.md package \
      ../custom-viz-<new>/
mkdir -p ../custom-viz-<new>/visualizations/custom_viz_<new>/src/assets
cp visualizations/custom_viz_<base>/src/assets/*.svg ../custom-viz-<new>/visualizations/custom_viz_<new>/src/assets/
cp visualizations/custom_viz_<base>/src/visualization.css ../custom-viz-<new>/visualizations/custom_viz_<new>/src/
mv ../custom-viz-<new>/visualizations/custom_viz_<base> ../custom-viz-<new>/visualizations/custom_viz_<new>
```

### 複製後に必ず置換する識別子

- `package.json` … `"name"`, `"description"`
- `package/app/app.conf` … `[package] id`, `[id] name`, `[ui] label`, `[launcher] description`
- `visualizations/custom_viz_<new>/config.json` … `config.name`, `config.description`, `optionsSchema`, `editorConfig`
- `README.md` … タイトル・特徴・サンプルSPL
- `visualizations/custom_viz_<new>/src/visualization.jsx` … 実装本体

ディレクトリ構成（重要ファイル）:
```
custom-viz-<name>/
├── build.mjs / package.mjs / build-plugins/css-and-size.mjs   # esbuild ビルド & .spl パッケージ
├── package/app/app.conf                                        # Splunkアプリ定義（id, version, label…）
├── package/metadata/default.meta                               # _vizName_ プレースホルダのまま流用可
└── visualizations/custom_viz_<name>/
    ├── config.json         # showTitleAndDescription, dataContract, optionsSchema, editorConfig, defaultContext
    └── src/
        ├── visualization.jsx   # 実装本体
        ├── visualization.css   # 原則いじらない（.viz-container 等の共通クラス）
        └── assets/*.svg
```

### ビルド & パッケージ

```bash
yarn install
yarn build          # dist/<viz>/visualization.js を生成（esbuild, jsx automatic）
yarn package        # dist/<viz>-<ver>-<hash>.spl を生成（stage/ 経由で tar.gz）
```

- パッケージ化のたびに **バージョンを上げる**（`package.json` と `package/app/app.conf` 両方）:
  `npm version minor --no-git-tag-version` → app.conf の `version = x.y.z` を sed で同期。
- **旧版の `.spl` は残す**。`rm -f dist/*.spl` はしない（ファイル名にバージョン＋ハッシュが入るので判別可）。
- **`yarn build` は `.spl` を消さないこと**。`build.mjs` は非 watch ビルド時に `dist/` を掃除するが、
  `.spl` は温存し、`dist/` 直下のビルド成果物（`<viz>/` や `.map`）だけ削除する形にする。
  複製元が古いと `dist/` 丸ごと削除になり `.spl` を巻き添えにするので、複製後に必ず確認する:
  ```js
  if (!isWatch && existsSync(distDir)) {
      for (const entry of readdirSync(distDir)) {
          if (entry.endsWith('.spl')) continue;          // .spl は残す
          rmSync(join(distDir, entry), { recursive: true, force: true });
      }
  }
  ```

### 実機に反映されないときの切り分け

- **リバースプロキシ（Cloudflare トンネル）のキャッシュが第一容疑**。トンネル経由だと
  アップグレード＋`_bump`＋ハードリロードをしても旧 `visualization.js` が配信され続けることがある。
  反映確認はまず直接 IP アクセスで行い、トンネル側は Cloudflare のキャッシュパージで対処する。
- バンドル内の日本語は esbuild が `\uXXXX` 形式（大文字hex）にエスケープするため、**日本語文字列の
  grep では新旧バンドルを判定できない**。ASCII の識別子や `VIZ_VERSION` 文字列で判定する。viz 側に
  バージョン定数を入れて UI/debug に出しておくと実機での反映確認が一目でできる。

---

## 2. 実装の定番パターン（visualization.jsx）

### ルート構成（マウントゲート必須）

カスタム viz はサンドボックス iframe で動き、テーマ/データ等の状態は親から postMessage で
非同期に届く。公式 React フックは「`getX()` でシード → `useEffect` で購読」だが**購読登録時に
現在値を再送しない**ため、初期 state をマウント後〜購読前に取り逃すと `useTheme()` 等が
**undefined のまま永久に描画されない**ことがある。対策は「**初期 state が揃ってからマウントする**」
マウントゲート。公式構成（import/Provider/フック）はそのまま維持できる。正常時の表示遅延は最大 +50ms。

```jsx
import {
  VisualizationExtensionProvider, useDataSources, useTheme, useOptions,
} from '@splunk/dashboard-studio-extension/react';
import { SplunkThemeProvider } from '@splunk/themes';
import { createRoot } from 'react-dom/client';

function App() {
  const themeApi = useTheme();
  const colorScheme = themeApi?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画
  const mode = colorScheme === 'dark' ? 'dark' : 'light';
  return (
    <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
      <MyVisualization mode={mode} />
    </SplunkThemeProvider>
  );
}

// ホスト初期化完了（DashboardExtensionAPI 注入＋テーマ/データの初期 state 受信）を
// 待ってからマウントする。最大5秒でフォールバック描画に入る。
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
    <VisualizationExtensionProvider><App /></VisualizationExtensionProvider>
  );
}

(function mountWhenReady() {
  if (hostReady() || Date.now() - MOUNT_START >= 5000) {
    mountApp();
  } else {
    setTimeout(mountWhenReady, 50);
  }
})();
```

- ゲートが待つのは**ハンドシェイク完了**（state の容れ物）であってサーチ完了ではない。
  `getDataSources()` は接続確立時点で `{loading:true}` を返すので、スピナー→本描画の流れは従来どおり。
- テーマは `themeApi?.theme || 'light'` でフォールバックし、未取得でも必ず描画する。
  `return null` で永久に待つガードは書かない。
- 残余リスク: API 注入前にバンドルが実行されるとライブラリのモジュール評価が throw する
  （コンソールに "DashboardExtensionAPI is not available..."）。

### データ正規化（rows / columns 両形式に対応・落とさない）

```jsx
function normalizeData(data) {
  try {
    if (data.rows && data.rows.length > 0) return data.rows;
    if (data.columns && data.columns.length > 0) {
      const n = data.columns[0].length;
      return Array.from({ length: n }, (_, i) => data.columns.map((c) => c[i]));
    }
  } catch (e) { /* 想定外形式でも落とさない */ }
  return [];
}
// フィールド名: (data?.fields || []).map((f) => f?.name || f)
```

### 堅牢性チェックリスト

- `loading` 中はスピナー、`!data || rows.length===0` は「No data」メッセージ。
- 数値は `Number(String(v).replace(/,/g,'').trim())` で正規化し `Number.isFinite` ガード。
- オプションは必ず `normalizeOptions(options)` で型・範囲を安全側に補正（未設定/型不一致に耐える）。
- 幅・高さは ResizeObserver でコンテナ実寸を測って自動フィット。非対応環境では初回計測にフォールバック。

### アニメーション viz（物理シミュレーション・パーティクル等）のハイブリッド描画

60fps の位置更新を React の再レンダリングでやると持たないので、**役割を属性単位で分離**する:

- **React(JSX)**: 構造・色・太さ・不透明度など「データ/オプション変更時にだけ変わるもの」。
- **rAF ループ**: `transform` / `d` / `cx,cy` など位置系の属性を `setAttribute` で直接更新。
  要素は callback ref で `Map<id, element>` に収集。React と同じ属性を触らないのが規約。
- ループは mount 時に 1 回だけ張り、設定・シム状態はすべて ref（`optsRef.current = opts` を
  毎レンダー代入）経由で読む → stale closure を回避。
- 初期配置はノード名ハッシュをシードにした mulberry32 で決定的に。初回は数十ステップ同期で
  「ならして」から画面に出すと初期の暴れが見えない。データ更新時は旧位置を id で引き継ぎ alpha を再加熱。
- **ガード表示→本表示の切替**があるため、`useEffect([])` で `ref.current` を掴むとガード時の要素を
  掴んだままになる。ResizeObserver は callback ref で張り直し、native リスナー（wheel の
  passive:false 等）は「本表示がマウントされているか」の boolean を deps に入れて張り直す。
- **力学レイアウトの定数は固定値にしない**：反発・リンク距離は `√(面積/ノード数)` ベースで面積
  スケールし、中心重力は弱く（0.01x）。画面いっぱいの利用は「カメラ自動フィット」（ノード bbox へ
  view transform を easing 追従、手動ズーム/パンで解除・dblclick で復帰）が担う。ラベル高さを
  衝突半径に足すとラベル同士の重なりも減る。
- ソースに生の NUL 文字（`\x00`）を入れない（grep がバイナリ扱いする）。`' '` エスケープで書く。
- **rAF ループが管理する要素グループを掴む callback ref は必ず `useCallback([])` で安定化する**。
  インライン関数だと再レンダーのたびに ref を detach(null)→attach し直し、プールをリセットすると
  古い要素が DOM に孤児として残る（症状: オプション変更後も古い色/位置のパーティクルが凍結表示）。
  attach 時に `while (el.firstChild) el.removeChild(...)` で子を掃除しておくと切替にも安全。

### オートフィット（余白を残さない）

コンテナ実寸 `clientWidth/clientHeight` を測り、要素サイズを動的計算して領域いっぱいに広げる。
「編集画面でパネルを大きくすると下に大きな余白」が出たら固定サイズ設計が原因。上限だけ
オプション化（例 `maxCellSize`, `0 = 無制限`）し、既定は自動。

### ラベルの見切れ防止

ラベル余白を「面積の固定比率」で取ると長い名前が見切れる。**実ラベルの推定幅から余白を計算**する:

- 推定幅: CJK ≈ 1.0×fontSize、その他 ≈ 0.62×fontSize（`codePointAt > 0x2e7f` で判定）。
  SVG に measureText は無いがこの推定で実用十分。
- 余白 = clamp(最長ラベル推定幅 + マージン, 下限, 面積の~28%)。収まらないときは段階退避:
  **値の併記を自動オフ → 名前を … で切り詰め → ラベル自体を自動非表示（ツールチップで代替）**。
  本体（リング等）の描画を常に優先し「Panel too small」は最終手段。
- 切り詰め・表示可否は layout メモ内で確定し、描画側はその結果を使う（判定の二重化を避ける）。
- happy-dom 検証でリサイズを試すには、寸法を `let VW/VH` + configurable getter にし、
  ResizeObserver インスタンスを配列に集めて手動 flush する `resize(w,h)` ヘルパを作る。

---

## 3. editorConfig（編集画面の右パネル）と editor 型

`config.json > config.editorConfig` は「セクション > layout > 行 > editor項目」の入れ子。
各項目は `{ label, option, editor, editorProps?, context? }`。`optionsSchema` に対応する option の
`default` を必ず定義し、viz 側は `useOptions()` で受け取る。

**ラベルは日本語で書く**（セクション `label`・項目 `label` とも。config.json は UTF-8 の日本語を
そのまま書ける）。キー名（`option` / `optionsSchema`）は英語のまま。訳語の目安:
Data Fields→データフィールド、Display→表示、Show ~→「~を表示」、severity→深刻度、
count→件数、source/destination→送信元/宛先。

### 使える editor 型

- **確実に動く（実機確認済み）**: `editor.color` / `editor.checkbox` / `editor.number` /
  `editor.columnSelector`。
- **実在するがカスタム viz での可否は要実機確認**: `editor.text`, `editor.select`, `editor.radioBar`,
  `editor.slider`, `editor.dynamicColor`, `editor.threshold`, `editor.seriesColors` ほか多数。
- **調べ方**: `@splunk/visualizations`（npm）を入れて grep すると全 editor 型が出る:
  ```bash
  npm install @splunk/visualizations   # スクラッチ領域で。プロジェクトには入れない
  grep -rhoE "editor\.[a-zA-Z]+" node_modules/@splunk | sort | uniq -c | sort -rn
  # 各 editor の完全な定義は SingleValue.config.js 等の .config.js を require() して walk
  ```

### 無効な editor を混ぜたときの症状

editorConfig のあるセクションに未対応 editor を1つでも入れると、**そのセクションごと編集画面に
出なくなる**（General/Title は出るのに独自セクションだけ消える）。config.json 更新後は editor 型を
機械チェックし、`_bump` + ハードリロードで検証する。未確認の editor 型を試すときは独立セクションに
隔離するのが定石。

### フィールド選択 UI（editor.columnSelector）

標準 viz の「データ設定」（ラベル/値のフィールド選択ドロップダウン）は `editor.columnSelector`。
標準 Pie の定義形状をそのまま真似る（`@splunk/visualizations/Pie.config.js` で確認）:
```json
[{ "label": "Source field", "editor": "editor.columnSelector", "option": "sourceField",
   "context": "valuesContext", "editorProps": { "dataSourceKey": "primary" } }]
```
- 選択結果はオプションに **DOS 文字列**（`> primary | seriesByName('src')`）で書かれ、カスタム viz
  には未解決のまま届く。**`seriesByName('X')` / `seriesByIndex(N)` を正規表現でパース**して列を自前解決する。
- 生フィールド名・ホスト解決済み配列（列内容の照合で特定）・未設定（既定列にフォールバック）も受けると
  全ケースで壊れない。optionsSchema は `{ "type": "string", "default": "" }`。
- 参照実装: chord-flow の `resolveFieldIndex()`。

### 編集モード中は viz 内のマウス操作 UI が効かない（iframe への入力遮断）

Studio 編集モードのイベント設計:
- パネル移動はホバー時に上部中央へ出るピル型ドラッグハンドルから（`useDragHandleComponent`,
  `EVENT_MOUSE_DOWN_ON_HANDLE` でのみ `isMovingRef=true`）。
- **viz 本体への mousedown はパネル選択に消費**される（`SelectableContainer.onMouseDown` →
  `EVENT_MOUSE_DOWN_ON_VIZ_WITH_HANDLE`）。これを iframe 拡張 viz でも成立させるため、編集モード中は
  ホストが拡張 iframe への入力を遮断する。
- → **編集モード中に viz 内へ描いたクリック/ドラッグ UI（アイコンピッカー・編集ハンドル等）は実機では
  動かない**。
- 対策:「**表示モードで操作 → 変更を viz 内 pending に保持 → mode が edit に変わった瞬間に setOptions を
  再送(flush) → ユーザーが保存**」。モード変化イベントは iframe に届き続ける（iframe は view↔edit で
  生存する）ため flush が成立する。echo（opts が pending と一致）で消し込み、再送は未反映分のみ1回。
  表示モード中の見た目はローカル draft でライブプレビューする（**表示モードの setOptions はホスト定義に
  載らない**ため）。参照実装: link-line の `pendingRef` / flush effect。確実な保険は右パネル
  （editor.number 等）完結の操作。

---

## 4. 値→色マッピング（editor.dynamicColor はカスタム viz で使えない）

### 結論

標準 viz の「動的色設定：範囲を+で追加」パネルは `editor.dynamicColor` だが、**カスタム viz 拡張では
使えない**。editorConfig に書くと編集 UI は右パネルに出るが、**編集した範囲/一致の配列は options に
渡らない**。viz が `useOptions()` で受け取るのは DOS 文字列だけ:
```
"cellColor": "> heatValue | rangeValue(cellColorEditorConfig)"   ← 配列ではなくこの文字列が来る
```
範囲配列は `context`（`<option名>EditorConfig`）に保存され、ホストの DOS 評価器だけが参照する。
拡張 iframe ランタイムは DOS を評価しないため、解決済みの色値も範囲配列も viz には届かない。

さらに標準の `rangeValue`/`matchValue` は「**1スカラー→1色**」で、行ごとに値が違うデータ駆動 viz
（カレンダー等）には原理的に不適合。

### 正しい実装：値ベースのカラースケール

値→色は **options に確実に届く editor.color / editor.number / editor.checkbox** で自前実装する:

- optionsSchema: `useValueColors`(checkbox), `lowColor`/`highColor`/`midColor`(color),
  `useMidColor`/`reverse`(checkbox), `scaleMin`/`scaleMax`(number, 空欄=データ min/max 自動)。
- ロジック: 値を `[scaleLo, scaleHi]` で 0..1 に正規化 → `lerpColor` で `low →(mid)→ high` を補間。
  `reverse` で低↔高を反転。全同値なら中央色。
- 凡例は連続グラデーションバー＋min/max ラベル。色を変えると即反映（options 直結）。

```js
function lerpColor(hexA, hexB, t){ /* rgb を線形補間して 'rgb(r,g,b)' */ }
function scaleColorFor(t, opts){
  let u = clamp01(t); if (opts.reverse) u = 1 - u;
  if (opts.useMidColor) return u<=0.5 ? lerpColor(opts.lowColor,opts.midColor,u/0.5)
                                      : lerpColor(opts.midColor,opts.highColor,(u-0.5)/0.5);
  return lerpColor(opts.lowColor, opts.highColor, u);
}
// cellFill: t = (value - scaleLo)/(scaleHi - scaleLo)
```
参照実装: `custom-viz-calendar-heatmap/.../visualization.jsx` の
`normalizeOptions` / `lerpColor` / `scaleColorFor` / `cellFill`。

### 「動的に範囲を+追加」したい場合の代替

- 固定 N 組の `editor.number(from) + editor.color` バンド（動的追加は不可だが確実に反映）。
- SPL 側で行に `color` フィールドを持たせる。
- **viz 内に「動的色設定」風パネルを自前実装**（参照実装: `custom-viz-link-line/.../visualization.jsx`
  の `parseColorBands`/色設定パネル）。範囲リスト（＋追加/×削除/プリセット/⇅反転）を
  `<input type="color">`+`<input type="number">` で組み、JSON 文字列オプション（例 `colorBands`）へ
  `setOptions` 保存。**編集モードは iframe への入力遮断があるため、パネルは表示モードに置く**。

---

## 5. ローカル検証（happy-dom で実機なしにバンドルを叩く）

ビルド済み `dist/<viz>/visualization.js` を Node + happy-dom で実行し、描画・オプション反映・ガードを
検証する。回帰の早期発見に有効。

### 仕組み

- happy-dom で DOM を用意し、`globalThis.DashboardExtensionAPI` をモックしてバンドルを `eval`。
- SVG/DOM 属性を検査。リスナーを発火してオプション/データ/テーマ変更をシミュレート。
- フックは `VisualizationExtensionProvider` 無しでも動く（standalone listener 実装）。

### モックの形

```js
globalThis.DashboardExtensionAPI = {
  getDataSources: () => ({ loading:false, dataSources:{ primary:{ data:{ fields, rows } } } }),
  addDataSourcesListener: mkListener('dataSources'),
  getOptions: () => ({ options: {...} }),   // options はネスト（フラットではない）
  setOptions, addOptionsListener: mkListener('options'),
  getTheme: () => ({ theme: 'dark' }), addThemeListener: mkListener('theme'),
  getDimensions: () => ({ width, height }), addDimensionsListener: mkListener('dimensions'),
  getMode: () => ({ mode:'view' }), addModeListener: mkListener('mode'),
  /* tokens / drilldown / error も同様に */
};
```

### ハマりどころ

- **オートフィット系**は `HTMLElement.prototype.clientWidth/clientHeight` を `Object.defineProperty` で固定。
- **ResizeObserver**: 削除して初回計測フォールバックに落とすか、observe 時に callback を呼ぶ簡易モックを
  入れる（サイズ変更の再計測を試すなら後者＋手動 flush）。
- `requestAnimationFrame` は `setTimeout(cb, 0)` で代替。`await sleep(150〜320)` で描画/再レンダリングを待つ。
- **色の比較**: rect の fill は `#RRGGBB` 生値で入ることが多い（`rgb(...)` 変換せずに hex で比較）。
- happy-dom では `editor.dynamicColor` 等の**編集画面 UI 自体は再現できない**。検証できるのは
  「options に値が渡ったときに viz が正しく適用するか」まで。エディタが実機で出るかは実機確認。
- `globalThis.navigator` は直接代入不可。`Object.defineProperty` で configurable 設定する。

雛形は `custom-viz-sankey-flow/test/verify.mjs`（`yarn verify` で実行、happy-dom は devDependency）を
流用する。モック一式・リスナー発火・オプション/データ/テーマ変更・ガード検証のパターンを網羅している。

### 「オプションは出るのに反映されない」症状の切り分け

config.json は新しいが `visualization.js` が古い（JS キャッシュ or 古い `.spl` をインストール）可能性大。
config.json と JS バンドルは別経路で配信される。§6 の `_bump` + ハードリロードと、正しい `.spl` の確認。

---

## 6. デプロイ（アンインストール・再起動なし）

1. `npm version <patch|minor> --no-git-tag-version` でバージョンを上げ、`app.conf` の version も同期。
   `yarn build && yarn package` で新 `.spl` 生成。
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード。
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）。
4. ブラウザをハードリロード（Ctrl+Shift+R）。

反映されない場合は §1「実機に反映されないとき」（リバースプロキシのキャッシュ）を参照。

---

## 7. GitHub（ユーザーが手動 push）

- モノレポ `Aria-1429/custom-viz`（private / `main`）。Claude は commit / push しない。
- push 前リークチェック: `git status --short | grep -E 'node_modules|dist/|stage/'`
  （`.spl` はコミット対象。それ以外のビルド成果物は `.gitignore` で除外）。
- `.gitignore` は「`dist/*` は無視、`!dist/*.spl` で `.spl` だけ救済」。ルート＋各 viz の両方に必要。
  新しい viz を追加したらこの 2 行が入っているか確認する。
- README は日本語（特徴・データ仕様・開発コマンド・デプロイ手順・サンプルSPL・リリースノート）。

---

## 8. データモデルの型

第1列をカテゴリ/軸/日付、第2列以降を数値とするのが基本。代表例:
- bar / donut … 第1列=カテゴリ, 第2列=数値
- radar … 第1列=軸(メトリック), 第2列以降=系列（列ごとにポリゴン）
- calendar-heatmap … 第1列=日付(_time/ISO/epoch 秒・ミリ秒), 第2列=数値（同日は合算）

サンプル SPL は必ず `makeresults` ベースで提示し、動作確認できるようにする。

### サンプル SPL の書き方

`eval _raw="..." | makemv | mvexpand | rex` のチェーンは実機で mvexpand が不発になり
「全行が1行に潰れて各セルがマルチバリュー」になることがある。確実な形式を使う:
- **Splunk 9.0+**: `| makeresults format=csv data="col1,col2,...\n..."`（最も確実・読みやすい）。
- **旧環境**: `| makeresults | eval raw=split("a,b,10|c,d,20","|") | mvexpand raw
  | eval x=mvindex(split(raw,","),0), ...`（makemv/rex に依存しない）。

### マルチバリューセルの救済（viz 側の防御）

mv フィールドが1行のセルに**配列**（環境により改行区切り文字列）で届くことがある。放置すると
`String(配列)`="A,B,..." がエンティティ名になり、数値は parseNum のカンマ除去で**桁連結**した
巨大値になる。防御パターン:
- 全カラムのトークン数（配列長 or 改行分割数）が一致する行だけ平行展開して復元。
- 不一致の行は null 行に置換して確実に落とす。
- 1e15 以上の値は `toExponential` で表示（カンマ 30 桁でヘッダーが崩壊する）。
