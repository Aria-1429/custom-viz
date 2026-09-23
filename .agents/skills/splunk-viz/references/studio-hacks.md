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

## ハック15：合成クリックで「無人のトークン設定」（2026-08-10 実機確定）⭐

**`node.dispatchEvent(new Event('click'))` でトークンが入る。ホストは `isTrusted` を見ていない。**
これで「発火はクリックのみ」というカスタム viz 最大の制約が、**ユーザー操作なしで**破れる。

検証（`hack15_probe` / vu-console の3メーター。echo パネルで実際のトークン値を観測）:

| 撃ち方 | 結果 |
|---|---|
| 実マウスクリック（対照実験） | ✓ `init/init` → `cpu/72` |
| `MouseEvent('click')` 5点セット（pointerdown〜click） | ✓ `mem/48` |
| **`MouseEvent('click')` 単発** | ✓ `disk/91` |
| **座標も view も無い `new Event('click')`** | ✓ `cpu/72` |
| **viz 自身の `setTimeout` から自走発火** | ✓ `disk/91` |
| `hit.click()` | ✗ ただし理由は `SVGElement` に `click()` が無いから（DOM の仕様。ホストの拒否ではない） |

**分かったこと**:
- **必要なのは `click` イベント1発だけ**。pointer/mouse のシーケンスは不要。
- **`isTrusted`・座標・`view` のいずれも検査されていない**（`new Event('click')` で通る）。
- **注入直後でなく、時間差で自走させても効く** → **viz のコードに書いてそのまま動く**
  （Playwright から撃ったから効いた、ではない）。
- 発火先は `elementFromPoint` で拾った最深ノード（`<rect>`）。**バブリングするので
  登録ノードの子孫を撃てばよい**。

```js
// viz 内での使い方（addDrilldownListener で登録済みのノードに撃つ）
node.dispatchEvent(new Event('click', { bubbles: true }));
```

**⚠ 使うときの注意**:
- **無限ループを作らない**。データ更新 → 合成クリック → トークン更新 → サーチ再実行 →
  データ更新… と回りうる。**前回値と比較して、変化したときだけ撃つ**。
- ユーザーの操作を勝手に上書きする挙動になるので、**自動巡回はオプションで
  明示的に ON にさせる**（既定 OFF）。
- 検証スクリプト: `tools/dashboard-loop/probe-hack15b.mjs`（対照実験つき）、
  `probe-hack15c.mjs`（条件の絞り込み）。

**これで解禁されるもの**: ハック22（サーチ結果→トークン＝Simple XML の `<done><set>` 相当）、
壁掛けキオスクの自動巡回、最悪値への自動フォーカス。

## ハック11：viz からダッシュボードの時間範囲を書く（2026-08-10 実機確定）⭐

**`drilldown.setToken` の宛先に `global_time.earliest` / `global_time.latest` を
指定すると、ダッシュボード全体の時間範囲が実際に動く。**

```jsonc
"eventHandlers": [
  { "type": "drilldown.setToken", "options": { "tokens": [
    { "token": "global_time.earliest", "key": "row.tr.value" }   // 値は "-7d@d" 等の時間修飾子
  ] } }
]
```

- 実測：クリック前 `-24h@h` → クリック後 **時間ピッカーの表示が「Last 7 days」に変わった**
  （URL も `form.global_time.earliest=-7d@d` に変化。スクリーンショットで確認）。
- **合成クリック（ハック15）との併用も確認済み** ＝ 無人で時間範囲を動かせる。
- 用途: **カスタム時間ブラシ**（バケットをクリック → 全パネルがその期間にズーム）。
- 値は SPL の時間修飾子文字列（`-7d@d` / `-1h@h` など）。epoch でも可かは未検証。

## ハック6：トークンに JSON を積む（2026-08-10 実機確定）⭐

**JSON 文字列はトークンバスを無傷で通る。`JSON.parse` に成功する。**
単一値のトークンが**複数選択の集合**を運べる＝クロスフィルタが作れる。

- 実測ペイロード `{"hosts":["web-01","web-02"],"n":2,"q":"a&b=c d"}` が
  **`"` `[` `]` `&` `=` 空白すべて無傷**で往復し、`JSON.parse` 成功。
- **長さは 20,229 文字でも無傷**（247 / 1,063 / 4,563 / 20,229 で確認。実用上は無制限と考えてよい）。

**🛑 ただし SPL に埋めると壊れる（最重要の注意点）**:

```
| eval x="$sel_json$"     ← 生の " が文字列リテラルを割る
→ Error in 'EvalCommand': The expression is malformed.（実機で FATAL を確認）
```

- **Simple XML の `|s` フィルタ（`$tok|s$`）は Studio では効かない。**
  実機の dispatch 済み SPL は `len(""init"")` になっており（クォートを重ねるだけで
  エスケープしない）、かえって壊れた。**Studio で `|s` を使わないこと。**
