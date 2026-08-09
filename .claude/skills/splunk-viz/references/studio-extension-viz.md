# Dashboard Studio 拡張 viz 実装ナレッジ

`/splunk-viz` スキルで作る **Dashboard Studio カスタムビジュアライゼーション拡張**の実装知見。
SKILL.md 本体から参照される。新規作成・改修の前に関連章を読むこと。

- リポジトリ：モノレポ `Aria-1429/custom-viz`（**public** / `main`。2026-07-30 に公開へ変更）。各 viz は `visualizations/<name>/`。
  （2026-07-25 に直下の `custom-viz-*/` から移設。フォルダ名からは `custom-viz-` プレフィックスを外し、
  　Splunk のアプリ ID は従来どおり `custom_viz_<name>`。）
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

各 viz は独立フォルダ `visualizations/<name>/`。CLI でベースを作れる:

```bash
npx @splunk/create@latest --mode=dashboard-studio-extension
```

CLI が生成する JavaScript テンプレートはそのまま使わず、実績のある **React + useOptions
スケルトン**（既存 viz、例 `visualizations/donut-graph`）を複製して流用する。CLI を非対話実行する
場合は inquirer が改行を取りこぼすので遅延付きで流し込む:

```bash
( for i in $(seq 1 8); do printf '\n'; sleep 2; done ) | \
  timeout 300 npx @splunk/create@latest --mode=dashboard-studio-extension
```

### スケルトン複製の手順（cp を使う）

```bash
cd <リポジトリルート>/visualizations
mkdir -p <new>
cd <base>   # 例: donut-graph（React+useOptions版）
cp -r build-plugins build.mjs package.mjs package.json yarn.lock .gitignore README.md package \
      ../<new>/
mkdir -p ../<new>/visualizations/custom_viz_<new>/src/assets
cp visualizations/custom_viz_<base>/src/assets/*.svg ../<new>/visualizations/custom_viz_<new>/src/assets/
cp visualizations/custom_viz_<base>/src/visualization.css ../<new>/visualizations/custom_viz_<new>/src/
mv ../<new>/visualizations/custom_viz_<base> ../<new>/visualizations/custom_viz_<new>
```

### 複製後に必ず置換する識別子

- `package.json` … `"name"`, `"description"`
- `package/app/app.conf` … `[package] id`, `[id] name`, `[ui] label`, `[launcher] description`
- `visualizations/custom_viz_<new>/config.json` … `config.name`, `config.description`, `optionsSchema`, `editorConfig`
- `README.md` … タイトル・特徴・サンプルSPL
- `visualizations/custom_viz_<new>/src/visualization.jsx` … 実装本体

ディレクトリ構成（重要ファイル）:
```
visualizations/<name>/
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
yarn build          # 開発ビルド（非minify・sourcemap付き）。検証・デバッグ用
yarn build:prod     # 本番ビルド（minify・sourcemap無し）。.spl を作る前は必ずこちら
yarn package        # dist/<viz>-<ver>-<hash>.spl を生成（stage/ 経由で tar.gz）
```

- **⚠ `.spl` を作るときは必ず `yarn build:prod && yarn package`**（2026-07-30 に発覚した実害）。
  `yarn package` は dist/ を無検査でそのまま固めるため、直前が `yarn build`（開発ビルド）だと
  **非 minify JS＋巨大な `.map` が `.spl` に混入**する。world-map v1.7.0 で実際に発生し、
  本来 729KB の `.spl` が 1.9MB（内容 9.5MB 相当）になっていた。しかも当時この節の手順自体が
  `yarn build` を案内していたため**全 28 viz の `.spl` が開発ビルド混入**だった
  （world-map は v1.8.0 で修正済み。他 viz は次回リリース時に本番ビルドで再パッケージする）。
  - 混入チェック: `tar -tzf dist/<最新>.spl | grep '\.map$'` が**空**であること。
  - `yarn verify` は dist/ のバンドルを叩くため、**package 後にもう一度 verify を回して
    「本番ビルドで全件成功」まで確認**する（開発ビルドで verify → prod で梱包、だと
    検証したものと配布物が一致しない）。
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

### マウント後にも取りこぼしの隙間がある（スピナー永久表示の原因。2026-08-09）

マウントゲートは「**マウント前**に届いた初期 state」の取り逃しを防ぐが、
**マウント後にも別の取りこぼし窓がある**。公式フックの実装（v1.x の
`createVisualizationListenerHook`。パッケージのソースで確認済み）:

```js
const [state, setState] = useState(() => transformer(getInitialState())); // ①render時にシード
useEffect(() => listenerFunction((d) => setState(transformer(d))), ...);  // ②commit後に購読
```

①と②の間（初回表示時はメインスレッドが混み、数十ms〜に広がりうる）に届いた更新は
**永久に失われる**（ホストは購読登録時に現在値を再送しない）。失われたのが
「サーチ完了（loading:false）」の最終通知だと、以後更新は来ないため
**`loading:true` のまま固まりスピナーが回り続ける**。

- 症状：不定期に発生・ダッシュボード初回表示で起きやすい・ブラウザ更新であっさり直る
  （2回目はジョブキャッシュから即返り、マウント前に届いて①のシードで拾えるため）。
- **対策（kpi-tile v1.5.1 で導入）**：公式フックが loading の間だけ
  `getDataSources()` を 500ms 間隔で読み直し、ホスト側が完了済みならその値を採用する。
  完了後はポーリングしないのでコストは実質ゼロ。

```jsx
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
                if (cur && !cur.loading) { setRescue(cur); return; }
            } catch (e) { /* noop */ }
            timer = setTimeout(tick, 500);
        };
        timer = setTimeout(tick, 500);
        return () => clearTimeout(timer);
    }, [officialLoading]);
    return officialLoading && rescue ? rescue : official;
}
// 使う側: const { dataSources, loading } = useDataSourcesWithRescue() || {};
```

- 回帰テストの書き方（kpi-tile `test/verify.mjs` §15）：モックで `loading:true` を配信して
  スピナー状態にし、**リスナーへは配信せず** `getDataSources` だけ完了済みに差し替え、
  ポーリング1周後に描画が復帰することを確認する。
- ⚠ フック実装の隙間と「症状との整合」はソース・回帰テストで確認済みだが、
  **実機の永久スピナーがこれ「だけ」で全て説明できるかは未確定**（不定期事象のため）。
  導入後も再発しないか観察する。theme / options / mode にも理論上同じ窓があるが、
  これらは次の更新で自己回復するため実害が小さく、対策は dataSources のみに入れている。
- **全 viz へ横展開済み**（2026-08-09）。`useDataSources()` を呼ぶ **29 viz 全部**に
  同じフックを入れ、本番ビルド・verify・実機インストールまで完了している。
  対象外は3つだけ:
  - `tab-selector` … データソースを読まない（サーチ不要 viz）
  - `weather-panel` … `src/` が空（未着手）
  - `editor-probe` … git 管理外の検証台。`esbuild` 未インストールで**元からビルド不可**
    （この横展開とは無関係の既存状態。誤って変更しかけたので元に戻してある）
- **新規 viz を作るときは最初からこのフックを入れる**（スケルトン複製元にも入っている）。

#### 横展開時にやらかしかけたこと（2026-08-09）

- **`VIZ_VERSION` 定数を持つ viz がある**（link-line / gauge-arc / icon-status /
  severity-table / spotlight-frame の5本）。実機での反映確認用に viz 内へ
  バージョン文字列を埋め込んでいるので、**`package.json` を上げたらここも直す**。
  link-line は verify がこの値を検査しているので気づけたが、**他4本は検査していない**ため
  黙ってズレる。横断チェック:
  ```bash
  for d in visualizations/*/; do n=$(basename "$d"); f=$(ls "$d"visualizations/*/src/visualization.jsx 2>/dev/null|head -1)
    [ -z "$f" ] && continue; v=$(node -p "require('./$d/package.json').version")
    e=$(grep -oP "VIZ_VERSION\s*=\s*'\K[0-9.]+" "$f" 2>/dev/null)
    [ -n "$e" ] && [ "$e" != "$v" ] && echo "MISMATCH $n: embedded=$e package=$v"; done
  ```
- **verify の合否判定を出力文字列で機械判定しない**。viz ごとに書式がバラバラで
  （`=== N passed, 0 failed ===` / `passed: 77 failed: 0` / `PASS 83 / FAIL 0` /
  `✅ ALL PASS pass=45 fail=0`）、`grep "0 failed"` だけだと**成功しているのに失敗と誤判定する**。
  実際にこれで3本を「FAIL」と誤読した。**終了コードで判定する**のが正しい。
- **ルート README の行フォーマットが揃っていない**。`**[名前](path)**<br>vX.Y.Z` が基本だが、
  severity-table だけ `**[Severity Table](path)** <br>v2.2.1`（`**` と `<br>` の間に半角スペース）。
  一括置換の正規表現は `\*\*\s*<br>v` のように**空白を許容**して書く。
- **実機のアプリが「消えている」ことがあるが、まず viz の不具合を疑わない。**
  横展開の途中で kpi-tile だけ実機に存在せず（他 28 本は在中）不審に見えたが、
  実際は**ユーザーが裏で全アンインストールしていた**だけだった。
  実機はこちらの与り知らないところで状態が変わる共有環境なので、
  **「前回入れたのに無い」＝異常** と決めつけず、まず素直に入れ直して事実を確認する。
  （このとき「原因不明」と報告したのは正しい対応。**推測で原因を作文しない**。）

### データ正規化（rows / columns 両形式に対応・落とさない）

> **`data.rows` だけ見る実装は必ず壊れる。** 実機では `columns` 形式で届くことがあり、
> その場合 rows は空なので**「サーチを紐づけているのに 0 行」**という症状になる
> （2026-07-25 に検証用 viz でやらかした）。下記の `normalizeData()` を必ず通すこと。

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

- `loading` 中はスピナー、`!data || rows.length===0` はデータなしメッセージ。
  **文言は全 viz 共通で「データがありません。サーチ結果を確認してください。」に統一する**
  （ダッシュボードに複数 viz を並べたとき、サーチ未設定の空パネルが揃った見た目になる）。
  データ形式の案内が要る場合は、この文言を本文に置き、副文（`opacity:0.7` / `fontSize:12` 程度）で添える。
  例外は link-line のみ（データが無くても線をニュートラル色で描き続ける仕様）。
- 数値は `Number(String(v).replace(/,/g,'').trim())` で正規化し `Number.isFinite` ガード。
- オプションは必ず `normalizeOptions(options)` で型・範囲を安全側に補正（未設定/型不一致に耐える）。
- 幅・高さは ResizeObserver でコンテナ実寸を測って自動フィット。非対応環境では初回計測にフォールバック。

