# Splunk カスタムビジュアライゼーション 実装ナレッジ

このファイルは `/splunk-viz` スキルの実装知見をまとめたもの。SKILL.md 本体から参照される。
新しく viz を作る／既存を改修する前に、関連する章に目を通すこと。

> 前提リポジトリ: `/home/ishitsuki/custom-viz/` 配下。1 viz = 1 private GitHub repo（Aria-1429、gh認証済み）。
> 既存 viz: donut-graph, donut-timechart, gradient-bar, country-graph, world-map, severity-table,
> radar-chart, calendar-heatmap, sankey-flow, network-graph, chord-flow。push はユーザーが手動（スキル方針でClaudeはpushしない）。

---

## 1. プロジェクト構成とスキャフォールド

各 viz は独立フォルダ `custom-viz-<name>/`。CLI でベースを作る指示がある:

```bash
npx @splunk/create@latest --mode=dashboard-studio-extension
```

ただし **CLI が生成する JavaScript テンプレートはそのまま使わない**。実績のある
**React + useOptions スケルトン**（既存 viz、例 `custom-viz-donut-graph`）を複製して流用するのが
確実で速い。CLI は対話式なので、非対話実行するなら遅延付きで改行を流し込む:

```bash
( for i in $(seq 1 8); do printf '\n'; sleep 2; done ) | \
  timeout 300 npx @splunk/create@latest --mode=dashboard-studio-extension
```
（inquirer が改行を取りこぼすので `sleep` 必須。CLI 実行後、実スケルトンに差し替える）

### スケルトン複製の手順（rsync は無い環境なので cp）

```bash
cd /home/ishitsuki/custom-viz
mkdir -p custom-viz-<new>
cd custom-viz-<base>   # 例: custom-viz-donut-graph（React+useOptions版）
cp -r build-plugins build.mjs package.mjs package.json yarn.lock .gitignore README.md package \
      ../custom-viz-<new>/
mkdir -p ../custom-viz-<new>/visualizations/custom_viz_<new>/src/assets
cp visualizations/custom_viz_<base>/src/assets/*.svg ../custom-viz-<new>/visualizations/custom_viz_<new>/src/assets/
cp visualizations/custom_viz_<base>/src/visualization.css ../custom-viz-<new>/visualizations/custom_viz_<new>/src/
mv ../custom-viz-<new>/visualizations/custom_viz_<base> ../custom-viz-<new>/visualizations/custom_viz_<new>
```

### 置換が必要な識別子（複製後に必ず全部直す）

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
- **旧版の `.spl` は残す方針**（リリース運用参照）。`rm -f dist/*.spl` は**しない**
  （取り違えは新版のみをアップロードすれば足りる。ファイル名にバージョン＋ハッシュが入るので判別可）。

#### ⚠️ `yarn build` は `.spl` を巻き添え削除しない（2026-07-20 修正済み・要確認）

`build.mjs` は非 watch ビルド時に `dist/` を掃除するが、**当初は `rmSync(distDir, {recursive:true})`
で dist/ を丸ごと消していた**ため、`yarn build` を回すたびに残す方針の `.spl` まで消えていた
（radial-bar で 1.0.1 の .spl を消失→復元する事故が発生）。**全 18 viz の build.mjs を修正済み**で、
今は「`.spl` は温存し、`dist/` 直下のビルド成果物(`<viz>/` や `.map`)だけ削除」する:

```js
if (!isWatch && existsSync(distDir)) {
    for (const entry of readdirSync(distDir)) {
        if (entry.endsWith('.spl')) continue;          // .spl は残す
        rmSync(join(distDir, entry), { recursive: true, force: true });
    }
}
```

新しい viz をスケルトン複製で作ったら、`build.mjs` がこの形になっているか（＝旧い丸ごと削除の
ままでないか）を必ず確認する。複製元が古いと事故が再発する。

---

## 2. 実装の定番パターン（visualization.jsx）

### ルート構成（テーマガード必須）

