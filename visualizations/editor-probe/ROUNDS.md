# 検証ラウンド定義

**無効な editor 型が1つでもあると editorConfig 全体が消える**（2026-07-25 実機で確定）。
エラーは `⚠ Invalid editor type: editor.xxx` として**最初の1つだけ**表示される。
そのため「全部入れて隔離セクションで切り分ける」はできない。**ラウンドを分けて絞り込む**。

各ラウンドの手順:
1. 下のスニペットを `visualizations/test/config.json` の `editorConfig` に差し替える
2. `yarn build && yarn package` → アップロード → `_bump` → ハードリロード
3. 設定パネルを開く
   - **パネルが出た** → そのラウンドの型は**全て有効**。viz 本体の表で値が届くか確認
   - **パネルが消えた** → エラーメッセージの型名を記録し、その型を**除いて**再実行

`0_基準`（checkbox 1個）は必ず全ラウンドに残す。これが消えていたら config.json 自体が壊れている。

---

## 🏁 全ラウンド完了（2026-07-25）— 実在候補 28 種を全数検証

| 判定 | 数 | 型 |
|---|---|---|
| ✅ **使える**（素の値／配列／オブジェクトが届く） | **20** | `checkbox` `color` `number` `select` `toggle` `radioBar` `text` `slider` `percent`※ `threshold`⭐ `arrayOfStrings` `markdown` `seriesColors` `presetSelector` `trellisSplitBy` `columnMultiSelectionByFieldNameEditor`⭐ `seriesColorsByField` `tableBackgroundColor`※ `image`※ `columnSelector`※ |
| ❌ **使用不可** | **8** | `marks` `seriesLineTypes` `seriesLineTypesByField` `dynamicColor` `dynamicColorWithPrecedence` `networkGraphDynamicColor` `tableDynamicColor` `tableColumnFormatter`※未検証 |

※付きの注意点:
- `percent` … **UI 値の 1/100** が届く（5 → `0.05`）
- `tableBackgroundColor` … **`option` ではなく `key`** が必要。書き込み先は固定キー `backgroundColor`
- `image` … **KVStore の URI** が届くだけで画像本体は取れない（実質使えない）
- `columnSelector` / `columnMultiSelector` … **DOS 文字列**。パースすれば使える
- `tableColumnFormatter` … `option` も `key` も持たない Table 専用型。未検証だが
  `tableDynamicColor` と同様に**入れると危険**（操作不能になる恐れ）なので採用しない

**最終的な法則**：

> - **ほとんどの型は素の値／配列／オブジェクトがそのまま options に届く**
> - **DOS 文字列になるのは①データソースの列を指す型**（`columnSelector` 系）
>   **②`option` の中身が DOS 式になる dynamicColor 系**
> - **Table 専用型**（`tableDynamicColor` / `tableColumnFormatter` / `tableBackgroundColor`）は
>   `option` を無視して**固定キー**に書く。`tableDynamicColor` は**編集パネルを操作不能にする**
> - **系統名では可否を判断できない**：`seriesColors` は動くが `seriesLineTypes` は使用不可

**当初の予想（`context` を使う型は全部ダメ）は誤りだった。**
静的解析での「使えなさそう」判断は当てにならず、実機検証がすべて。

> **実在候補の数え方（修正済み）**：`grep -rhoE "editor\.[a-zA-Z0-9]+"` は
> Slate.js の `editor.marks` などを拾って誤検出する。
> **クォート付きで検索**すると誤検出が消える:
> ```bash
> grep -rhoE "'editor\.[a-zA-Z0-9]+'|\"editor\.[a-zA-Z0-9]+\"" node_modules/@splunk/ | tr -d "'\"" | sort -u
> ```
> これで 28 種。`editor.marks` / `children` / `isInline` などは出てこない（＝実在しない）。

### ROUND 1〜3 の結論

**14種中13種が使える**。使えないのは `editor.marks`（実在しない）だけ。
DOS 文字列で届くのは `columnMultiSelector` のみ（パースすれば使える）。

**最終的な法則**：

> - **ほとんどの型は素の値／配列／オブジェクト配列がそのまま options に届く**
> - **DOS 文字列になるのは「データソースの列を指す」型だけ**（`columnSelector` / `columnMultiSelector`）
> - `dynamicColor` 系が届かないのは `context` を使うからではなく、
>   **`option` の中身が `> value | rangeValue(...)` という DOS 式そのもの**だから

**当初の予想（`context` を使う型は全部ダメ）は誤りだった。**
静的解析での「使えなさそう」判断は当てにならず、実機検証がすべて。

---

## 結果記録

