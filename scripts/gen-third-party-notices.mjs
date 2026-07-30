#!/usr/bin/env node
// =============================================================================
// THIRD_PARTY_NOTICES.txt 生成（機械的・再現可能）
//
// 使い方: 各 viz プロジェクト直下（visualizations/<name>/）で
//   yarn build:prod   … dist/<viz>/metafile.json を生成（build.mjs が出力）
//   yarn notices      … node ../../scripts/gen-third-party-notices.mjs
//
// 設計（.claude/skills/splunk-viz/references/studio-extension-viz.md §11 準拠）:
//  1. 対象の特定は esbuild metafile の outputs[*].inputs（唯一の正確な情報源。
//     package.json の dependencies から推測しない。.map 出力は配布物でないので除外）
//  2. 条文は `yarn licenses generate-disclaimer` の出力を機械的に切り出す
//     （手で書き写さない）。同一条文をまとめたブロックのカンマ区切りは全て展開する
//  3. disclaimer に無いパッケージは node_modules 内の LICENSE ファイルを直接読む。
//     それも無ければ「宣言のみ（原文は配布元参照）」と事実だけ書く（条文を捏造しない）
//  4. OSS ライセンスを宣言していないパッケージ（Splunk 商用契約等）は条文を貼らず
//     参照情報のみの別枠にする（OSS として再配布可能と誤読させないため）
//  5. ライセンス宣言が全く無いパッケージがあれば **失敗** させる（黙って漏らさない）
//  6. esbuild を通らない同梱素材（地図データ等）は viz 直下の notices-data.json で
//     申告し、データ出典の節として収録する
//
// 出力の Fingerprint 行は「パッケージ名@版」一覧の SHA-256。package.mjs が
// パッケージ時に再計算して照合し、通知が古いままの .spl 生成を失敗させる。
// =============================================================================
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// OSS として全文収録してよいライセンス（SPDX）。ここに無い宣言は「OSS ではない」
// 扱いの別枠に落とす（例: SEE LICENSE IN LICENSE = Splunk General Terms）。
const OSS_LICENSES = new Set([
    'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD',
    'CC0-1.0', 'Unlicense', 'Zlib', 'CC-BY-4.0', 'BlueOak-1.0.0',
    'MIT OR Apache-2.0', '(MIT OR Apache-2.0)', '(MIT OR CC0-1.0)',
]);

// --- metafile → バンドルされたパッケージ集合 --------------------------------
export function extractBundledPackages(metafile) {
    const pkgs = new Set();
    for (const [outPath, out] of Object.entries(metafile.outputs || {})) {
        if (outPath.endsWith('.map')) continue; // ソースマップは配布物ではない
        for (const inputPath of Object.keys(out.inputs || {})) {
            const i = inputPath.lastIndexOf('node_modules/');
            if (i < 0) continue; // viz 自身のソース
            const rest = inputPath.slice(i + 'node_modules/'.length);
            const seg = rest.split('/');
            pkgs.add(seg[0].startsWith('@') ? `${seg[0]}/${seg[1]}` : seg[0]);
        }
    }
    return [...pkgs].sort();
}

// --- 指紋（name@version の一覧の SHA-256） ----------------------------------
export function fingerprintPackages(pkgsWithVersion) {
    const list = [...pkgsWithVersion].sort().join('\n');
    return createHash('sha256').update(list, 'utf8').digest('hex');
}

// プロジェクト内の全 metafile から name@version 一覧を作る（package.mjs も使う）
export function collectPackagesFromDist(projectRoot) {
    const distDir = join(projectRoot, 'dist');
    if (!existsSync(distDir)) throw new Error('dist/ がありません。先に yarn build:prod を実行してください。');
    const metafiles = readdirSync(distDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(distDir, e.name, 'metafile.json'))
        .filter((p) => existsSync(p));
    if (metafiles.length === 0) {
        throw new Error('dist/*/metafile.json がありません。build.mjs が metafile を出力する版か確認し、yarn build:prod を実行してください。');
    }
    const names = new Set();
    for (const p of metafiles) {
        const metafile = JSON.parse(readFileSync(p, 'utf8'));
        for (const n of extractBundledPackages(metafile)) names.add(n);
    }
    return [...names].sort().map((name) => {
        const pkgJsonPath = join(projectRoot, 'node_modules', name, 'package.json');
        if (!existsSync(pkgJsonPath)) {
            throw new Error(`node_modules/${name}/package.json が見つかりません（yarn install 済みか確認）`);
        }
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type || '');
        const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url || '');
        return { name, version: pkg.version || '0.0.0', license, homepage: pkg.homepage || '', repo };
    });
}

export function parseFingerprintFromNotices(text) {
    const m = text.match(/^Fingerprint: ([0-9a-f]{64})$/m);
    return m ? m[1] : null;
}