```jsx
import {
  VisualizationExtensionProvider, useDataSources, useTheme, useOptions,
} from '@splunk/dashboard-studio-extension/react';
import { SplunkThemeProvider } from '@splunk/themes';
import { createRoot } from 'react-dom/client';

function App() {
  const themeApi = useTheme();
  const colorScheme = themeApi?.theme;
  if (!colorScheme) return null;            // テーマ未取得の間はレンダリングしない（表示崩れ防止の要）
  const mode = colorScheme === 'dark' ? 'dark' : 'light';
  return (
    <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
      <MyVisualization mode={mode} />
    </SplunkThemeProvider>
  );
}
const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(
  <VisualizationExtensionProvider><App /></VisualizationExtensionProvider>
);
```

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

### 堅牢性チェックリスト（表示されない事故を防ぐ）

- `loading` 中はスピナー、`!data || rows.length===0` は「No data」メッセージ。
- 数値は `Number(String(v).replace(/,/g,'').trim())` で正規化し `Number.isFinite` ガード。
- オプションは必ず `normalizeOptions(options)` で型・範囲を安全側に補正（未設定/型不一致に耐える）。
- 幅・高さは ResizeObserver でコンテナ実寸を測って自動フィット（固定サイズだと余白が出る）。
  ResizeObserver 非対応環境では初回計測にフォールバック。

### アニメーション viz（物理シミュレーション・パーティクル等）のハイブリッド描画

custom-viz-network-graph で確立したパターン。60fps の位置更新を React の再レンダリングで
やると持たないので、**役割を属性単位で分離**する:

- **React(JSX)**: 構造・色・太さ・不透明度など「データ/オプション変更時にだけ変わるもの」
- **rAF ループ**: `transform` / `d` / `cx,cy` など位置系の属性を `setAttribute` で直接更新。
  要素は callback ref で `Map<id, element>` に収集。React と同じ属性を触らないのが規約
- ループは mount 時に 1 回だけ張り、設定・シム状態はすべて ref（`optsRef.current = opts` を
  毎レンダー代入）経由で読む → stale closure を回避
- 初期配置はノード名ハッシュをシードにした mulberry32 で決定的に。初回は数十ステップ
  同期で「ならして」から画面に出すと初期の暴れが見えない。データ更新時は旧位置を id で
  引き継ぎ alpha を再加熱
- **ガード表示→本表示の切替**があるため、`useEffect([])` で `ref.current` を掴むと
  ガード時の要素を掴んだままになる。ResizeObserver は callback ref で張り直し、
  native リスナー（wheel の passive:false 等）は「本表示がマウントされているか」の
  boolean を deps に入れて張り直す
- **力学レイアウトの定数は固定値にしない**：反発・リンク距離は `√(面積/ノード数)` ベースで
  面積スケールし、中心重力は弱く（0.01x）。画面いっぱいの利用は「カメラ自動フィット」
  （ノード bbox へ view transform を easing 追従、手動ズーム/パンで解除・dblclick で復帰）が担う。
  ラベル高さを衝突半径に足すとラベル同士の重なりも減る（network-graph v0.2 で確立）
- ソースに生の NUL 文字（`\x00`）を入れない（grep がバイナリ扱いする）。`'\u0000'` エスケープで書く
- **rAF ループが管理する要素グループを掴む callback ref は必ず `useCallback([])` で安定化する**。
  インライン関数だと再レンダーのたびに React が ref を detach(null)→attach し直し、そのたびに
  プールをリセットすると「古い要素が DOM に孤児として固まったまま残る」（chord-flow で実測。
  症状: オプション変更後も古い色/位置のパーティクルが凍結表示）。attach 時に `while
  (el.firstChild) el.removeChild(...)` で子を掃除しておくとガード表示⇔本表示の切替にも安全

### オートフィット（余白を残さない）実装の要点

コンテナ実寸 `clientWidth/clientHeight` を測り、要素サイズを動的計算して領域いっぱいに広げる。
「編集画面でパネルを大きくすると下に大きな余白」が出たら、固定サイズ設計が原因。
上限だけオプション化（例 `maxCellSize`, `0 = 無制限`）し、既定は自動。

### ラベルの見切れ防止（chord-flow v0.3 で確立）

ラベル余白を「面積の固定比率」で取ると長い名前が見切れる。**実ラベルの推定幅から余白を計算**する:
- 推定幅: CJK ≈ 1.0×fontSize、その他 ≈ 0.62×fontSize（`codePointAt > 0x2e7f` で判定）。
  SVG に measureText は無いがこの推定で実用十分
