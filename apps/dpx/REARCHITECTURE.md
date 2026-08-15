# DPX 再設計プラン（Phase 1〜4）

**開始 2026-08-13。** DPX を「Visualization / Studio Extension / Layout / Data Source /
Material を独立した拡張ポイントとして追加できる基盤」へ再設計する作業の記録。

進捗はこのファイルを**唯一の正**とする（作業を中断・再開するときはここを読む）。

---

## 前提（ユーザー確定事項）

| 項目 | 決定 | 確定日 |
|---|---|---|
| **後方互換** | **不要。新規で作る。** 実機に残るのは検証用ボードのみで、失われて困る本番ボードは無い。migration コードも旧形式フォールバックも**書かない**。スキーマは最善の形で新規設計してよい | 2026-08-13 |
| **Property Editor** | 未対応 editor 型を**段階的に埋める**（JSON フォールバック止まりにしない） | 2026-08-13 |
| **今回のスコープ** | **Phase 1 + 2**（Schema + State）。Phase 3/4 は別途 | 2026-08-13 |

⚠ **「互換不要」は「壊してよい」ではない。** 既存の**機能・デザイン・質感**は
再構築後も同等以上を維持する。捨てるのは*定義フォーマットの互換*だけ。

---

## 判断：大規模リファクタリング（全面再実装ではない）

**理由**：DPX の弱点は「設計が間違っている」ことではなく、**正しい設計が一部の
ファイルに埋まったまま境界が宣言されていない**こと。
現資産の多くは**実機でしか発見できなかった知見の結晶**（`liquidGlass` の色収差
scale 差 10 / `background` 一括指定が枠を消す / `exec_mode=blocking` の 503 /
canvas 手描きの seed 固定 …）で、再実装すれば高確率で踏み直す。

**既に目標アーキテクチャを満たしている部分（触らない・活かす）**:

- **Studio Extension Adapter** … `extensionAdapter.jsx`（121 行）が webpack alias で
  `@splunk/dashboard-studio-extension/react` を差し替え、**30 viz が viz 側ほぼ無改変で載っている**
- **Search Layer** … `useSplunkSearch.js` + `dataSources.js`（`resolvePanelSearch`）
- **History** … `history.js`（純粋関数・テスト付き）
- **Material の中身** … `themes.js` の `panelSurface()` / `groupSurface()`。
  **名前が Theme なだけで実体は Material Engine**

**本当の負債は 3 つ**:

1. **Schema が無い**（`schema.js` は 17 行の判定関数のみ）。型・検証・既定値・
   versioning が無く、**既定値の二重定義が実際に不具合になった**（§8.dd）
2. **`DashboardPage.jsx`（1,072 行）が God Component**（useState 20 個）。
   Multi Select / Copy Paste を足す先が無い
3. **Layout が差し替え不能**（grid 座標が `Panel` と `DpxDashboard` に直接埋まっている）

---

## Phase 1: Dashboard Schema の実体化 ✅ **完了（2026-08-13）**

`components/engine/dashboardSchema/` を新設。

- [x] `dashboardSchema/vocab.js` … **列挙値と既定値の唯一の出どころ**（依存ゼロ）
- [x] `dashboardSchema/dashboard.js` … Zod スキーマ（`schemaVersion: 2`）
- [x] `dashboardSchema/parse.js` … `parseDefinition()` を唯一の入口に
- [x] `dashboardSchema/index.js` … 公開 API
- [x] `test/schema.test.mjs`（24 件）/ `test/schemaVocab.test.mjs`（9 件）

**実測**: 全 13 テストファイル green。本番ビルド成功。
**Zod のバンドル増は 75,131 バイト**（4,749,190 → 4,824,321。約 73KB・全体の 1.6%）。

### ⚠ Phase 1 で踏んだ罠（記録）

**1. `schema/` は使えない — 既存の `schema.js` と衝突する**

`engine/schema.js`（v1 判定・17 行）が既にあり、`engine/schema/` を作ると
**webpack はディレクトリではなくファイルを解決する**（Node の ESM は逆にディレクトリを取るので
**テストだけ通ってビルドで壊れる**という最悪の形になる）。

- 症状: `export 'emptyDashboard' was not found in './schema'
  (possible exports: isDpxDefinition)` という **警告のみ**。ビルドは成功する
- **Zod が丸ごと tree-shake されて「バンドル増ゼロ」に見えた**ため、
  危うく「Zod は軽い」と誤った計測を報告するところだった
- → ディレクトリ名を **`dashboardSchema/`** にして解消。
  **`schema.js` は v1 判定として現役**（`viewStore` / `importDefinition` が使用中）なので
  Phase 2 で参照ごと外すまで消さない

**教訓**: **バンドルへの寄与は「入っていること」を確かめてから測る**。
サイズ差だけを見ると、モジュールが丸ごと消えている状態を「軽い」と誤読する。

**2. Zod 4 の `.default({})` は入れ子の既定値を走らせない**

```js
z.object({ i: Inner.default({})  }).parse({})  // → { i: {} }        ⚠
z.object({ i: Inner.prefault({}) }).parse({})  // → { i: { a: 5 } }  ✓
```

`default` は「その値をそのまま入れる」、`prefault` は「その値を**入力として流す**」。
**入れ子オブジェクトの既定値はすべて `prefault`**。`default` に戻すと
`layout.grid.columns` が undefined のまま描画層に届く。
⚠ ただし **`z.record()` は `.default({})` でよい**（空のマップは本当に空）。

**採用ライブラリ**: **Zod 4.4.3**（`yarn add zod` 済み）。
理由＝「既定値・検証・型推論が 1 定義で揃う」。既定値の二重定義という実バグに直接効く。

**設計方針**:

- `schemaVersion: 2` から始める（v1 は旧形式。**読まない**）
- **既定値の適用は Zod の `.default()` に集約**し、コンポーネント側の `??` を撤廃する
- 検証エラーは**落とさず理由を返す**（手編集の JSON を貼る導線があるため）
- **依存ゼロのファイルを分ける**（`vocab.js` は素の Node でテストできる）

## Phase 2: State / Command 層の抽出 ✅ **ストア実装まで完了（2026-08-13）**

`components/store/` を新設。**ストアとテストは完成。`DashboardPage` の配線は次の作業**。

- [x] `store/dashboardStore.js` … 定義＋履歴（保存対象）＋ Command
- [x] `store/editorStore.js` … 選択・ダイアログ・プレビュー（保存しない）
- [x] `edit(fn, key)` → `dispatch(fn, key)` へ昇格。`history.js` を接続
- [x] `test/store.test.mjs`（25 件）
- [x] **`DashboardPage.jsx` を新ストアへ配線**（**useState 20 → 3**）
- [x] 旧 `engine/schema.js`（v1 判定）の参照を外して**削除**
- [x] **実機で動作確認**（v0.2.0 をインストールし表示／編集／保存を確認）

**採用ライブラリ**: **Zustand 5.0.15**。実測バンドル増 **約 4.5KB**。
XState は「編集操作＝定義への patch 列」であってモード遷移が主ではないため過剰と判断。

### 設計の要点

**分離の判定基準はひとつ: 「リロードしたら失われて困るか」。**
困る → `dashboardStore` / 困らない → `editorStore`。

**選択は `selection: {kind, ids[]}` の 1 つにまとめた**（旧実装は
パネル / 入力 / 区画で useState 3 個）。理由は 2 つ:
- **3 種の排他が構造的に保証される**（旧実装は片方だけ消す実装漏れで
  「パネルと区画が同時に選択中」になりうる状態だった）
- **`ids` を常に配列にしてある**ので、Multi Select を足すときに**型が変わらない**

**zustand を選んだ実利**: `get()` で**同期的に現在値が読める**ため、
旧実装の「`setDef` の中で `setHistory` の結果を読むと古い値が返る」問題
（矢印キーの移動が戻らない不具合）が**構造的に起きない**。`defRef` のような
控えの ref も不要になった。

