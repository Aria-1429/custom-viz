# Studio ハック集 — 仕様の隙間で実現できること・できないこと（実機検証つき）

`/splunk-viz` スキルの参照ナレッジ。**個々の viz の作り方ではなく、
「プラットフォームの隙間を突いてダッシュボードの仕組みそのものを拡張する」手筋**を集約する。
各項目に（実機確認済み）/（不成立・実機確定）/（未検証・推測）を明記する。
検証環境: Splunk Enterprise 10.4.2（開発機）。

> **不成立の記録も消さないこと。** 「できない」と実機で確定した事実は、
> 同じ発想を再検討するときの前提条件になる（sandbox 属性が変われば結論も変わる）。

---

## ✅ ハック1：トークンバス — viz 間のリンクドハイライト（実機確認済み 2026-08-09）

**クリックで設定した動的トークンは、別パネル（別 iframe）の `useTokens` に
リアルタイムで届く。** サーチを再実行せず描画だけが連動するクロスフィルタを作れる。

- 実装詳細・注意点は [studio-extension-viz.md](studio-extension-viz.md) §5
  「トークンは viz 間のメッセージバスとして使える」を参照。
- 参照実装: **ローカルブランチ `experiment/vu-console-token-bus`**（vu-console v1.1.0 の
  `highlightToken` / `findTokenValue()`。実機検証済みだが「一旦 v1.0.0 のまま」の判断で
  main 未マージ・未 push。採用時はこのブランチをマージする）。
- 検証: `viz_check_vu_link`（パネルAクリック → 別 iframe のパネルBが即ハイライト。
  before/after の DOM 属性まで確認）。
- **⚠ これが viz 間連携の上限**（下のハック5・7の不成立により確定）。
  発火は click のみ（ホバー・ドラッグでは発火できない。§5 実機確認済み）。

## ✅ ハック2：ダッシュボード定義をデータストアにする（実機確認済み）

`setOptions` は **optionsSchema に無いキーでもダッシュボード定義に永続化**され、
次回 viz に届く（link-line v1.11.0 `labelPos` / vu-console v1.1.0 `highlightToken` で実証）。

- **splunkd 再起動なしで機能追加できる**逃げ道として確立
  （編集パネルに出す必要が無い設定はスキーマに載せない）。
- 応用候補: 注釈ピン・確認済みフラグ（Ack）などバックエンド無しの状態保存。
  **制約**: 表示モードの setOptions は定義に載らない。永続化には
  「表示モードで操作 → pending → 編集モードで flush → ユーザーが保存」が要る
  （[studio-extension-viz.md](studio-extension-viz.md) §3 の pending flush パターン）。

## ✅ ハック3：標準テーブルをレンダラーとして使う（実機確認済み）

カスタム viz を1つも入れずに「値→色」の表を作る。隠しフィールド
（`_color_hex` + `showInternalFields:false`）＋ `columnFormat` ＋ DOS 17関数
（`gradient` / `maxContrast` / `frame` / `renameSeries` …）。

- 詳細は [studio-standard-viz.md](studio-standard-viz.md) §2.3〜2.14（全部実機画像つき）。
- カスタム viz のインストールが許されない環境への持ち出し手段になる。

## ❓ ハック4：透明オーバーレイ viz（未検証・推測）

図形パネルにタイトルバーが出ない・パネルは重ねてよい（Link Line × Icon Status 実績）
＋ WebGL 透過3点セット、を組み合わせた全面オーバーレイ演出（IDEAS.md 案2 Weather Panel）。

- **急所は `pointer-events: none` が iframe 越しに効くか**（未検証）。
  下のパネルを操作できなければ実用にならない。着手前に1プローブ。

## ❌ ハック5：BroadcastChannel / localStorage による viz 間直接通信（不成立・実機確定 2026-08-09）

**カスタム viz の iframe は `sandbox="allow-scripts"` のみ（`allow-same-origin` 無し）**。
実機の vu-console iframe 2枚の実コンテキストで測定した結果:

| 項目 | 結果 |
|---|---|
| `window.origin` | **`"null"`（opaque origin）** |
| `localStorage` 読み書き | **SecurityError** |
| `document.cookie` | **SecurityError** |
| `BroadcastChannel` | コンストラクタは存在し送信も例外なし。**しかし別 iframe に届かない**（opaque origin は各 iframe が別オリジン扱いのため） |

→ **viz 間の直接通信（ホバー同期・60fps 連携・共有キャッシュ）は不可能。**
viz 間連携はトークンバス（ハック1、click 駆動）が上限。
「送信は成功するが届かない」ので、**例外が出ない＝動いている、ではない**（いつもの罠）。

## ❌ ハック7：viz から認証付き splunkd REST を叩く（不成立・実機確定 2026-08-09）

opaque origin のため **fetch に session cookie が付かない**。
`/en-US/splunkd/__raw/services/server/info` へ `credentials: 'same-origin'` /
`'include'` の両方で試したが、**どちらも HTTP 200 で未認証のログインページ HTML** が返る
（JSON は取れない）。ネットワーク自体は通るが認証境界は越えられない。

→ viz が使えるデータは **dataContract で紐づけたデータソースだけ**、が正式にも実質にも正しい。

## ❓ ハック6：トークンに JSON を積む — 複数選択クロスフィルタ（未検証・推測）

トークン値はただの文字列で `payloadCallback` の値がそのまま入る（実機確認済み）。
選択集合を `JSON.stringify` してトークンに載せれば、単一値のトークンバスが
**複数選択・時間範囲 `{start,end}` の伝達**に化ける見込み。
未検証: 値の長さ制限・特殊文字。プローブは `viz_check_vu_link` の流用で小さく済む。

## ❓ ハック8：編集モード専用の作図ガイド viz（部品は実機確認済み）

`useMode`（edit/view、実機確認済み）で **編集モード中だけ**グリッド・配置ガイドを
表示する「ダッシュボード作者用の定規」。重ね配置ダッシュボード
（Icon Status + Link Line 系）の位置合わせ道具。
残る論点はハック4と同じ pointer-events（表示モードで下のパネルを塞がないか）。

## ✅（部品）ハック9：env トークンで見る人に合わせる（部品は実機確認済み）

`useTokens` の `env` にユーザー名・ロケール・タイムゾーン・版数が入っている。
サーチを変えずに「ログインユーザーで表示が変わる viz」（当番表・TZ補正時計・
言語切替）を作れる。未検証項目なし。単体 viz というより既存 viz への1行追加向き。

---

## 検証の記録

- ハック1: `viz_check_vu_link`（dashboard_loop_test）。クリック → 別 iframe の
  DOM 属性変化まで確認。
- ハック5・7: 同ダッシュボードの vu-console iframe 内で `frame.evaluate` により
  実測（2026-08-09）。iframe 属性は親ページから `sandbox="allow-scripts"` を確認。
- **sandbox 属性は Splunk のバージョンで変わりうる。** 将来 `allow-same-origin` が
  付いたらハック5・7の結論は覆るので、大型アップグレード後は再測定する価値がある。