### 登場アニメーションは `@keyframes` + `fill-mode: both` で作らない（2026-08-07 実害）

**症状**：ダッシュボードを **PNG でダウンロードすると、その viz のパネルだけ真っ白**になる。
画面上は正常に表示されているので気づきにくい。country-graph で実際に発生した。

**原因**：行とバーの登場アニメーションを、行ごとの `animation-delay` 付き
CSS `@keyframes` ＋ `animation-fill-mode: both` で描いていた。

```css
/* ✗ やってはいけない */
@keyframes cg-fade-in { from { opacity: 0 } to { opacity: 1 } }
.cg-row { animation: cg-fade-in 0.45s ease both; }   /* + style={{animationDelay: `${i*55}ms`}} */
```

`both`（= `backwards` + `forwards`）は **`animation-delay` の間、要素を `from` の状態に固定する**。
つまり遅延中の行は `opacity: 0`、バーは `transform: scaleX(0)` で**完全に不可視**。
**アニメーションが一度も進まない描画コンテキスト**（DOM を複製して撮る書き出し経路など）では、
その不可視状態のまま確定して焼き付く。

**対策（house pattern）**：**最終状態が常に inline style に載っている**方式にする。
マウント後フラグ＋`transition` で、DOM を複製しても最終値がそのまま複製先に残るようにする。

```jsx
function useMounted() {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf !== 'function') { setMounted(true); return undefined; }  // rAF 無し環境の保険
        const id = raf(() => setMounted(true));
        return () => { try { globalThis.cancelAnimationFrame(id); } catch (e) { /* noop */ } };
    }, []);
    return mounted;
}
// …
const settled = mounted || !animate;
<div style={{
    width: settled ? `${pct}%` : '0%',
    transition: animate ? `width 700ms cubic-bezier(0.22,1,0.36,1) ${index * 70}ms` : 'none',
}} />
```

- **`transform: scaleX()` ではなく `width` を動かす**。`scaleX` は角丸と `box-shadow` のグローまで
  一緒に潰れ、伸びている最中の見た目が崩れる。
- **`prefers-reduced-motion` は CSS の `@media` ではなく JS（`matchMedia`）で判定する**。
  inline style を `@media` で上書きするには `!important` が要り、指定が読みにくくなる。
- **rAF が無い環境のフォールバックを必ず入れる**。入れないと `mounted` が立たず
  「バーが 0% のまま」という別の不表示を作る。
- 採用実績：gradient-bar / donut-graph / radial-bar / radar-chart / calendar-heatmap /
  donut-timechart / country-graph。**それ以外の viz は rAF で SVG 属性を直接更新**しており、
  いずれも「DOM にその瞬間の最終値が入っている」点は同じ。

**回帰テストの書き方**（`test/verify.mjs`。country-graph に実装済み）:

```js
const s = bar.getAttribute('style') || '';
check('bar width materialized in inline style', /width:\s*([\d.]+)%/.exec(s)?.[1] > 0);
check('bars use no CSS animation', !/animation/.test(s));
check('row opaque after mount', /opacity:\s*1\b/.test(row.getAttribute('style') || ''));
const css = [...doc.querySelectorAll('style')].map((e) => e.textContent).join('\n');
check('no @keyframes injected', !css.includes('@keyframes'));
```

**検出コマンド**（他の viz に同じ地雷が無いか。2026-08-07 時点では 0 件）:

```bash
grep -l "animation:.* both" visualizations/*/visualizations/*/src/visualization.jsx
```

> ⚠ **未検証**：Splunk の PNG 書き出しが「アニメーションを進めずに DOM を複製して撮っている」
> という機構そのものは、書き出し実装が手元に無いため確認していない。
> **確認済みなのは**「コンテンツ本体を `@keyframes` + `both` + `delay` で描いていたのは
> 全 viz 中 country-graph だけ」「`both` は遅延中 `from` に固定する（CSS 仕様）」の2点。

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
- ソースに生の NUL 文字（`\x00`）を入れない（grep がバイナリ扱いする）。`'\u0000'` エスケープで書く。
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

`@splunk/visualizations` の全 `*.config.js` を require して walk した結果、**標準 viz が使っている
editor 型は 28 種**（2026-07-25 調査。2026-07-28 に v28.8.0 の一次ソースで再現・件数まで一致）。
標準 viz での採用数が多いものほど素性が確か。

> ⚠ **【重要な訂正】この 28 種は「実在する editor 型の全部」ではない**（2026-07-28 確認）。
> 一次ソースを調べ直した結果、**この数字が上限である保証は無い**ことが分かった:
>
> - `@splunk/visualizations` は**標準 viz の定義集であって、有効な editor 型のレジストリではない**。
>   28 種は「**標準 viz がたまたま使っている型**」を数えたものにすぎない。
> - **有効／無効を判定しているホスト側のコード（`Invalid editor type` を出す実体）は、
>   ローカルの node_modules のどこにも無い**。Splunk Web 側にあり、手元から列挙できない。
>   `visualization-schemas` 等の兄弟パッケージ7つを全て調べたが、editor 型の定義は**0件**。
>   `.d.ts` にも `docs-llm/` にも editor 型の union 定義は**存在しない**。
> - **反証が実在する**：`editor.arrayOfStrings` は `LinkGraph.config.js` の
>   **コメントアウトされたブロックの中にしか出てこない**（＝標準 viz は誰も使っていない）のに、
>   実機では正常に動作し値も届く。**「標準 viz が使っていない＝存在しない」は成り立たない。**
>
> 従って正しい言い方は「**実在する型は 28 種**」ではなく
> 「**28 種は動作確認済み。それ以外に未知の型が存在する可能性は否定できない**」。
> 未知の型を探すには、名前を推測して Editor Probe で1つずつ試すしかない
> （`Invalid editor type` が出れば無効、UI が出れば有効、という判定は実機でのみ可能）。
>
> なお `editor:` の値が変数・ファクトリ関数になっている箇所は**全パッケージで0件**（全て文字列リテラル）
> なので、**「このパッケージ内に grep で見逃した型がある」可能性は排除できている**。
> 見えていないのは「パッケージ外の型」だけ。

| editor 型 | 採用 viz 数 | editorProps の要点 | カスタム viz での評価 |
|---|---|---|---|
| `editor.color` | 26 | `{labelPosition, themes:{}}` | **確実（実機確認済み）** |
| `editor.number` | 23 | `{min, max}` | **確実（実機確認済み）** |
| `editor.select` | 20 | `{values:[{label,value},…]}` | **確実（実機確認済み）** |
| `editor.columnSelector` | 19 | `{dataSourceKey:'primary', supportsDSL, expectedDataPrimitive}` | **確実**（ただし DOS 文字列で届く→§3 後述） |
| `editor.toggle` | 18 | `{help, helpFormat}` | **確実（実機確認済み）** |
| `editor.radioBar` | 18 | `{values:[{label,value},…]}` | **確実（実機確認済み）** |
| `editor.checkbox` | 16 | なし | **確実（実機確認済み）** |
| `editor.text` | 15 | `{tooltip}` | **確実（実機確認済み）** |
| `editor.slider` | 6 | `{min, max, step}` | **確実（実機確認済み）**。UI 値がそのまま届く |
| `editor.percent` | 4 | `{min}` | **確実（実機確認済み）**。⚠ **UI 値の 1/100 が届く**（下記） |
| `editor.threshold` | 1 | `{openRanges, isTogglable}` | **確実（実機確認済み）**。⭐ **`[{from,to,value}]` の配列が生で届く**（→ §4） |
| `editor.arrayOfStrings` | 0（コメントのみ） | `{themes, labelPosition}` | **確実（実機確認済み）**。チップ形式の文字列リスト。`["a","b"]` が届く |
| `editor.markdown` | 1 | なし | **確実（実機確認済み）**。ツールバー付きエディタ。**Markdown 原文の文字列**が届く（描画は viz 側） |
| `editor.image` | 2 | `{validMediaTypes:['svg'], svgRenderAsDom}` | **△ 動くが実用不可**。届くのは `splunk-enterprise-kvstore://<id>` という**URI で画像本体ではない**。拡張 iframe から解決できないため、同梱アセットか `editor.text` で data URI を貼る方が現実的 |
| `editor.columnMultiSelectionByFieldNameEditor` | 8 | なし | **確実（実機確認済み）**。⭐ **生のフィールド名配列**（`["_time","category"]`）が届く。複数フィールド選択はこれ一択 |
| `editor.seriesColorsByField` | 6 | なし | **確実（実機確認済み）**。`{"_time":"#7B56DB",…}` のオブジェクトが届く |
| `editor.tableBackgroundColor` | 1 | `{themes, palette:[…]}` | **△ 使えるが要注意**。`option` ではなく **`key`** が必要。書き込み先は**固定キー `backgroundColor`**（`key` の値は使われない） |
| `editor.marks` / `editor.seriesLineTypes` / `editor.seriesLineTypesByField` | — | — | **× 使用不可（実機確認済み）**。`Invalid editor type` で editorConfig 全体が消える。`seriesColors` は動くのに LineTypes 系は動かない＝**系統名で判断できない** |
| `editor.tableDynamicColor` | 1 | — | **× 使用不可（実機確認済み）**。`option` 名を無視して固定キー `tableFormat` に DOS 式を書き、**編集パネルが操作不能になる**。Table 専用 |
| `editor.tableColumnFormatter` | 1 | — | **× 採用しない**（未検証）。`option`/`key` を持たない Table 専用型。`tableDynamicColor` と同様に危険 |
| `editor.operations` / `editor.children` / `editor.isInline` / `editor.onChange` / `editor.insertText` | — | — | **実在しない**（Slate.js 由来の grep 誤検出。クォート付き grep では出てこない） |
| `editor.seriesColors` | 10 | なし | **確実（実機確認済み）**。プリセット選択＋色スウォッチ列。`["#7B56DB",…]` が生で届く |
| `editor.presetSelector` | 6 | `{presets:[{label,name,value:{context,options}}]}` | **確実（実機確認済み）**。`option` を持たず、選んだ preset の `value.options` が options に流れる（複数オプションの一括切替に使える） |
| `editor.trellisSplitBy` | 11 | `{dataSourceKey:'primary'}` | **確実（実機確認済み）**。生のフィールド名（`"count"`）が届く |
| `editor.columnMultiSelector` | 5 | `{dataSourceKey, filterByTypes}` | **△ DOS 文字列で届く**（`> primary \| frameBySeriesNames('a','b')`）。パースすれば使える |
| `editor.dynamicColor` / `editor.dynamicColorWithPrecedence` / `editor.networkGraphDynamicColor` / `editor.tableDynamicColor` / `editor.seriesColorsByField` / `editor.tableColumnFormatter` / `editor.tableBackgroundColor` / `editor.columnMultiSelectionByFieldNameEditor` | 3〜8 | `context` + DOS 前提 | **× 使えない見込み**（`dynamicColor` のみ実証済み）。`option` の中身が DOS 式（`> value \| rangeValue(...)`）になる型は届かない → §4 |