### Phase 2 のテストが押さえている「過去に壊れた性質」

| 性質 | 旧実装で何が起きたか |
|---|---|
| undo で戻しきると dirty が false | カウンタ方式・別 state 方式はどちらもここで壊れた |
| 「変えて元に戻す」でも false | 内容比較でないと検出できない |
| 連続 2 回の編集が 1 手ずつ戻る | 外側クロージャの古い値を積んで**2 手前に飛んだ** |
| 一時状態を触っても dirty にならない | **分離の目的そのもの** |
| `removePanel` が区画からも外す | ゴーストが残ると外接矩形が狂う |

## Phase 3: Layout Engine の差し替え化 ✅ **完了（2026-08-13）**

`engine/layout/` に `grid` / `freeform` を同一インターフェースで実装し、
**Renderer の座標計算をすべてエンジン経由にした**。

- [x] `layout/types.js` … 契約と `makeLayoutContext`（依存ゼロ）
- [x] `layout/gridLayout.js` … 現行挙動をそのまま抽出（列/行）
- [x] `layout/freeformLayout.js` … px 絶対配置＋スナップ＋座標変換
- [x] `layout/index.js` … レジストリ（`resolveLayout` / `switchLayoutType`）
- [x] `DpxDashboard` を配線（配置・寸法・ドラッグ・リサイズ・区画移動・コンテナ）
- [x] `test/layout.test.mjs`（32 件）
- [x] **実機で grid / freeform 両方を描画確認**

**外部ライブラリは採用しない判断**：GridStack / react-grid-layout は DOM を own するため、
**`GroupFrame` の「パネル間の隙間に描く」機構と区画ごと移動のクランプが成立しなくなる**。
これは Studio に対する DPX の差別化点そのもの。Craft.js は Schema を own するので Phase 1 と衝突。

### 設計の要点

⭐ **座標のキー（`x/y/w/h`）は共有し、単位だけ変える**（grid=セル / freeform=px）。
別キー（`px`/`py`）を足さない理由は、**移動・複製・区画・undo の既存処理が
そのまま効く**こと。切替時は `switchLayoutType()` が**座標を変換する**
（変換しないと「セル 6」が「6px」になり全パネルが左上に固まる）。

⚠ **エンジンは純粋関数**（React 非依存）。座標計算はテストで押さえないと必ずズレるが、
**枠のズレは目視で気づけない**（1 マスずれてもそれらしく見える）ため。

### ⚠ Phase 3 で踏んだバグ

**1. `position: 'relative'` の決め打ちが freeform を壊した**（実機で発生）

パネル本体の style に `position:'relative'` がベタ書きされており、
エンジンの `absolute` を**後から上書き**していた。結果、`left/top` は
**通常フローの位置からのオフセット**になり、**全パネルが縦に積まれた**。

- 症状が紛らわしい：`left/top` は計算値として正しく入っているのに絵が合わない
- **DOM の `getComputedStyle` で `position` を見て確定**した（推測では辿り着けない）
- → `layoutStyle.position` があるときは決め打ちしない

**2. `convertToGrid` が幅をクランプしていなかった**（テストで検出）

`x` だけ丸めて `w` を丸めていなかったため、**フリーフォームの広いパネルが
12 列を超えたまま**グリッドへ戻っていた（`w=50`）。実機に出る前にテストが捕まえた。

**3. `Math.max(-0, …)` が `-0` を返す**（テストで検出）

区画のクランプが `-0` を返し、定義に `-0` として残りうる状態だった。`+ 0` で正規化。

## Phase 4: Material Engine 化 ✅ **完了（2026-08-13）**

`engine/material/` を新設し、**境界の宣言**と**足りなかった機能**を実装した。

- [x] `material/index.js` … Material 層の公開 API（他の層はここだけを import）
- [x] `material/MaterialSurface.jsx` … `<MaterialSurface material intensity>`＋`useMaterial()`
- [x] `material/quality.js` … **品質レベル**（full / reduced / minimal）
- [x] `DpxDashboard` に配線（質感 CSS・出現アニメ）＋ `style.quality` をスキーマへ
- [x] `test/material.test.mjs`（24 件）

### ⭐ `themes.js` を物理移動しなかった判断（意図的）

`themes.js`（1,514 行）は**中身が既に Material Engine そのもの**で、
`panelSurface()` / `groupSurface()` が「意匠を 1 か所で決める」構造を満たしている。
**名前が Theme なだけ**だった。物理移動すると:

- 25 質感 × 18 配色の巨大な定義が全部 diff に出て**レビュー不能**
- 実機でしか発見できなかった知見（liquidGlass の色収差 scale 差 10 /
  `background` 一括指定が枠を消す / 手描き canvas の seed 固定）が
  **移動の過程で壊れるリスク**

→ **境界の宣言（`material/index.js` から再輸出）と、足りない機能の追加**を成果とした。
他の層は `material/` だけを見るので、**将来物理移動しても呼び出し側は変わらない**。

### 品質レベル（性能の逃がし弁）

| level | 落とすもの | 条件 |
|---|---|---|
| `full` | なし | パネル 10 未満 |
| `reduced` | **`backdrop-filter`**（＋地を不透明化） | パネル 10〜23 |
| `minimal` | ＋影・発光・アニメ | パネル 24 以上 / **`prefers-reduced-motion`** |

⚠ **落としてよいのは「重ねている効果」だけ。** 色・配置・枠線・
`backgroundImage`（カギ括弧の 8 層）は**品質に関係なく保つ**
（変えると「テーマが切り替わった」ように見える／パネルの境界が消える）。
⚠ **ぼかしを落としたら地を不透明にする**。すりガラスは「半透明＋ぼかし」で
成立しているので、ぼかしだけ消すと**ただの薄い板**になって下が透ける。

## Registry の機械生成 ✅ **完了（2026-08-13）**

**最終ゴール「新しい Studio Extension を最小限の登録作業で使えるようにする」を達成。**

`tools/gen-viz-registry.mjs` が `visualizations/*/visualizations/*/` を走査し、
`vizRegistry.generated.js` を出力する。**登録条件は 2 つだけ**:

1. `src/host.jsx` がある（⚠ エントリ `visualization.jsx` に **export を書かない**。
   esbuild が ESM 出力になり Studio 実機で**パネルが真っ黒**になる）
2. `config.json` がある（`optionsSchema` / `editorConfig` をそのまま流用）

- `vizRegistry.js` は **187 行 → 100 行**（手書きの import 60 行が消えた）
- **`yarn test` に `--check` を組み込み済み**＝「viz を足したのに再生成し忘れた」を
  機械的に検出する（壊して落ちることを確認済み）
- ⚠ **生成物はコミットする**（ビルド時生成だと実行を忘れた瞬間に壊れる。
  追跡しておけば diff でレビューでき、CI で検証できる）

---

## Brush Engine（グラフの線と塗りの質感）✅ 試作完了（2026-08-13）

**Surface（面の質感）と別軸で、グラフの線・塗りに画材の質感を与える層。**
`engine/material/brush/`。`dpx.line` で成立を実機確認済み。

```
Design Engine
 ├─ Theme          … 配色（既存 themes.js）
 ├─ Surface Engine … 面の質感（既存 panelSurface）
 ├─ Brush Engine   … ★ 線と塗りの質感（今回）
 └─ Motion Engine  … 動き（未着手。既存 ENTRANCE_ANIM の上の抽象として設計する）
```

### ユーザー指定の 4 原則（すべて実装・実機検証済み）