- 余白 = clamp(最長ラベル推定幅 + マージン, 下限, 面積の~28%)。収まらないときは段階退避:
  **値の併記を自動オフ → 名前を … で切り詰め → ラベル自体を自動非表示（ツールチップで代替）**。
  本体（リング等）の描画を常に優先し「Panel too small」は最終手段
- 切り詰め・表示可否は layout メモ内で確定し、描画側はその結果を使う（判定の二重化を避ける）
- happy-dom 検証でリサイズを試すには、寸法を `let VW/VH` + configurable getter にし、
  ResizeObserver インスタンスを配列に集めて手動 flush する `resize(w,h)` ヘルパを作る

---

## 3. editorConfig（編集画面の右パネル）と editor 型

`config.json > config.editorConfig` は「セクション > layout > 行 > editor項目」の入れ子。
各項目は `{ label, option, editor, editorProps? , context? }`。`optionsSchema` に対応する
option の `default` を必ず定義し、viz 側は `useOptions()` で受け取る。

**ラベルは日本語で書く**（ユーザー方針。セクション `label`・項目 `label` とも。config.json は
UTF-8 の日本語をそのまま書いて問題ない）。キー名（`option` / `optionsSchema`）は英語のまま。
訳語の目安: Data Fields→データフィールド、Display→表示、Show ~→「~を表示」、
severity→深刻度、count→件数、source/destination→送信元/宛先。world-map v0.2.1 で採用。

### 使える editor 型

- **確実に動く（実機確認済み）**: `editor.color` / `editor.checkbox` / `editor.number`（公式ベスト
  プラクティス記載）+ `editor.columnSelector`（2026-07-19 chord-flow v0.4 で実機確認。§フィールド選択 UI 参照）
- **実在するがカスタムvizでの可否は要実機確認**: `editor.text`, `editor.select`, `editor.radioBar`,
  `editor.slider`, `editor.dynamicColor`, `editor.threshold`, `editor.seriesColors` ほか多数。
- **確認方法**: `@splunk/visualizations`（npm）を入れて grep すると全 editor 型が出る:
  ```bash
  npm install @splunk/visualizations   # スクラッチ領域で。プロジェクトには入れない
  grep -rhoE "editor\.[a-zA-Z]+" node_modules/@splunk | sort | uniq -c | sort -rn
  # 各 editor の完全な定義は SingleValue.config.js 等の .config.js を require() して walk
  ```

### 無効な editor を混ぜたときの症状（重要）

editorConfig のあるセクションに未対応 editor を1つでも入れると、**そのセクションごと編集画面に
出なくなる**（General/Title は出るのに独自セクションだけ消える）。原因特定が難しいので、
config.json 更新後は editor 型を機械チェックし、`_bump` + ハードリロードで必ず検証する。

### フィールド選択 UI（editor.columnSelector）★chord-flow v0.4 で採用・実機動作確認済み

標準 viz の「データ設定」（ラベル/値のフィールド選択ドロップダウン）は `editor.columnSelector`。
標準 Pie の定義形状をそのまま真似る（`@splunk/visualizations/Pie.config.js` で確認）:
```json
[{ "label": "Source field", "editor": "editor.columnSelector", "option": "sourceField",
   "context": "valuesContext", "editorProps": { "dataSourceKey": "primary" } }]
```
- 選択結果はオプションに **DOS 文字列**（`> primary | seriesByName('src')`）で書かれる。
  カスタム viz には未解決のまま届く（dynamicColor と同じ挙動）ので、
  **`seriesByName('X')` / `seriesByIndex(N)` を正規表現でパース**して列を自前解決する
- 生フィールド名・ホスト解決済み配列（列内容の照合で特定）・未設定（既定列にフォールバック）
  も受けると全ケースで壊れない。optionsSchema は `{ "type": "string", "default": "" }`
- 参照実装: chord-flow の `resolveFieldIndex()`。**実機で編集 UI の表示・反映とも動作確認済み**
  （2026-07-19）。未確認の editor 型を試すときは独立セクションに隔離するのが定石
  （無効 editor はセクションごと消えるため）

### 文字列入力・列挙が欲しいとき（3種で代替する場合）