**選定の原則**（2026-07-25 に**実在候補 28 種を全数実機検証**して確定。20種が使える）:

> - **ほとんどの型は素の値／配列／オブジェクトがそのまま options に届く**
> - **DOS 文字列になるのは 2 系統だけ**：
>   ① データソースの列を指す型（`columnSelector` / `columnMultiSelector`）… パースすれば使える
>   ② `dynamicColor` 系（`option` の中身が `> value | rangeValue(...)` になる）… 使えない（→ §4）
> - **Table 専用型は `option` を無視して固定キーに書く**。
>   `tableBackgroundColor` は `key` 指定で使えるが書き込み先は `backgroundColor` 固定。
>   **`tableDynamicColor` / `tableColumnFormatter` は編集パネルを操作不能にするので入れない**
> - **系統名で可否を判断しない**。`seriesColors` は動くが `seriesLineTypes` は使用不可。
>   `arrayOfStrings` は標準 viz が使っていない（コメントアウトのみ）が動く。

**旧記述の誤り（訂正）**：以前は「`context` を使う型は全部届かない」と書いていたが**誤り**。
`editor.seriesColors` は `context` を使う型だが**配列が生で届く**（実機確認済み）。
`dynamicColor` が届かないのは `context` のせいではなく、`option` に DOS 式が入るため。

#### `context` は viz から読めない（2026-07-25 実機確認済み）

`dynamicColor` 系はダッシュボード定義の `context` に**範囲配列を生で保存している**:
```json
"context": { "<option名>EditorConfig": [{ "from": 20, "to": 40, "value": "#D94E17" }, …] }
```
「これを viz から読めれば dynamicColor 系も使えるのでは」を実機で検証したが、**読めない**。
拡張 API がホストから受け取れるのは以下 **19 個だけ**で、`context` を取る手段は存在しない
（API オブジェクトをプロトタイプチェーンごと総なめして確認済み）:

```
getDataSources / getOptions / getTheme / getDimensions / getMode / getTokens / getError
addDataSourcesListener / addOptionsListener / addThemeListener / addDimensionsListener /
addModeListener / addTokensListener / addErrorListener / addDrilldownListener
setOptions / setError / clearError / triggerDrilldown
```

→ **`option` に DOS 式が入り、実データが `context` にしか無い型は原理的に使えない。**
範囲→色をやりたいなら `editor.threshold`（`option` に配列が直接入る）を使う。

#### ⚠ `editor.percent` は UI 値の 1/100 が届く（2026-07-25 実機確認）

編集パネルに `5` と入力すると、viz には **`0.05`** が来る（`editor.slider` は `0.42` がそのまま来る）。

```
editor.percent : UI「5」   → options: 0.05   ← 比率。viz 側で ×100 しない
editor.slider  : UI「0.42」→ options: 0.42   ← そのまま
```

- 「%」で見せたいが**内部は比率**として扱う設計。`opacity` などにはそのまま渡せて都合がよい。
- **既存の「%で持つ」オプション（例 `bgOpacity: 0〜100`）を `editor.percent` に移行すると値が
  1/100 になる**ので、viz 側の計算を必ず見直すこと。移行しないなら `editor.number` のままでよい。

#### `editor.seriesColors`（色パレット）と `editor.presetSelector`（一括切替）

どちらも実機確認済み。標準 viz と同じ UI がそのまま使える。

```json
// 系列色パレット。プリセット選択＋色スウォッチ列の UI が出る
[{ "label": "系列の色", "editor": "editor.seriesColors", "option": "seriesColors" }]
// → viz には ["#7B56DB", "#009CEB", "#00CDAF"] が生で届く
```
```json
// 複数オプションを一括で切り替えるプリセット。option は持たない
[{ "label": "配色プリセット", "editor": "editor.presetSelector",
   "editorProps": { "presets": [
     { "label": "標準", "name": "p.default", "value": { "context": {}, "options": { "accentColor": "#22d3ee", "useGlow": true } } },
     { "label": "警告", "name": "p.alert",   "value": { "context": {}, "options": { "accentColor": "#f85149", "useGlow": false } } }
   ] } }]
// → 選ぶと value.options のキーがまとめて options に反映される
```

`editor.trellisSplitBy` も**生のフィールド名**（`"count"`）が届くので、
「1フィールドを選ばせたい」用途では `columnSelector`（DOS 文字列でパースが要る）より扱いやすい。

#### optionsSchema は `anyOf` ＋ DOS 文字列パターンで書く（2026-07-25 実機で判明）

**標準 viz の optionsSchema は素の `"type"` を使っていない。** 必ず次の形をとる:

```json
"seriesColors": {
  "default": ["#7B56DB", "#009CEB"],
  "anyOf": [
    { "type": "array", "items": { "type": "string" } },
    { "type": "string", "pattern": "^>.*" }        ← DOS 文字列も許容する
  ]
}
```

理由は、**どのオプションにも DOS 文字列（`> primary | ...`）が入りうる**ため。`"type": "string"` と
書き切ると、ユーザーが値を設定した瞬間にダッシュボードの保存時検証で落ちる:

```
/visualizations/viz_XXXX/options/p_arrayOfStrings: must be string
/visualizations/viz_XXXX: must match "then" schema
```

これは**editor 型が無効なのではなく、こちらの型宣言と実際の値の不一致**。エラーメッセージに
option 名が出るので、その option の `optionsSchema` を疑う。

- 単純な型（`editor.checkbox` の boolean 等）は素の `"type"` でも実用上は動いている（既存 viz が実績）。
- ただし**配列やオブジェクトを返す editor 型**（`threshold`・`seriesColors`・`columnMultiSelector` 等）は
  必ず `anyOf` で正確に書く。`"type": "string"` のままだと確実に落ちる。
- 迷ったら標準 viz の同じ editor 型の定義をコピーする（`<Viz>.config.js` の `optionsSchema`）。

#### options には optionsSchema に無いキーも来る

ホストが `backgroundColor: "transparent"` などを勝手に載せてくる（実機で確認）。
**viz 側は未知のキーを無視する作り**にしておく（`normalizeOptions` で必要なキーだけ拾う既存パターンでOK）。

**逆向きも成り立つ：`optionsSchema` に載せていないキーを viz 側から `setOptions` で保存しても、
ダッシュボード定義に永続化され、次回ちゃんと viz に届く**（2026-08-08 実機確認。Splunk 10.4.2）。

- 確かめ方：`options` に `labelPos` と適当な `totallyMadeUpKey` を入れたダッシュボードを push し、
  `getDashboard` で読み戻す → **両方そのまま残っていた**。
- **なぜ重要か**：`optionsSchema` にキーを足すと**編集パネルへの反映に splunkd 再起動が要る**（§7.1）。
  だが「編集パネルに出す必要が無い永続状態」（viz 内のドラッグ操作で決まる位置・サイズ等）なら、
  **スキーマに載せずに保存すれば再起動なしで機能追加できる**。
- 実例：link-line v1.11.0 の `labelPos`（値ラベルの位置。線編集モードでドラッグして決める）。
  `config.json` を一切変えずに済んだので `_bump` のみで反映できた。
- ⚠ ただし **`DEFAULTS` と `normalizeOptions` には必ず追加する**。壊れた値は既定へ倒すこと。
- ⚠ 「スキーマに無いキーは捨てられるはず」と**推測で諦めない**。実機は保持する。

- **調べ方**（再現手順）:
  ```bash
  npm install @splunk/visualizations   # スクラッチ領域で。プロジェクトには入れない
  # ざっと候補を洗う（誤検出込み。Slate.js の editor.marks なども混じる）
  grep -rhoE "editor\.[a-zA-Z0-9]+" node_modules/@splunk | sort | uniq -c | sort -rn
  # 実際に標準 viz で使われている型と editorProps / optionsSchema の正しい書き方を見る
  # → 各 .config.js を require() して editorConfig を再帰 walk し、
  #   node.editor が 'editor.' 始まりのノードから label/option/context/editorProps を集める
  ```

  **【重要】この静的解析で分かるのは「標準 viz が使っているか」だけ。「型が実在するか」は分からない。**
  `@splunk/visualizations` は**標準 viz の定義集**であって、**editor 実装のレジストリではない**
  （editor 本体はダッシュボード編集画面側のバンドルにあり、このパッケージには入っていない）。

  実例（2026-07-25 にやらかした誤判定）:
  - `editor.arrayOfStrings` は `LinkGraph.config.js` に**コメントアウトでしか出てこない**ため
    「実在しない」と判断した。→ **誤り。実機では UI が出て配列も届いた**。
  - 一方 `editor.marks` は実機で `Invalid editor type` になった（本当に無い）。
  - **静的解析だけでは両者を区別できない。可否は実機で確かめるしかない。**

  → 採用数 0 の型を「使えない」と決めつけない。**使えるかどうかは実機検証がすべて**。

### 選択肢は `editor.select` / `editor.radioBar` を使う（数値コード化しない）

**このリポジトリの全 viz は checkbox / color / number / columnSelector の4種だけで組まれており、
`editor.select` を1つも使っていない**（2026-07-25 時点）。そのため列挙型のオプションが
「数値コード」や「チェックボックス複数」で代用され、UI が分かりにくくなっている箇所がある。
新規・改修では下記に従う。

```json
// editorConfig：3つ以上の選択肢はドロップダウン
[{ "label": "判定モード", "editor": "editor.select", "option": "matchMode",
   "editorProps": { "values": [
     { "label": "自動",         "value": "auto" },
     { "label": "数値しきい値", "value": "numeric" },
     { "label": "文字列一致",   "value": "string" }
   ] } }]

// 2〜4択で常時見せたいなら radioBar（同じ editorProps.values 形状）
[{ "label": "並び順", "editor": "editor.radioBar", "option": "sortMode",
   "editorProps": { "values": [
     { "label": "検索結果順", "value": "none" },
     { "label": "最大値順",   "value": "peak" },
     { "label": "合計順",     "value": "total" }
   ] } }]
```
```json
// optionsSchema は文字列型にする（数値コードにしない）
"matchMode": { "type": "string", "default": "auto" }
```
```js
// viz 側：未知値は既定へ丸める（旧バージョンの数値が残っていても壊れないように）
const MATCH_MODES = ['auto', 'numeric', 'string'];
const matchMode = MATCH_MODES.includes(o.matchMode) ? o.matchMode : 'auto';
```

**アンチパターン**（実在した例）:

| 悪い例 | 何が問題か | 直し方 |
|---|---|---|
| `「判定モード（0=自動 / 1=数値 / 2=文字列）」` を `editor.number` | ユーザーが数字の意味を覚える必要がある。範囲外の値も入力できる | `editor.select` + 文字列 value |
| `sortByPeak` + `sortByTotal` の checkbox 2つ | **両方ONが未定義動作**（コードは `if/else if` で片方が黙って勝つ）。UI 上は両方チェックできてしまう | 1つの `editor.select`（`none`/`peak`/`total`） |
| `sortByValue` + `sortAscending` の checkbox 2つ | 「並べ替える」OFF時に「昇順」が無意味に残る（依存関係が UI に出ない） | `editor.select`（`none`/`asc`/`desc`）に統合 |

**checkbox のままでよいもの**: `sortRowsByTotal` と `sortColsByTotal` のように**独立して ON/OFF
できる**もの。排他かどうかで判断する。

**「0＝特別値」の数値は数値のままでよい**（`maxCellSize`（0=無制限）、`labelWidth`（0=自動）など）。
選択肢ではなく連続量なので `editor.number` が正しい。

### ⭐ チェックボックス／トグルのラベルは短くする（10文字前後・実機で実害）

**`editor.checkbox` / `editor.toggle` のラベルが長いと、編集パネルで文字が重なって
判読不能になる**（2026-08-09 にユーザーが実機で発見。world-map・sankey-flow の両方で発生）。

**原因**：チェックボックスとトグルは**ラベルがコントロールの右に横並びで置かれ、
`white-space: nowrap` + `overflow: hidden` が効いている**（実機の DOM で確認）。
折り返されないため、幅を超えた分が隣の要素と重なる。
一方 **`editor.number` / `editor.select` / `editor.slider` などはラベルが
コントロールの「上」に置かれる**ので、多少長くても壊れない。
→ **同じ長さでも editor 型によって壊れるかどうかが違う**のがハマりどころ。

**守ること**:

- チェックボックス／トグルのラベルは **動詞止めの短文（目安10文字前後、最大12文字）**。
  「〜を表示」「〜を反転」「グラデーション」のように**何をするか**だけ書く。
- **括弧書きの補足・例示・条件をラベルに詰め込まない。**
  ❌ `グラデーションリンク（送信元色→送信先色）` / `数値を省略表記（1.5M など）`
  ✅ `グラデーション` / `数値を省略表記`
- **説明は README に書く**。編集パネルのラベルは「見出し」であって説明文ではない。
- 他の editor 型（number / select / text 等）は**上にラベルが出るので長くてよい**
  （`ラベル文字サイズ（px、0で自動）` などはそのままで問題ない）。

**横断チェック**（新規・改修のたびに回す。12文字超が出たら短縮する）:

```bash
python3 - <<'PY'
import json,glob
rows=[]
for p in sorted(glob.glob('visualizations/*/visualizations/*/config.json')):
    viz=p.split('/')[1]
    if viz=='editor-probe': continue
    try: d=json.load(open(p,encoding='utf-8'))
    except Exception: continue
    for sec in d.get('config',{}).get('editorConfig') or []:
        for row in sec.get('layout',[]) or []:
            for it in row:
                if it.get('editor') in ('editor.checkbox','editor.toggle'):
                    l=it.get('label','')
                    if len(l)>12: rows.append((len(l),viz,l))
rows.sort(reverse=True)
print(f"要短縮: {len(rows)}件")
for n,v,l in rows: print(f"{n:3d}\t{v}\t{l}")
PY
```

**2026-08-09 に全 viz へ横展開済み**（22 viz・64 ラベルを短縮し、12文字超を 0 件にした）。
それ以前は world-map だけを直して「他 viz は未チェック」の状態が残っていた。

⚠ **ラベル変更は `config.json` なので、編集パネルへの反映に splunkd 再起動が要る**（§7.1）。
描画には影響しないため、**再起動できないなら次回の再起動時に反映される**（急がなくてよい）。

> **`editor.select` は実機確認済み**（2026-07-25、kpi-tile v1.3.0）。編集画面にドロップダウンとして
> 正しく表示され、選択値も `useOptions()` に届く。セクションが消える症状も出ない。
> `editor.radioBar` は同じ `editorProps.values` 形状なので通る見込みだが未検証。

### 【重要】既定値と同じ値は options に載らない（旧オプション読み替えの罠）

**ホストは `optionsSchema` の `default` と同じ値を options に載せないことがある。**
ユーザーが既定値を選ぶと、その option は options から**消える**（未設定と区別できない）。

このため、**旧オプションへフォールバックする「後方互換」実装を書いてはいけない**:

```js
// ❌ やってはいけない
function resolveIconName(raw) {
    if (isValid(raw.iconName)) return raw.iconName;
    if (Number.isFinite(raw.iconIndex)) return ICONS[raw.iconIndex - 1].name; // ← 旧値が復活する
    return DEFAULTS.iconName;
}
// ✅ 正しい：新オプションだけ見て、無ければ既定値へ倒す
function resolveIconName(raw) {
    return isValid(raw.iconName) ? raw.iconName : DEFAULTS.iconName;
}
```

症状は**「既定値を選んだときだけ直らない」**という分かりにくい形で出る。実例（kpi-tile v1.3.0 開発中）:
旧 `iconIndex:3`(警告) が残ったダッシュボードでドロップダウンから既定値の「シールド」を選ぶと、
`iconName` が options に載らず → 旧 `iconIndex` が読まれて**警告アイコンのまま**になった。
既定値以外（稲妻など）を選んだときは正常に動くため、テストでも見落としやすい。

→ **オプションのキー名を変えるときは読み替えを諦め、既定値に戻す**。README に「この設定は既定値に
戻るので選び直してください」と書くのが正しい。ローカル検証では「旧キーだけがある options」を
食わせて、**旧値が漏れてこないこと**を回帰テストにする。

### ドリルダウン用の editor 型は存在しない

`editor.drilldown` のような型は動作確認済みの 28 種のどこにも無く、標準 viz の editorConfig にも
drilldown 項目は無い（※未知の型が存在する可能性は否定できないが、少なくとも標準 viz は使っていない）。
ドリルダウン（＝「インタラクション」）は editorConfig とは**別レイヤー**の仕組み → §5 を参照。

### 無効な editor を混ぜたときの症状（2026-07-25 実機で確定）

**未対応の editor 型を1つでも入れると、editorConfig 全体が出なくなる。**
セクション単位ではなく**全滅**する（他のセクションも、確実に動く `editor.checkbox` だけの
セクションも、まとめて消える）。標準の「全般 / データソース / 可視性 / 位置とサイズ」だけが残る。

**ただし原因の型名は表示される。** 設定パネル下部に赤い警告アイコンとともに

```
⚠ Invalid editor type: editor.marks
```

と**最初に見つかった無効な型の名前が1つだけ**出る。これが唯一の手がかり。

→ **「独立セクションに隔離すれば1つずつ切り分けられる」は誤り**（この前提でプローブを作って
失敗した）。全滅するので隔離しても無意味。正しい切り分け方は次のどちらか:

1. **エラーメッセージを読んで1つずつ消す**。表示されるのは1つだけなので、消して再デプロイ →
   次の型名が出る → また消す、の反復。確実だが `_bump`＋リロードを型の数だけ繰り返す。
2. **二分探索**。候補を半分ずつ入れて、パネルが出るか出ないかで絞る。デプロイ回数は
   log2 で済むが、どの型が原因かはエラーメッセージの方が速い。

**実務上の結論**：未検証の editor 型は**1つずつ追加して確認する**。まとめて入れると
全滅したうえに、エラーは最初の1つしか出ないため何個ダメなのか分からない。

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

## 4. 値→色マッピング（`dynamicColor` は不可 → **`threshold` を使う**）

### 結論（2026-07-25 更新）

やりたいことに応じて2択:

| やりたいこと | 使うもの |
|---|---|
| **範囲→色を editor で設定させたい**（動的に増減） | **`editor.threshold`**（後述。配列が生で届く） |
| 値の大小を連続グラデーションで塗りたい | 自前のカラースケール（`editor.color` × 2〜3 ＋ 補間） |

**`editor.dynamicColor` は使えない**（下記）。ただし**代わりに `editor.threshold` が使える**ことが
実機で判明したので、「範囲を+で追加」系の UI はそちらで実現する。

### DOS の全体像と `matchValue`（2026-07-28 公式ドキュメントで確認）

公式ドキュメントに **DOS 関数の完全な一覧ページ**がある（今まで参照していなかった）。
DOS は **`> データソース | セレクタ関数 | フォーマット関数`** というパイプ構造で、関数は2種類:

- **セレクタ関数**（列や値を取り出す）… `seriesByName` `seriesByIndex` `frameBySeriesNames`
  `seriesByType` `getField` `getValue` `min` `max` `sum` `firstPoint` `lastPoint` ほか多数
  <https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/10.4/configuration-options-reference/dynamic-options-syntax-functions/dynamic-options-syntax-selector-functions>
- **フォーマット関数**（値を変換・着色する）… **`matchValue`** `rangeValue` `gradient` `lerp`
  `pick` `formatByType` `multiFormat` `type` `maxContrast` `setColorChannel` `prefix` ほか
  <https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/10.4/configuration-options-reference/dynamic-options-syntax-functions/dynamic-options-syntax-formatting-functions>

**⭐ 文字列カテゴリ→色は `matchValue`（＝「HIGH なら赤」）が正式に存在する。**
`rangeValue`（数値範囲→色）と対をなす関数で、標準 viz の編集画面では
「Ranges（範囲）」と並ぶ **「Matches（一致）」** として出てくる。

```
> primary | seriesByName("status") | matchValue(colorMatchConfig)
```
```json
[ { "match": "SIM Cubicle", "value": "#FF0000" },
  { "match": "Dream Crusher", "value": "#00FF00" } ]
```

> ⚠ **【訂正】**「文字列→色を1組ずつ登録する仕組みは無い」と過去に回答したのは**誤り**。
> `matchValue` として**確実に存在する**（公式ドキュメント記載＋パッケージ内 107 箇所で使用）。
>
> **ただしカスタム viz からは依然として使えない**（結論は変わらない）。理由は
> 「機能が無いから」ではなく「**到達手段が無いから**」:
> `matchValue` の対応表を編集 UI で設定する経路は `editor.dynamicColor` /
> `editor.dynamicColorWithPrecedence` / `editor.tableDynamicColor` の3つだけで、
> **いずれも実機で使用不可**。しかも対応表の実体は `option` ではなく **`context` 側**に入る
> （`Timeline.config.js`: `context: { colorMatchConfig: "colorMatchConfig" }`）ため、
> `useOptions()` には DOS 式の文字列しか来ない。
>
> → 文字列カテゴリの着色は **`editor.seriesColors`（順序付きパレット）** で自前実装する方針のまま。
> 関連: [[threshold-vs-palette-categorical]]

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
参照実装: `visualizations/calendar-heatmap/.../visualization.jsx` の
`normalizeOptions` / `lerpColor` / `scaleColorFor` / `cellFill`。