| # | 原則 | 実装 | 検証 |
|---|---|---|---|
| 1 | 中間表現 `BrushPath[]`（単一 d に固定しない／ライブラリ型を漏らさない） | `brush/types.js`。rough.js は `brushes.js` に閉じる | テストで**許可キー以外が出ないこと**を検査 |
| 2 | 決定論的 seed | `seedFor(panelId, seriesName, pointCount)` | **実機でホバー再描画しても d が不変**を確認 |
| 3 | Visual と Interaction の分離 | `BrushStrokes` が `pointerEvents:'none'` を強制 | **実機でツールチップが出ることを確認** |
| 4 | flat は再生成しない | `useBrush()` が **null を返す**。flat 用実装を持たない | **実機で flat の brush 経由 path が 0 本**を確認 |

⚠ **`BrushPath[]` は必須だった**（推測ではなく実測）。塗りは
**ハッチ（線幅 0.5）＋輪郭（線幅 1）の 2 path** になり、単一 `d` では表現できない。

⚠ **seed に「データの値」を入れない。** 入れると `makeresults` のように
値が変わるサーチで**再サーチのたびに形が変わる**。点数は入れてよい。

### ⚠ 実機で分かったこと（パラメータは測って決めた）

**手描きは「露骨に効かせないと普通のグラフに見える」**（パネル枠と同じ結論）。
幅 1500px・14 点で「元座標からの最大ずれ」を実測:

| roughness / bowing | ずれ | 実機での見え方 |
|---|---|---|
| 2.6 / 2.0（初版） | **5.4px** | **効いていない**（ただの線） |
| 4.5 / 3.0（採用） | ~13px | 手描きと分かり、値も読める |
| 6.5 / 4.5 | 18px+ | **系列同士が混ざって値が読めない** |

⚠ **重ね描きで seed をずらしすぎない。** 初版は `seed + i*977` としたため
**2 本が別の線に見え、系列が混ざった**（実機のスクリーンショットで判明）。
実際の二度塗りも「ほぼ同じ線を薄くなぞる」動きなので、
**seed は同じにして roughness と線幅を落とす**のが正しい。

### 対応 viz（2026-08-13 拡張・すべて実機確認済み）

| viz | 描画方式 | Brush の当て方 |
|---|---|---|
| `dpx.line` | SVG `<path>` | `brush.line` で線を差し替え |
| `dpx.donut` | SVG `<path>`（円弧） | `brush.arc` を**背面**に描き、**元の path は `fill:transparent` で当たり判定として残す** |
| `dpx.bar` | **CSS の div** | `BrushOverlay`（div の中に SVG を重ねる） |
| `dpx.ranking` | **CSS の div** | 同上 |

⭐ **CSS の div で描く viz が半分あった**（実測。SVG 前提の設計では届かない）。
構造を SVG に書き換えると**ホバー・クリック・幅のアニメを全部作り直す**ことになるので、
**元の div を残して寸法だけ借り、上に SVG を重ねる**形にした（`BrushOverlay`）。

⭐ **円弧は rough.js に渡せない**（SVG の `A` コマンド）。**点列に標本化して多角形として塗る**
（分割数は弧長から決める。固定分割だと小さい扇形が粗く、大きい扇形がカクつく）。

### ⚠ 拡張時に実機で見つけた不具合 3 件（スクリーンショットで発覚）

| 症状 | 原因 | 対策 |
|---|---|---|
| **棒が色を失って暗くなる** | `toBrushPaths` が**塗りの不透明度を輪郭にも適用**していた（0.3）。輪郭は「形を決める線」なので薄くしてはいけない | 塗りと輪郭で**不透明度を分ける**（`strokeOpacity`） |
| **ドーナツがギザギザの多角形に見える** | 面の `roughness` が線と同じ値だった。**面の輪郭が大きくふらつくと「にじみ」ではなく多角形**に見える | 面は `roughness * 0.55` |
| **ランキングだけ変化しない** | **`DpxBar` の横向きレイアウトを `DpxRanking` と取り違えて配線**していた（同じ `dpx-bar-rect` クラスが両方にある） | 実際の要素（`<span>`）へ配線し直し |

⚠ **「塗り」は「線」と別物として調整する。** 線は薄くても形が読めるが、
**面は薄いと色が消える**。塗りの濃度は線より上げる必要がある（実機で確認）。

### 残件（当時）→ **すべて解消済み（2026-08-13）**
- ~~fps の実測~~ … 画材適用時は未計測のまま（末尾の「残件」へ移動）
- ~~Inspector に画材の選択 UI~~ → **実装済み**（デザイン→「グラフの画材」）
- ~~Motion Engine~~ → **実装済み**（`design/motion.js`。既存 `entrance` を上書きしない）


## DPX Design Engine（見た目の 4 軸）✅ 2026-08-13

**見た目に関するすべてを 4 つの独立した軸にまとめた層。** `engine/design/`。
他の層（Renderer / viz / Layout）は**このファイルだけを import する**。

```
DPX Design Engine
├── Theme          … 配色（dark / light / custom）      実体: themes.js
├── Surface Engine … 面の質感（flat / glass / …25種）    実体: themes.js の panelSurface
├── Brush Engine   … 線と塗りの質感（flat / crayon / …）  実体: material/brush + design/brushFilter
└── Motion Engine  … 動きの性格（none/subtle/spring/organic）実体: design/motion.js
```

**4 軸は直交する。** 「ダーク × Liquid Glass × 水彩 × スプリング」も
「ライト × 紙 × なし × なし」も同じように選べる。軸をまたぐ暗黙の依存を作らない。

### ⭐⭐ Brush の疎結合（ユーザー要件・実機で成立を確認）

**Brush には 2 つの適用経路があり、既定は「viz を知らない側」**:

| 経路 | viz 側の変更 | 依存の向き | 対象 |
|---|---|---|---|
| **① SVG フィルタ**（既定） | **ゼロ** | **なし**（CSS が外から掛かる） | **SVG / Canvas / WebGL すべて** |
| ② 描画 API（`useBrush`） | あり | viz → Brush | 作り込む viz だけ（任意） |

```
✗ 旧案:  カスタム viz ──依存──> Brush Engine     31 viz すべてに対応コードが要る
✓ 現在:  Surface ──filter──> [ viz は無改変 ]     依存の矢印が無い
```

**実機で確認済み（2026-08-13）**: `gauge-arc` / `radial-bar` / `sunburst` の
**3 つのカスタム viz を 1 行も変えずに**水彩の質感が乗った
（`filter: url("#dpx-brush-watercolor")` が適用されていることを DOM で確認）。

⚠ **フィルタは文字も歪ませる**（実測）。ラベル・数値の輪郭が波打つ。
→ `brushIntensity`（0〜1）で強度を選べるようにし、**既定は「文字が耐えられる上限」**。
⚠ **同一ドキュメント内でしか参照できない**（`url(#id)`）。
  DPX は全パネルが同じ DOM にいるので成立するが、**iframe の Studio には持ち出せない**
  （liquidGlass の変位マップと同じ制約）。
⚠ **`colorInterpolationFilters="sRGB"` を必ず指定する。** 既定の linearRGB だと
  フィルタを通しただけで**色が明るく転ぶ**。

**性能（実測・カスタム viz 3 枚）**: flat 60fps → watercolor **61fps**（差は誤差）。
⚠ ただし**パネル数を増やしたときは未計測**。フィルタは面積比例なので要注意。

### Motion Engine（既存の 12 種を置き換えない）

⚠⚠ **`ENTRANCE_ANIM` の 12 種を置き換えると、既存ボードの `style.entrance` 指定が
全部無効になる。** Motion は**その上に乗る抽象**:

| 優先順位 | |
|---|---|
| 1 | `prefers-reduced-motion`（アクセシビリティ。何より優先） |
| 2 | `style.entrance` の明示指定（**既存ボードを守る**） |
| 3 | Motion の性格からの既定 |

| motion | 出現 | 常時 | 用途 |
|---|---|---|---|
| `none` | — | — | 壁面表示・reduced-motion |
| `subtle` | fade | — | 実用ダッシュボード（既定） |
| `spring` | pop | — | プレゼン・デモ |
| `organic` | rise | float | 手描き・アンビエント |