- → **使い分けの結論**：
  - **JSON トークンは「viz が `useTokens` で読む」用途に限る**（ここは完全に安全）。
  - **SPL に流すなら JSON にしない**。カンマ区切り等の引用符を含まない形にして
    `split()` + `IN` で受ける（[[studio-inputs-tokens]] の multiselect と同じ流儀）。
- 検証スクリプト: `probe-h6d.mjs`（往復の無傷確認）、`probe-h6len.mjs`（長さ）、
  `probe-h6c.mjs`（**dispatch 済み SPL を REST で読んで FATAL を確認**）。

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

> **2026-08-10 にハック15・11・6 を実機検証し、3件とも成立**（上の「✅ 成立」章へ移動済み）。
> 残っているのはハック20＋21（実装のみ）とハック24（未調査）。

## ハック20＋21：ds.test / サーチを「設定チャネル」にする（実質検証済みの組み合わせ）

ハック10（複数データソース ✓）× ds.test（JSON 直書きデータ ✓）の合成。
viz に `config` という名前のソースを縛り、**任意の表形式設定**を流し込む:

- **ds.test 版（ハック20）**: フロアプラン座標・状態→色→優先度の対応表・SLA 目標一覧など、
  editor 型では表現できない構造化設定。編集パネル不要・再起動不要。
  残る確認は「ds.test をセカンダリ名で縛れるか」のみ（10分）。
- **サーチ版（ハック21・自動キャリブレーション）**: `| stats p50(x) as warn, p95(x) as crit`
  を `config` ソースにすると、**色帯が過去データの分位点に自動追従**する。
  しきい値の手動メンテが消える。ハック10確定済みのため**技術的な未知はゼロ、実装のみ**。

## ハック22：見えないセンサー viz — 「サーチ結果 → トークン」の復活（2026-08-10 **実機成立**）⭐

**Studio に無い Simple XML の `<done><set>` 相当が作れる。**
サーチ結果を読んで**ユーザー操作なしにトークンを設定**できることを実機で確認した。

**実測**（`probe-hack22.mjs`。vu-console の中核ロジックだけを再現して検証）:

| 確認項目 | 結果 |
|---|---|
| データ到着で自動発火 | ✓ サーチ結果から最悪値の行（`disk=91`）を選び、**無人でトークン設定**（`init/init` → `disk/91`） |
| **無限ループしないか**（最重要） | ✓ **12秒放置しても発火は1回のまま**。前回値と比較するガードが効いた |

**中核ロジック**（これを 1px の不可視 viz に入れれば完成。**残りは見た目だけ**）:

```js
let lastKey = null;
const tick = () => {
    const worst = pickWorst();            // サーチ結果から対象行を選ぶ
    if (!worst) return;
    const key = `${worst.name}=${worst.value}`;
    if (key === lastKey) return;          // 🛑 同じ結果なら撃たない（暴走防止の要）
    lastKey = key;
    node.dispatchEvent(new Event('click', { bubbles: true }));   // ハック15
};
addDataSourcesListener(() => tick(), { invokeImmediately: true });
```

- 発火は**ハック15**（合成クリック）、登録時の取りこぼし対策に **`invokeImmediately`**
  （[studio-extension-viz.md](studio-extension-viz.md) の該当節）を使っている。
  **今回の一連の検証成果がそのまま組み合わさる形。**
- 🛑 **`lastKey` のガードは必須**。外すと「データ更新→クリック→トークン更新→再サーチ→
  データ更新」で回り続ける。
- 用途: 最重要アラートのホストへ全パネルが無人でフォーカス／壁掛けの自動巡回。
- ⚠ **viz として作るのは未実施**（検証したのはロジックのみ）。1px viz を新規に作る場合は
  `config.json` に `events` 宣言が要る＝**splunkd 再起動が必要**になる点に注意。
  既存 viz（vu-console 等）にオプションとして足すなら**再起動不要**。

## ハック24：パネルの条件表示 — **ネイティブ機能。`hideWhenNoData` は動く／カスタム条件は不発**（2026-08-10 実機）

**結論：Studio には「Visibility（表示条件）」がネイティブで存在する。ハックは不要。**
ただし **Simple XML の `depends` / `rejects` は使えない**（別物）。

### 実機で確かめた結果（この環境 = Splunk Enterprise 10.4.2）

| 項目 | 結果 |
|---|---|
| 編集パネルの「Visibility」セクション | ✓ **出る**（カスタム viz の vu-console でも出た）。`enableShowHide` は有効 |
| **`hideWhenNoData: true`** | ✓ **効く**。空サーチ（`where 1=0`）のパネルが**実際に消えた**（スクショ確認） |
| `showConditions` / `hideConditions`（カスタム条件） | ✗ **効かなかった**。式5通り（`==` / `=` / `LIKE` / クォート囲み / **定数 `true`**）を並べたが**全部そのまま表示**され、トークンを切り替えても変化なし |
| 定義の保存 | ✓ `expressions.conditions` も `containerOptions.visibility` も**そのまま保存される**（REST で確認） |