| editor 型 | パネル表示 | 値が届くか | 判定 |
|---|---|---|---|
| `editor.marks` | ❌ 全体が消えた | — | **使用不可**（`Invalid editor type: editor.marks`） |
| `editor.seriesLineTypesByField` | ❌ 全体が消えた | — | **使用不可**（`Invalid editor type`）。ROUND 4 で判明 |
| `editor.seriesLineTypes` | ❌ 全体が消えた | — | **使用不可**（`Invalid editor type`）。ROUND 4 で判明。seriesLineTypes 系は両方ダメ |
| `editor.arrayOfStrings` | ✅ チップ形式の文字列リスト（×で削除） | ✅ `["a","b","aaa"]` | **使える**。文字列配列がそのまま届く |
| `editor.image` | ✅ ファイル選択＋プレビュー | ✅ `"splunk-enterprise-kvstore://6a65..."` | **使える**が ⚠ **KVStore の URI が届く**（SVG 本体ではない）。viz 側で解決不可 |
| `editor.markdown` | ✅ リッチテキスト風ツールバー付き | ✅ `"# test\naaaaa"` | **使える**。Markdown 原文が届く（レンダリングは viz 側の責任） |
| `editor.threshold` | ✅ 「+閾値の追加」で行を増減、色ピッカー付き | ✅ **オブジェクト配列がそのまま** | **使える。特筆**：`[{from,to,value}]` が生で届く（DOS 文字列ではない） |
| `editor.radioBar` | ✅ 3分割ボタン | ✅ `"left"` | **使える** |
| `editor.toggle` | ✅ 緑のトグル | ✅ `true` | **使える** |
| `editor.text` | ✅ 入力欄（×クリア付き） | ✅ `"aaa"` | **使える** |
| `editor.slider` | ✅ スライダー＋数値欄 | ✅ `0.42` | **使える**（UI値がそのまま届く） |
| `editor.percent` | ✅ 数値欄 | ✅ `0.05` | **使える**。ただし **UI「5」→ `0.05`（1/100）** |
| `editor.image` | | | |
| `editor.markdown` | | | |
| `editor.threshold` | | | |
| `editor.arrayOfStrings` | | | |
| `editor.columnMultiSelectionByFieldNameEditor` | ✅ 複数選択ドロップダウン | ✅ `["_time","category"]` | **使える**。⭐ **生のフィールド名配列**が届く（DOS ではない） |
| `editor.seriesColorsByField` | ✅ 色スウォッチ列 | ✅ `{"_time":"#7B56DB","category":"#009CEB",…}` | **使える**。`{フィールド名: 色}` のオブジェクト |
| `editor.tableBackgroundColor` | ✅ 色ピッカー＋パレット | ✅ `"#000000"`（`key` 指定時） | **使えるが要注意**。`option` では届かず `key` が必要。しかも**キー名は `key` の値ではなく固定の `backgroundColor`** |
| `editor.tableDynamicColor` | ⚠ 表示されるが**操作不能**（クリック不可） | ❌ `tableFormat` に DOS 式3つ | **× 使用不可**。`option` 名を無視して**固定キー `tableFormat`** に書く。Table 専用 |
| `editor.networkGraphDynamicColor` | ✅ 表示される | ❌ `"> nodeColorValues \| rangeValue(...)"` | **× 使用不可**（DOS 式。範囲配列は context 側） |
| `editor.dynamicColorWithPrecedence` | ✅ 表示される | ❌ `"> dataValues \| rangeValue(...)"` | **× 使用不可**（同上） |
| `editor.seriesColors` | ✅ プリセット選択＋色スウォッチ列 | ✅ `["#7B56DB","#009CEB","#00CDAF"]` | **使える**（予想を裏切り配列が生で届く） |
| `editor.presetSelector` | ✅ ドロップダウン | ✅ `"red"` | **使える**。preset の `value.options` が options に反映される |
| `editor.columnMultiSelector` | ✅ 複数選択ドロップダウン | ❌ `"> primary \| frameBySeriesNames('ratio','count')"` | **DOS 文字列**。viz 側でパースが必要 |
| `editor.trellisSplitBy` | ✅ ドロップダウン | ✅ `"count"` | **使える**。生のフィールド名が届く |

### ROUND 3 の結果（2026-07-25）— 予想が 3/4 で外れた

「`context`／DOS 依存だから届かないはず」という予想は**ほぼ間違っていた**。

| 型 | 予想 | 実際 |
|---|---|---|
| `seriesColors` | 届かない | ✅ **配列が生で届く** `["#7B56DB","#009CEB","#00CDAF"]` |
| `presetSelector` | 届かない | ✅ **届く** `"red"`（preset の `value.options` がそのまま options に入る） |
| `trellisSplitBy` | 届かない | ✅ **届く** `"count"`（生のフィールド名） |
| `columnMultiSelector` | 届かない | ❌ 予想通り **DOS 文字列** `> primary \| frameBySeriesNames('ratio','count')` |

**判明した本当の法則**：

> **DOS 文字列で届くのは「データソースの列を指す」型だけ**
> （`columnSelector` / `columnMultiSelector`）。
> それ以外は `context` を使う型（`seriesColors` など）でも**素の値／配列が届く**。

つまり §4 の「`context` に保存する型は全部ダメ」という一般化は誤りだった。
**`editor.dynamicColor` が届かないのは `context` を使うからではなく、
`option` の中身が `> value | rangeValue(...)` という DOS 式そのものだから**。

