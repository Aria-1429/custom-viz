@./AGENTS.md

# Claude Code 固有の補足

共通ルールは上でインポートしている AGENTS.md が正本。ここには Claude Code だけに関係することしか書かない。

- スキル `splunk-viz` は `/splunk-viz` で明示的に呼ぶ（自動では読み込まれない）。`.claude/skills/splunk-viz/SKILL.md` は入口だけで、実体は `.agents/skills/splunk-viz/` にある
- 撮影したスクリーンショット（PNG）は Read ツールで画像として見える。「直った」の確認はこれで行う
- 自動メモリ（`~/.claude/projects/…/memory/`）は Claude Code 専用で Codex からは見えない。他ツールにも要る知見は references に書き戻す
- 権限の許可リストは `.claude/settings.json`（リポジトリ共有）と `.claude/settings.local.json`（個人用・git 管理外）