**⚠ 「定数 `true` すら効かない」＝式の書き方の問題ではない。**
条件が解決できないと**表示側にフォールバック**する挙動なので、**条件評価そのものが
走っていない**と考えられる。UI 側も「Set up condition」→ Conditions 一覧が**空**で、
`Create condition` から先へ進めなかった。
→ **`showConditionsEditor` フィーチャーフラグが無効**の可能性が高い（**未確定**。
フラグの実値は `window` から取得できず未確認）。

**実務上の結論**:
- **「データが無いパネルを隠す」だけなら今すぐ使える**（`hideWhenNoData`。JSON 1行）。
  これは**サーチ未設定の空パネルを消す**用途に有効。
- **トークン条件でパネルを出し分けるのは、この環境では現状できない。**
  ハック22（センサー viz でトークンを立てる）と組み合わせる構想は**保留**。
- 環境・バージョンによってはフラグが有効なこともありうるので、
  **別環境では「Set up condition が押せるか」を最初に見る**。

**① `depends` / `rejects` は「変換時の非対応警告」として実装されている**（＝Studio では死んでいる）:
- 出現箇所はすべて Simple XML → Studio の**変換器**（`warnIfShowHide` /
  `unsupportedConfigs` / `conversionWarnings`）。
- **変換時に「この設定は移行できません」と警告を出すためのコード**。
  → **Studio の JSON に `depends` を書いても効かない**（[[bundle-schema-not-registry]] の
  「移行マップが混ざる罠」と同じ構図）。

**② 本物は `containerOptions.visibility` + `expressions.conditions`**（バンドルのコード構造）:

```jsonc
// パネル側：どの条件で出す/隠すか（条件は id で参照する）
"containerOptions": { "visibility": {
    "hideConditions": ["<conditionId>"],
    "showConditions": ["<conditionId>"]
} },
// ダッシュボード直下：条件式の実体
"expressions": { "conditions": { "<conditionId>": { /* 式 */ } } }
```

- 編集 UI は右サイドバーの **「Visibility」パネル**（`SidebarCollapsiblePanel` /
  `data-test="collapsible-panel-visibility"`）。`ConditionListEditor` で条件を並べる。
- 既製の条件に **「no data」「no results」「hide」** があり、**「custom conditions」**（自由な式）も持つ。
- **入力（inputs）にも同じ Visibility がある**（`hideInViewMode` ＝ 表示モードでだけ隠す、も別途ある）。
- 条件式は専用の式エンジンで評価される（`expressionType: "conditions"` / DAG を作って解決）。

**⚠ フィーチャーフラグで出し分けられている**（`useFeatureFlags()` の
`enableShowHide` と `showConditionsEditor`）。**この環境で編集パネルに出るかは未確認**。
また `shouldHideVisibilitySection(type)` により **viz の型によっては出ない**
（`abslayout.line` は明示的に除外されている＝link-line 系の図形は対象外）。

**→ 次にやるべきこと（未実施）**：検証用ダッシュボードを編集モードで開き、
右サイドバーに「Visibility」セクションが出るかを**スクリーンショットで確認する**。
出るなら UI で条件を1つ作り、**保存された JSON を読んで正確な書式を採取する**
（推測で書かない＝[[bundle-schema-not-registry]]）。出ないならフラグが無効。

**⭐ これが効くと**：ハック22（サーチ結果→トークン）と組み合わせて
**「異常時だけ詳細パネルが現れる」ダッシュボード**が、カスタム viz 無しで作れる。

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
- ハック15・11・6: `hack11_probe` / `hack15_probe`（dashboard_loop_test）。2026-08-10。
  合成クリック → echo パネルのトークン値・時間ピッカーの表示・URL の form.* を観測。
  **判定は必ず「echo の値が変わったか」で行った**（例外が出ないことは証拠にしない）。
  ハック6 の不成立部分（SPL 埋め込み）は **dispatch 済みジョブの `search` フィールドを
  REST で読んで FATAL を確認**（[[verify-by-reading-dispatched-spl]] の流儀）。
- **sandbox 属性は Splunk のバージョンで変わりうる。** 将来 `allow-same-origin` が
  付いたらハック5・7の結論は覆るので、大型アップグレード後は再測定する価値がある。
- ⚠ 副産物の未確認事項: 各データソースのペイロードに `requestParams` / `meta` が
  付いてくることを視認済み（中身は未ダンプ。実効 earliest/latest やサーチ文字列が
  入っているなら「パネル単独の対象期間表示」に使える）。