### 「動的に範囲を+追加」したい場合 → **`editor.threshold` を使う**（2026-07-25 実機確認）

**`editor.dynamicColor` の代わりに `editor.threshold` を使えば、やりたいことがそのまま実現できる。**
`dynamicColor` と違い **`context`／DOS を経由せず、範囲＋色の配列が生で options に届く**。

```json
// editorConfig
[{ "label": "しきい値の色", "editor": "editor.threshold", "option": "colorBands",
   "editorProps": { "openRanges": false, "isTogglable": false } }]
```
```json
// optionsSchema（anyOf で正確に書く。素の "type" だと保存時に落ちる）
"colorBands": {
  "default": [{ "from": 0, "to": 50, "value": "#118832" }, { "from": 50, "to": 100, "value": "#D41F1F" }],
  "anyOf": [
    { "type": "array", "items": { "type": "object",
      "properties": { "from": { "type": "number" }, "to": { "type": "number" }, "value": { "type": "string" } },
      "required": ["from", "to", "value"], "additionalProperties": false } },
    { "type": "string", "pattern": "^>.*" }
  ]
}
```
```js
// viz 側に届く生の値（そのまま使える）
[{ from: 40, to: 100, value: '#f8be34' }, { from: 22, to: 40, value: '#dc4e41' }, …]
```

UI は**「+ 閾値の追加」で行を動的に増減**でき、各行に数値2つ＋色ピッカーが並ぶ
（標準 viz の MarkerGauge「ゲージ範囲」と同じ見た目）。`editorProps.openRanges: true` にすると
上限なしの範囲も作れる。

#### ⚠ `openRanges: true` を使うなら optionsSchema を null 許容にする（2026-07-25）

**上の schema 例は `openRanges: false` 用。`true` にするなら下記に変えること。**
開いた範囲は `from`／`to` が **`null`** で保存されるため、`"type": "number"` かつ
`required` に入れたままだと**ダッシュボード保存時の検証で落ちる**（症状は
`must be number` / `must match "then" schema`）:

```json
"colorBands": {
  "default": [ { "from": 0, "to": 40, "value": "#53a051" },
               { "from": 40, "to": null, "value": "#dc4e41" } ],   ← 上限なし
  "anyOf": [
    { "type": "array", "items": { "type": "object",
      "properties": { "from": { "type": ["number", "null"] },      ← null を許す
                      "to":   { "type": ["number", "null"] },
                      "value": { "type": "string" } },
      "required": ["value"], "additionalProperties": false } },     ← from/to は必須にしない
    { "type": "string", "pattern": "^>.*" }
  ]
}
```

viz 側は `from == null → -Infinity` / `to == null → +Infinity` に正規化して判定する。

**既定バンドの上端は開けておく**のが安全。`{from:90, to:100}` のように閉じると
**100 を超える値がどのバンドにも入らず**「色が付かない」症状になる（link-line v1.9.1 で実際に混入し修正）。

**したがって以下の旧・代替案はもう不要**（既存 viz を触るときは threshold への置き換えを検討する）:

- ~~固定 N 組の `editor.number(from) + editor.color` バンド~~
- ~~viz 内に「動的色設定」風パネルを自前実装~~（参照実装だった link-line の `parseColorBands`／
  色設定パネルは、**編集モードでの iframe 入力遮断を回避するための苦肉の策**だった。
  threshold なら右パネルで完結するのでその問題も起きない）
- SPL 側で行に `color` フィールドを持たせる方式は、データ駆動で色を決めたい場合には引き続き有効。

---

## 5. ドリルダウン（設定UIの「インタラクション」）とトークン

### 結論

**使える（2026-07-25 実機確認済み）。** `config.json` で `showDrilldown: true` と
`hasEventHandlers: true` を立てると、**編集画面に「インタラクション」タブが実際に出る**。
Studio では drilldown が「インタラクション（Interactions）」に名称変更されているだけで、
カスタム viz も同じ UI に乗る。`triggerDrilldown` / `addDrilldownListener` も例外なく呼べる。

### `useTokens` で読めるもの（実機確認済み）

**トークンはフラットではなく入れ子で届く。** `tokens.foo` ではなく下記の3階層:

```json
{
  "env":       { "app": "…", "locale": "ja-JP", "user": "admin",
                 "user_realname": "Administrator", "user_email": "…", "user_timezone": "…",
                 "product": "enterprise", "version": "10.4.1", "is_enterprise": true },
  "default":   { "global_time.earliest": "-24h@h", "global_time.latest": "now" },
  "submitted": { "global_time.earliest": "-24h@h", "global_time.latest": "now" }
}
```

- `env` … ログインユーザー名・表示名・メール・タイムゾーン・アプリ名・ロケール・Splunk 版数
- `default` / `submitted` … **選択中の時間レンジ**（`global_time.earliest` / `latest`）

→ **ドリルダウンを使わなくても、viz 内に「対象期間」や「ユーザー名」を出せる**。
ダッシュボードの入力（input）で設定したトークンも同様にここへ入る。
**任意のトークン名を探すときは階層を再帰的に走査すること**（どの階層に入るかは名前次第）。

ただし**デフォルトで無効**。`config.json` の 2 フラグを立て、かつ **viz 側でクリック発火を実装**
しないと、パネルに出てこない／出ても何も起きない。この repo の既存 viz はすべて
`showDrilldown: false` なので、必要な viz で個別に有効化する。

### ✅ トークン設定は**できる**（2026-07-25 実機確認済み・Splunk 10.4.1）

> **【訂正】** 当初この節は「トークン設定は不可」と結論づけていたが**誤りだった**。
> 原因は `config.json` に **`events` 宣言が無かった**こと（下記①）。

**成立の条件は3つ。1つでも欠けると「例外は出ないが何も起きない」。**

**① `config.json` に `events` / `supports` を宣言する（これが抜けていて失敗した）**

```json
{
  "showDrilldown": true,
  "hasEventHandlers": true,
  "canSetTokens": ["dynamic", "static"],
  "config": {
    "events": { "cell.click": { "description": "triggered when user clicks a table cell" } },
    "supports": ["events"]
  }
}
```
標準 viz（`Table.js` 等）と同じ形。**ホストはここに宣言されたイベント名しか認識しない**ので、
宣言が無いと編集画面のインタラクションに紐づける対象が存在せず、発火しても無視される。
イベント名は標準 viz に倣う（`cell.click` / `point.click` / `legend.click` / `node.click` など）。

**② 各要素を `addDrilldownListener` で登録し、「命令」ではなく「事実」を渡す**

`action: 'setToken'` という**命令を送るのは誤り**（公式ドキュメントの例は効かない）。
渡すのは**クリックされたという事実だけ**。`payloadCallback` が返す payload がそれにあたる:

```js
addDrilldownListener({
  node,                               // ← クリックさせたい DOM 要素（セル・バー等）
  action: 'cell.click',               // ← config の events に宣言した名前
  payloadCallback: () => ({
    'row.host.value': 'host-2',       // ← 行の各フィールドを row.<フィールド名>.value で載せる
    'row.status.value': 'OK',
    name: 'status', value: 'OK',      // クリックされた要素自身
  }),
});
```

**`triggerDrilldown()` を自前の `onClick` から呼んでも効かない**（下記）。

**③ ユーザーが編集画面「インタラクション」で「トークンを設定」を追加する**

**何をするか（トークン設定・リンク遷移）を決めるのはホスト側のインタラクション定義**であって
viz ではない。viz は発火するだけ。

→ これで**viz のクリックでダッシュボード全体を絞り込める**（実機確認済み）。

#### ⚠ カスタム viz で発火できるのは **click だけ**（2026-07-25 実機確認済み）

標準 viz は `events` にホバー・ドラッグ・範囲選択も宣言している:

| 分類 | イベント名 |
|---|---|
| クリック | `cell.click` `point.click` `legend.click` `node.click` `link.click` `lane.click` `event.click` `parent.click` `tag.click` `time.click` `value.click` |
| ホバー | `point.mouseover` `point.mouseout` `node.mouseOver` `node.mouseOut` |
| ドラッグ | `node.drag` |
| 範囲選択 | `range.select` `range.selectBeforeZoom` |
| 描画完了 | `viz.renderedWithData` |

**しかしカスタム viz（拡張）で使えるのは click のみ。**
`config.json` の `events` に `point.mouseover` / `range.select` を宣言し、
ホバー／ドラッグのタイミングで `triggerDrilldown` を呼んでも**発火しない**（実機で確認）。

理由は明快で、**`addDrilldownListener` が click しか見ないから**
（型定義に "listens to 'click' events" と明記）。そして
**`triggerDrilldown` は効かない**（前述）。つまり
**「click 以外を発火する手段が存在しない」**。

→ カスタム viz のインタラクションは**クリック前提で設計する**。
ホバーでツールチップを出すなどは viz 内で完結させ、
ダッシュボード連携（トークン設定・リンク遷移）はクリックに割り当てる。

#### ⭐ 発火するのは `addDrilldownListener` だけ（`triggerDrilldown` は効かない）

**2026-07-25 実機で確定した最重要事項。**

`triggerDrilldown()` を各要素の `onClick` から呼んでも**トークンは更新されない**
（例外も出ないので気づきにくい）。**実際にインタラクションを発火させるのは
`addDrilldownListener` で登録した DOM ノードのクリック**である。

→ **クリック可能にしたい要素（セル・バー・ノード等）を1つずつ
`addDrilldownListener` に登録する**のが正解。`payloadCallback` はその要素専用に
行/列を閉じ込めておけばよい（固定で問題ない）。

```jsx
// 各セルの ref を集める
const cellRefs = useRef(new Map());

useEffect(() => {
    cellRefs.current.forEach((node, key) => {
        const [r, c] = key.split(':').map(Number);
        addDrilldownListener({
            node,
            action: 'cell.click',
            payloadCallback: () => buildPayload(r, c),   // ← この要素専用なので固定でよい
        });
    });
}, [rows.length, fields.join(','), JSON.stringify(rows)]);

// JSX 側
<td ref={(el) => { if (el) cellRefs.current.set(`${ri}:${ci}`, el); }} …>
```

これで**要素を押した瞬間にトークンが入る**（デフォルト viz と同じ挙動。実機確認済み）。