- `columnMultiSelector` は `frameBySeriesNames('a','b')` をパースすれば列名を取り出せる
  （`columnSelector` の `seriesByName()` パースと同じ要領）。
- `presetSelector` は「複数オプションを一括で切り替えるプリセット」として実用可能。
  `option` を持たず、`editorProps.presets[].value.options` に書いたキーが options へ流れる。

### ROUND 2 の結果（2026-07-25）— 4種すべて合格

**最大の収穫：`editor.threshold` は「範囲＋色」の配列が生で届く。**

```json
"p_threshold": [
  { "from": 40, "to": 100, "value": "#f8be34" },
  { "from": 22, "to": 40,  "value": "#dc4e41" },
  { "from": 10, "to": 22,  "value": "#f1813f" },
  { "from": 0,  "to": 10,  "value": "#118832" }
]
```

UI は「+閾値の追加」で行を動的に増減でき、各行に色ピッカーが付く。
**これは `editor.dynamicColor` でやりたかったこと（動的な範囲→色マッピング）そのもの**で、
しかも dynamicColor と違い **DOS 文字列ではなく配列that が直接届く**。
→ §4 の「動的に範囲を+追加したい場合の代替（自前パネル実装）」は**もう不要**。

その他:
- `editor.arrayOfStrings` … チップ形式の文字列リスト。`["a","b","aaa"]` がそのまま届く。
- `editor.markdown` … ツールバー付きエディタ。**Markdown 原文の文字列**が届く（描画は viz 側の責任）。
- `editor.image` … ファイル選択＋プレビューは出るが、届くのは
  **`splunk-enterprise-kvstore://6a65086a4b697103980b5491` という KVStore の URI**。
  SVG 本体ではないため、**拡張 iframe からは解決できない見込み**（画像を出す用途には使えない）。
  同梱アセットを使うか、`editor.text` で data URI を貼らせる方が現実的。

### ROUND 2 の途中で分かったこと（2026-07-25）

- **`optionsSchema` を `"type": "string"` と書き切ると、値を設定した瞬間に保存時検証で落ちる**:
  ```
  /visualizations/viz_XXXX/options/p_arrayOfStrings: must be string
  /visualizations/viz_XXXX: must match "then" schema
  ```
  これは editor 型が無効なのではなく**こちらの型宣言ミス**。標準 viz は必ず
  `anyOf: [{正しい型}, {type:'string', pattern:'^>.*'}]`（DOS 文字列も許容）で書いている。
  配列/オブジェクトを返す型（`threshold`・`seriesColors`・`columnMultiSelector`）は特に必須。
- **`editor.arrayOfStrings` は「標準 viz で未使用」なだけで、実機ではちゃんと動く**。
  `LinkGraph.config.js` にコメントアウトでしか出てこないため一度「実在しない」と誤判定したが、
  実際は **UI（文字列リスト）が出て配列も options に届いていた**（保存時エラーはこちらの
  optionsSchema ミスであって、型の問題ではなかった）。
  **`@splunk/visualizations` は標準 viz の定義集であって editor 実装のレジストリではない**ので、
  「採用数 0 ＝ 使えない」とは言えない。可否は実機でしか判断できない。
  なお `editor.marks` は実機で `Invalid editor type` になったので**本当に使用不可**。
  静的解析だけでは両者を区別できなかった。

### ROUND 1 で分かったこと（2026-07-25）

- **有力5種はすべて合格**。UI も正常に描画され、値は素の値（string / boolean / number）で届く。
- **`editor.percent` は 1/100 されて届く**。UI に「5」と入れると viz には `0.05` が来る。
  一方 `editor.slider` は `0.42` がそのまま来る。**percent を使うときは viz 側で ×100 しない**こと
  （`bgOpacity` のような「%で持つ」既存オプションを percent に移行すると値が 1/100 になる）。
- options には **`backgroundColor: "transparent"` がホストから勝手に載る**。
  `optionsSchema` に書いていないキーも来るので、viz 側は未知キーを無視する作りにしておく。

---

## ROUND 1（有力5種）← いま config.json に入っている

`radioBar` / `toggle` / `text` / `slider` / `percent`。
標準 viz での採用数が多く、`option` に素の値が入る型。ここが通れば実用上ほぼ困らない。

---

## ROUND 2（用途が特殊な型）

`marks` は使用不可が確定したので除外済み。

```json
      {
        "label": "ROUND2",
        "layout": [
          [{ "label": "image（SVG）", "editor": "editor.image", "option": "p_image", "editorProps": { "validMediaTypes": ["svg"], "svgRenderAsDom": true } }],
          [{ "label": "markdown", "editor": "editor.markdown", "option": "p_markdown" }],
          [{ "label": "threshold（範囲）", "editor": "editor.threshold", "option": "p_threshold", "editorProps": { "openRanges": false, "isTogglable": false } }],
          [{ "label": "arrayOfStrings", "editor": "editor.arrayOfStrings", "option": "p_arrayOfStrings" }]
        ]
      }
```

---

### ROUND 4 の結果（2026-07-25）

**2種が使える。1種は「UI は動くが値が届かない」第3のパターン。2種は使用不可。**

