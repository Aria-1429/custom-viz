# DPX — DPX

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

---

### [1.0.0] - 2026-08-12

**初回リリース。** DPX（独自ダッシュボード基盤）の最初の正式版。
これ以前の 0.x は開発版のため、リリースノート・配布アーカイブとも本版に集約している。

#### 主な機能

**基盤**
- Splunk 上で動く**完全独自のダッシュボード基盤**（Dashboard Studio でも classic でもない）。
  独立 React ページの上に自前のレンダリングエンジンを載せた構成
- 画面はホストビュー 1 枚に集約した **SPA**（`?id=<app>/<name>` で切り替え。画面遷移で再読込なし）
- ダッシュボード定義は**ビュー XML 1 枚＝1 ダッシュボード**（classic と同じモデル）。
  REST で動的に作成・更新できる
- **Mako 不使用**（Splunk 同梱の標準テンプレートを使用）。AppInspect は
  cloud / private_* すべて **failure 0**

**作成・編集**
- GUI での**ダッシュボード編集**（パネルのドラッグ移動・リサイズ・複製・重なり順）
- **共有データソース**（1 つのサーチを複数パネルで参照しても実行は 1 回）
- **タブ**（上部／左サイドバー）と自動送り、**入力とトークン**、**パネル間のクリック連携**
- **SPL エディタ**（Splunk 公式の Ace＋SPL モード。構文ハイライト・整形）
- **設定の別ウィンドウ表示**（URL バーの無い浮遊ウィンドウ。マルチモニタ対応。
  ダッシュボードを全幅で見たまま調整できる）

**見た目**
- **配色プリセット 13 種**（画面発光系に加えて、紙・活版／青焼き図面／熱画像／電子ペーパー）
- **パネル質感 19 種**（コーナーフレーム・すりガラス・活版・印画紙・パンチカードなど）
- **背景エフェクト 22 種**（canvas 系・パターン系・グラデーション系）
- タイトルの位置と質感、パネル個別の色・角丸・傾きなどの上書き

**viz**
- **DPX ネイティブ viz**（表・棒・折れ線／エリア・ドーナツ・単一値・ランキング・ステータス一覧）
- **装飾・図形**（テキスト・時計・図形・コーナーフレーム）
- **既存のカスタム viz 31 種がそのまま動く**（iframe なし・Studio と同じ type 指定）
- **値→色のルール**を UI から設定可能（範囲・一致・グラデーション。Studio では DOS の手書きが必要だった領域）

#### 動作環境

- Splunk Enterprise 10.4 系で開発・実機検証
- 一部の viz は WebGL2 を使用（対応環境が必要）

#### ライセンス

- **MIT License** で公開（`LICENSE` を配布物にも同梱）

生成物: `dist/dpx-1.0.0-<hash>.spl`