⚠ **出現遅延には上限（700ms）を設ける。** パネルが 30 枚あると
70ms × 30 = 2.1 秒になり「壊れて出てこない」ように見える。

### テスト

`test/design.test.mjs`（14 件）。**押さえているのは「既存を壊さない」性質**:
entrance の明示指定が Motion より優先されること、reduced-motion が最優先であること、
遅延に上限があること。

## 作業ログ

| 日付 | 内容 |
|---|---|
| 2026-08-13 | 調査完了。方針決定（大規模リファクタリング） |
| 2026-08-13 | **Phase 1 完了**。`zod@4.4.3` 追加、`engine/dashboardSchema/` 4 ファイル、テスト 33 件 |
| 2026-08-13 | **Phase 2（ストア）完了**。`zustand@5.0.15` 追加、`components/store/` 2 ファイル、テスト 25 件 |
| 2026-08-13 | **Phase 2（配線）完了**。`DashboardPage` の useState 20→3、v1 判定を全廃、**v0.2.0 を実機で確認** |
| 2026-08-13 | **残件消化**。E2E ツール 12 本を更新、`@splunk/dashboard*` 6 削除、OSS 通知再生成、README v0.2.0 |
| 2026-08-13 | **Phase 3 完了**。`engine/layout/`（grid / freeform）、テスト 32 件、**実機で両レイアウトを描画確認** |
| 2026-08-13 | **Phase 4 完了**。`engine/material/`（MaterialSurface / 品質レベル）、テスト 24 件 |
| 2026-08-13 | **Design Engine 完成**。`engine/design/`（Brush フィルタ＋Motion）。**カスタム viz 3 種を無改変で質感適用**（実機確認・60→61fps） |
| 2026-08-13 | **Registry 機械生成 完了**。`vizRegistry.js` 187→100 行、`--check` を CI 化。**実機で Studio 拡張 3 種＋Property Editor 52 項目を確認** |
| 2026-08-13 | **Brush Engine 試作**。`engine/material/brush/`、テスト 22 件、**dpx.line で実機確認**（4原則すべて検証） 

### 残件の消化（2026-08-13・すべて完了）

- [x] **E2E ツールの更新**。⚠ **4 本ではなく 12 本**が旧 URL だった（下記）
- [x] `@splunk/dashboard*` **6 パッケージ削除**。
      ⚠ **`@splunk/react-search` を直接依存に昇格してから**消した
      （`SplAce.jsx` が `require` しており、`@splunk/dashboard` の推移的依存に
      頼っていた＝**そのまま消すと SPL エディタが壊れる**状態だった）
- [x] OSS 通知の再生成（47 パッケージ。zod / zustand を収録）
- [x] README にリリースノート v0.2.0 を追記

**⚠ 「未使用」の判定は依存グラフまで見る。** `package.json` の参照が 0 でも、
**そのパッケージが他の実行依存を供給している**ことがある。
`dashboard` / `dashboard-core` / `dashboard-presets` の 3 つが `react-search` を
供給していた（`dashboard-core > dashboard-layouts > dashboard-ui > react-search`）。

**修正した E2E ツール（12 本）**:
`dp-drag-check` / `dp-edit-check` / `dp-hover-check` / `dp-inputorder-e2e` /
`dp-interact-check` / `dp-save-check` / `dp-scroll-shot` / `dp-select-check` /
`dp-settings-e2e` / `dp-tab-check` / `dp-timemode-e2e` / `dp-token-check`

| ツール | 何が古かったか |
|---|---|
| 上記 12 本 | URL が **1 ビュー集約前**の `/app/{app}/{view}` |
| `dp-save-check` | **Studio 時代の `aria-label*="description"`**。DPX の自前 `TextInput` には無く**常に失敗していた**。あわせて `fill()` だけで済ませていたのを **blur まで**行うよう修正 |
| `dp-settings-e2e` | プリセットを **`aurora ? 'オーロラ' : 'ネオン'` と 2 択で決め打ち**（他のプリセットのボードでタイムアウト）。ドロップダウンを `.first()` で掴んでいた（**先頭は「見出し行」**） |
| `dp-group-e2e` | パネル ID **`h1` の決め打ち**・既存の区画があるボードが前提 |

⚠ **E2E が落ちたら、まず「ツールが古い」を疑う。**
今回 4 本の失敗はすべてツール側の陳腐化で、**DPX の退行はゼロ**だった。
とはいえ**それを確かめるまで断定しない**（今回は手書きスクリプトで同じ検証を
代替し、合格を確認してからツールを直した）。

### 実測値（2026-08-13）

| 項目 | 値 |
|---|---|
| テスト | **全 15 ファイル green**（新規 58 件: schema 24 / vocab 9 / store 25） |
| 本番ビルド | 成功（警告は既存のバンドルサイズのみ） |
| Zod のバンドル増 | **75,131 バイト**（4,749,190 → 4,824,321） |
| Zustand のバンドル増 | **約 4,555 バイト**（4,824,321 → 4,828,876） |
| 合計 | **約 80KB**（全体の約 1.7%） |

### ⭐ 実機確認（2026-08-13・v0.2.0 をインストールして実施）

検証ボード: `search/dpx_v2_check`（`/en-US/app/dpx/dpx?id=search/dpx_v2_check`）。

| 確認したこと | 結果 |
|---|---|
| 表示モードの描画（5 viz・共有データソース・質感・背景） | ✅ スクリーンショットで確認 |
| 編集モード（ツールバー・インスペクタ自動生成・選択） | ✅ 同上 |
| **`dp-undo-e2e`**（入力/複製/削除/矢印/区画/redo・戻しきりで保存不可） | ✅ **全て成功** |
| **`dp-dragpreview-e2e`**（絵は動くが定義は無傷） | ✅ **全て成功** |
| **`dp-textcommit-e2e`**（打鍵中は書かない・IME・Escape） | ✅ **全て成功** |
| 保存 → REST 永続化（`schemaVersion:2` / `layout.grid`） | ✅ 直接検証 |
| ドラッグ移動 → 保存 → REST 永続化 | ✅ 直接検証（x: 0 → 2） |

### ⚠ 実機でしか出なかったバグ（ビルドは通っていた）

**`phase === 'loading'` だけを弾く早期 return では足りなかった。**
ストアの初期値は **`idle`** なので、マウント直後の 1 フレームが
`def = null` のまま描画へ進み **`Cannot read properties of null (reading 'tabs')`** で落ちた。

```js
// ✗ ストアの初期値 idle をすり抜ける
if (phase === 'loading') return <DpxBootScreen />;
// ✓ 「描ける」ことを条件にする
if (phase !== 'ready' || !def) return <DpxBootScreen />;
```

**教訓**: state を `useState`（初期値を自分で決める）から**ストア**（初期値は
ストアが決める）へ移すときは、**早期 return の条件を「否定形」から「肯定形」へ
書き換える**。否定形は列挙漏れが起きる。

### ⚠ 古くなっていた E2E ツール（今回の変更とは無関係）

実機確認の過程で、**v0.2.0 以前の前提のまま止まっているツール**が見つかった。
**これらは今回の配線による退行ではない**（同じ検証を手書きスクリプトで代替して合格を確認済み）:

| ツール | 何が古いか |
|---|---|
| `dp-drag-check.mjs` | URL が **`/app/{app}/{view}`**（1ビュー集約前の形）。今は `/app/dpx/dpx?id={app}/{view}` |
| `dp-save-check.mjs` | `aria-label*="description"` で説明欄を探す（**Studio 時代のセレクタ**。DPX の自前 `TextInput` には無い） |
| `dp-settings-e2e.mjs` | 配色プリセットを表示名「ネオン」で引く（ドロップダウンの実装が変わっている） |
| `dp-group-e2e.mjs` | **既存の区画があるボード**を前提にしている |

→ **すべて修正済み（2026-08-13）**。回帰スイート（`dp-regression.mjs`）で 9/9 通過。