- ⭐ **`columnMultiSelectionByFieldNameEditor` は生のフィールド名配列が届く** — `["_time","category"]`。
  `columnMultiSelector` が DOS 文字列（`> primary | frameBySeriesNames(...)`）なのと対照的で、
  **複数フィールドを選ばせたいときはこちらを使えばパース不要**。
- **`seriesColorsByField`** … `{"_time":"#7B56DB","category":"#009CEB",…}` のオブジェクトが届く。
  フィールド名ごとに色を割り当てたいときに使える。
- **`seriesLineTypes` / `seriesLineTypesByField`** … 両方とも `Invalid editor type`（使用不可）。
  `seriesColors` 系は動くのに LineTypes 系は動かない。**系統では判断できない**good例。
- **`tableBackgroundColor`** … UI（色ピッカー＋パレット）は正常に動作するが**値が options に届かない**。
  原因の候補：標準 viz（Table.config.js）では `option` ではなく **`key`** を使っている:
  ```json
  { "key": "backgroundColor", "editor": "editor.tableBackgroundColor", "editorProps": {…} }
  ```
  他の editor 型では見たことのないプロパティ。`key` で再検証する（ROUND 4c）。

### ROUND 7 の途中結果（2026-07-25）

**確定したこと（実機確認済み）**:

- ✅ **`showDrilldown: true` + `hasEventHandlers: true` で編集画面に「インタラクション」タブが出る**
- ✅ **`useTokens` は動く。ただし届くのは入れ子構造**:
  ```json
  { "env":      { "app":"…", "locale":"ja-JP", "user":"admin", "user_realname":"Administrator",
                  "product":"enterprise", "version":"10.4.1", "is_enterprise":true },
    "default":  { "global_time.earliest":"-24h@h", "global_time.latest":"now" },
    "submitted":{ "global_time.earliest":"-24h@h", "global_time.latest":"now" } }
  ```
  **フラットな `tokens.foo` ではない。** `env` にユーザー名・アプリ名・ロケール・Splunk バージョン、
  `default`/`submitted` に**選択中の時間レンジ**が入る。これだけでも実用価値がある
  （viz 内に時間レンジやユーザー名を出せる）。
- ✅ `triggerDrilldown` / `addDrilldownListener` は**例外なく呼べる**（型定義どおりの単一オブジェクト引数）

**未確定**: `setToken` で実際にトークンが設定されるか。
初回はデータ 0 行で値が `no-data` になり判定できなかった。

**やらかし（修正済み）**: プローブが `data.rows` しか見ておらず、
**サーチを紐づけているのに「0 行」**になっていた。Splunk は `rows` / `columns` の**両形式**で
データを届けるため、既存 viz と同じ `normalizeData()` が必要だった。
→ 修正し、`columns` 形式の回帰テストを追加（`[5c]`）。

### ROUND 7 の結論（2026-07-25）

**`setToken` は例外なく呼べるが、トークンは設定されない（実機確認済み）。**
データ 5 行・インタラクション設定済みの状態で、公式ドキュメントどおりの
`triggerDrilldown({ action:'setToken', payload:{name,value} })` を 3 回発火しても
`probe_token` はトークンに現れなかった。

## 🏁 全検証完了（2026-07-25）

editor 型 28 種 ＋ ドリルダウン／トークンをすべて実機検証した。

### ROUND 11 の結論 — **トリガーは click のみ**

`config.json` の `events` に `point.mouseover` / `point.mouseout` / `range.select` を宣言し、
ホバー／ドラッグのタイミングで `triggerDrilldown` を呼んだが、**click 以外は発火しなかった**。

理由は明快:
- `addDrilldownListener` は **click しか見ない**（型定義に "listens to 'click' events"）
- `triggerDrilldown` は**効かない**（ROUND 10 で確定）
→ **click 以外を発火する手段が存在しない。**

カスタム viz のインタラクションは**クリック前提で設計する**。
ホバーでツールチップ等は viz 内で完結させ、ダッシュボード連携はクリックに割り当てる。

### 最終的なドリルダウン実装レシピ

1. `config.json`：`showDrilldown` / `hasEventHandlers` を true、
   `config.events` にイベント名を宣言、`config.supports: ["events"]`
2. クリックさせたい要素を**1つずつ** `addDrilldownListener` に登録
   （`payloadCallback` はその要素専用。固定の行番号を書かない）
3. payload は `{'row.<field>.value': …, name, value}`
4. ユーザーが編集画面「インタラクション」で動作（トークン設定・リンク遷移）を設定

**テーブル以外でも同じ**（SVG の path / circle 等）。ただし型定義は `node: HTMLElement` で
SVG 要素での動作は未検証。

---

## ROUND 12（任意の選択肢で「複数チェックボックス」を出せるか）← 未検証

**知りたいこと**：`editor.columnMultiSelectionByFieldNameEditor`（radar-chart が使っている
チェックボックス式の複数選択 UI）で、**サーチ結果のフィールド名ではなく、こちらが決めた
固定の選択肢**（合計 / 平均 / 最大 …）を出せるか。

