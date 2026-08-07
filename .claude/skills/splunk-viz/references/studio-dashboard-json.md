# Dashboard Studio の JSON を書く（ダッシュボード作成の実装ナレッジ）

`/splunk-viz` スキルの参照ナレッジ。**カスタム viz を並べた Studio ダッシュボードの
JSON を作る**ときに読む。viz 本体の実装ナレッジは
[studio-extension-viz.md](studio-extension-viz.md)（別物）。

参照実装（`Splunk-Dashboard-Examples/`）:

| ファイル | パネル数 | テーマ |
|---|---|---|
| `soc_mission_control_dashboard.json` | 21 | SOC 壁掛け。Attack Globe / Liquid Tube など新しい viz が主役 |
| `jp_infra_operations_dashboard.json` | 19 | 国内インフラ運用。Japan Map / Link Line が主役 |
| `network_topology_dashboard.json` | 18 | **機器構成監視。Icon Status のアイコンを Link Line で結んで手描きトポロジを組む**（下記） |
| `soc_custom_viz_dashboard.json` | 16 | SOC 統合監視（最初に作ったもの） |
| `soc_overview_dashboard.json` | 28 | **SOC 概要（デザイン画からの再現）**。左サイドバー（Spotlight Frame ＋ Icon Status 5枚）／KPI 6枚の横一列／World Map ＋ Donut ＋ MITRE の3分割／下段の一覧3枚＋ミニ地図という「参考画像レイアウトの写し取り」。ヘッダ・フッタに `splunk.markdown` を使う |
| `soc_incident_console_dashboard.json` | 16 | **クリックで連動する調査コンソール**（2026-08-07）。他の5枚が「見るだけ」なのに対し、**Severity Table のクリックがトークンを設定し、右の調査ペイン（Gauge / Radar）と下の関連イベントがそのホストに切り替わる**。`input.dropdown` で初期値を与えて「未選択で空パネル」を避けている（下記 §5.1） |

### パネルを組み合わせて「図」を作る（network_topology の手法）

**Icon Status（機器）と Link Line（線）を格子状に並べると、パネル配置そのものが
ネットワーク構成図になる。** network-graph の自動配置と違い、**意図した位置に機器を置ける**。

- 機器は `230x230` 程度の正方形、線は機器の**間**に `200x120`（横向き）／`120x130`（縦向き）
- 線の向きは `linePoints`（**正規化座標 0〜1 の JSON 文字列**）で決める:
  - 横: `"[[0.04,0.5],[0.96,0.5]]"` / 縦: `"[[0.5,0.04],[0.5,0.96]]"`
  - 空文字なら既定の水平線。表示画面の「✎ 線を編集」でドラッグ調整もできる
- 機器の中心と線の中心の **y（横線）／x（縦線）を揃える**と繋がって見える
  （例: 機器 y=176 h=230 → 中心 291。線 h=120 なら y=231）
- 自動配置の network-graph を**併置**すると、手描き図（意図した構成）と
  力学配置（実際の依存の重み）を見比べられる

---

## 0. 最重要：SPL の中の引用符をエスケープしない（2026-08-06 実機で発覚）

**JSON の `query` に書く SPL は「JSON の文字列として」1回だけエスケープする。
SPL 用に2重でエスケープしてはいけない。**

### 何が起きたか（実害）

`soc_mission_control_dashboard.json` の ds_timeline で、文字列結合の `"m"` を
`\\\"m\\\"` と書いた。JSON をパースすると **`\"m\"`（バックスラッシュ付き）** が
Splunk に渡り、**SPL の文字列リテラルとして成立せず結合が動かなかった**。

```
JSON ソースに書いた字面 : offset_start.\\\"m\\\"
    ↓ JSON.parse
Splunk が受け取る SPL   : offset_start.\"m\"      ← ✗ 不正。バックスラッシュが残る
正しく渡すべき SPL      : offset_start . "m"      ← ✓
```

**症状が分かりにくい**：JSON としては妥当なのでパースも保存も通り、
ダッシュボードは開ける。該当パネルだけが空になる／時刻が壊れるという形で出る。

### 正しい書き方

**「Splunk に渡したい SPL」をまず確定させ、それを JSON 文字列に入れるだけ**。
`"` は `\"` に、改行は `\n` にする。**それ以上は何もしない**。

```jsonc
// ✓ 正しい（SPL としては  eval x = host . "-suffix"  が渡る）
"query": "| makeresults | eval x = host . \"-suffix\""

// ✗ 誤り（SPL に \"-suffix\" が渡り、文字列リテラルにならない）
"query": "| makeresults | eval x = host . \\\"-suffix\\\""
```

`makeresults format=csv data="..."` も同じ。**CSV を囲む `"` は `\"` 1回だけ**:

```jsonc
"query": "| makeresults format=csv data=\"col1,col2\nA,10\nB,20\""
```

### 検算（書いた後に必ず実行する）

**目視では2重エスケープを見抜けない。** パース後の文字列を必ず出力して確認する:

```bash
node -e "
const d=require('./path/to/dashboard.json');
let ng=0;
for (const [k, v] of Object.entries(d.dataSources)) {
  const q = v.options.query;
  // パース後にバックスラッシュが残る＝2重エスケープの疑い
  if (q.includes('\\\\')) { console.log('✗ 残存バックスラッシュ:', k); ng++; }
}
console.log(ng === 0 ? '✓ OK' : '✗ ' + ng + ' 件');
"
```

> ⚠ この検査は**「バックスラッシュが残っていないか」だけ**を見る（実機確認済み・有効）。
> SPL が意味的に正しいかは別問題で、**最終的には実機で実行して確かめる**しかない。

### 引用符を避けられる場面では避ける

エスケープの事故を減らすため、**SPL 側の書き方で `"` を減らす**のも有効:

- 文字列結合より `strftime` / `printf` で済むならそちらを使う
- 相対時刻は `relative_time(now(), "-5m")` のように**リテラル1個**で書けるなら、
  変数と結合するより安全（結合が要る場合のみ `. "m"` を使う）
- `makeresults format=csv` の CSV 内では `"` を使わない値設計にする

---

## 1. ダッシュボード JSON の骨格

```jsonc
{
  "title": "…",
  "description": "…",
  "inputs":        { /* 時間レンジ等の入力 */ },
  "defaults":      { /* 全 dataSource / viz に効く既定値 */ },
  "visualizations":{ /* パネル定義。キーが item 名になる */ },
  "dataSources":   { /* サーチ定義 */ },
  "layout":        { /* 配置 */ }
}
```

```jsonc
"inputs": {
  "input_time": {
    "type": "input.timerange",
    "title": "時間範囲",
    "options": { "token": "global_time", "defaultValue": "-24h@h,now" }
  }
},
"defaults": {
  "dataSources": { "ds.search": { "options": { "queryParameters": { "latest": "now" } } } },
  "visualizations": { "global": { "showLastUpdated": false, "showProgressBar": false } }
},
"layout": {
  "type": "absolute",
  "globalInputs": ["input_time"],
  "options": { "backgroundColor": "#050a14", "display": "auto-scale", "width": 1920, "height": 2080 },
  "structure": [
    { "type": "block", "item": "viz_globe", "position": { "x": 20, "y": 254, "w": 940, "h": 600 } }
  ]
}
```

### カスタム viz の `type` は **`<appId>.<appId>`**

```jsonc
"viz_globe": {
  "type": "custom_viz_attack_globe.custom_viz_attack_globe",   // ← アプリIDを2回
  "title": "グローバル攻撃状況",
  "dataSources": { "primary": "ds_attacks" },
  "options": { /* viz の optionsSchema のキー */ }
}
```

- 標準 viz は `splunk.singlevalue` / `splunk.line` 等。
- **アプリ ID はフォルダ名ではなく `visualizations/<name>/visualizations/<appId>/` の `<appId>`**。
  例: `japan-map` の appId は `custom_viz_japanmap`、`world-map` は `custom_viz_worldmap`
  （**アンダースコアの位置が名前と違うものがある**ので必ず実物を確認する）。

### フィールド選択は DOS 文字列で書く

`editor.columnSelector` のオプションは、ダッシュボード JSON でも DOS 形式で渡す:

```jsonc
"srcLatField": "> primary | seriesByName('src_lat')"
```

viz 側はこれをパースして列を解決する（各 viz の `resolveFieldIndex()`）。
生のフィールド名を書いても動く実装が多いが、**標準に合わせて DOS 形式で書く**。

### ⚠ フィールド選択オプションを**持たない** viz がある（2026-08-06 に判明）

**全 viz に `*Field` があると思ってはいけない。** 一部の viz は
**列の順序で自動判定する設計**で、`optionsSchema` に `*Field` を1つも持たない:

| viz | フィールド指定 | データの渡し方 |
|---|---|---|
| **network-graph** | **無し** | 列を「送信元・宛先・値」の順で渡す |
| **sankey-flow** | **無し** | 列を「送信元・宛先・値」の順で渡す |
| **country-graph** | **無し** | 列を「国名・値」の順で渡す |
| tab-selector | 無し | そもそもデータを使わない |

ここに `sourceField` 等を書くと**「未知のオプション」**になる（§2 の検証で検出できる）。
代わりに **SPL 側で列順を整える**（`| table src dst value`）。

**着手前に確認するコマンド**（使う viz の `*Field` を一覧する）:

```bash
node -e "
const fs = require('fs');
for (const n of fs.readdirSync('visualizations')) {
  const p = 'visualizations/' + n + '/visualizations';
  if (!fs.existsSync(p)) continue;
  for (const app of fs.readdirSync(p)) {
    const cf = p + '/' + app + '/config.json';
    if (!fs.existsSync(cf)) continue;
    const s = JSON.parse(fs.readFileSync(cf, 'utf8')).config.optionsSchema || {};
    const f = Object.keys(s).filter(k => /Field$/.test(k));
    console.log(n.padEnd(20), f.length ? f.join(',') : '← 列順で自動判定（フィールド選択なし）');
  }
}
"
```

### ⚠ 列順で判定する viz には `| table` で列を明示する（2026-08-06 実機で発覚）

**`makeresults` の結果には `_time` 列が付く。** 列順で判定する viz
（network-graph / sankey-flow / country-graph）に渡すと **列が1つずれる**:

```
| makeresults format=csv data="src,dst,calls..."
  → fields = [_time, src, dst, calls]  ← 列0が _time になる
  → network-graph は 列0=送信元, 列1=宛先 と解釈 → 「_time → src」という
     無意味なリンクになり、値も非数値になって全行が捨てられる
```

実機では **`No valid network links found.`**（network-graph）というエラーが出た。
`makeresults format=csv` のヘッダを正しく書いていても起きるので気づきにくい。

**対策**：列順依存 viz に渡す SPL は**必ず `| table` で列を明示して締める**:

```jsonc
"query": "| makeresults format=csv data=\"src,dst,calls\n…\" | table src dst calls"
```

`*Field` を持つ viz（DOS でフィールドを指定する）はこの問題を受けない。
**§1「フィールド選択オプションを持たない viz」の表と必ずセットで確認する。**

### データの形が特殊な viz に注意

`*Field` があっても、**期待するデータの形**が独特なものがある。README のデータ仕様を読む:

- **metric-terrain** … `xField` / `yField` / `valueField` の**3列グリッド**（x × y の格子に
  高さを載せる）。「カテゴリ＋値」の2列を渡しても地形にならない。
- **japan-map** … 座標は**日本国内のみ**（投影が日本にフィットしているため国外は画面外）。
  色分けは `severityField` ＋ `severityColors`（world-map の「カテゴリ名\|色」形式とは**別**）。
- **link-line** … シングルバリュー（**最終行の値**のみ使用）。線の形（`linePoints`）は
  表示画面でドラッグ編集して保存する運用なので、**JSON には書かない**のが普通。

---

## 2. 書いたら必ず機械検証する（推測で書いた値は外れる）

**オプション名・選択肢の値は記憶や既定値からの推測で書かない。**
2026-08-06 に 21 パネルのダッシュボードを作った際、**推測で書いた5件が実際に無効**だった:

| 書いた値 | 実際の有効値 |
|---|---|
| `iconName: "activity"`（kpi-tile） | `pulse` 等 24 種のみ（activity は無い） |
| `deltaColorMode: "inverse" / "normal"` | `none` / `positiveGood` / `positiveBad` |
| `pulseMode: "crit"`（icon-status） | `none` / `ring` のみ |

**同じキー名でも viz ごとに有効値が違う**（`pulseMode` は spotlight-frame では
`none`/`warn`/`crit`/`always` が正しく、icon-status では `none`/`ring`）。
**一括置換すると別の viz を壊す**ので、viz 単位で確認する。

### ⭐ 検証は2本立て（2026-08-07 にツール化）

**書いたら必ずこの2つを通してから push する。** 毎回スクリプトを書き直さない
（自前で書き直して `backgroundColor` の除外を忘れ、23 パネル全部を誤検出した実績がある）。

```bash
# ① 定義との突き合わせ（実機不要）：オプション名・選択値・レイアウト・eventHandlers・inputs
node tools/dashboard-loop/src/validate-dashboard.mjs Splunk-Dashboard-Examples/*.json

# ② SPL を実機で1本ずつ実行（oneshot 検索）。0行・エラーを検出する
node tools/dashboard-loop/src/spl-check.mjs Splunk-Dashboard-Examples/<file>.json
```

- **①で分かるのは「定義と食い違っていないか」まで**。SPL が動くかは分からない。
- **②が本命**。`| eval x=round(3*係数,0)` のような**実行時にしか落ちない誤り**
  （§3 の日本語フィールド名）を、push する前に捕まえられる。
  トークンは `inputs` の `defaultValue` で埋めてから実行し、埋まらないものはスキップして報告する。
- ①のパネル高さ（推奨の 75% 未満）は**警告**扱い。細い帯として使う意図的な設計もあるため。

以下は①が内部でやっていることの説明（自分で書き直す必要はない）。

<details>
<summary>検証スクリプトの中身（参考）</summary>

リポジトリの `config.json` を正として突き合わせる。**5項目すべてを通す**:

```bash
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('Splunk-Dashboard-Examples/<file>.json', 'utf8'));

// 各 viz の optionsSchema と select/radioBar の許容値を集める
const schemas = {}, allowed = {};
for (const n of fs.readdirSync('visualizations')) {
  const p = 'visualizations/' + n + '/visualizations';
  if (!fs.existsSync(p)) continue;
  for (const app of fs.readdirSync(p)) {
    const cf = p + '/' + app + '/config.json';
    if (!fs.existsSync(cf)) continue;
    const cfg = JSON.parse(fs.readFileSync(cf, 'utf8')).config;
    schemas[app] = cfg.optionsSchema || {}; allowed[app] = {};
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if ((node.editor === 'editor.select' || node.editor === 'editor.radioBar')
          && node.option && node.editorProps?.values)
        allowed[app][node.option] = node.editorProps.values.map(v => v.value);
      Object.values(node).forEach(walk);
    };
    walk(cfg.editorConfig || []);
  }
}

// ホストが解釈する共通オプション（viz の optionsSchema には無いが正当）
const HOST_OPTS = new Set(['backgroundColor']);
// 列順で判定する viz（SPL に | table が必要。§1 参照）
const ORDER_DEP = new Set(['custom_viz_network_graph', 'custom_viz_sankey_flow', 'custom_viz_country_graph']);

let e = 0;
// ① type が実在し <app>.<app> 記法か  ② オプションキーが実在  ③ 選択値が有効
for (const [k, v] of Object.entries(d.visualizations)) {
  if (v.type.startsWith('splunk.')) continue;
  const app = v.type.split('.')[0];
  if (!schemas[app]) { console.log('✗ 未知の viz type', k, v.type); e++; continue; }
  if (v.type !== app + '.' + app) { console.log('✗ type 記法', k, v.type); e++; }
  for (const [key, val] of Object.entries(v.options || {})) {
    if (HOST_OPTS.has(key)) continue;
    if (!(key in schemas[app])) { console.log('✗ 未知オプション', k, key); e++; }
    const ok = allowed[app][key];
    if (ok && !ok.includes(val)) { console.log('✗ 無効な選択値', k, key, JSON.stringify(val), '→', JSON.stringify(ok)); e++; }
  }
  // ④ dataSource 参照 ＋ 列順依存 viz の | table
  const ds = v.dataSources?.primary;
  if (ds && !d.dataSources[ds]) { console.log('✗ 未定義 dataSource', k, ds); e++; }
  if (ORDER_DEP.has(app) && ds) {
    const q = d.dataSources[ds].options.query;
    if (!q.includes('| table') && !q.includes('| fields')) { console.log('✗ | table なし', k, ds); e++; }
  }
}
// ⑤ layout（重なり・はみ出し・未配置）
const S = d.layout.structure, L = d.layout.options;
for (const s of S) {
  if (!d.visualizations[s.item]) { console.log('✗ layout の item 未定義', s.item); e++; }
  const p = s.position;
  if (p.x < 0 || p.y < 0 || p.x + p.w > L.width || p.y + p.h > L.height) { console.log('✗ はみ出し', s.item); e++; }
}
for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
  const a = S[i].position, b = S[j].position;
  if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { console.log('✗ 重なり', S[i].item, S[j].item); e++; }
}
const placed = new Set(S.map(s => s.item));
Object.keys(d.visualizations).filter(k => !placed.has(k)).forEach(k => { console.log('✗ 未配置', k); e++; });
// ⑥ SPL の2重エスケープ（§0）
for (const [k, v] of Object.entries(d.dataSources))
  if (v.options.query.includes('\\\\')) { console.log('✗ 残存バックスラッシュ', k); e++; }

console.log(e === 0 ? '✓ 全チェック通過' : '✗ ' + e + ' 件');
"
```

</details>

**この検証で分かるのは「定義と食い違っていないか」まで。**
実際に表示されるか・SPL が意図どおり動くかは**実機でしか確認できない**（→ ②の `spl-check.mjs` と §6 の撮影）。

### 既存ダッシュボードにも回す（viz 改修で古くなる）

**viz のオプション名を変えると、過去に作ったダッシュボード JSON が静かに古くなる。**
未知のオプションは**エラーにならず無視される**ので、「なぜか既定の見た目に戻っている」
という形でしか気づけない。2026-08-06 に最初のダッシュボードを検証したら**27件**あった:

| 旧オプション | 現行 | 備考 |
|---|---|---|
| `color1`〜`color6`（donut 系） | `seriesColors`（配列） | 順序をそのまま配列にする |
| `seriesField1`〜`3` / `seriesColor1`〜`3`（radar） | `seriesFields` / `seriesColors` | 同上 |
| `criticalColor` / `highColor` …（severity-table） | `severityBands`（`[{from,to,value}]`） | 低い順に 0..5 のレンジへ |
| `sortByValue` + `sortAscending`（gradient-bar） | `sortMode`（`none`/`asc`/`desc`） | checkbox 2つ → select 1つに統合された |
| `severityField` + `lowColor`/`mediumColor`/`highColor`（world-map） | `categoryField` + `categoryColors`（`"名前\|色"`）+ `colorMode` | 深刻度専用 → 任意カテゴリへ一般化された |

**viz のオプションを改修したら、`Splunk-Dashboard-Examples/` の全ファイルに検証を回す**
（§2 のスクリプトをファイル名だけ変えて実行）。

---

## 3. サンプルデータ（`makeresults`）の書き方

**実データ無しで表示確認できるよう、全パネルを `makeresults` で動かす**のが基本。

```jsonc
// 静的な表（最も確実・読みやすい）
"query": "| makeresults format=csv data=\"label,value\nCPU,68\nMEM,88\""
```

```jsonc
// 時系列（現在時刻基準で生成する）
"query": "| makeresults count=48 | streamstats count as i | eval _time=relative_time(now(), \"-\".(48-i).\"m\"), host=\"web-01\", cpu=45+20*sin(i/4)+random()%12 | table _time host cpu"
```

### ⚠ 日本語のフィールド名を `eval` の**演算**に使うなら `'…'` で囲む（2026-08-07 実機で確定）

このリポジトリのダッシュボードは日本語のフィールド名を多用するので**踏みやすい**。

```
✗ | makeresults format=csv data="domain,係数\nA,0.86" | eval x=round(3*係数,0)
     → Error in 'EvalCommand': The expression is malformed.
       An unexpected character is reached at '係数,0)'.
✓ | … | eval x=round(3*'係数',0)                    ← 単一引用符で囲む
✓ | … | eval f=係数 … は不可。ASCII 名で計算して最後に `| rename` する方法も可
```

**代入先が日本語なのは問題ない**（`| eval 選択ホスト=round(3*f,0)` は通る）。
落ちるのは**式の中でフィールドを参照するとき**だけ。実機の oneshot 検索で
4パターン試して切り分け済み（引用符あり／なし × 代入先／オペランド）。

**パネルにはエラー文言が小さく出るだけ**なので、スクリーンショットを拡大しないと気づかない。
`spl-check.mjs`（§2）で先に潰すこと。

- 複数系列は `| append [ ... ]` で足す。
- `queryParameters` に `"$global_time.earliest$"` / `"$global_time.latest$"` を渡すと
  時間レンジ入力と連動する（`makeresults` 主体のサンプルでは実質効かないが、
  実データへ差し替えたときにそのまま動く形にしておく）。
- SPL の書き方の一般則（`mvexpand` が不発になる等）は
  [studio-extension-viz.md](studio-extension-viz.md) の「サンプル SPL の書き方」を参照。

---

## 4. レイアウトの実務

### ⚠ `layout` には2形式ある（検証スクリプトを書くときの注意）

**単一ページ**か**タブ付き**かで構造が違う。`d.layout.structure` を直接読むコードは
タブ付きのダッシュボードで `undefined` になり落ちる（2026-08-06 に実際に踏んだ）:

```jsonc
// 形式A: 単一ページ（structure が layout 直下）
"layout": { "type": "absolute", "options": {...}, "structure": [...] }

// 形式B: タブ付き（layoutDefinitions 配下に複数の structure）
"layout": {
  "globalInputs": [...],
  "tabs": { ... },
  "layoutDefinitions": { "layout_1": { "options": {...}, "structure": [...] } }
}
```

検証スクリプトは**両方を拾う**ようにする:

```js
const layouts = d.layout.structure
    ? [d.layout]                                   // 形式A
    : Object.values(d.layout.layoutDefinitions);   // 形式B
for (const L of layouts) { /* L.structure と L.options を見る */ }
```


- `display: "auto-scale"` にすると、宣言した `width`/`height` を基準に画面サイズへ拡縮される。
  壁掛け想定なら `1920 x <必要な高さ>` で組むと収まりが良い。
- **重なりは検証で機械的に潰す**（§2 の⑤）。目視では見落とす。
- 余白は 16〜20px で揃えると整う。左右の余白を同じにすると締まって見える。

### viz の背景は透過させる（2026-08-06 に指摘を受けて全ダッシュボードへ適用）

**viz ごとに背景を塗ると、ダッシュボード背景の上に「黒い箱」が並んで見える。**
特にアイコンを並べて図を作る構成（トポロジ図）では、箱の輪郭が図の意味を壊す。

#### ⭐ 大前提：パネル自体の透過は `"backgroundColor": "transparent"`（ユーザー情報）

