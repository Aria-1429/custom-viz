#!/usr/bin/env node
// 各 viz の「現行バージョンの .spl」をリポジトリ直下の packages/ へコピーする。
// Splunk へまとめてインストールする作業用の集約フォルダ（git 管理外・再生成可能）。
//
// 使い方: リポジトリ直下で `node scripts/collect-packages.mjs`
//
// 「最新」は package.json の version と一致する dist/*-<version>-*.spl。
// 同一バージョンで複数ハッシュがある場合は更新時刻が新しい方を採る。
// 1つでも見つからない viz があれば失敗させる（歯抜けの集約を作らない）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIZ_ROOT = join(ROOT, 'visualizations');
const OUT = join(ROOT, 'packages');

const missing = [];
const collected = [];
for (const e of readdirSync(VIZ_ROOT, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(VIZ_ROOT, e.name);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    const distDir = join(dir, 'dist');
    const candidates = existsSync(distDir)
        ? readdirSync(distDir)
              .filter((f) => f.endsWith('.spl') && f.includes(`-${version}-`))
              .map((f) => ({ f, mtime: statSync(join(distDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)
        : [];
    if (candidates.length === 0) {
        missing.push(`${e.name}: v${version} の .spl が dist/ に無い`);
        continue;
    }
    collected.push({ viz: e.name, file: candidates[0].f, from: join(distDir, candidates[0].f) });
}

if (missing.length > 0) {
    console.error('エラー: 集約できない viz があります:\n' + missing.join('\n'));
    console.error('yarn build:prod && yarn package で .spl を作ってから再実行してください。');
    process.exit(1);
}

// 古い集約物を残さない（旧バージョンの .spl が紛れると誤インストールの元）
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const c of collected) copyFileSync(c.from, join(OUT, c.file));

console.log(`packages/ へ ${collected.length} 件をコピーしました:`);
for (const c of collected) console.log(`  ${c.file}`);