- 文字列ラベル等 → editorConfig に載せず `optionsSchema` の `default` で固定値扱い、または boolean 化。
- 列挙 → checkbox 複数 or 固定値。
- 「値→色」のマッピングは §4 参照。**`editor.dynamicColor` はカスタムvizでは使えない**（配列が
  options に来ない）。値ベースのカラースケール（low→mid→high 補間）を自前で実装する。

---

## 4. 値→色マッピング ★重要：editor.dynamicColor はカスタムvizで使えない

### 結論（実機＋公式で確定）

標準viz の「動的色設定：範囲を+で追加」パネルは `editor.dynamicColor` だが、**カスタムviz拡張では使えない**。
editorConfig に書くと編集UIは右パネルに出るが、**編集した範囲/一致の配列は options に渡らない**。
viz が `useOptions()` で受け取るのは DOS 文字列だけ:
```
"cellColor": "> heatValue | rangeValue(cellColorEditorConfig)"   ← 配列ではなくこの文字列が来る
```
範囲配列は `context`（`<option名>EditorConfig`）に保存され、**ホストのDOS評価器だけが参照**する。
公式ドキュメント（dynamic options syntax）も「viz が受け取るのは解決済みの色値。EditorConfig配列は
DOSを評価するホストのみが参照」と明記。

**罠**: viz 内の既定配列と config の defaultContext がたまたま同色だと、初期表示は正しく見える。だが編集しても
options に配列が来ないので反映されず、ずっとフォールバックを表示する（=「初期OK・編集反映されない・凡例も
変わらない」症状）。→ **debug で options をダンプして必ず確認**（§5参照。2026-07-19 に実測して確定）。

さらに標準の `rangeValue`/`matchValue` は「**1スカラー→1色**」で、行ごとに値が違うデータ駆動viz
（カレンダー等）には原理的に不適合（`majorValue` は `> sparklineValues|lastPoint()` 等で単一値を作る前提）。

### 正しい実装：値ベースのカラースケール（推奨）

「安全＝緑・危険＝赤」のような値→色は、**options に確実に届く editor.color / editor.number /
editor.checkbox** で自前実装する。custom-viz-calendar-heatmap v0.6 の採用パターン:

- optionsSchema: `useValueColors`(checkbox), `lowColor`/`highColor`/`midColor`(color),
  `useMidColor`/`reverse`(checkbox), `scaleMin`/`scaleMax`(number, 空欄=データmin/max自動)。
- ロジック: 値を `[scaleLo, scaleHi]` で 0..1 に正規化 → `lerpColor` で `low →(mid)→ high` を補間。
  `reverse` で低↔高を反転（「高い値＝赤」を直感設定）。全同値なら中央色。
- 凡例は連続グラデーションバー＋min/maxラベル。色を変えると即反映（options直結）。

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
`normalizeOptions` / `lerpColor` / `scaleColorFor` / `cellFill`（scaleLo/Hi はデータ min/max から解決）。

### 「動的に範囲を+追加」したい場合の代替

- 固定N組の `editor.number(from) + editor.color` バンド（動的追加は不可だが確実に反映）。
- SPL 側で行に `color` フィールドを持たせる（world-map で実装）。
- 編集モード（`useMode` が `edit`）中に viz 内へ自前の「+追加/×削除」UIを描き、`setOptions` で
  JSON文字列として保存（標準UIではなく自前UIになるが、動的追加＋確実な反映が両立）。

---

## 5. ローカル検証（Splunk 実機なしでバンドルを叩く）★happy-dom

実機に上げる前に、ビルド済み `dist/<viz>/visualization.js` を Node + happy-dom で実行し、
描画・オプション反映・ガードを検証できる。**回帰の早期発見に必須**。

### 仕組み

- happy-dom で DOM を用意し、`globalThis.DashboardExtensionAPI` をモックしてバンドルを `eval`。
- SVG/DOM 属性を検査。リスナーを発火してオプション/データ/テーマ変更をシミュレート。
- フックは `VisualizationExtensionProvider` 無しでも動く（standalone listener 実装）。

### モックの形（型定義どおり）

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
- **ResizeObserver**: 削除して初回計測フォールバックに落とすか、observe時にcallbackを呼ぶ簡易モックを入れる
  （サイズ変更の再計測を試すなら後者＋手動 flush）。
