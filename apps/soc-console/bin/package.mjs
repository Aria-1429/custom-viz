#!/usr/bin/env node
//
// stage/ を Splunk アプリのアーカイブ (.spl) に固める。
//
// 出力: dist/<appId>-<version>-<commit hash>.spl
//   .spl の中身は <appId>/... の 1 ディレクトリで始まる tar.gz（Splunk の要求どおり）。
//
// 実行前に必ず `yarn build`（本番ビルド）を済ませておくこと。
// このスクリプトは stage/ を無検査で固めるため、開発ビルドが残っていると
// sourcemap 入りの巨大な .spl ができてしまう。

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { create as createTar } from 'tar';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const stageDir = join(root, 'stage');
const distDir = join(root, 'dist');

function fail(msg) {
    console.error(`\n  エラー: ${msg}\n`);
    process.exit(1);
}

if (!existsSync(stageDir)) {
    fail('stage/ がありません。先に `yarn build` を実行してください。');
}

// app.conf から id と version を読む（package.json ではなく配布物の実体を正とする）
const appConfPath = join(stageDir, 'default', 'app.conf');
if (!existsSync(appConfPath)) fail('stage/default/app.conf がありません。');

const appConf = readFileSync(appConfPath, 'utf8');
const readKey = (stanza, key) => {
    const re = new RegExp(`\\[${stanza}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
    const block = re.exec(appConf);
    if (!block) return null;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(block[1]);
    return m ? m[1].trim() : null;
};

const appId = readKey('package', 'id') || readKey('id', 'name');
const version = readKey('id', 'version') || readKey('launcher', 'version');

if (!appId) fail('app.conf に [package] id がありません。');
if (!version) fail('app.conf に version がありません。');
if (!/^[a-z0-9_.]+$/.test(appId)) {
    fail(`アプリ ID "${appId}" が不正です（小文字英数字・_・. のみ）。`);
}

// sourcemap の混入チェック（開発ビルドのまま固めるのを防ぐ）
const pagesDir = join(stageDir, 'appserver', 'static', 'pages');
if (existsSync(pagesDir)) {
    const maps = readdirSync(pagesDir).filter((f) => f.endsWith('.map'));
    if (maps.length) {
        fail(
            `stage/ に sourcemap が残っています (${maps.join(', ')})。\n` +
                '  開発ビルドが混入しています。`yarn build`（本番ビルド）で作り直してください。'
        );
    }
}

// ── OSS 通知がバンドル内容と一致しているか（指紋照合）─────────────
//
// ⚠ **通知が古いままの .spl を作らせない。** 依存を足しても通知を再生成し忘れる
//   のが典型的な事故（2026-08-13 に DPX で 45 件中 42 件の未記載が発覚）。
//   `visualizations/*` が既にこの指紋方式で守られていたので apps/* も揃える。
{
    const noticesPath = join(stageDir, 'THIRD_PARTY_NOTICES.txt');
    if (!existsSync(noticesPath)) {
        fail(
            'stage/THIRD_PARTY_NOTICES.txt がありません。\n' +
                '  `yarn notices` で生成してから `yarn build` し直してください。'
        );
    }
    try {
        const helpers = await import(
            pathToFileURL(join(root, '..', '..', 'scripts', 'gen-third-party-notices.mjs')).href
        );
        const statsPath = process.env.WEBPACK_STATS || '/tmp/soc-console-stats.json';
        if (!existsSync(statsPath)) {
            fail(
                `バンドル情報 (${statsPath}) がありません。\n` +
                    '  `yarn notices` を実行すると生成されます（通知の照合に必要）。'
            );
        }
        process.env.WEBPACK_STATS = statsPath;
        const current = helpers.fingerprintPackages(
            helpers.collectPackagesFromDist(root).map((p) => `${p.name}@${p.version}`)
        );
        const recorded = helpers.parseFingerprintFromNotices(readFileSync(noticesPath, 'utf8'));
        if (recorded !== current) {
            fail(
                'THIRD_PARTY_NOTICES.txt がバンドル内容と一致しません（依存が変わっています）。\n' +
                    '  `yarn notices` で再生成してから `yarn build` し直してください。\n' +
                    `  記録: ${recorded}\n  現在: ${current}`
            );
        }
    } catch (err) {
        fail(`OSS 通知の照合に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
}

let hash = 'nogit';
try {
    hash = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
} catch {
    // git 管理外でも動くようにする
}

mkdirSync(distDir, { recursive: true });
const outName = `${appId}-${version}-${hash}.spl`;
const outPath = join(distDir, outName);

// .spl の中身は <appId>/... で始まる必要がある。
// stage/ を <appId> という名前でコピーしてから固める（build/ 配下の一時領域を使う）。
const tmpRoot = join(root, 'build');
const tmpApp = join(tmpRoot, appId);
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });
cpSync(stageDir, tmpApp, { recursive: true });

await createTar(
    {
        gzip: true,
        file: outPath,
        cwd: tmpRoot,
        portable: true,
    },
    [appId]
).catch((e) => fail(`アーカイブ作成に失敗しました: ${e.message}`));

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n  作成しました: dist/${outName}`);
console.log(`  アプリ ID: ${appId} / バージョン: ${version}\n`);
