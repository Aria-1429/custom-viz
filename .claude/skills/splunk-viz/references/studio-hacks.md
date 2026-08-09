# Studio ハック集 — 仕様の隙間で実現できること・できないこと（実機検証つき）

`/splunk-viz` スキルの参照ナレッジ。**個々の viz の作り方ではなく、
「プラットフォームの隙間を突いてダッシュボードの仕組みそのものを拡張する」手筋**を集約する。
各項目に（実機確認済み）/（不成立・実機確定）/（未検証・推測）を明記する。
検証環境: Splunk Enterprise 10.4.2（開発機）。

> **不成立の記録も消さないこと。** 「できない」と実機で確定した事実は、
> 同じ発想を再検討するときの前提条件になる（sandbox 属性が変われば結論も変わる）。
>
> **番号には欠番がある**（2026-08-09 に優先度の低い未検証案を意図的に間引いた。
> 削除したのは：透明オーバーレイの pointer-events／編集モード専用ガイド／env 個人化／
> options 内トークン展開／defaults 一括オプション／setError の見た目／Deck viz／
> `?theme=` URL／Web Worker。必要になったら会話ログやこの節を手がかりに再検討する）。

---

# ✅ 成立（実機確認済み）

## ハック26：兄弟 iframe への直接 postMessage — ホバー同期の解禁（2026-08-09）

**`window.parent.frames[i].postMessage(msg, '*')` で viz iframe 同士が直接通信できる。**
ハック5（BroadcastChannel / localStorage 全滅）から導いた「viz 間の直接通信は不可能」は
**誤りだった**（下の【訂正】参照）。実測値:

- viz iframe は**トップ文書の直下**（`parent === top`）。`parent.frames` の列挙・
  `postMessage` とも sandbox 下で例外なく通り、**別の viz iframe が実際に受信した**
- **バースト200通: 送信 1.5ms・受信 200/200・受信スパン 1.5ms** —
  ホバー同期（60fps = 16ms 間隔）に対して2桁の余裕

```js
// 送信側（全兄弟へブロードキャスト。opaque origin なので targetOrigin は '*' 一択）
const frames = window.parent.frames;
for (let i = 0; i < frames.length; i++) {
    frames[i].postMessage({ __vizBus: 1, type: 'hover', ts: 1723190400, x: 42 }, '*');
}
// 受信側
window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__vizBus !== 1) return;   // 自分たちの規約マーカー以外は無視
    // d を「データとしてだけ」使う。関数実行・HTML挿入はしない
});
```

**使いどころ**：クロスヘア同期（パネルAをなぞると B・C に同じ時刻の縦線）／
ドラッグ中のライブ連動／トークンに載せるには重い一時状態の共有。

**規約（必ず守る）**:
- **これは揮発チャネル**。永続化・SPL 連携は従来どおりトークンバス（ハック1）が担当。
  「サーチに効かせる状態はトークン、描画だけの高頻度状態は postMessage」と使い分ける
- **`ev.origin` は `"null"`**（opaque origin）なので**送信元をオリジンで検証できない**。
  ページ内の全フレームに届く前提で、①独自マーカー（`__vizBus`）で自分宛てだけ処理、
  ②中身は必ずデータとして扱い実行しない、③構造を検証して壊れた値は捨てる
- `parent.frames` には viz 以外の iframe も入りうる。ブロードキャストはマーカーで受け手が選別する

**検証方法の注記**：実機の viz iframe 実コンテキストに `frame.evaluate` で注入して測定
（ハック5・7と同じ手法。viz のコードに書いた場合と同じ条件）。viz 実装としての
組み込みデモは未作成。ブラウザは Chromium で確認（他ブラウザは仕様上同挙動の見込み・未測定）。

## ハック1：トークンバス — viz 間のリンクドハイライト（2026-08-09）

**クリックで設定した動的トークンは、別パネル（別 iframe）の `useTokens` に
リアルタイムで届く。** サーチを再実行せず描画だけが連動するクロスフィルタを作れる。

- 実装詳細・注意点は [studio-extension-viz.md](studio-extension-viz.md) §5
  「トークンは viz 間のメッセージバスとして使える」を参照。
- 参照実装: **ローカルブランチ `experiment/vu-console-token-bus`**（vu-console v1.1.0 の
  `highlightToken` / `findTokenValue()`。実機検証済みだが「一旦 v1.0.0 のまま」の判断で
  main 未マージ・未 push。採用時はこのブランチをマージする）。
- 検証: `viz_check_vu_link`（パネルAクリック → 別 iframe のパネルBが即ハイライト。
  before/after の DOM 属性まで確認）。
- 発火は click のみ（ホバー・ドラッグでは発火できない。§5 実機確認済み）。
- **【訂正 2026-08-09】** かつてここに「これが viz 間連携の上限」と書いたが**誤り**。
  **揮発性の高頻度連携はハック26（兄弟 postMessage）で可能**。トークンバスの独自価値は
  「サーチに効く・ダッシュボード状態として永続する・入力とも連動する」点にある。