**これが最も重要で、かつ見落としやすい。** パネルの器（ホストが描く背景）は
**viz の options に `backgroundColor` を指定して透過させる**:

```jsonc
"viz_node_fw": {
  "type": "custom_viz_icon_status.custom_viz_icon_status",
  "options": {
    "backgroundColor": "transparent",   // ← パネルの器を透過（ホストが解釈する）
    "showCard": false                   // ← viz 内部の塗りを消す（viz ごとに違う）
  }
}
```

**`backgroundColor` は viz の `optionsSchema` には存在しない**（全31 viz で確認済み）。
**ホスト側が解釈する共通オプション**で、標準 viz（`splunk.singlevalue` 等）でも同じキーを使う。

> ⚠ **検証スクリプト（§2）は `backgroundColor` を「未知のオプション」と誤検出する。**
> ホスト共通オプションは除外リストに入れること:
> ```js
> const HOST_OPTS = new Set(['backgroundColor']);
> // …ループ内で
> if (HOST_OPTS.has(key)) continue;
> ```
> 【関連】studio-extension-viz.md に「ホストが `backgroundColor: transparent` を勝手に
> 載せてくる」という記述があるが、**こちらから指定して透過させる用途にも使える**
> （2026-08-06 にユーザーから情報提供。**viz 実装側では未検証**）。

#### 加えて、viz 内部の塗りも切る

パネルを透過しても**viz が自前で塗っている背景**は残る。viz ごとに指定方法が違うので、
`optionsSchema` を見て使い分ける:

| viz | 透過の指定 | 効果 |
|---|---|---|
| **icon-status** | `showCard: false` | カード背景・枠線・影が消える（アイコンのグローは残る） |
| **attack-globe / liquid-tube** | `transparentBg: true` | WebGL の透過3点セットが働き背景が透ける |
| **world-map / japan-map** | `useBgColor: false` | viz 独自の背景塗りを止める（`bgColor` は不要になる） |
| **kpi-tile** | `bgOpacity: 20` 程度 | カード背景を薄くする（0〜100。100 で不透明） |
| **spotlight-frame** | `fillOpacity: 8`（既定） | 枠内の塗りは元から薄い。既定のままでよい |

**注意**：`transparentBg` を true にしたら `bgColor` は指定しない（不要なキーが残ると
意図が読みにくい）。逆に**不透過で使う viz は `bgColor` をダッシュボード背景と
同色**にすると箱に見えない。

### ⚠ パネルを低くしすぎると中身が見切れる（2026-08-06 に指摘を受けて是正）

**「重なっていない」だけでは足りない。** viz は狭いと段階的に要素を落とすので、
低いパネルに置くと**ラベルや凡例が消える／窮屈になる**。各 viz の実装にある閾値:

| viz | 閾値（実装から確認） | 下回ると |
|---|---|---|
| **icon-status** | `availH >= 110` でラベル、`>= 78` で数値<br>（`availH = h - pad*2`、`pad = clamp(min(w,h)*0.035, 4, 10)`） | ラベル→数値の順に消える |
| **metric-terrain** | `h >= 220`（`isShort`）、`h >= 150`（`isTiny`） | ヘッダ/凡例が縮小 → 凡例が消える |
| **gauge-arc** | サブパネル4スロットを使うなら **h >= 200** 目安 | 弧が小さくなり情報が詰まる |
| **horizon-chart** | 系列数 × `laneHeight` + 軸 + 凡例。5系列 × 30px なら **h >= 240** 目安 | レーンが潰れる |
| **spotlight-frame** | 枠＋バッジ＋件数内訳を出すなら **h >= 80** 目安 | バッジ・内訳が入らない |
| **link-line** | 線＋値ラベル＋接続名で **w >= 110 / h >= 100** 目安 | ラベルが重なる |

**着手時のチェック**（`config.json` の `size.initialHeight` に対する比を機械的に見る）:

```bash
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('Splunk-Dashboard-Examples/<file>.json', 'utf8'));
const sizes = {};
for (const n of fs.readdirSync('visualizations')) {
  const p = 'visualizations/' + n + '/visualizations';
  if (!fs.existsSync(p)) continue;
  for (const app of fs.readdirSync(p)) {
    const cf = p + '/' + app + '/config.json';
    if (!fs.existsSync(cf)) continue;
    const c = JSON.parse(fs.readFileSync(cf, 'utf8')).config;
    if (c.size) sizes[app] = c.size;
  }
}
const layouts = d.layout.structure ? [d.layout] : Object.values(d.layout.layoutDefinitions);
for (const L of layouts) for (const s of L.structure) {
  const v = d.visualizations[s.item]; if (!v) continue;
  const rec = sizes[v.type.split('.')[0]]; if (!rec) continue;
  const r = s.position.h / rec.initialHeight;
  if (r < 0.75) console.log('低い:', s.item, s.position.h, '/ 推奨', rec.initialHeight, (r*100).toFixed(0)+'%');
}
"
```