**⚠ ノードを1つだけ登録して `payloadCallback` を使い回さない。**
`payloadCallback` に `buildPayload(0, …)` のような**固定の行番号**を書くと、
**どこを押しても1行目の値が飛ぶ**（「2行目の OK を押したのに1行目の NG になる」症状。実際にやらかした）。

#### ⭐ 登録は「ノード1つにつき1回」にする（payload は WeakMap で差し替える）

上の `useEffect` 版は**データが変わるたびに同じノードへ登録し直す**形になっている。
**`addDrilldownListener` に解除手段は無い**（`removeDrilldownListener` は存在せず、
型定義の export にも無い＝確認済み）。React が同じ `<td>` を使い回すと登録が積み上がる。

→ **登録は1回だけにして、payload の方を毎レンダー差し替える**のが安全:

```jsx
const cellPayloads = useRef(new WeakMap());   // ノード → payload
const registeredCells = useRef(new WeakSet());

const attachCell = useCallback((node, payload) => {
    if (!node) return;                        // ref のデタッチ（null）は無視
    cellPayloads.current.set(node, payload);  // 毎レンダー入れ直す
    if (registeredCells.current.has(node)) return;
    registeredCells.current.add(node);
    addDrilldownListener({
        node,
        action: 'cell.click',
        payloadCallback: () => cellPayloads.current.get(node) || {},
    });
}, []);

// インライン ref は毎レンダー呼ばれるので、これが payload の更新契機になる
<td ref={(el) => attachCell(el, { ...rowTokens, name: field, value: text })} />
```

- **並べ替え・オプション変更のあとでも「その位置に表示されている行」の値が飛ぶ**
  （クリック時に WeakMap を読むため）。**実機確認済み**（severity-table v2.1.0 で
  別々の行・別々の列を押して、それぞれの値が飛ぶことを確認）。
- WeakMap / WeakSet なのでノードが捨てられれば一緒に回収される。
- **クリックを無効化したいときは、その要素を作り直す**（例: `<tbody key={clickable ? 'on' : 'off'}>`）。
  解除 API が無いので、**登録済みノードを捨てる以外に止める方法がない**。
- ⚠ **未検証**：「同じノードに2回登録すると1クリックで2回発火するか」は実機では試していない
  （ローカル検証のモックでは2回発火する）。**確かめる価値のない賭け**なので、
  そもそも二重登録しない作りにしてある。

参照実装: `visualizations/severity-table/.../visualization.jsx`（`attachCell`）。

#### テーブル以外（SVG 図形など）にも同じ手法が使える

登録するのは**任意の DOM ノード**なので、テーブルのセルに限らない。
world-map のアタックライン（`<path>`）、network-graph のノード（`<circle>`）、
treemap の矩形（`<rect>`）なども**要素ごとに ref を集めて登録すれば**クリックできる。

```jsx
// 例：world-map のアタックライン（データ1本 = 1 path）
const arcRefs = useRef(new Map());

useEffect(() => {
    arcRefs.current.forEach((node, id) => {
        const t = threats.find((x) => x.id === id);
        if (!t) return;
        addDrilldownListener({
            node,
            action: 'link.click',                    // config の events に宣言した名前
            payloadCallback: () => ({
                'row.src.value': t.srcName,
                'row.dst.value': t.dstName,
                'row.severity.value': t.severity,
                name: 'src', value: t.srcName,
            }),
        });
    });
}, [threats]);

<path ref={(el) => { if (el) arcRefs.current.set(t.id, el); }} d={d} … />
```

**⚠ 型定義は `node: HTMLElement` だが SVG 要素は `SVGElement`**（`HTMLElement` の派生ではない）。
実際に受け付けるかは**未検証**。動かない場合は、SVG 図形を透明な `<div>` でオーバーレイして
その div を登録する、`<foreignObject>` を使う、などの回避策を検討する。

- **当たり判定は太めに**：線や小さい点は押しにくいので、
  透明で太い `stroke`（`strokeWidth` 大 + `stroke="transparent"`）のパスを重ねて
  そちらを登録すると押しやすい（既存 viz のツールチップ用ヒット領域と同じ考え方）。
- **要素が再生成されると登録が外れる**：データ更新やアニメーションで要素を作り直す実装なら、
  `useEffect` の依存配列にデータを入れて**再登録**する。

**注意**：`triggerDrilldown` は**どの形でも例外を投げない**。サイレントに無視されるだけなので、
**「例外が出ない＝動いている」と判断してはいけない**。必ずトークンの値が変わったかを確認する。

### 有効化の 3 ステップ

**① `config.json` のトップレベル 2 フラグ**（`config` の中ではなく外側。既定はどちらも `false`）:

```json
{
  "showDrilldown": true,
  "hasEventHandlers": true,
  ...
}
```

- `showDrilldown` … 編集画面の「インタラクション」パネルにこの viz を出す
- `hasEventHandlers` … viz が発火したイベントをホスト側のハンドラへ流す

**② トークンを設定させるなら `canSetTokens`**（`["dynamic","static"]`）**＋ `events` 宣言**。
`events` が無いとトークン設定は動かない（上記参照）。

**③ viz 側でクリックを発火**（どちらか一方）:

```jsx
// 方式A: DOM ノードを登録してホストに click を任せる
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';

addDrilldownListener({
  node: barEl,                       // HTMLElement（SVG 要素も可）
  action: 'custom.click',
  payloadCallback: () => ({ name: 'host', value: 'host-1', data: { ...row } }),
});
```

```jsx
// 方式B: 自前の onClick から明示的に発火（React ではこちらが素直）
import { triggerDrilldown } from '@splunk/dashboard-studio-extension/visualization';

<rect onClick={(e) => triggerDrilldown({
  action: 'custom.click',
  payload: { name: 'host', value: row.host, data: row },
  originalEvent: e.nativeEvent,      // click 以外の起点なら指定
})} />
```

### API の所在（重要）

**`/react` サブパスに drilldown フックは無い。** `useDataSources` 等と違い、
`useDrilldown` のようなフックは存在しないので、**コアの
`@splunk/dashboard-studio-extension/visualization` から関数を直接 import** する
（`.d.mts` の export 一覧で確認済み）。

**公式ドキュメントの `addDrilldownListener` シグネチャは誤り。**
docs は位置引数 `(node, action, payloadCallback)` と書いているが、**実際の型定義は
単一オブジェクト引数** `({ node, action, payloadCallback })`。型定義（node_modules の
`visualization-*.d.mts`）が正。docs のコード例をそのままコピペすると動かない。

### 型

```ts
interface DrilldownPayloadState {
  earliest?: string | number;  latest?: string | number;
  data?: Record<string, unknown>;
  bounds?: string[];  name?: string;  value?: unknown;  action?: string;
  [key: string]: unknown;      // 任意キー可
}
interface DrilldownArgs {
  action: string;                    // 例 'custom.click'
  payload: DrilldownPayloadState;
  originalEvent?: Event;             // click 以外の起点で使う
}
declare const addDrilldownListener: (a: {
  node: HTMLElement; action: string; payloadCallback: () => DrilldownPayloadState;
}) => void;
declare const triggerDrilldown: (a: DrilldownArgs) => void;
```

`payload` の `name` / `value` が、インタラクション設定 UI 側でトークン
（`$name$` / `$value$` 相当）やリンク先 URL のパラメータに渡る値になる。
行全体を `data` に入れておくと、フィールド指定のインタラクションで参照できる。

### ダッシュボード JSON 側の書き方（`eventHandlers`）

viz が発火したイベントを**何に使うか**はダッシュボード側の `eventHandlers` が決める。
公式ドキュメント
[Setting tokens on a visualization click](https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/9.4/add-dashboard-interactions/setting-tokens-on-a-visualization-click)
に形が載っている（**カスタム viz でもそのまま使える。2026-08-07 実機確認済み**）:

```jsonc
"viz_table": {
  "type": "custom_viz_severity_table.custom_viz_severity_table",
  "options": { … },
  "eventHandlers": [
    { "type": "drilldown.setToken",
      "options": { "tokens": [
        { "token": "tok_sev",   "key": "row.severity.value" },
        { "token": "tok_name",  "key": "name" },
        { "token": "tok_value", "key": "value" }
      ] } }
  ]
}
```

`key` に指定できるのは **`name`（押した列名）/ `value`（押した値）/ `row.<フィールド名>.value`** の3種類。
**viz の `payloadCallback` が返すキーと1対1で対応する**ので、viz 側は
「全フィールドの `row.<名>.value` ＋ `name` ＋ `value`」を載せておけば標準テーブルと同じ使い勝手になる。

`drilldown.customUrl` などと併記して複数の動作を同時に設定することもできる（公式ドキュメント記載）。

### 実機での確認方法（クリックは押してみるしかない）

`tools/dashboard-loop/src/click-check.mjs` を使う。表示モードで開いてセルを押し、
クリック前後のスクリーンショットを撮る:

```bash
node tools/dashboard-loop/src/click-check.mjs <dashboard-name> <出力先> <押すセルの文字列>
```

トークンが入ったかは、**同じダッシュボードにトークンを使うパネル**
（`| makeresults | eval x="$tok_sev$"` や `| search severity="$tok_sev$"`）を置いて、
その表示が変わることで確認する。

⚠ **カスタム viz は iframe（`about:srcdoc`）の中に描画される**ので、
ページ本体の DOM を探しても要素は見つからない。`page.frames()` を辿ること。

### 注意

- **編集モードでは viz 内のマウス操作が iframe ごと遮断される**（§3 の既知事項）。
  クリックの動作確認は表示モードで行う。
- **`config.json` に `events` を足した回は splunkd の再起動が要る**（§7.1）。
  再起動前は「実装は正しいのにクリックしても何も起きない」状態になるので、
  **実装を疑う前にまず実機の config が新しいかを確認する**
  （`install-viz.mjs` が自動で警告する。`--restart` で再起動まで行う）。
- ローカル検証（§6）では `DashboardExtensionAPI` モックに
  `addDrilldownListener` / `triggerDrilldown` を生やしておくと、発火の有無を検査できる。

### ⭐ トークンは viz 間のメッセージバスとして使える（2026-08-09 実機確認済み）

**クリックで設定した動的トークンは、別パネル（別 iframe）のカスタム viz の
`useTokens` にもリアルタイムで届く。** つまり
「viz A のクリック → `drilldown.setToken` → viz B が `useTokens` で受信 → 描画だけ変える」
という **サーチ再実行なしの viz 間連携（リンクドハイライト）** が成立する。
実機で before/after の DOM 属性まで確認済み（`viz_check_vu_link`、vu-console v1.1.0）。

- 受信側は**トークン名で入れ子（env / default / submitted）を再帰走査**して値を取る
  （どの階層に入るかは名前次第。クリック設定分も届いた）。