- `requestAnimationFrame` は `setTimeout(cb, 0)` で代替。`await sleep(150〜320)` で描画/再レンダリングを待つ。
- **色の比較**: rect の fill は `#RRGGBB` 生値で入ることが多い（`rgb(...)` 変換せずに hex で比較）。
- **注意**: happy-dom では `editor.dynamicColor` 等の**編集画面UI自体は再現できない**。検証できるのは
  「options に配列が渡ったときに viz が正しく各セルへ適用するか」まで。エディタが実機で出るかは実機確認。

雛形は **`custom-viz-sankey-flow/test/verify.mjs`（`yarn verify` で実行、happy-dom は devDependency）**
を流用するのが速い。リポジトリ内に永続化してあるので scratchpad 消失の影響を受けない。
モック一式・リスナー発火・オプション/データ/テーマ変更・ガード検証のパターンを網羅している。
（注意: `globalThis.navigator` は直接代入不可。`Object.defineProperty` で configurable 設定する）

### 「オプションは出るのに反映されない」症状の切り分け

config.json は新しいが `visualization.js` が古い（JSキャッシュ or 古い `.spl` をインストール）可能性大。
config.json と JS バンドルは別経路で配信される。§6 の `_bump` + ハードリロードと、正しい `.spl` の確認。

---

## 6. デプロイ（アンインストール・再起動なし）

1. `npm version <patch|minor> --no-git-tag-version` でバージョンを上げ、`app.conf` の version も同期。
   `yarn build && yarn package` で新 `.spl` 生成。
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード。
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）。
4. ブラウザをハードリロード（Ctrl+Shift+R）。

---

## 7. GitHub（ユーザーが手動 push。Claude は基本 push しない）

方針: 1 viz = 1 private repo、アカウント **Aria-1429**（gh 認証済み）。
- git identity: name=`Aria-1429`, email=`Aria-1429@users.noreply.github.com`（公開メール回避）
- push 前リークチェック: `git status --short | grep -E 'node_modules|dist/|stage/|\.spl'`（.gitignore で除外済み）
- repo 作成: `gh repo create Aria-1429/<name> --private --source . --remote origin --push`
- ブランチは main。README は日本語（特徴・データ仕様・開発コマンド・デプロイ手順・サンプルSPL）。

---

## 8. データモデルの型（viz 設計時の目安）

第1列をカテゴリ/軸/日付、第2列以降を数値とするのが基本。代表例:
- bar / donut … 第1列=カテゴリ, 第2列=数値
- radar … 第1列=軸(メトリック), 第2列以降=系列（列ごとにポリゴン）
- calendar-heatmap … 第1列=日付(_time/ISO/epoch秒・ミリ秒), 第2列=数値（同日は合算）

サンプル SPL は必ず `makeresults` ベースで提示し、動作確認できるようにする。

### サンプル SPL の書き方（makemv/rex チェーンは事故る）

`eval _raw="..." | makemv | mvexpand | rex` のチェーンは実機で mvexpand が不発になり
「全行が1行に潰れて各セルがマルチバリュー」になる事故が起きた（chord-flow で実測）。
確実な形式を使う:
- **Splunk 9.0+**: `| makeresults format=csv data="col1,col2,...\n..."`（最も確実・読みやすい）
- **旧環境**: `| makeresults | eval raw=split("a,b,10|c,d,20","|") | mvexpand raw
  | eval x=mvindex(split(raw,","),0), ...`（makemv/rex に依存しない）

### マルチバリューセルの救済（viz 側の防御）

mv フィールドが1行のセルに**配列**（環境により改行区切り文字列）で届くことがある。
放置すると `String(配列)`="A,B,..." がエンティティ名になり、数値は parseNum のカンマ除去で
**桁連結**（"5200","3100",… → 5.2e30）した怪物になる。防御パターン（chord-flow v0.2）:
- 全カラムのトークン数（配列長 or 改行分割数）が一致する行だけ平行展開して復元
- 不一致の行は null 行に置換して確実に落とす（`String(['A','B'])` が有効リンクに化けるのを防ぐ）
- 1e15 以上の値は `toExponential` で表示（カンマ30桁でヘッダーが崩壊する）