---

## Phase 5: 理想の構成との差分を埋める ✅ **完了（2026-08-13）**

ユーザーが提示した理想の構成と現状を突き合わせ、**残っていた 4 つの差異**を埋めた。

```
DPX
├─ Dashboard Builder
│   ├─ Component Palette          engine/VizPicker.jsx
│   ├─ Dashboard Canvas           engine/canvas/          ← ⭐ 新設
│   └─ Property Editor            engine/Inspector.jsx
├─ Dashboard Schema               engine/dashboardSchema/
├─ State / Command Layer          store/
├─ Layout Engine                  engine/layout/
├─ Visualization Registry         engine/vizRegistry.js
│   ├─ DPX Native Visualization   engine/nativeViz.jsx ほか
│   └─ Studio Extension Adapter   extensionAdapter.jsx
├─ Dashboard Renderer             engine/DpxDashboard.jsx
├─ Splunk Data / Search Layer     engine/data/           ← ⭐ 新設
└─ Design / Material Engine       engine/design/ + material/
```

### 差異① Canvas と Renderer の分離（最大の乖離）

**編集の操作を `engine/canvas/` へ出した。**

| | Before | After |
|---|---|---|
| ドラッグの実装 | `DpxDashboard.jsx` に直書き | `canvas/useCanvasInteractions.js` |
| ストア接続 | ページが props で配線 | `canvas/DashboardCanvas.jsx` |
| Renderer の役割 | 描画 ＋ 編集 | **描画だけ** |

**Renderer は props だけで動く**ので、壁掛け・印刷・埋め込みで
**ストアも編集コードも持ち込まずに使える**。

#### ⚠ 循環依存を切るための `sync()`（設計上の要点）

ドラッグに要る `layoutCtx` は **`gridWidth` から決まり**、その `gridWidth` は
Canvas 層が実測して持つ。素直に引数で渡すと**値が一周して決まらない**。

→ **描画のたびに Renderer が `canvas.sync({...})` で現在の場面を入れ直し、
ハンドラは発火時に `sceneRef.current` から読む。**
⚠ `sync()` を呼び忘れると「掴めるが動かない」になる。

### 差異② State / Command 層の配線

ストアを読むのが `DashboardPage` だけだったので、**`DashboardCanvas` が
ストアから定義を取る**形にした。`definition` は props で渡さない
（渡せる形にすると「ストアと props のどちらが正か」が曖昧になる）。

### 差異③ Data / Search 層のディレクトリ化

`useSplunkSearch.js` / `dataSources.js` / `inputChoices.js` を
**`engine/data/` に集約**し、barrel を通す形にした（他層と同じ作法）。

### 差異④ Property Editor の editor 型

**⚠ 「13/28 型しか対応していない」は誤った見立てだった。**
実際に 30 個の viz の `config.json` を全部数えたところ、
**使われている型は 13 種で、その全部に対応済み**＝**カバー率 100%** だった。
（28 という数は Studio 全体のカタログであって、DPX が必要とする数ではない。）

→ 「不足」ではなかったが、将来のために 3 種を追加した:
`editor.percent`（⚠ Studio と同じく **UI 値の 1/100** を保存）/
`editor.trellisSplitBy` / `editor.seriesColorsByField`。

**教訓**: **「N/M しか対応していない」と言う前に、分母が正しいか確かめる。**
分母を外部のカタログから借りると、実態と無関係な「不足」を報告してしまう。

### ⭐ 層の境界をテストで固定した（`test/layers.test.mjs`）

**層の分離はコメントで書くと必ず腐る**（実際 Renderer は 1,600 行まで膨らんだ）。
依存の向きは機械が読める性質なので、12 個のテストで固定した:

- Renderer がストアを import しない／ドラッグ実装を持たない
- Data 層の中身へ直接 import しない（barrel 必須）／Data 層が描画層を知らない
- Schema が React にも他層にも依存しない／Layout が React に依存しない
- Motion Engine の依存がゼロ／生成物を手で編集していない

### ⚠ ソースに NUL が混入していた（3 ファイル・このテストで発見）

`dataSources.js` / `material/brush/types.js` / `panelFields.jsx` の 3 つで、
**キーの区切りに生の NUL を書いていた**。動作は正しいが
**ファイルが「バイナリ」扱いになり `grep` が無言で何も返さなくなる**
（sankey-flow で踏んだのと同じ罠。**同じ過ちを別の場所で 3 回繰り返していた**）。

→ エスケープ表記（バックスラッシュ + u0000）に統一。**実行時の値は同一**。
→ `layers.test.mjs` に制御文字の検査を入れて**再発を検出できるようにした**。

### 実機確認（2026-08-13・検証ボード `dpx_rearch_verify`）

**分離の前後で挙動が変わっていないことを E2E で確かめた**（ビルドでは捕まらない）:

| 検証 | 結果 |
|---|---|
| ドラッグ移動 → 保存 → 永続化 | ✅ x: 0 → 2 |
| 区画ごと移動（相対位置の保持） | ✅ 全メンバーが同じ量だけ移動 |
| ドラッグ中のプレビュー（定義を書かない） | ✅ 移動・リサイズとも |
| Ctrl+Z / Ctrl+Shift+Z（25 項目） | ✅ 全項目 |
| Property Editor（カスタム viz） | ✅ **未対応 0 件**・152 コントロール |
| 描画（スクリーンショット確認） | ✅ 5 パネル・区画枠・カスタム viz とも正常 |

### ⚠ E2E ツールのフィクスチャ決め打ちを直した

実機確認の過程で、**パネル ID や座標を決め打ちしたツール**が落ちた。
**製品の退行ではなくツール側の古さ**だったが、誤診しかけたので直した:

| ツール | 何が決め打ちだったか |
|---|---|
| `dp-dragpreview-e2e.mjs` | パネル ID `p1`（引数化）＋ **掴み手のオフセット 4px** |
| `dp-undo-e2e.mjs` | パネル ID `p1` / `p2`（引数化）＋ **配置の決め打ち** |

⚠ **リサイズの掴み手は 4px 内側では掴めない**（外周が move 用の
オーバーレイに覆われている。実機で `elementFromPoint` で観測）。**8〜12px 内側**を掴む。

⚠ **右に伸びる余地が無いパネルでリサイズを試すと、クランプされて
「幅が変わらない」のが正常**。これを「リサイズが壊れた」と誤診しかけた。
**否定的な結論を出す前に、そもそも動ける状況かを確かめる。**

---

## Phase 6: 構造の作り直し（妥協しない版）✅ **完了（2026-08-13）**

> ユーザー指示: 「既存の動きが壊れるのを恐れて手出ししていなかった部分も含めて直す。
> まだリリースしていないし、問題があれば後から修正すればいい。
> **設計・構造が美しく納得性があり、あとから機能を追加しやすく**」

前フェーズまでで**意図的に見送っていた 3 つ**に手を入れた。

### ⭐ 差異①: Viz SDK（最大の構造問題）

**症状**: 7 つのネイティブ viz が engine の内部 **8 モジュール・23 シンボル**を
直接 import していた。しかもそのうち 1 つは **Property Editor**（`optionEditors.jsx` の
`dosToField`）＝**viz が Builder に依存する層違反**。

```
Before:  viz ──> colorRules / themes / vizKit / scale / timeBrush /
                 tokens / vizBus / material/brush / optionEditors(!)
After:   viz ──> engine/viz（Viz SDK）──> 内部
```

**効果**: engine の内部構造を変えても **viz が巻き添えにならない**（SDK が緩衝材）。
「viz を足すとき何を import するか」が **1 か所を見れば分かる**。

- `engine/viz/index.js` … viz が使ってよいものの全部（唯一の入口）
- `engine/viz/data.js` … **サーチ結果の形を知る唯一の場所**（`useVizData`）
- `engine/viz/kit.js` … 共通小物（`toNum` / `fmtNumber` / `useContainerSize` / `EmptyHint`）
- `engine/viz/types.js` … VizProps の契約（Studio 拡張と互換）
- `engine/data/dos.js` … **DOS 文字列は Data 層へ**（UI ではなくデータの形式）