- 受信側のオプション（購読するトークン名）は **optionsSchema に載せない**方式にすると、
  config.json 無変更＝**splunkd 再起動なしで既存 viz に横展開できる**
  （スキーマ外キーの永続化は実機確認済み）。
- 一致ゼロのトークン値では何も変えない実装にする（他パネル向けの値で
  全要素が沈む誤動作を避ける）。
- 参照実装: **ローカルブランチ `experiment/vu-console-token-bus`**（vu-console v1.1.0 の
  `findTokenValue()` / `highlightToken`。実機検証済み・main 未マージ）。

---

## 6. ローカル検証（happy-dom で実機なしにバンドルを叩く）

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

雛形は `visualizations/sankey-flow/test/verify.mjs`（`yarn verify` で実行、happy-dom は devDependency）を
流用する。モック一式・リスナー発火・オプション/データ/テーマ変更・ガード検証のパターンを網羅している。

### 「オプションは出るのに反映されない」症状の切り分け

config.json は新しいが `visualization.js` が古い（JS キャッシュ or 古い `.spl` をインストール）可能性大。
config.json と JS バンドルは別経路で配信される。§7 の `_bump` + ハードリロードと、正しい `.spl` の確認。

**逆の症状（「描画は新しいのに編集パネルが古い」＝新オプションが出てこない）は
splunkd のキャッシュ**。`_bump` では直らず、**splunkd の再起動が要る**。→ §7.1

---

## 7. デプロイ

> **【重要な訂正】この章は以前「アンインストール・再起動なし」と題していたが、
> `config.json` を変更した場合は誤り**（2026-08-07 実機で確認）。
> **JS（見た目）は `_bump` で反映されるが、`config.json`（編集パネル）は splunkd の再起動が要る。**
> 詳細は下の「§7.1 config.json は再起動しないと反映されない」。

1. `npm version <patch|minor> --no-git-tag-version` でバージョンを上げ、`app.conf` の version も同期。
   **`yarn build:prod && yarn package`** で新 `.spl` 生成（`yarn build` は開発ビルド。
   §1「ビルド & パッケージ」の混入事故を参照）。
2. Splunk Web「Install app from file」で **"Upgrade app"（上書き）にチェック**して `.spl` をアップロード。
3. ブラウザで `https://<host>:8000/en-US/_bump` を開き **Bump version**（Splunk 再起動の代替）。
4. ブラウザをハードリロード（Ctrl+Shift+R）。

**開発機（`~/.splunk-dev.env` の実機）では 2〜3 を自動化できる**（2026-08-07 実機確認済み）:

```bash
node tools/dashboard-loop/src/install-viz.mjs <viz名>   # 上書きインストール ＋ _bump
```

- **管理ポート(8089)の REST では `.spl` を送れない**。`POST /services/apps/local` /
  `POST /services/apps/appinstall` / Web の REST プロキシ `__raw/services/apps/local` の
  いずれも multipart を受け付けず **`Unparsable URI-encoded request data` (HTTP 400)**。
  これらの `name` は「splunkd から見えるパス / URL」を渡す前提。
- 効くのは **Splunk Web の `POST /en-US/manager/appinstall/upload_app`**
  （`appPackage` = ファイル、`forceOverride=1` = Upgrade 上書き）。
  必要な権限は **`install_apps` だけ**（`edit_local_apps` / `admin_all_objects` は不要）。
  画面上のボタンが表示されないロールでも**エンドポイントは通る**。
- 旧 UI の `/en-US/manager/appinstall/_upload` は **Splunk 10.4 では 404**（廃止）。

反映されない場合は §1「実機に反映されないとき」（リバースプロキシのキャッシュ）を参照。

### 7.1 config.json は splunkd を再起動しないと反映されない（2026-08-07 実機で確定）

**症状**：`.spl` を上書きインストールすると**描画（見た目）は新しくなるのに、
編集パネル（Configuration）は古いオプションのまま**。新しく足したオプションが出てこない。

**原因**：viz の2つの成果物は**配信経路が違う**。

| 成果物 | 配信経路 | 更新のされ方 |
|---|---|---|
| `visualization.js` | Splunk Web の静的アセット<br>`/en-US/static/@<bump>/app/<app>/visualizations/<app>/visualization.js` | **`_bump` + リロードで反映される** |
| `visualizations.conf` の `label` / `description` | splunkd の conf レイヤ | **インストールだけで反映される** |
| **`config.json`（editorConfig / optionsSchema / name / dataContract）** | **splunkd の REST**<br>`data/ui/visualizations?includeConfig=true` の `content.config` | **splunkd 内にキャッシュされ、再起動するまで古いまま** |

Studio の編集パネルはこの REST の `content.config` を読む。つまり
**`_bump` は editorConfig には一切効かない**（`_bump` は Splunk *Web* の静的アセット用）。

**実機で確かめたこと**（Splunk Enterprise 10.4.2。すべて splunkd 再起動なしで実施）:

- ディスク上の `config.json` は**新しい**
  （`/en-US/static/app/<app>/visualizations/<app>/config.json` を直接取得して確認）。
  → **ファイルは置き換わっている。古いのは splunkd のキャッシュだけ。**
- それでも `data/ui/visualizations?includeConfig=true` は**旧版の config を返し続ける**
  （namespace を `nobody/<app>` / `<user>/<app>` / `nobody/search` / 無指定 のどれにしても同じ）。
- 編集パネルのスクリーンショットでも**旧ラベルが並ぶ**（描画は新しいのに）。
- **効かなかった手段（すべて HTTP 200 が返るのに config は古いまま）**:
  - `/en-US/_bump`
  - `POST /services/apps/local/<app>/_reload`
  - `POST /servicesNS/nobody/<app>/data/ui/visualizations/_reload`
  - `POST /services/data/ui/visualizations/_reload`
  - `POST /services/configs/conf-visualizations/_reload`
  - `POST /services/admin/localapps/_reload`
  - `POST /en-US/debug/refresh?entity=data/ui/visualizations`
    （公式ドキュメントが挙げる「登録済み EAI ハンドラを全部 reload」する手段）
  - アプリの **disable → enable**（一覧から消えて戻るが config は古いまま）