**2026-08-06 の実例**：最初のダッシュボードを実機で見たら、10行のテーブル（severity-table）と
10カ国のランキング（country-graph）に**スクロールバーが出ていた**。推奨比を測ると
**12パネル中8つが 75% 未満**で、行の高さを一律に低く取りすぎていた。
行ごとに「その行で一番大きい推奨高さ」に寄せて積み直すと解消した。

> ⚠ この比だけで機械的に判断しない。**意図的に細長くする形もある**
> （Liquid Tube を 68x600 の試験管として使う等）。**実装の閾値**（上の表）を満たしていれば
> 推奨比が低くても問題ない。逆に閾値を割っていたら比に関わらず直す。

> 推奨サイズを下回ること自体は**必ずしも不可**ではない（Liquid Tube を細長い
> 68x600 で使うなど、意図的な形もある）。**「その viz が何を落とすか」を実装で確かめてから**
> 決める。判断できないときは推奨サイズに寄せておくのが安全。
- **WebGL を使う viz（Attack Globe / Liquid Tube）を同一ダッシュボードに複数置くと、
  ブラウザの同時 WebGL コンテキスト上限（実装依存で 8〜16 程度）に当たる可能性がある**
  （**未検証**。詳細は [webgl-in-custom-viz.md](webgl-in-custom-viz.md) の未検証項目）。
  表示が不安定なら数を減らして切り分ける。

---

## 5.1 クリックで連動させる（インタラクション）

**カスタム viz でも標準 viz と同じようにトークンを設定できる**（2026-08-07 実機確認済み。
参照実装 `soc_incident_console_dashboard.json`）。viz 側の対応は
[studio-extension-viz.md](studio-extension-viz.md) の §5、ダッシュボード側は下記。

```jsonc
"viz_queue": {
  "type": "custom_viz_severity_table.custom_viz_severity_table",
  "options": { … },
  "eventHandlers": [
    { "type": "drilldown.setToken",
      "options": { "tokens": [
        { "token": "sel_host", "key": "row.host.value" },
        { "token": "sel_rule", "key": "row.rule.value" }
      ] } }
  ]
}
```

### ⚠ 未設定のトークンを使うパネルは「Set token value to render visualization」になる

**実機で確認した表示**：トークンが未設定だとパネルは描画されず、警告アイコンと
`Set token value to render visualization` が出る。**クリック前の初期状態がこれだと壊れて見える。**

→ **`input.dropdown` で同じトークンに既定値を与える**（実機確認済み）:

```jsonc
"inputs": {
  "input_host": {
    "type": "input.dropdown",
    "title": "調査対象ホスト",
    "options": {
      "token": "sel_host",
      "defaultValue": "web-01",
      "items": [ { "label": "web-01", "value": "web-01" }, … ]
    }
  }
},
"layout": { "globalInputs": ["input_time", "input_host"], … }
```

- **`layout.globalInputs` に入れないと画面に出ない**。
- **ドロップダウンとドリルダウンは同じトークンを共有でき、表示も同期する**
  （行をクリックすると**ドロップダウンの選択も切り替わった**。実機確認済み）。
  つまり「初期値を与える」と「クリックで切り替える」を両立できる。

### パネルタイトルにトークンを書ける

`"title": "$sel_host$ のリスクスコア"` は**実機で置換される**（確認済み）。
選択中の対象をタイトルに出すと、どのパネルが連動しているのかが一目で分かる。

---

## 5. カスタム viz を並べるときの注意

- **そのダッシュボードで使う viz アプリがすべてインストール済みである必要がある**。
  未導入のものがあると、そのパネルだけエラーになる。
- **トークンを設定する viz（Tab Selector 等）は JSON だけでは完結しない**。
  編集画面「インタラクション」で「トークンを設定」を**1回だけ手動設定**する必要がある
  （カスタム viz は自分でトークンを書けないため。詳細は
  [studio-extension-viz.md](studio-extension-viz.md) の「ドリルダウン」章）。
  JSON にはタブ定義までしか書けないので、**引き渡し時に必ずこの手順を伝える**。
- データ不要の viz（Tab Selector）は `dataSources` を書かない
  （`dataContract` が空配列なので、書くと逆にデータソース指定を求められる）。

---

## 6. 実機へ push して画面を見る（自動ループ）

**2026-08-07 構築・実機確認済み。手貼りは不要になった。**
`tools/dashboard-loop/` に、JSON を実機へ push してスクリーンショットを撮るツールがある。
**撮った PNG は Read ツールで画像として見える**ので、「実装 → 画面を見る → 微調整」を
Claude 側だけで回せる。詳細は [tools/dashboard-loop/README.md](../../../../tools/dashboard-loop/README.md)。