// --- yarn licenses generate-disclaimer の出力を name → 条文 に展開 ----------
function buildDisclaimerMap(projectRoot) {
    const raw = execSync('yarn licenses generate-disclaimer --silent 2>/dev/null', {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    const map = new Map();
    // ブロックは "-----" 行で区切られる。ヘッダ文のパッケージ列を全て展開する
    // （yarn は同一条文のパッケージを1ブロックにまとめるため、先頭だけ拾うと漏れる）
    for (const block of raw.split(/^-{5,}$/m)) {
        const header = block.match(/The following software may be included in this product: (.+?)\. (?:A copy|This software)/s);
        const textStart = block.indexOf('license and notice below:');
        if (!header || textStart < 0) continue;
        const text = block.slice(textStart + 'license and notice below:'.length).trim();
        for (const name of header[1].split(',').map((s) => s.trim()).filter(Boolean)) {
            if (!map.has(name)) map.set(name, text);
        }
    }
    return map;
}

// パッケージ同梱の LICENSE ファイル（disclaimer に無い場合のフォールバック）
function readLicenseFile(projectRoot, name) {
    const dir = join(projectRoot, 'node_modules', name);
    if (!existsSync(dir)) return null;
    const candidates = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
    for (const f of candidates.sort()) {
        try {
            const text = readFileSync(join(dir, f), 'utf8').trim();
            if (text) return text;
        } catch { /* 読めないものはスキップ */ }
    }
    return null;
}

// --- main -------------------------------------------------------------------
function main() {
    const projectRoot = resolve(process.cwd());
    const projectPkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));

    const packages = collectPackagesFromDist(projectRoot);
    const disclaimer = buildDisclaimerMap(projectRoot);

    const oss = [];
    const nonOss = [];
    const declaredOnly = [];
    const failures = [];
    for (const p of packages) {
        if (!p.license) {
            failures.push(p.name);
            continue;
        }
        if (!OSS_LICENSES.has(p.license)) {
            nonOss.push(p);
            continue;
        }
        const text = disclaimer.get(p.name) || readLicenseFile(projectRoot, p.name);
        if (text) oss.push({ ...p, text });
        else declaredOnly.push(p);
    }
    if (failures.length > 0) {
        console.error(`エラー: ライセンス宣言の無いパッケージがあります: ${failures.join(', ')}`);
        console.error('宣言が確認できるまで配布できません（黙って漏らさないための失敗です）。');
        process.exit(1);
    }

    // 同梱データ・素材（esbuild metafile に出ない配布物）の申告ファイル
    const dataPath = join(projectRoot, 'notices-data.json');
    const dataEntries = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : [];

    const fp = fingerprintPackages(packages.map((p) => `${p.name}@${p.version}`));
    const lines = [];
    lines.push('THIRD-PARTY SOFTWARE NOTICES');
    lines.push('============================');
    lines.push('');
    lines.push(`App: ${projectPkg.name} v${projectPkg.version}`);
    lines.push(`Fingerprint: ${fp}`);
    lines.push('');
    lines.push('このファイルは scripts/gen-third-party-notices.mjs が esbuild metafile');
    lines.push('（実際にバンドルされたモジュールの一覧）から機械生成したものです。');
    lines.push('手で編集しないでください。再生成: yarn build:prod && yarn notices');
    lines.push('');
    lines.push('================================================================');
    lines.push('1. バンドルされている OSS とライセンス条文');
    lines.push('================================================================');
    for (const p of oss) {
        lines.push('');
        lines.push('----------------------------------------------------------------');
        lines.push(`${p.name}@${p.version} (${p.license})`);
        if (p.homepage || p.repo) lines.push(`Source: ${p.homepage || p.repo}`);
        lines.push('----------------------------------------------------------------');
        lines.push(p.text);
    }
    if (declaredOnly.length > 0) {
        lines.push('');
        lines.push('================================================================');
        lines.push('2. ライセンス宣言のみのパッケージ（条文が配布物に同梱されていない）');
        lines.push('================================================================');
        lines.push('以下は package.json でライセンスを宣言していますが、パッケージに');
        lines.push('条文ファイルが含まれていません。原文は各配布元を参照してください。');
        for (const p of declaredOnly) {
            lines.push('');
            lines.push(`${p.name}@${p.version} — 宣言: ${p.license}`);
            lines.push(`  配布元: ${p.homepage || p.repo || '(package.json に記載なし)'}`);
        }
    }
    if (nonOss.length > 0) {
        lines.push('');
        lines.push('================================================================');
        lines.push('3. OSS ライセンスではないパッケージ（参照情報のみ）');
        lines.push('================================================================');
        lines.push('以下は OSS ライセンスで提供されていません。本 App への同梱は各提供元の');
        lines.push('条件に基づきます。条文は各パッケージ同梱の LICENSE を参照してください。');
        lines.push('（OSS として再配布可能と誤読させないため、契約全文はここに貼りません）');
        for (const p of nonOss) {
            lines.push('');
            lines.push(`${p.name}@${p.version} — ライセンス表記: ${p.license}`);
            lines.push(`  参照: node_modules/${p.name}/LICENSE / https://www.npmjs.com/package/${p.name}`);
        }
    }
    if (dataEntries.length > 0) {
        lines.push('');
        lines.push('================================================================');
        lines.push('4. 同梱データ・素材（コード以外）');
        lines.push('================================================================');
        for (const d of dataEntries) {
            lines.push('');
            lines.push(`${d.name} — ${d.license}`);
            if (d.url) lines.push(`  出典: ${d.url}`);
            if (d.note) lines.push(`  ${d.note}`);
        }
    }
    lines.push('');

    const outPath = join(projectRoot, 'THIRD_PARTY_NOTICES.txt');
    writeFileSync(outPath, lines.join('\n'));
    console.log(`生成: ${outPath}`);
    console.log(`  バンドル対象: ${packages.length} パッケージ`);
    console.log(`  ├ OSS 条文収録: ${oss.length}`);
    console.log(`  ├ 宣言のみ    : ${declaredOnly.length}${declaredOnly.length ? ` (${declaredOnly.map((p) => p.name).join(', ')})` : ''}`);
    console.log(`  └ 非 OSS 別枠 : ${nonOss.length}${nonOss.length ? ` (${nonOss.map((p) => p.name).join(', ')})` : ''}`);
    console.log(`  同梱データ申告: ${dataEntries.length} 件 (notices-data.json)`);
    console.log(`  Fingerprint: ${fp}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main();
}
