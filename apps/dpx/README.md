# DPX

> ⚠ **リリース前（v0.1.0）です。** `0.x` の間は破壊的変更を予告なく入れることがあります。

**Splunk 上で動く完全独自のダッシュボード基盤**（アプリ ID: `dpx`）。
Dashboard Studio でも classic（Simple XML）でもなく、独立 React ページの上に自前の
ダッシュボードエンジンを載せたものです。「Splunk 上で動作し、Splunk にサーチが投げられる」
ことだけを前提に、**より映えるダッシュボードを自由に簡単に作れる**ことを目指しています。

実装ナレッジ（構成・スキーマ・viz の作り方・踏んだ罠・E2E ツール）は
[.claude/skills/splunk-viz/references/dpx-platform.md](../../.claude/skills/splunk-viz/references/dpx-platform.md)
に集約しています。**着手前にそちらを読むこと。**

## 構成（30秒版）

```
Splunk Web
 └ ホストビュー dpx（画面はこの1枚だけ。template="pages/splunk_ui_app.html" ＝ Splunk 同梱）
    └ pages/dpx.js                        ← 唯一のランタイム（ホーム＋ダッシュボード）
        /app/dpx/dpx            → ホーム（一覧）
        /app/dpx/dpx?id=<app>/<name> → ダッシュボード
 └ 定義ビュー（1 ダッシュボード = 1 ビュー XML。isVisible=False の入れ物）
    └ <definition><![CDATA[ DPX スキーマ v1 の JSON ]]></definition>
```

- 保存形式は Studio と同型（ビュー XML に定義 JSON を埋め込む）。REST で動的に作成できる
- **画面間は SPA 遷移（pushState）＝ページ再読込ゼロ**。ボード切替・ホーム往復に白は出ない
- viz は「props を受け取る素の React コンポーネント」を `vizRegistry.js` に登録するだけ
  （iframe なし・config.json なし・splunkd 再起動なし）
- **カスタム Mako テンプレートは不使用**（10.4.0 非推奨・AppInspect 4.4.0 から審査 fail の対象）。
  検討した代替案と全数調査の記録は dpx-platform.md §1.1 を参照

## 開発ループ

```bash
cd apps/dpx
rm -rf stage && NODE_OPTIONS=--max-old-space-size=8192 yarn build   # 本番ビルド
yarn package                                                        # dist/*.spl
node ../../tools/dashboard-loop/src/install-viz.mjs $(ls -t dist/*.spl | head -1)
node ../../tools/dashboard-loop/src/shot-page.mjs /en-US/app/dpx/<view> --out /tmp/shots
```

---

## サンプルダッシュボード

| ファイル | 用途 |
|---|---|
| [`examples/aegis-soc.json`](examples/aegis-soc.json) | **ショーケース**。DPX でしか組めない構図を一枚にまとめたもの（下記） |
| [`examples/all-viz-check.json`](examples/all-viz-check.json) | 全 viz の描画確認用（30枚を並べただけ） |

### AEGIS / Global Threat Operations（ショーケース）

3タブ・25パネル・21データソース・14種の viz。**Studio では組めない**要素を意図的に集めてある:

- **左サイドバータブ**（`tabPosition: "left"`）
- **背景エフェクト**（`constellation`）がパネルの裏で常時動く
- **枠なしパネル**（`frameless`）で見出しと時計を地の上に直接置く
- **全幅の地図を1枚のキャンバスとして使う**（`frameless` + 12列。枠もタイトルバーも無い）
- 自作 viz（world-map / attack-globe / sunburst / sankey-flow / heat-matrix /
  timeline-swimlane / liquid-tube）とネイティブ viz を混在

⚠ **地図（world-map / attack-globe）の上に他のパネルを重ねない。**
DPX は `style.z` でパネルを重ね置きできる（Studio に無い機能）が、
**地図に対して使うと肝心の地形と着弾点が隠れる**。
重ねたガラスパネルは見栄えはするものの、地図の凡例・フロー一覧・
端の国（日本／オーストラリア）が読めなくなった（実機で確認して取りやめ）。
**重ね置きは「地図以外」で使う。** 地図は単独で全幅を与えるのが正解。

投入:

```bash
node tools/dashboard-loop/src/push.mjs apps/dpx/examples/aegis-soc.json --name dpx_aegis
```

⚠ **`makeresults format=csv` の CSV は本物の改行で書く。**
`\n` の2文字を埋め込むと**1行の壊れた CSV**になり、
**HTTP 200 のまま 0 行**が返る（エラーにならないので気づきにくい）。
⚠ **`eval` で日本語のフィールド名を参照するときは `'達成率'` と単引用符で囲む。**
囲まないとこれも **200 で 0 行**になる（このダッシュボードの作成中に実際に踏んだ）。

---

## できること・できないこと

### 見た目の 4 軸（Design Engine）

ダッシュボード全体の見た目を、独立した 4 つの軸で切り替えられます。
どの組み合わせも成立します（「ダーク × Liquid Glass × 水彩 × スプリング」など）。