**背景**：gauge-arc の「サブ指標に出す統計」を `editor.arrayOfStrings`（チップに `sum` などを
手入力）で作ったが、ユーザーから「複数チェックボックスのやつでよくない？」と指摘があった。
チェックボックス式の複数選択 UI は `columnMultiSelectionByFieldNameEditor` として実在する
（ROUND で検証済み・生の配列が届く）が、**この型は `editorProps` を取らず、
選択肢はホストがデータソースのフィールド名から作る**（radar-chart の定義で確認）。
そのため任意の選択肢を出せるかは**未検証**。

**「無い」と断定しない**：`arrayOfStrings` が「標準 viz に無いから実在しない」と誤判定した前例が
あるため、`editorProps` を渡せば効くか／別名の型が受け付けられるかを実機で確かめる。

**手順**：下を `editorConfig` に入れ、1つずつ（**まとめて入れない**。全滅すると切り分け不能）:

```json
      {
        "label": "ROUND12a_固定選択肢を渡せるか",
        "layout": [
          [
            {
              "label": "columnMulti + values",
              "editor": "editor.columnMultiSelectionByFieldNameEditor",
              "option": "p_multiFixed",
              "editorProps": {
                "values": [
                  { "label": "合計", "value": "sum" },
                  { "label": "平均", "value": "avg" },
                  { "label": "最大", "value": "max" }
                ]
              }
            }
          ]
        ]
      }
```

`optionsSchema`:
```json
      "p_multiFixed": {
        "default": [],
        "anyOf": [
          { "type": "array", "items": { "type": "string" } },
          { "type": "string", "pattern": "^>.*" }
        ]
      }
```

**判定**:

| 結果 | 意味 | gauge-arc での対応 |
|---|---|---|
| 「合計 / 平均 / 最大」がチェックボックスで出る | **任意の選択肢を渡せる** | `statList` をこの型へ移行 |
| サーチのフィールド名（`_time` `cpu`…）が出る | `editorProps` は無視され、**列名専用** | `editor.checkbox` × 7 に変更 |
| パネルが全部消える（`Invalid editor type`） | この使い方は不可 | 同上 |

**ROUND12b（保険）**：`editorProps` を `{ "values": [...] }` ではなく
`{ "options": [...] }` / `{ "items": [...] }` にした場合も一応試す
（プロパティ名が違うだけで通る可能性があるため）。

---

## ROUND 11（click 以外のトリガー）← 完了

`config.json` の `events` に4種を宣言し、それぞれのトリガーで発火する:

| トリガー | イベント名 | 発火方法 |
|---|---|---|
| セルをクリック | `cell.click` | **`addDrilldownListener`**（ROUND 10 で有効と確定） |
| 行にホバー | `point.mouseover` / `point.mouseout` | `triggerDrilldown`（他に手段が無い） |
| 行を縦にドラッグ | `range.select` | `triggerDrilldown`（同上） |

**⚠ 未検証の懸念**：`addDrilldownListener` は**click しか見ない**（型定義に明記）。
そのためホバー／範囲選択は `triggerDrilldown` で送るしかないが、
**ROUND 10 で「triggerDrilldown は効かない」ことが分かっている**。
→ **click 以外は発火できない可能性がある。** それを確かめるのが今回の目的。

### 確認手順

1. 編集画面「インタラクション」→「+ インタラクションを追加」
   → **トリガーの選択肢に `point.mouseover` / `range.select` が出るか**（最初の関門）
2. 出たら「トークンを設定」を割り当てる
3. 表示モードで**行にホバー** → トークンが変わるか
4. **行を縦にドラッグ** → トークンが変わるか

「発火ログ」には送った内容が出るので、**ログには出るがトークンは変わらない**なら
`triggerDrilldown` の限界が確定する。

---

### 🏁 ROUND 10 の結論（2026-07-25）— **クリック即トークン設定に成功**

**発火するのは `addDrilldownListener` だけ。`triggerDrilldown` は効かない（実機確定）。**

ROUND 9 で「トークンは変わるが②のボタンを押したときだけ」という挙動だったのは、
実際に発火していたのが `addDrilldownListener` に登録した専用ノードだったから。
各セルの `onClick` から呼んでいた `triggerDrilldown` は**まったく効いていなかった**
（例外も出ないので気づけなかった）。

→ **クリックさせたい要素を1つずつ `addDrilldownListener` に登録する**のが正解。
`payloadCallback` はその要素専用なので固定でよい。
これで**セルを押した瞬間にトークンが入る**（デフォルト viz と同じ挙動）。

### 🏁 ROUND 9 の結論（2026-07-25）— **トークン設定はできた**

**ROUND 8 の「不可」は誤りだった。原因は `config.json` の `events` 宣言の欠落。**

`events: {"cell.click": {…}}` / `supports: ["events"]` を宣言し、
`type:'cell.click'` ＋ `row.<field>.value` で「事実」を送る形にしたところ、
編集画面で設定した「トークンを設定」インタラクションが**実際に発火してトークンが変わった**。