## ハック2：ダッシュボード定義をデータストアにする

`setOptions` は **optionsSchema に無いキーでもダッシュボード定義に永続化**され、
次回 viz に届く（link-line v1.11.0 `labelPos` / vu-console v1.1.0 `highlightToken` で実証）。

- **splunkd 再起動なしで機能追加できる**逃げ道として確立
  （編集パネルに出す必要が無い設定はスキーマに載せない）。
- 応用候補: 注釈ピン・確認済みフラグ（Ack）などバックエンド無しの状態保存。
  **制約**: 表示モードの setOptions は定義に載らない。永続化には
  「表示モードで操作 → pending → 編集モードで flush → ユーザーが保存」が要る
  （[studio-extension-viz.md](studio-extension-viz.md) §3 の pending flush パターン）。

## ハック3：標準テーブルをレンダラーとして使う

カスタム viz を1つも入れずに「値→色」の表を作る。隠しフィールド
（`_color_hex` + `showInternalFields:false`）＋ `columnFormat` ＋ DOS 17関数
（`gradient` / `maxContrast` / `frame` / `renameSeries` …）。

- 詳細は [studio-standard-viz.md](studio-standard-viz.md) §2.3〜2.14（全部実機画像つき）。
- カスタム viz のインストールが許されない環境への持ち出し手段になる。

## ハック10：複数データソース — 「1 viz = 1 サーチ」の縛りは無い（2026-08-09）

**ダッシュボード JSON で viz に2本目のデータソースを縛ると、dataContract に
宣言していなくても `getDataSources().dataSources` に名前付きで届く**
（キー実測 `["primary", "baseline"]`。baseline にも requestParams / data / meta が揃い、
別サーチの正しい行が入っていた）。ハック2と同じ「宣言なしでも素通し」パターンの
データソース版で、**config.json 無変更＝再起動不要で既存全 viz が対象**。

```jsonc
"dataSources": { "primary": "ds_now", "baseline": "ds_lastweek" }
```

- viz 側は `dataSources.<名前>?.data` を読むだけ（normalizeData を流用）。
  **baseline 不在・loading 中でも primary だけで描くガードを必ず入れる**。
- 用途: 今日 vs 先週のゴースト比較／実測＋しきい値定義の分離／状態＋注釈の2本立て。
- ⚠ 未検証: 編集画面 UI からの2本目の紐づけ（JSON 直書きのみ確認。UI に出すには
  `optionalDataSources` 宣言が要る可能性が高い）、loading フラグの集計仕様。

---

# ❌ 不成立（実機確定）

## ハック5：BroadcastChannel / localStorage による viz 間直接通信（2026-08-09）

**カスタム viz の iframe は `sandbox="allow-scripts"` のみ（`allow-same-origin` 無し）**。
実機の vu-console iframe 2枚の実コンテキストで測定した結果:

| 項目 | 結果 |
|---|---|
| `window.origin` | **`"null"`（opaque origin）** |
| `localStorage` 読み書き | **SecurityError** |
| `document.cookie` | **SecurityError** |
| `BroadcastChannel` | コンストラクタは存在し送信も例外なし。**しかし別 iframe に届かない**（opaque origin は各 iframe が別オリジン扱いのため） |

→ 表の**個々の測定事実は今も正しい**（BC / localStorage / cookie は死んでいる）。
「送信は成功するが届かない」ので、**例外が出ない＝動いている、ではない**（いつもの罠）。

> **【訂正 2026-08-09】** この表から「viz 間の直接通信は不可能・トークンバスが上限」と
> 結論したのは**誤りだった**。試したのが**同一オリジン前提の共有機構だけ**で、
> **クロスオリジン通信のために設計された postMessage を試していなかった**
> （「同じ次元で総当たりして、別の土俵を疑わなかった」の再演）。
> 正しい結論は**ハック26**：兄弟 iframe への直接 postMessage は通る。
> ホバー同期・60fps 連携は可能。**共有キャッシュ（永続）だけは今も不可能**
> （localStorage が無いため。状態は各 viz のメモリ内か、永続はトークン/options 経由）。

## ハック7：viz から認証付き splunkd REST を叩く（2026-08-09）

opaque origin のため **fetch に session cookie が付かない**。
`/en-US/splunkd/__raw/services/server/info` へ `credentials: 'same-origin'` /
`'include'` の両方で試したが、**どちらも HTTP 200 で未認証のログインページ HTML** が返る
（JSON は取れない）。ネットワーク自体は通るが認証境界は越えられない。

→ viz が使えるデータは **dataContract で紐づけたデータソースだけ**、が正式にも実質にも正しい。

---

# 🔥 有望・未検証（優先度順の検証キュー）

## ハック15：合成クリックで「無人のトークン設定」（未検証・かなめ）