⚠ 以前は 7 つの viz が全部 `dataSources?.primary?.data` を各自で掘っていた。
データの形を変えたくなったら **7 箇所直す**ことになっていた。

### ⭐ 差異②: `nativeViz.jsx`（2,516 行）を viz ごとに分割

| ファイル | 行数 |
|---|---|
| `viz/native/DpxLine.jsx` | 799 |
| `viz/native/DpxBar.jsx` | 572 |
| `viz/native/DpxTable.jsx` | 475 |
| `viz/native/DpxDonut.jsx` | 215 |
| `viz/native/DpxValue.jsx` / `DpxStatus.jsx` / `DpxRanking.jsx` | 各 ~170 |

**分割は機械的に行い、本文が 1 文字も変わっていないことを検証してから**
元ファイルを消した（手で写すと必ず写し間違える）。

図形・装飾・linkLine・SpikeViz も `engine/viz/` へ集約。

### ⭐ 差異③: `themes.js`（1,514 行）を Theme / Surface に分割

前フェーズで「レビュー不能な差分になる」「実機で得た知見を壊す」として
**意図的に見送っていた**もの。今回は分割し、**211 個のテーマテストが
全部通ることで同一性を確認**した。

- `engine/design/theme/` … 配色（18 プリセット・`resolveTheme`）
- `engine/design/surface/` … 面の質感（25 variant・タイトル字面）。**React 非依存**
- `engine/themes.js` … 互換 barrel（実装は持たない）

これで Design Engine の 4 軸が**再輸出ではなく実体**になった。

### ⚠⚠ 分割で作り込んだバグ 2 件（どちらもビルドは通った）

**これが「分割は危ない」の具体的な中身**。記録しておく。

| バグ | 症状 | 原因 |
|---|---|---|
| `DEFAULT_STATUS_MATCHES is not defined` | **画面が真っ白**（パネル 0 枚） | `DpxStatus` が使う定数が、行の位置の都合で **`DpxValue` のファイルに入った** |
| `e.toFixed is not a function` | **画面が真っ白** | `DpxTable` に**グローバルと同名のローカル `fmt`** があり、機械置換で取り違えた |

⚠ **どちらも `yarn build` は成功していた。** バンドラは実行時の参照を追わない。
→ **実機で開くまで分からなかった。**

**対策として `tools/check-undefined.mjs` を作った**（`yarn test` に組み込み済み）。
- コメント・文字列・JSX テキスト・オブジェクトのキーを除外してから未定義参照を探す
- **実際にこのバグを再現させて、検出できることを確認済み**
- 86 ファイルで誤検出 0

### ⭐ 差異④: E2E の回帰スイート化

```bash
node tools/dashboard-loop/src/dp-regression.mjs          # 全部
node tools/dashboard-loop/src/dp-regression.mjs --only drag
```

- **固定フィクスチャ**（`fixtures/dpx-regression.json`）を用意
- ⚠ **テストごとにフィクスチャを push し直す**。E2E は実機の定義を書き換えるので、
  前のテストの結果が残ると**「前提の座標が違う」だけで落ちる**（実際に踏んだ）
- `dp-delete-view.mjs` を新設（⚠ **owner のネームスペースを指定しないと 500**）

**結果: 8/8 成功。**

#### ⚠ 直した「古い E2E」の中身（全部フィクスチャ／UI の陳腐化）

| ツール | 何が古かったか |
|---|---|
| `dp-dragpreview-e2e` / `dp-undo-e2e` | パネル ID `p1`/`p2` と配置 `'0,0,4,3'` の決め打ち |
| `dp-settings-e2e` / `dp-group-e2e` / `dp-textcommit-e2e` | `input.dpx-input` を `.first()` で掴む |
| `dp-inputorder-e2e` | **↑↓ ボタンで並べ替える前提**（実際は D&D に変わっていた） |

⚠ **`.first()` で入力欄を掴まない。** キャンバスに「入力」があると
そちらが先に来て、**`draggable` なカードがクリックを遮る**（TimeoutError）。
→ **現在値で特定する**（`input.dpx-input[value="..."]`）。

⚠ **HTML5 の D&D を 1 回の `evaluate` で投げない。**
`dragstart` が呼ぶ `setDragIdx` は React の状態更新なので**次のレンダーまで反映されない**。
同じ同期ブロックで `drop` まで投げると、ハンドラが `dragIdx == null` を見て
**何もせず終わる**（「イベントは届いているのに動かない」ように見える）。

### 層の境界テストを 12 → 21 件へ

追加した検査（**わざと違反を入れて、検出できることを確認済み**）:

- **viz は Viz SDK だけを見る**（engine の内部を直接 import しない）
- **viz は Builder（Inspector / Canvas）を知らない** ← 実際に起きていた層違反
- viz はストアを知らない / SDK は viz を import しない（循環防止）
- **1 viz = 1 ファイル**（1,000 行を超えたら落ちる）
- Theme / Surface が別ファイルで実在する / Surface は React 非依存
- ⚠ **ディレクトリ import を使っていない**
  （webpack は解決するが **Node の ESM は解決しない**＝ビルドは通るのにテストだけ落ちる）

### 実機確認（2026-08-13）

| 検証 | 結果 |
|---|---|
| 回帰スイート 8 件 | ✅ **8/8** |
| 単体テスト | ✅ 全 19 ファイル（うち themes 211 アサーション） |
| 未定義参照チェック | ✅ 86 ファイルで 0 件 |
| 描画（スクリーンショット確認） | ✅ 7 viz すべて正常 |

---

## Phase 7: ディレクトリ構造の再編成 ✅ **完了（2026-08-13）**

**きっかけ**: ユーザーの指摘「`material/` 配下の `brush` は何？」。
調べると **Brush の実体が 2 か所に割れていた**（`design/brushFilter.jsx` と
`material/brush/`）。「Design Engine の 4 軸」と言いながら、
コード上は Brush だけ 4 軸の外に居た。

さらに見ると、**`engine/` 直下に 31 ファイルが平置き**で、
層になっているもの（`layout/` `data/` …）と雑多なものが混在していた。

### 目標: 図の層 = ディレクトリ

```
components/
├── builder/     11  Palette / Inspector / Toolbar / 各種エディタ
├── canvas/       3  編集の器（ドラッグ・プレビュー）
├── renderer/     7  DashboardRenderer・背景・枠・入力バー
├── schema/       6  Zod スキーマ・取り込み検証・テンプレート
├── store/        3  定義ストア・編集ストア・履歴
├── layout/       4  Grid / Freeform
├── viz/         24  SDK・Registry・Adapter・ネイティブ 7 種・図形・装飾
├── design/      11  Theme / Surface / Brush / Motion / 品質
├── data/         7  サーチ実行・データソース・DOS・ビュー永続化
├── shared/       6  UI 部品・トークン・時間ピッカー
└── pages/        2  画面
```

**`engine/` は廃止**（層のどこかに必ず属するようにした）。

### 主な移動と改名

| 旧 | 新 | 理由 |
|---|---|---|
| `engine/DpxDashboard.jsx` | `renderer/DashboardRenderer.jsx` | **図の「Dashboard Renderer」と名前を一致**させた |
| `engine/dashboardSchema/` | `schema/` | 衝突していた `schema.js` は削除済みなので短縮できる |
| `engine/vizKit.jsx` | `viz/parts.jsx` | `viz/kit.js` と二重だった |
| `engine/material/brush/` | `design/brush/` | ⭐ **Brush の実体を 4 軸の中へ** |
| `engine/design/brushFilter.jsx` | `design/brush/filter.jsx` | Brush の 2 経路を 1 か所に |
| `engine/material/quality.js` | `design/quality.js` | material/ を解体 |
| `engine/themes.js` | **削除** | 実体は `design/theme/` と `design/surface/` |
| `engine/material/index.js` | **削除** | **中身が design barrel の再輸出＝循環**していた |