```bash
# push → 撮影（通常はこれだけ）
node /home/ishitsuki/work/custom-viz/tools/dashboard-loop/src/sync.mjs <dashboard.json> \
     --name <id> --out <出力先> --panels
```

接続設定は `~/.splunk-dev.env`（git 管理外）。**認証情報をチャットやリポジトリに書かない。**

### 実機で確認した事実（Splunk Enterprise 10.4.2 / <開発機のIP>）

| 事項 | 結果 |
|---|---|
| REST `data/ui/views` での作成・更新・読み戻し・削除 | 全て動作（`<dashboard version="2">` + CDATA） |
| ヘッドレス Chromium の WebGL2 | **動く**。GLSL ES 3.00／ANGLE + SwiftShader |
| パネルのセレクタ | **`[data-test="viz-item"]`**（`data-id` = `visualizations` のキー、`data-viz-type` = viz の型） |
| ダッシュボード本体の領域 | **`[data-test="canvas"]`** |
| アプリの新規作成 | **`power` ロールでは不可**（要 `admin_all_objects` / `edit_local_apps`）。既存アプリへの書き込みは可 |
| `.spl` のインストール／アップグレード | **可**（2026-08-07 に `install_apps` を付与して確認）。`tools/dashboard-loop/src/install-viz.mjs`。⚠ **管理ポート(8089)の REST では送れない**（`services/apps/local` / `services/apps/appinstall` とも multipart 非対応で `Unparsable URI-encoded request data`）。効くのは Splunk Web の `POST /en-US/manager/appinstall/upload_app`（`appPackage` + `forceOverride=1`） |

### 踏んだ落とし穴

- **⚠ 一発の撮影を信用しない。サーチが終わらないと正常なパネルでも「データがありません」になる。**
  同じ JSON を撮り直すたびに**空になるパネルが変わった**（35秒→3枚、75秒→2枚、90秒→0枚）。
  スクショだけ見て「このパネルは壊れている」と判断すると**誤診する**。
  → `shot.mjs` は空表示パネルを数えて警告する。出たら `--wait` を伸ばして撮り直し、
  それでも空なら初めてデータ側の問題と判断する。既定の待ちは 75 秒。
- **⚠ カスタム viz は iframe 内で描画される**（このダッシュボードで 23 枚。実機確認済み）。
  そのためホスト DOM の `textContent` では**中身が一切読めない**。
  最初この実装で空表示検出を書き、**「検出ゼロ」と報告しながら画面には空パネルが2枚写っていた**。
  パネルの中身を読む処理は必ず `iframe` の `contentFrame()` を辿ること。
- **オプション検証は §2 のスクリプトをそのまま使う。自前で書き直さない。**
  自前で書いて `HOST_OPTS`（`backgroundColor`）の除外を忘れ、**23 パネル全部を
  「無効オプション」と誤検出した**。§2 のスクリプトには最初からこの除外が入っている。
- **⚠ 縦長のダッシュボードは `--scale 1` で撮る**（2026-08-07）。
  既定の 2x（`deviceScaleFactor: 2`）だと 1920x2200 のダッシュボードで画像が巨大になり、
  **`page.screenshot: Timeout 30000ms exceeded`** で撮影自体が失敗する。
  「fonts loaded」の直後に固まるのが特徴。`--scale 1` にすると通る。
- **ビューポートが足りないと折り返しより下のパネルが空白のまま撮れる。**
  レイアウト 1920x1680 を 1920x1080 で撮って下段4パネルが空白になった。
  **パネル個別撮影は要素を可視域へスクロールするので影響を受けない**ため、
  「個別は撮れているのに全体だと空白」という紛らわしい出方をする。
  → `[data-test="canvas"]` の実寸を測ってビューポートを自動追従させて解決。
- **共有をアプリレベルに上げると所有者が `nobody` に移り**、ユーザー名前空間の
  URL では GET/DELETE が 404 になる。両方の名前空間を試すこと。
- **描画完了は DOM のロード完了では判定できない**（サーチ実行が挟まる）。
  「スクショが2回連続で同一」で判定する。アニメーションする viz は
  永久に安定しないので上限時間で打ち切る（異常ではない）。

---

## 7. 引き渡し時に必ず伝えること

ダッシュボード JSON を提示したら、以下を添える:

1. **実機での見え方**：§6 のループで撮ったスクリーンショット（手貼りを頼む前に自分で見る）
2. **インポート手順**：手貼りする場合は Studio で新規作成 →「ソースコードを編集」に全文貼り付け
3. **前提**：必要な viz アプリの一覧（未導入だとそのパネルだけ落ちる）
4. **手動設定が要る箇所**：トークン設定（インタラクション）など
5. **未検証の点**：実機でしか分からないもの