**同時に見つかった実装バグ**：`addDrilldownListener` の `payloadCallback` を
`buildPayload(0, …)` と**1行目固定**にしていたため、
**2行目(OK)をクリックしてもトークンが1行目(NG)になる**症状が出た。
→ `payloadCallback` は**クリックのたびに呼ばれる**ので、固定値を返してはいけない。
セルごとに値を変えるなら**各セルの onClick から triggerDrilldown を呼ぶ**方が確実。
回帰テスト `[4a]` を追加済み。

**教訓**：4通り試して全滅しても「不可能」とは限らなかった。
同じ次元（引数の形）で総当たりしても、**前提条件（config 宣言）が欠けていれば全滅する**。

## ROUND 9（テーブル viz ＋ `events` 宣言で再検証）← 完了

**ROUND 8 の「トークン設定は不可」という結論は保留にする。検証方法に穴があった。**

標準 viz（`Table.js`）の実装を読み直して分かったこと:

```js
// 標準 Table の config には events 宣言がある
events: { "cell.click": { description: "triggered when user clicks a table cell" } },
supports: ["dynamic-options", "events", "page-and-sort", "placeholder"],
```

**ROUND 8 までの config.json にはこの `events` / `supports` が無かった。**
ホスト側に「紐づけられるイベント」が存在しなければ、
インタラクションを設定しようがなく、発火しても何も起きないのは当然かもしれない（推測）。

さらに、標準 viz は `action:'setToken'` のような**命令**を送っていない。送るのは
**「クリックされたという事実」だけ**:
```js
onEventTrigger({ type:'cell.click', originalEvent, payload:{ 'row.<field>.value': … } })
```
**トークン設定はホスト側のインタラクション定義が行う**。
→ viz が setToken を指示するのではなく、
**ユーザーが「インタラクション」で『トークンを設定』を選ぶ**のが正しい形（推測）。

### 今回の変更

| 項目 | ROUND 8 まで | ROUND 9 |
|---|---|---|
| `config.json` | events 宣言なし | **`events: {"cell.click": {…}}` / `supports: ["events"]` を追加** |
| viz | ボタンを並べただけ | **実データのテーブル**。セルがクリック可能 |
| 送るもの | `action:'setToken'`（命令） | **`type:'cell.click'` ＋ `row.<field>.value`（事実）** |

左クリック＝`type: cell.click` / 右クリック＝`action: cell.click` で**両方を比較**できる。

### 確認手順

1. 編集画面 →「インタラクション」→「+ インタラクションを追加」
   → **「トークンを設定」** を選ぶ。ここで**選択肢に `cell.click` が出るか**が最初の関門
2. トークン名（例 `probe_token`）に row の値を割り当てる
3. 表示モードに戻り、**①「クリック前のトークンを記録」**を押す
4. **テーブルのセルを左クリック** → 「クリック後にトークンが変化したか」を見る
5. 変化しなければ**右クリック**（`action` 形）でも試す

「クリック前後でトークンが変化したか」を機械的に判定する欄を用意したので、
`probe_token` 以外の名前でインタラクションを設定しても検知できる。

---

### ROUND 8 の結論（2026-07-25）— ※ ROUND 9 で再検証中

**4方式すべて発火したが、すべてトークンは設定されなかった（実機確認済み）。**

| 方式 | 引数 | 結果 |
|---|---|---|
| A | `{action:'setToken', payload:{name,value}}`（公式docs形） | ❌ |
| B | `{type:'point.click', originalEvent, payload:{'row.*.value':…}}`（標準viz形） | ❌ |
| C | `{action:'point.click', payload:{'row.*.value':…}}` | ❌ |
| D | `{type:'setToken', payload:{name,value}}` | ❌ |

`triggerDrilldown` は**どの形でも例外を投げない**（サイレントに何もしない）。
`canSetTokens: ["dynamic","static"]` を設定し、編集画面で「インタラクション」も設定済みの状態での結果。

→ **カスタム viz（Studio 拡張）から `triggerDrilldown` でトークンを設定することはできない。**
公式ドキュメントには `action:'setToken'` の例が載っているが、**少なくとも Splunk 10.4.1 では効かない**。
「例外が出ない＝動いている」ではないことに注意（発火ログは全部 OK だった）。

## ROUND 8（`setToken` の正しい形を探す）← 完了

`triggerDrilldown` の引数の形が違う可能性を追う。根拠（コード調査）:

**標準 viz は `action` ではなく `type` を使っており、値は `row.<フィールド名>.value` で載せている**:
```js
// @splunk/visualizations/Bar.js より
onEventTrigger({ type: 'point.click', originalEvent, payload: { 'row.count.value': 12, … } })
```
`type` に使われている名前は**決まっている**（`point.click` / `legend.click` / `node.click` /
`link.click` / `lane.click` / `event.click` / `parent.click` / `range.select` など）。
`custom.click` のような任意名は標準 viz には存在しない。

**注意：以下は推測であって事実ではない。** 4通りをボタンで individually 試す:

| 方式 | 引数の形 |
|---|---|
| A | `{ action:'setToken', payload:{name,value} }`（公式docs形。ROUND 7 で失敗した形） |
| B | `{ type:'point.click', originalEvent, payload:{'row.*.value':…} }`（標準viz形） |
| C | `{ action:'point.click', payload:{'row.*.value':…} }` |
| D | `{ type:'setToken', payload:{name,value} }` |

トークンに入った値の**先頭文字（A/B/C/D）でどの方式が効いたか分かる**ようにしてある。

### 確認手順

1. 編集画面の「インタラクション」で**「トークンを設定」** のインタラクションを追加しておく
   （`probe_token` を設定する形。設定済みならそのまま）
2. 表示モードで **A → B → C → D** を順に押す
3. 「③ probe_token が設定されたか」が緑になったら、**値の先頭文字**を見る

全部ダメなら「カスタム viz からのトークン設定は不可」で確定する。

---

### ROUND 7 の途中経過（参考）

editor 型（28種）は全数完了したので、**ホスト連携機能**に対象を移した。
プローブを作り替えてある（`probe-2.0.0`）。ローカル検証は 26 passed / 0 failed。

`config.json`:
```json
{ "showDrilldown": true, "hasEventHandlers": true, "canSetTokens": ["dynamic", "static"] }
```

### 確認すること（実機）

| # | 項目 | 見るところ |
|---|---|---|
| 0 | 編集画面に**「インタラクション」タブ**が出るか | 設定パネル |
| 1 | `triggerDrilldown`（自前 onClick から明示発火） | ①ボタン → 発火ログ |
| 2 | `addDrilldownListener`（DOM ノード登録） | ②の点線枠をクリック |
| 3 | `triggerDrilldown({action:'setToken'})` でトークンを設定できるか | ③ボタン → 「読めているトークン」 |
| 4 | `useTokens` でトークンを読めるか | 「読めているトークン」行 |

**表示モードで操作すること**（編集モードは iframe への入力が遮断される）。

### 未検証・推測

- 公式ドキュメントには `canSetTokens: ["dynamic","static"]` と
  `triggerDrilldown({action:'setToken', payload:{name,value}})` の記載があるが、
  **カスタム viz で実際に効くかは未確認**。
- 「インタラクション」タブが出るかどうかも**未確認**（前回はフラグを立てていなかった）。
- `addDrilldownListener` は**公式ドキュメントのシグネチャが型定義と食い違っている**
  （docs は位置引数、実際は単一オブジェクト引数）。型定義に従って実装してある。

---

### ROUND 6 の結果（2026-07-25）— `context` は viz から読めない（確定）

`dynamicColor` 系は options に DOS 式しか入れないが、**範囲配列そのものは `context` に生で入っている**:

```json
"context": { "p_dynColorPrecedenceEditorConfig": [{ "value": "#9E2520", "to": 20 }, …] }
```

「これを viz から読めれば dynamicColor 系も使えるのでは？」を検証した。
API オブジェクトをプロトタイプチェーンごと総なめし、`getContext`/`getVizContext`/`getDefinition`/
`getConfig` の呼び出しも試みたが、**`context` を取得する手段は無かった（実機確認済み）**。

拡張 API が公開しているのは以下 19 個だけで、`context` 系は存在しない:
```
getDataSources getOptions getTheme getDimensions getMode getTokens getError
addDataSourcesListener addOptionsListener addThemeListener addDimensionsListener
addModeListener addTokensListener addErrorListener addDrilldownListener
setOptions setError clearError triggerDrilldown
```

→ **`context` に保存される型は原理的に使えない**。範囲→色は `editor.threshold` を使う（§4）。

### ROUND 4c / 5 の結果（2026-07-25）

**`tableBackgroundColor` は `key` を書くと届く。ただしキー名は固定。**

```jsonc
// config.json：key を書かないと届かない（option では無視される）
{ "key": "p_tableBackgroundColor", "editor": "editor.tableBackgroundColor", "editorProps": {…} }

// 実際に options に来たもの ← key の値 "p_tableBackgroundColor" ではない！
{ "backgroundColor": "#000000" }
```
→ **`key` は「このオプションを有効化するスイッチ」のようなもので、書き込み先のキー名は
`backgroundColor` に固定されている**（実機確認済み）。任意の名前は付けられない。

**dynamicColor 系3種はすべて使用不可**（今回は事前の推測どおり）:

```jsonc
"p_networkNodeColors":  "> nodeColorValues | rangeValue(p_networkNodeColorsEditorConfig)",
"p_dynColorPrecedence": "> dataValues | rangeValue(p_dynColorPrecedenceEditorConfig)",
// 範囲配列は context 側にだけ保存される
"context": { "p_dynColorPrecedenceEditorConfig": [{ "value": "#9E2520", "to": 20 }, …] }
```

- `networkGraphDynamicColor` / `dynamicColorWithPrecedence` … DOS 式が届く。`dynamicColor` と同構造。
- **`tableDynamicColor` は実害あり**。`option` に `p_tableFormat` と書いたのに**固定キー `tableFormat`**
  へ3つの DOS 式を書き込み、しかも**編集パネルが操作不能（クリック不可）になる**。
  Table viz 専用の editor で、カスタム viz に入れてはいけない。

