# Editor Probe（検証専用ビジュアライゼーション）

Dashboard Studio 拡張 viz の**プラットフォーム挙動を実機で確かめるための検証台**。
本番ダッシュボードで使う viz ではない。

このプラットフォームはドキュメント化されていない挙動が多く、コードからの推測がよく外れる
（実際、検証中に事前予想が7回外れた。公式ドキュメントにも2件誤りがあった）。
そのため**未確認の仕様は必ずここで1つずつ潰してから本番 viz に入れる**。

- **App ID:** `custom_viz_editor_probe` / **表示名:** Editor Probe
- 検証の全ログと結論は [ROUNDS.md](ROUNDS.md) にある

## これまでに確定したこと

editor 型 28 種とドリルダウン／トークンを全数検証済み（Splunk 10.4.1）。
結論はスキルのナレッジ
（`.claude/skills/splunk-viz/references/studio-extension-viz.md`）に反映済み。

| 領域 | 結果 |
|---|---|
| editor 型 | 実在候補 28 種のうち **20 種が使える**。使用不可 8 種 |
| ドリルダウン | `events` 宣言 ＋ `addDrilldownListener` で**トークン設定できる** |
| トリガー | **click のみ**。ホバー・範囲選択は発火する手段が無い |
| `triggerDrilldown` | **効かない**（例外も出ずサイレントに無視される） |

## 現在の内容

`config.json` に `events` / `supports` を宣言したクリック可能なテーブル。
セルを `addDrilldownListener` に1つずつ登録してあり、
編集画面で「インタラクション」→「トークンを設定」を設定すると
**セルを押した瞬間にトークンが入る**。

画面には「クリック前後でトークンが変化したか」「最後に送った値」「トークン生ダンプ」を出すので、
ホストの挙動を目視で確認できる。

## 使い方

```bash
yarn install
yarn build
yarn verify    # happy-dom によるローカル検証（API 呼び出しの引数形状を検査）
yarn package   # dist/custom_viz_editor_probe-<ver>-<hash>.spl
```

1. `.spl` を Splunk Web「App の管理 > ファイルから App をインストール」でアップロード
   （更新時は「App のアップグレード」にチェック）
2. `https://<host>:8000/en-US/_bump` → ハードリロード（Ctrl+Shift+R）
3. ダッシュボードに **Editor Probe** を追加し、下のサーチを紐付ける

**表示モードで操作すること。** 編集モードは iframe への入力が遮断される。

### サンプル SPL

```spl
| makeresults count=5
| streamstats count as i
| eval _time = relative_time(now(), "-" . (5 - i) . "d")
| eval host = "host-" . i, status = if(i % 2 = 0, "OK", "NG"), count = i * 7
| table _time, host, status, count
```

## 新しい検証を回すとき

1. [ROUNDS.md](ROUNDS.md) に**仮説と確認手順**を書く（推測は「推測」と明記する）
2. `config.json` / `visualization.jsx` を検証内容に合わせて書き換える
3. `yarn verify` を通してから `yarn package` → 実機で確認
4. **結果を ROUNDS.md に記録し、確定した知見はスキルのナレッジへ反映する**

`yarn verify` には「使用不可が確定した editor 型が config に紛れ込んでいないか」の
検査が入っている（紛れると編集パネルが全滅するため）。

---

## リリースノート

このセクションは本ビジュアライゼーションのバージョン履歴を記録します。
新しいバージョンをパッケージ化するたびに、履歴の先頭（下の区切り線の直下）に新しいエントリを追記してください。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョンは [セマンティックバージョニング](https://semver.org/lang/ja/) に従います。
変更種別: `追加` / `変更` / `修正` / `削除` / `非推奨` / `セキュリティ`。

---

### [1.0.0] - 2026-07-25

検証専用ビジュアライゼーションとしてリポジトリに正式収録（初回リリース）。

#### 追加

- **editor 型の検証台**：実在候補 28 種を全数検証し、20 種が使えることを確認。
  結果は [ROUNDS.md](ROUNDS.md) とスキルのナレッジに記録。
- **ドリルダウン／トークンの検証台**：`config.json` に `events` / `supports` を宣言した
  クリック可能なテーブル。各セルを `addDrilldownListener` に登録してあり、
  「インタラクション」→「トークンを設定」でセルクリック時に即トークンが入る。
- **ローカル検証**（`yarn verify`、happy-dom）：API 呼び出しの引数形状、
  行ごとに正しい値が送られるか、使用不可 editor 型の混入チェックなど 36 件。
- [ROUNDS.md](ROUNDS.md)：全ラウンドの仮説・実機結果・結論の生ログ。

#### 変更

- ルート直下の作業用フォルダ `test/`（git 管理外）から
  `visualizations/editor-probe/` へ移設し、正式収録した。
  アプリ ID を `test` → `custom_viz_editor_probe` に変更
  （`test` のままでは他アプリと衝突しうるため）。

#### パッケージ

- `dist/custom_viz_editor_probe-1.0.0-9cd10b5.spl`