### やり方（手で動かさない）

**80 ファイルを手で動かすと必ず取りこぼす**ので、2 本のスクリプトで機械的に行った:

- `tools/restructure.mjs` … 移動表を単一の真実として `git mv`
- `tools/fix-imports.mjs` … 相対 import を貼り直す

#### ⚠ import 書き換えの肝（ここを間違えると直らない）

相対 import は「**書いた側の元の場所**」から解決しないと意味が取れない。

```
viz/index.js の '../themes' は、
  元が engine/viz/index.js なので engine/themes を指す。
  今の場所（viz/）から読むと themes ＝ 別物。
```

→ 各ファイルの**旧パス**を持ち、「旧位置 + 相対指定」で旧ターゲットを求め、
移動表で新ターゲットへ引き直し、「**新位置**から見た相対パス」を書き戻す。

最初これを「今の位置から解決」で書いたため **書き換え対象が 4 件しか出ず**、
実際には **104 件壊れていた**（検出スクリプトで発覚）。

### ⚠ 移動でしか出ないもの（記録）

| 事象 | 原因 |
|---|---|
| `git mv` が `fatal: not under version control` | **未コミットの新規ディレクトリ**があった。git mv 失敗時は素の mv に落とす＋**再実行可能**にする |
| webpack だけ壊れる | **alias が旧パス**（`extensionAdapter`）を指していた |
| ビルドだけ壊れる | `components/` の外（`pages/dpx/index.jsx`）からの import は走査対象外だった |
| Node ESM のテストだけ壊れる | テストが**旧パスを文字列で持っていた**（19 ファイル） |
| 生成物の差分が消えない | **ジェネレータのテンプレート**が旧 import を出力していた |

### 層テストを 21 → 23 件へ

- **`engine/` が復活していない**（層のどこかへ置くことの担保）
- **トップレベルが図の層と一致する**（増やしたら落ちる）
- **Design Engine の 4 軸すべてが `design/` 配下に実体を持つ**＋ `material/` が無い
- viz が Renderer / Builder を import しない

⚠ SDK 規則の適用範囲を**「viz 本体だけ」**に絞った。
`viz/` には Registry（全 viz を束ねる）と Adapter（ホストの橋渡し）も居るので、
一律に掛けると**当たり前の依存を違反と報告**してしまう。

### 実機確認（2026-08-13）

| 検証 | 結果 |
|---|---|
| 回帰スイート 8 件 | ✅ **8/8**（81 ファイル移動後） |
| 単体テスト | ✅ 全 19 ファイル |
| 未定義参照チェック | ✅ 84 ファイルで 0 件 |
| 描画（スクリーンショット） | ✅ 7 viz・入力 2 個とも正常 |

---

## 全 viz の描画確認（2026-08-13・実機）

**登録されている 46 個すべて**を 1 枚に並べて描画を確認した。
再編成（Phase 6・7）で **viz が 1 つも壊れていないこと**の担保。

| 区分 | 数 | 結果 |
|---|---|---|
| DPX ネイティブ（チャート 7・図形 5・装飾 2・その他 2） | 16 | ✅ 全部描画 |
| カスタム viz（Studio 拡張） | 30 | ✅ 全部描画 |
| **合計** | **46** | **✅ ok 46 / empty 0 / error 0** |

WebGL を使うもの（Attack Globe・Metric Terrain・World Map・Japan Map）も含めて
**JS エラー 0 件**。

### 作ったもの

- `fixtures/build-allviz.mjs` … ボードを**生成**する（手書きしない）
  - ⚠ **オプション名を推測で書かない**。各 viz の `config.json` から
    `optionsSchema` を読んで実在するキーだけを使う
  - ⚠ **列を指すオプションは DOS 文字列**（`> primary | seriesByName("x")`）。
    生のフィールド名だと viz のパーサが**黙って空を返す**
  - ⚠ **registry と突き合わせて検証する**（載せ忘れ・綴り間違いで exit 1）
- `src/dp-allviz-check.mjs` … パネルごとに描画状態を判定して分割撮影

### ⚠ 検証ツールで踏んだ 2 件（記録）

| 事象 | 原因 |
|---|---|
| **同じ絵が何枚も撮れた** | `window.scrollTo` では動かない。**DPX は内側の `div.dpx-scroll` がスクロールする**。気づかないと「全部見た」と誤認する |
| 正常な 4 枚を `blank` と誤判定 | **図形・装飾は要素数が少ないのが正常**（矩形は div 1 枚）。一律の閾値で「要素が少ない＝描けていない」と判定していた |

⚠ **9 本のサーチが走るので 60 秒待つ**。焦って撮ると
正常なパネルまで「データがありません」になる。

### データソースは 9 種類用意した

**1 種類で全部賄おうとしない**（列が合わないと空になり、実装の問題と誤診する）:
カテゴリ別 / 時系列 / 行列 / 階層 / フロー / 地理 / 国内 / 期間 / 複数メトリック。

---

## Ink Layer（画材を「どこに」掛けるか）✅ **2026-08-13**

**きっかけ**: ユーザーの指摘「よく見たら文字が歪んでいる」。
**Claude は 4 倍に拡大せず「文字は無傷」と誤って報告していた（訂正）。**
縮小された画像で判断したのが原因。**細部の主張は等倍以上で確かめる。**

### 原因は画材ではなく「適用範囲」だった

SVG フィルタは**ラスタライズ後の絵**に掛かる。パネル全体に掛けていたため、
線・塗り・**文字**の区別が付かず、ラベルまで波打っていた。

```
✗ <div style="filter:url(#brush)"><Viz/></div>   ← 中身ぜんぶ歪む
✓ 「印」だけに filter を当てる                    ← 文字は素通し
```

⚠ **画材（feTurbulence のパラメータ）をいくら調整しても直らない。**
強くすれば文字も歪み、弱くすれば線も効かない。
→ **「画材を自作すれば直る」は誤り**（ユーザーからの問いに対する答え）。

### 設計：宣言と自動検出の 2 段構え

| 優先 | やり方 | 対象 |
|---|---|---|
| ① | viz が `data-dpx-ink="mark"` で**自分で宣言** | 今後の viz・作り込みたい viz |
| ② | **SVG の形状要素だけを自動で拾う** | 宣言していない既存 30 viz |

- `design/brush/ink.js` … 判定（**依存ゼロ**・テスト 13 件）
- `design/brush/useInkFilter.js` … DOM への適用

**要点**:
- `text` / `tspan` / `foreignObject` / `image` は**絶対に印にしない**
- **`text` の中の形状も印にしない**（親が文字なら結局文字が歪む）
- **最も外側の印にだけ**当てる（入れ子に多重で掛けると歪みが累積する）
- **未知のタグは印にしない**（安全側に倒す）
- viz が再描画すると filter が消えるので `MutationObserver` で当て直す

### ⚠ Canvas / WebGL は既定で除外

`<canvas>` は**1 枚の絵に図形と文字が一緒に焼かれている**ので原理的に分離できない。
→ 既定で掛けない。承知のうえで掛けたいパネルだけ `style.brushCanvas: true`。

⚠ ただし **viz が印を宣言していれば canvas があっても掛ける**
（宣言できている＝viz が「どこを歪ませてよいか」分かっている）。

### 実機確認（2026-08-13）

| 検証 | 結果 |
|---|---|
| 棒＋日本語ラベル（4 倍拡大で確認） | ✅ **質感は保持・文字の歪みは消えた** |
| カスタム viz（gauge-arc・無改変） | ✅ `VALUE` `36` `前回 19` `最大` すべて鮮明 |
| 全 46 viz に水彩を適用 | ✅ **46/46**・error 0 |
| World Map（WebGL） | ✅ **除外され文字は無傷** |
| 回帰スイート | ✅ **9/9** |

