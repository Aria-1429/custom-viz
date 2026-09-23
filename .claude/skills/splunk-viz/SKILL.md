---
name: splunk-viz
description: Splunkのカスタムビジュアライゼーション(React/JSX, Dashboard Studio向け)を作る。/splunk-vizで明示的に呼び出す。
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# splunk-viz（Claude Code 用の入口）

このスキルの実体は Claude Code と Codex で共有するため `.agents/skills/` にある。
Claude Code は `.agents/skills/` を探索しないので、このファイルが橋渡しをする。

**まず `.agents/skills/splunk-viz/SKILL.md` を Read し、以後はその指示に従うこと。**
参照資料はその隣の `.agents/skills/splunk-viz/references/` にある。

ナレッジの追記・修正は必ず `.agents/skills/splunk-viz/` 側に行う（このファイルには書かない）。