| 軸 | 設定 | 選択肢 |
|---|---|---|
| Theme（配色） | `style.preset` | 18 プリセット |
| Surface（面の質感） | `panel.style.variant` | 25 種 |
| Brush（線と塗り） | `style.brush` | なし / 色鉛筆 / クレヨン / 水彩 / インク / マーカー |
| Motion（動き） | `style.motion` | なし / 控えめ / スプリング / オーガニック |

編集パネルの「デザイン」から選べます。

### ⚠ 画材（Brush）の効き方は viz によって違う

**同じ設定でも、DPX ネイティブ viz とカスタム viz で結果が変わります。**

| viz | 経路 | 見た目 |
|---|---|---|
| **DPX ネイティブ**（棒・折れ線・ドーナツ・ランキング） | 描画 API（rough.js） | **塗りにハッチングが入る**（別物になる） |
| **カスタム viz（SVG 描画）** | SVG フィルタ | **輪郭が揺れるだけ**（塗りはベタのまま） |
| **Canvas / WebGL**（Attack Globe・World Map 等） | — | **既定で対象外**（文字が焼き込まれ分離できない） |
| **HTML div 描画**（Gradient Bar・Liquid Tube 等 5 件） | — | **未対応**（SVG 形状が無く自動検出が届かない） |

⚠ フィルタ経路は**原理的に塗りを変えられません**（変位マップは既にある絵を
ずらす処理なので、ハッチングを作れない）。強度を上げても輪郭の歪みが増えるだけです。

**塗り感まで揃えたい場合**は、その viz の描画コードを rough.js に差し替える
必要があります（`design/brush/brushes.js` に `brushArc` 等を実装済み）。
ただし **viz が DPX に依存する**ため、Studio では動かなくなります。

### 画材を viz 側で細かく制御する

自動検出の結果を変えたいときは、その要素に属性を 1 つ足します。
**例外だけ書けばよく、全部を宣言する必要はありません。**

```jsx
<line ... data-dpx-ink="none" />   {/* この要素だけ画材から外す */}
<path ... data-dpx-ink="mark" />   {/* この要素も画材の対象に加える */}
```

⚠ Studio では**未知の `data-*` 属性として無視される**ので、両対応は壊れません。

## ライセンス

**MIT License**（[LICENSE](LICENSE)）。

バンドルに含まれるサードパーティ OSS の著作権表示・許諾条文は
[THIRD-PARTY-NOTICES.txt](src/main/resources/splunk/THIRD-PARTY-NOTICES.txt) に同梱しています
（配布物である `.spl` にも両方が入ります）。

⚠ `@splunk/dashboard-studio-extension` など Splunk 提供のパッケージは OSS ではなく
Splunk General Terms が適用されます（OSS 通知とは別枠で参照情報のみ記載）。

---

## リリースノート

このセクションは [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠します。
バージョニングは [SemVer](https://semver.org/lang/ja/) です。

> **v1.0.0 で最初の安定版になりました。**
> 0.1.0〜0.7.1 は再設計期間で、**破壊的変更を含みます**（スキーマ v1 は読めません）。
> ⚠ さらに以前、開発中の区切りとして 1.0.0〜1.8.0 という版番号を付けていた
> 時期がありますが、**それらとは無関係**です（0.1.0 で振り直しました）。
> 経緯は git の履歴で追えます。

---

### [1.0.0] - 2026-08-13

**最初の安定版。** 0.1.0 からの再設計を完了し、
**図の 11 層がすべてコード上の実体を持つ**状態になった。

#### この版で到達したこと

- **層＝ディレクトリ**。`builder / canvas / renderer / schema / store /
  layout / viz / design / data / shared / pages`（`engine/` は廃止）
- **Viz SDK**。viz が import してよいものが 1 つの入口に集約された
- **Design Engine の 4 軸**（Theme / Surface / Brush / Motion）が
  すべて `design/` 配下に実体を持ち、編集パネルから選べる
- **境界をテストで固定**（層 23 件・Ink 23 件・未定義参照チェッカ）
- **E2E 回帰スイート 9 件**を 1 コマンドで実行できる

#### ⚠ 既知の制約（v1.0.0 時点）

- **カスタム viz の画材は「輪郭が揺れる」までで、塗り感は変わらない**。
  DPX ネイティブ viz（rough.js で塗りを描き直す）とは効果が異なる。
  → 「できること・できないこと」を参照
- **HTML div で描く viz 5 件は画材の対象外**（SVG 形状が無いため）
- **Canvas / WebGL の viz は既定で対象外**（文字が焼き込まれ分離できない）
- 画材適用時の **fps は未計測**
- `Inspector.jsx`（1,965 行）と `DashboardPage.jsx`（947 行）は未分割

#### 変更

- バージョンを 1.0.0 に。**0.x の「破壊的変更を予告なく入れる」段階を終了**。