### ⚠ 追加修正: 「カスタム viz に質感が乗らない」（2026-08-13・ユーザー報告）

**症状**: crayon を選んでも gauge-arc がほぼ変化しない（フィルタは当たっているのに）。

**原因**: `scale` は **px の固定値**なので、**図形の大きさで効き方が変わる**。

| 図形 | 大きさ | scale 4 の相対量 | 見え方 |
|---|---|---|---|
| 棒（dpx.bar） | 約 60px | 約 7% | しっかり手描き |
| ゲージの弧 | 約 270px | 約 1.5% | **ほぼ効かない** |

実機で scale を 4 → 8 → 14 と上げて確認し、**大きい図形ほど強くしないと
同じ印象にならない**ことを確定した。

**対策**: `SIZE_TIERS`（`ink.js`）で**図形の外接矩形の長辺に応じた倍率**を掛ける。
フィルタは**段ごとに別実体**を作る（`scale` は属性なので 1 つを共有すると
全部同じ強さになる）。`useInkFilter` が `getBBox()` で測って段を選ぶ。

- 小さい印（〜40px）… 0.7 倍（効きすぎて壊れて見えるので弱める）
- 標準（〜120px）… 1 倍
- 大きい（〜260px）… 1.6 倍
- 特大 … 2.2 倍（**上限あり**。青天井だと輪郭が溶ける）

⚠ **素の `dpx-brush-<id>` という filter は存在しない**（段ごとに分けたため）。
存在しない id を CSS で指すと**無言で無視される**＝「効かない」になる。

⚠ **大きさの判定は `ink.js`（依存ゼロ）に置く。** `filter.jsx` は JSX なので
Node の ESM から import できず、**テストが書けない**。

テスト 19 件（`test/ink.test.mjs`）。実機で 46/46・回帰 9/9 を再確認。

---

## ⚠ Brush の到達点と限界（2026-08-13・ユーザー指摘で確定）

### 2 つの経路は「強さ」ではなく「やっていること」が違う

| | DPX ネイティブ viz | カスタム viz（30 個） |
|---|---|---|
| 経路 | **描画 API**（rough.js） | フィルタ（SVG feDisplacementMap） |
| やること | **塗りを描き直す**（ハッチング線を生成） | 輪郭を**揺らす**だけ |
| 見た目 | 斜線が入って別物になる | **ベタ塗りのまま、形が少し歪む** |

⚠⚠ **フィルタ経路では「塗り感」は変わらない。** 変位マップは既にある絵を
ずらす処理なので、**原理的にハッチングを作れない**。`scale` をいくら上げても、
輪郭の歪みが増えるだけで塗りはベタのまま。

### Claude が繰り返した誤り（記録）

**「DOM に filter が当たっている」ことと「狙った見た目になっている」ことを
同一視した。** そのため次の順で誤った報告をした:

1. 「46/46 で質感が乗った」← filter の適用を確認しただけ
2. 「`scale` を上げたので効くようになった」← 輪郭の揺れを見て判断
3. ユーザーの「棒は効いていて gauge-arc は変わっていない」で初めて気づいた

→ **見た目の主張は、比較対象を揃えて等倍以上で確認する。**
   「効いた」の基準を最初に決めてから測る。

### 同じ見た目にするには

カスタム viz の描画コードを rough.js に差し替えるしかない（`brushArc` 等は
`design/brush/brushes.js` に実装済み）。ただし:

- **1 行では済まない**（弧を描いている箇所を全部差し替える）
- **viz が `useBrush` を import する＝DPX に依存する**。
  Studio では動かなくなり、**両対応が壊れる**

→ **2026-08-13 時点では見送り**（ユーザー判断）。

### 画材が効かない viz（構造上の理由）

| 種類 | 対象 | 理由 |
|---|---|---|
| **Canvas / WebGL** | Attack Globe / Metric Terrain / World Map / Japan Map | 1 枚の絵に文字が焼き込まれ**分離できない**（既定で除外） |
| **HTML div 描画** | Gradient Bar / Liquid Tube / Country Graph / Spotlight Frame / Tab Selector | **SVG 形状が 0 個**。自動検出が届かない（未対応） |

## Phase 6: Renderer の内部分割 ✅ **完了（2026-08-15 / v1.0.1）**

タブ切替の性能改善（同一サーチの共有・タブの DOM 保持）で
`DashboardRenderer.jsx`（1,609 行）に手を入れた際、**タブの生存管理を
`useState` で書き足してしまった**ので、同じ版のうちに整理した。

**着手前に計測した**（行数ではなく結合で判断するため）:

| コンポーネント | 行数 | 他と共有していたもの |
|---|---|---|
| `Panel` | 597 | **定数のみ**（TITLE_H / HAND_DRAWN_INSET / ENTRANCE_ANIM …） |
| `DpxDashboard` | 468 | 同上 |
| `GroupFrame` ほか | 544 | `GROUP_HEADER_H` 1 個 |

→ **状態の共有はゼロ**。「God Component」ではなく
**独立したものが 1 ファイルに同居していた**だけと判明したので、
分割は低リスクと判断した（`DashboardPage.jsx` の useState 20 個とは別物）。

**やったこと**:

| 新ファイル | 中身 | React 依存 |
|---|---|---|
| `renderer/tabLifecycle.js` | どのタブを DOM に残すか（LRU・上限・掃除） | **なし**（純粋関数） |
| `renderer/tabLayout.js` | タブ 1 枚のレイアウト解決（見出し行の挿し込み） | **なし**（純粋関数） |
| `renderer/rendererConst.js` | 寸法・アニメ表（両ファイルが共有する定数） | なし |
| `renderer/Panel.jsx` | パネル 1 枚の描画（サーチ・viz・質感・全画面） | あり |

**境界は `test/layers.test.mjs` に 4 件追加して機械で固定**（循環参照の禁止・
Renderer が viz 解決を持たない・定数の定義は 1 か所・純粋関数は React 非依存）。

### ⚠ この分割でやらかしたこと（再発防止）

**同名・別シグネチャの関数を作って、実機で「何も出ない」状態にした。**

Renderer 内のローカル関数 `panelsOfTab(tabId)`（1 引数）と、切り出し先から
import した `panelsOfTab(panels, tabs, tabId)`（3 引数）が衝突した。JS は
引数の数を検査しないので `panels=tabId, tabs=undefined` となり、
**例外も警告も出さずに空配列**を返した。

- 症状は「**パネルが 1 枚も描かれない**」。しかも **`pageErrors` はゼロ**
- **ビルド・既存テスト・`check-undefined.mjs`・lint をすべて素通り**した
- 気づいたのは**実機のスクリーンショットを見たとき**だけ

→ **`tools/check-arity.mjs` を追加**（`yarn test` に組み込み）。
import した関数を少ない引数で呼んでいないかを検査する。
誤検出を避けるため「末尾 1 個の省略は正当」「コメント・文字列は数えない」
「メソッド定義を呼び出しと誤認しない」を実装し、
**バグを再注入して検出できることを確認済み**。

**教訓**: **切り出した関数と同名のローカルを残さない。**
名前が同じで引数が違う関数は、JS では**静かに壊れる**。

## 残件（v1.0.1 時点）

- **カスタム viz の塗り感**（上記。描画 API 経路への移行が要る）
- **div 描画 viz への画材適用**（5 件。div は入れ子が深く文字と同階層のため、
  SVG のような単純な判定ができない）
- **fps の実測**（画材適用時。大量パネルでの影響は未計測）
- `Inspector.jsx`（1,965 行）と `DashboardPage.jsx`（947 行）の分割
  … ⚠ **こちらは本物の God Component**（useState 20 個）。Renderer と違い
  **状態が絡んでいる**ので、分割前に「何を保存すべきか」の整理が要る