- **公開ドキュメントにこの挙動の記述は無い**。
  [Customization options and caching](https://help.splunk.com/en/splunk-enterprise/developing-views-and-apps-for-splunk-web/10.4/customize-splunk-web/customization-options-and-caching)
  は `appserver/static` のキャッシュ対処として `_bump` / `debug/refresh` / **splunkd 再起動** /
  `web.conf` の `cacheEntriesLimit=0`（開発用）を挙げているが、
  `config.json` や `includeConfig` については何も書いていない。
  拡張 CLI のページも API リファレンスも、インストール後の反映手順に触れていない。

**運用（結論）**:

- **`config.json` を変えたリリースは splunkd の再起動が要る。**
  `_bump` では直らないので、「直したのに編集パネルが古い」と誤診しないこと。
- **JS だけの変更（描画・ロジック）なら再起動は不要**。インストール＋`_bump` で足りる。
- 🛑 **再起動は必ずユーザーの許可を取ってから実行する（毎回）。**
  権限があるので技術的には実行できるが、**再起動は実機を数十秒止める操作**であり、
  他の利用者・実行中のサーチ・スケジュール処理があるかどうかは**ユーザーしか知らない**。
  無言で再起動しない。断られたら再起動せずに進め、「編集パネルへの反映には再起動が必要」と
  明示して引き渡す（描画は `_bump` で確認できるので、確認できることは済ませておく）。
  → SKILL.md「🛑 splunkd の再起動は必ず許可を取る」
- **そもそも再起動を避けられないかを先に検討する。**
  編集パネルに出す必要が無い設定なら **`optionsSchema` に載せなければ再起動は要らない**
  （スキーマ外のキーも定義に保存され viz に届く。2026-08-08 実機確認。
  → 「options には optionsSchema に無いキーも来る」の章）。
- **開発機では再起動まで自動化できる**（2026-08-07 に `restart_splunkd` を付与して確認）。
  **許可を得たうえで**:

  ```bash
  node tools/dashboard-loop/src/install-viz.mjs <viz名> --restart
  ```

  `POST /services/server/control/restart` を叩き、`data/ui/visualizations` が
  新しい `optionsSchema` を返すまでポーリングして待つ。**実測 45 秒前後**で復帰する。
  `--restart` を付けなければ警告だけ出して終わる（＝**既定は再起動しない**。この挙動のままにしておく）。
- **未検証**：`web.conf` の `cacheEntriesLimit=0` は Splunk *Web* のキャッシュ設定で、
  今回の犯人（splunkd 側）とは層が違うため効かないと考えられるが、**試していない**。
  設定変更自体に再起動が必要なので、開発機で常時入れておく価値はあるかもしれない。

**まとめてインストールする場合**: `node scripts/collect-packages.mjs` で各 viz の
現行バージョンの `.spl` がリポジトリ直下の `packages/` に集約される
（git 管理外・毎回作り直し。旧バージョンが紛れない）。バージョン更新後は再実行する。

---

## 8. GitHub（ユーザーが手動 push）

- モノレポ `Aria-1429/custom-viz`（**public** / `main`。2026-07-30 に公開へ変更）。Claude は commit / push しない。
- push 前リークチェック: `git status --short | grep -E 'node_modules|dist/|stage/'`
  （`.spl` はコミット対象。それ以外のビルド成果物は `.gitignore` で除外）。
- `.gitignore` は「`dist/*` は無視、`!dist/*.spl` で `.spl` だけ救済」。ルート＋各 viz の両方に必要。
  新しい viz を追加したらこの 2 行が入っているか確認する。
- README は日本語（特徴・データ仕様・開発コマンド・デプロイ手順・サンプルSPL・リリースノート）。

---

## 9. データモデルの型

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

---

## 10. 同梱データ・素材のライセンス（著作権フリーのみ）

viz にバンドルする**データ・素材**（地図データ、GeoJSON/TopoJSON、アイコン、フォント、画像、辞書・
参照データ等）は、**著作権フリー＝パブリックドメイン、またはそれ相当のものだけを使う**。
「実行時のインターネット通信なし」制約とは別軸の話で、**バンドルする=再配布する**ため、素材本体の
再配布可否・条件がそのまま viz の配布条件になる。

### 採否の基準

- **可**：クレジット表記・出典明記・利用報告・承認申請のいずれも**「必須ではない」**もの。
  - パブリックドメイン / CC0 / PDDL。
  - MIT / BSD / ISC / Apache-2.0 等（主にコード・フォント）。ただし**データ本体のライセンスは別途確認**
    （パッケージのライセンスと中身のデータのライセンスは別なことがある。例：`world-atlas` は
    パッケージが ISC だが、**中身は Natural Earth=パブリックドメイン**。両方確認して初めて安全と言える）。
- **不可**：以下のいずれかが**必須**のもの。確実にフリーと言えなければ採用しない。
  - 出典表記・クレジット表示が必須（CC BY、政府標準利用規約 / 国土地理院コンテンツ利用規約 等）。
  - 継承（ShareAlike）が必須（CC BY-SA、ODbL＝OpenStreetMap 由来データ）。
  - 利用報告・事前承認が必要（旧「地球地図」系など）。
  - ライセンス不明・出所不明。

### 地図データの調達（第一候補：Natural Earth）

- **Natural Earth**（<https://www.naturalearthdata.com/about/terms-of-use/>）は明示的に
  **パブリックドメイン**：*"All versions ... are in the public domain."* /
  *"No permission is needed to use Natural Earth. Crediting the authors is unnecessary."*
  → **クレジット不要・商用可・改変可・再配布可**。地図系はまずこれを使う。
- **国レベル**：npm `world-atlas`（Natural Earth の再配布。`countries-110m/50m/10m.json`）。
  world-map viz が採用済み。
- **行政区画（州・都道府県=Admin-1）**：Natural Earth の `ne_10m_admin_1_states_provinces`
  （`nvkelso/natural-earth-vector` リポジトリの `geojson/` にパブリックドメインで置かれている。
  約 40MB）から対象国を `properties.admin==='Japan'` 等で抽出し、`topojson-server` で TopoJSON 化、
  `topojson-simplify` の presimplify→simplify で簡略化＋量子化して同梱する。
  japan-map viz がこの手順で 47 都道府県（`name`/`name_ja` 付き、153KB）を作成済み。
- **使ってはいけない代表例**：国土地理院「地球地図日本」「基盤地図情報」（出典表記必須）、
  GADM（再配布・商用に制限）、OpenStreetMap 由来（ODbL の継承義務）。
  ※ かつて japan-map v1.0.0 で `dataofjapan/land`（地球地図日本由来）を使い、**出典表記が必要**と
  判明して Natural Earth へ差し替えた経緯がある。最初からフリー素材を選ぶこと。

### 調達時のワークフロー

1. 素材を採用する前に**ライセンス原文（ToU / LICENSE / README のライセンス節）を必ず確認**する。
   開発中に Claude が公式サイトを参照するのは可（SKILL「制約」参照）。
2. パッケージ経由で入れる場合も、**パッケージのライセンス**と**同梱データの出所・ライセンス**の
   両方を確認する。
3. フリーと確認できたら、README の「地図データの出典・ライセンス」節に**パブリックドメインである旨**を
   記載する（表記は義務ではないが、後任が再確認せず済むように書いておく）。
4. 少しでも不明なら採用しない。代替のフリー素材を探すか、ユーザーに確認する。

---

## 11. バンドルした OSS のライセンス通知（THIRD_PARTY_NOTICES）

§10 は「**どの素材を採用してよいか**」の基準（CC BY / ODbL のように
データ本体に表示・継承義務があるものを避ける）。
本章はそれとは**別軸**で、「**採用してよいものを配布するときに何が要るか**」を扱う。

### 結論：MIT / ISC / BSD / Apache-2.0 でも条文の同梱が要る

これらは条件節で許諾している:

- ISC: *"provided that the above copyright notice ... appear in **all copies**"*
- MIT: *"The above copyright notice ... shall be included in **all copies**"*

**バンドル＝複製・再配布**なので、`.spl` とリポジトリの両方に条文を置く必要がある。
素材選定としては**可**であり、対応は「テキストファイルを1つ同梱する」だけ。

Splunk 側もこれを求めている（[Splunk App EULA](https://www.splunk.com/en_us/legal/splunk-app-end-user-license-agreement.html)）:

> "you must comply with any restrictions or requirements for the
> **third-party software (including any open source libraries) included in the App**"

Splunkbase 提出時・Cloud 審査で使われる AppInspect でも third-party ライセンス遵守は審査観点。

### 🚨 対象を `package.json` の dependencies から決めてはいけない

`react` / `react-dom` / `styled-components` / `@splunk/react-ui` / `@splunk/themes` /
`lodash` / `@emotion/*` は **devDependencies** に置かれているが、
`build.mjs` に `external` 指定が無いため **esbuild が配布物にバンドルする**。
**`dependencies` が空の viz でも 17〜20 パッケージが入っている＝全 viz が対象。**

各手段の実測比較（world-map。正解は 34 件）:

| 方法 | 件数 | 問題 |
|---|---|---|
| `package.json` の `dependencies` | 3 | React 等が漏れる |
| `yarn licenses list --production` | 6 | 同上。しかも未バンドルの `commander` を含む |
| `yarn licenses list`（全体） | 192 | `esbuild` / `happy-dom` 等ビルド専用まで混入 |
| `license-checker --production` | 7 | 同上 |
| バンドルの grep | 34 | インライン展開に弱く、誤検出もしやすい |
| **esbuild metafile の `outputs[*].inputs`** | **34** | **正確** |

### 手順（推測を排し、ビルド結果を基準にする）

1. **対象の特定**：`build.mjs` で `metafile: true` を有効にし、
   **`outputs[*].inputs`** からパッケージを抽出する。
   - `metafile.inputs` では**ない**。前者は tree-shaking で出力に残らなかったものを含み
     過剰になる（world-map では `internmap` が該当。実際のバンドルに含まれないことを確認済み）。
   - ソースマップ（`.map`）は配布物ではないので除外する。
2. **条文の取得**：`yarn licenses generate-disclaimer` の出力をそのまま使う（**手で書き写さない**）。
   - `--production` は使わない（devDependencies 由来が漏れる）。全体を取って①で絞る。
   - ⚠ **yarn は同一条文のパッケージを1ブロックにまとめる**
     （例 `product: @emotion/is-prop-valid, @emotion/memoize, @emotion/stylis.`）。
     先頭1件だけ拾うと大半を取りこぼす。**カンマ区切りを全て展開すること**。
3. **照合**：①の集合に②を突き合わせ、配布対象だけを収録する。
4. **個別条件**：Splunk 提供パッケージは OSS と混ぜない（後述）。
5. **同梱**：`package.mjs` で `.spl` にコピーし、**無ければ警告ではなく失敗させる**。
6. **esbuild 外の配布物を別途検査**：`config.json` / `app.conf` / `visualizations.conf` /
   `default.meta` / `app.manifest` は metafile に出ない。
   画像・フォント・地図データを将来 `import` ではなく直接コピーする形にすると、
   静かに追跡対象から外れる。

### `@splunk/dashboard-studio-extension` は OSS ではない

- `package.json` の license は **`SEE LICENSE IN LICENSE`**、同梱 LICENSE は
  **Splunk General Terms（商用契約）**。homepage / repository の記載も無い。
- **OSS ではないので、OSS の attribution 義務は発生しない**。
  契約全文（約 59KB / 通知全体の 33%）を OSS 通知に貼ると
  「OSS として再配布可能」と誤読させるため**貼らない**。
  パッケージ名・バージョン・参照先 URL のみ記載する。
- **同じ `@splunk/*` でも一律ではない**。`react-ui` / `themes` / `ui-utils` /
  `react-icons` は **Apache-2.0** なので通常の OSS として扱う。
  `package.json` の `license` を見て判定すること。
- **このパッケージを使って開発し、成果物を配布すること自体は問題ない**。
  General Terms が禁じる `distribute any Offering` の `Offering` は
  **Splunk の製品・サービス**を指す。条文には
  **`Third Party Extensions`（＝第三者が作った拡張）という区分が明示的に存在**し、
  Splunkbase での配布を前提にした語彙になっている。
  所有権も「Splunk は Splunk の成果物」「顧客は Customer Content」と分離されている。
  ※ 公式ドキュメント（API リファレンス / CLI ガイド）に**再配布可否の記載は無い**（確認済み）。

### 自動化できない部分

- **`styled-components` は MIT を宣言しているが LICENSE ファイルを同梱していない**。
  `generate-disclaimer` の出力に現れない。**条文を捏造せず**、
  「宣言は MIT・原文は配布元参照」と事実だけ書く。
- ライセンスの宣言すら無いパッケージは判断できないので**失敗させる**。

### 実装（world-map で稼働中。2026-07-30 に確立）

> **【訂正】** 旧記述の「v1.7.1 で試作。スクリプトは `.gitignore` 対象」は誤り。
> **その試作はコミットされずに消えており、リポジトリに存在しなかった**
> （2026-07-30 に調査して確認。ナレッジだけが残り実物が無い状態だった）。
> 再現性が目的なのに生成スクリプトを ignore するのは自己矛盾。
> **`scripts/gen-third-party-notices.mjs` はコミット対象**とし、今回コミットした。

構成（すべてコミット対象。world-map が参照実装）:

- `visualizations/<viz>/build.mjs` … `metafile: true` で `dist/<viz>/metafile.json` を出力
- `scripts/gen-third-party-notices.mjs`（リポジトリ直下・共通）… 各 viz から
  `yarn notices` で呼ぶ（`yarn build:prod && yarn notices` の順）。処理:
  metafile から対象特定 → `yarn licenses generate-disclaimer` から条文切り出し
  （カンマ区切りブロックを全展開）→ 無ければ node_modules の LICENSE ファイル →
  それも無ければ「宣言のみ・原文は配布元参照」→ **宣言すら無ければ exit 1**。
  非 OSS（license が SPDX の OSS 許諾でない。`SEE LICENSE IN LICENSE` 等）は
  参照情報のみの別枠。ハードコードせず license フィールドで機械判定する。
- `visualizations/<viz>/notices-data.json` … esbuild を通らない同梱素材
  （地図データ等）の申告。データ出典の節として収録される。
- `visualizations/<viz>/THIRD_PARTY_NOTICES.txt` … 生成物だが**コミット対象**。
  先頭に `Fingerprint:`（バンドルされた name@version 一覧の SHA-256）を持つ。
- `visualizations/<viz>/package.mjs` … NOTICES を `.spl` のアプリ直下へコピーする。
  **無い／Fingerprint が現在の metafile と不一致（＝依存が変わって古い）なら
  警告ではなく失敗**させる。3経路（成功・欠落・陳腐化）とも動作検証済み。

実測（world-map v1.8.1 時点・33 パッケージ）:
OSS 条文 31 件 + 宣言のみ 1 件（styled-components）+ 非 OSS 別枠 1 件
（`@splunk/dashboard-studio-extension`）。同梱データ申告 3 件（Natural Earth 系）。

**横展開の残作業**: 他の viz は build.mjs の metafile 出力・package.mjs の
NOTICES チェック・`yarn notices` スクリプト登録・notices-data.json が未導入。
各 viz を次に触るときに world-map から移植する（`.spl` の再生成が伴うので
build:prod 再パッケージと同時にやるのが効率的）。