`addDrilldownListener` は登録ノードの click を聴く（実機確認済み）。
**viz 自身が `node.dispatchEvent(new MouseEvent('click'))` を発火**したら、
ホストは人間のクリックと区別するか（`isTrusted` を検査しない実装は多い）。

- 通れば「クリックのみ」の発火制約を**ユーザー操作なしで**突破:
  壁掛けキオスクの自動巡回（N 秒ごとに選択が回る）／最悪値への自動フォーカス。
- **ハック22・自動巡回系はすべてこの成否に懸かる**。プローブは `viz_check_vu_link`
  流用で10分（iframe 内で登録済みノードに合成クリック → 別パネルと echo を観測）。
- 不発なら最後の手段としてホストブリッジの postMessage 直叩き（クリック時に流れる
  メッセージを親側で観測して同じ形を送る）があるが、**非公開プロトコル依存で
  バージョンアップに脆い**。正攻法が死んだ時だけ検討する。

## ハック20＋21：ds.test / サーチを「設定チャネル」にする（実質検証済みの組み合わせ）

ハック10（複数データソース ✓）× ds.test（JSON 直書きデータ ✓）の合成。
viz に `config` という名前のソースを縛り、**任意の表形式設定**を流し込む:

- **ds.test 版（ハック20）**: フロアプラン座標・状態→色→優先度の対応表・SLA 目標一覧など、
  editor 型では表現できない構造化設定。編集パネル不要・再起動不要。
  残る確認は「ds.test をセカンダリ名で縛れるか」のみ（10分）。
- **サーチ版（ハック21・自動キャリブレーション）**: `| stats p50(x) as warn, p95(x) as crit`
  を `config` ソースにすると、**色帯が過去データの分位点に自動追従**する。
  しきい値の手動メンテが消える。ハック10確定済みのため**技術的な未知はゼロ、実装のみ**。

## ハック22：見えないセンサー viz — 「サーチ結果 → トークン」の復活（15依存）

Studio に無い Simple XML の `<done><set>` 相当を作る。1px の不可視 viz にサーチを縛り、
**データ到着時に自分へ合成クリック**（payloadCallback はクリック時評価＝行の値を載せられる）
→ サーチ結果がトークンに入る。最重要アラートのホストへ全パネルが無人でフォーカスする、等。
**ハック15が通った場合のみ成立**。

## ハック11：viz からダッシュボードの時間範囲を書く — カスタム時間ブラシ（未検証）

`drilldown.setToken` の `token` に **`global_time.earliest` / `latest`** を指定したら
効くか。通れば「バケットをクリック → 全パネルがその1時間にズーム」という
カスタム時間ブラシが作れる（Simple XML では可能だった系譜）。
プローブは既存ダッシュボードに eventHandlers を1個足すだけ（15分）。

## ハック6：トークンに JSON を積む — 複数選択クロスフィルタ（未検証）

トークン値はただの文字列で `payloadCallback` の値がそのまま入る（実機確認済み）。
選択集合を `JSON.stringify` して載せれば、単一値のトークンバスが**複数選択**に化ける。
未検証は値の長さ制限・特殊文字の扱いのみ。プローブ15分。

## ハック24：パネルの条件表示 — Studio ネイティブ機能の存否調査（未調査）

Simple XML の `depends`（トークンでパネルを出し隠し）相当が Studio の layout に
あるかどうか、**まだ調べていない**。バンドル抽出済みスキーマの再走査＋docs＋1プローブで
白黒つく（30分）。有ればハック22と合成して「サーチ結果でダッシュボードの形が変わる」
まで届く。

---

# 検証の記録

- ハック1: `viz_check_vu_link`（dashboard_loop_test）。クリック → 別 iframe の
  DOM 属性変化まで確認。
- ハック5・7: 同ダッシュボードの vu-console iframe 内で `frame.evaluate` により
  実測（2026-08-09）。iframe 属性は親ページから `sandbox="allow-scripts"` を確認。
- ハック10: `viz_check_vu_multi`（dashboard_loop_test）。vu-console（primary のみ宣言）に
  `baseline` を JSON で縛り、iframe 内の `getDataSources()` で両キーとデータ内容を照合。
- ハック26: `viz_check_vu_link` の vu-console iframe 2枚で実測（2026-08-09）。
  A から `parent.frames` 経由で送信 → B の message リスナーで受信を確認。
  バースト200通=受信200/200（送信1.5ms・受信スパン1.5ms）。`ev.origin` は `"null"`。
- **sandbox 属性は Splunk のバージョンで変わりうる。** 将来 `allow-same-origin` が
  付いたらハック5・7の結論は覆るので、大型アップグレード後は再測定する価値がある。
- ⚠ 副産物の未確認事項: 各データソースのペイロードに `requestParams` / `meta` が
  付いてくることを視認済み（中身は未ダンプ。実効 earliest/latest やサーチ文字列が
  入っているなら「パネル単独の対象期間表示」に使える）。