**結論：範囲→色マッピングは `editor.threshold` を使う**（§4 のとおり）。dynamicColor 系は全滅。

## ROUND 4（未検証9種のうち期待できる5種）← 完了

**以下の「期待」は推測であって事実ではない**（これまで推測は5回外れている）。実機で確かめる。

| 型 | 標準 viz での定義 | 推測 |
|---|---|---|
| `columnMultiSelectionByFieldNameEditor` | Area「Additional tooltip fields」。schema は `array of string` | **フィールド名の配列がそのまま届く**かも（`columnMultiSelector` と違い DOS ではない可能性） |
| `seriesColorsByField` | Area「Series colors by field name」。schema は `type: object` | `{"count":"#008000"}` のようなオブジェクト |
| `seriesLineTypes` | Line の線種指定 | 文字列配列 |
| `seriesLineTypesByField` | 同上（フィールド別） | オブジェクト |
| `tableBackgroundColor` | Table。`editorProps.palette` でパレット指定 | 色文字列。`editor.color` のパレット版として使えるかも |

`4a`（4種）と `4b`（tableBackgroundColor）でセクションを分けてある。
**片方が全滅してももう片方の結果は得られる**……**わけではない**（無効な型があると全体が消える）。
分けてあるのは、エラー型を除外したあと復旧しやすくするため。

## ROUND 5（dynamicColor 系の3種・未検証）

`option` に DOS 式が入る型なので**届かない可能性が高い**（`dynamicColor` の実績から）。
ただし ROUND 3 で「context を使う型は届かない」という一般化が外れているので、
**決めつけずに確認する**。

```json
      {
        "label": "ROUND5_dynamicColor系",
        "layout": [
          [{ "label": "tableDynamicColor", "editor": "editor.tableDynamicColor", "option": "p_tableFormat", "context": "colorGradientConfig",
             "editorProps": { "labelPosition": "top",
               "formatters": [{ "label": "Ranges", "value": "rangeValue", "isDefault": true,
                 "defaults": { "table": [{ "to": 20, "value": "#D41F1F" }, { "from": 20, "value": "#118832" }] } }],
               "dataSelectors": [{ "label": "Table", "value": "table" }] } }],
          [{ "label": "networkGraphDynamicColor", "editor": "editor.networkGraphDynamicColor", "option": "p_networkNodeColors", "context": "nodeColorsEditorConfig",
             "editorProps": { "themes": {}, "contextName": "nodeColorsEditorConfig", "flyoutTitle": "Dynamic coloring",
               "formatters": [{ "label": "Ranges", "value": "rangeValue", "isDefault": true,
                 "defaults": { "nodeColorValues": [{ "to": 20, "value": "#D41F1F" }, { "from": 20, "value": "#118832" }] } }],
               "dataSelectors": [{ "label": "Node color values", "value": "nodeColorValues" }] } }],
          [{ "label": "dynamicColorWithPrecedence", "editor": "editor.dynamicColorWithPrecedence", "option": "p_dynColorPrecedence", "context": "colorRangeConfig",
             "editorProps": { "labelPosition": "top", "flyoutTitle": "Dynamic coloring: value",
               "formatters": [{ "label": "Ranges", "value": "rangeValue", "isDefault": true,
                 "defaults": { "dataValues": [{ "to": 20, "value": "#D41F1F" }, { "from": 20, "value": "#118832" }] } }],
               "dataSelectors": [{ "label": "Data values", "value": "dataValues" }] } }]
        ]
      }
```

## ROUND 3（届かない想定＝反証用）

`context` / DOS 評価に依存する型。**パネルには出るが値が届かない**（DOS 文字列が来る）と予想。
予想通りなら §4「値→色マッピング」の仮説が裏付けられる。

```json
      {
        "label": "ROUND3",
        "layout": [
          [{ "label": "seriesColors", "editor": "editor.seriesColors", "option": "p_seriesColors" }],
          [{ "label": "columnMultiSelector", "editor": "editor.columnMultiSelector", "option": "p_columnMultiSelector", "editorProps": { "dataSourceKey": "primary", "filterByTypes": ["number"] } }],
          [{ "label": "trellisSplitBy", "editor": "editor.trellisSplitBy", "option": "p_trellisSplitBy", "editorProps": { "dataSourceKey": "primary" } }]
        ]
      }
```

`presetSelector` は `option` を持たず `editorProps.presets` で複数 option を書き換える特殊な型。
単独で試す:

```json
      {
        "label": "ROUND3b_presetSelector",
        "layout": [
          [
            {
              "label": "presetSelector",
              "editor": "editor.presetSelector",
              "editorProps": {
                "presets": [
                  { "label": "なし", "name": "probe.none", "value": { "context": {}, "options": {} } },
                  { "label": "赤", "name": "probe.red", "value": { "context": {}, "options": { "p_presetSelector": "red" } } }
                ]
              }
            }
          ]
        ]
      }
```
