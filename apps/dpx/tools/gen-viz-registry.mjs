#!/usr/bin/env node
// ── Studio 拡張 viz のレジストリを機械生成する ───────────────────
//
// **目的（再設計の最終ゴール）**:
//   「新しい Studio Extension を作ったら、**最小限の登録作業だけ**で
//     DPX の Component Palette / Property Editor / Renderer から使える」
//
// これまでは `vizRegistry.js` に **import 2 行＋登録 1 行を手書き**していた。
// viz が 30 個あるので 90 行の定型コードで、**足し忘れ・綴り間違いが起きる**。
// このスクリプトは `visualizations/*/visualizations/*/` を走査して
// `vizRegistry.generated.js` を吐く。
//
// ## 登録の条件（これを満たすだけで自動で載る）
//
//   1. `visualizations/<name>/visualizations/<appId>/src/host.jsx` がある
//      （⚠ **エントリ `visualization.jsx` に export を書かない**。
//        esbuild が ESM 出力になり Studio 実機で**パネルが真っ黒**になる）
//   2. 同じ階層に `config.json` がある（`optionsSchema` / `editorConfig` を流用）
//
// ## 使い方
//
//   node tools/gen-viz-registry.mjs           # 生成
//   node tools/gen-viz-registry.mjs --check   # 差分があれば非ゼロ終了（CI 用）
//
// ⚠ **生成物はコミットする。** ビルド時生成にすると、
//   `yarn build` の前に必ずこれを走らせる約束が要る＝忘れると壊れる。
//   生成物を追跡しておけば **diff でレビューできる**し、CI で `--check` すれば
//   「viz を足したのに再生成し忘れた」を機械的に検出できる。
// ────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '../..');
const vizRoot = join(repoRoot, 'visualizations');
const outFile = join(appRoot, 'src/main/webapp/components/viz/registry.generated.js');

/** 除外する viz（検証用・ソース未実装）。 */
const EXCLUDE = new Set([
    'editor-probe', // editor 型の検証台。プロダクトの viz ではない
    'weather-panel', // src/ が空（ソース未実装）
]);

/** キャメルケースの識別子にする（`world-map` → `WorldMap`）。 */
function pascal(name) {
    return name
        .split(/[-_]/)
        .filter(Boolean)
        .map((s) => s[0].toUpperCase() + s.slice(1))
        .join('');
}

function discover() {
    const found = [];
    for (const dir of readdirSync(vizRoot).sort()) {
        if (EXCLUDE.has(dir)) continue;
        const inner = join(vizRoot, dir, 'visualizations');
        if (!existsSync(inner)) continue;
        for (const appId of readdirSync(inner).sort()) {
            const base = join(inner, appId);
            const host = join(base, 'src/host.jsx');
            const config = join(base, 'config.json');
            // ⚠ **両方揃っているものだけ**登録する。
            //   片方だけだと import が解決できずビルドが落ちる
            if (!existsSync(host) || !existsSync(config)) continue;
            let name = appId;
            try {
                name = JSON.parse(readFileSync(config, 'utf8'))?.config?.name ?? appId;
            } catch {
                /* config が壊れていても名前が既定になるだけ */
            }
            found.push({
                dir,
                appId,
                name,
                ident: pascal(appId.replace(/^custom_viz_/, '')),
                // ⚠ **type は Studio と同じ `<appId>.<appId>`**。
                //   定義をそのまま移せるようにするため（変えると既存ボードが壊れる）
                type: `${appId}.${appId}`,
                hostPath: relative(dirname(outFile), host).replace(/\\/g, '/'),
                configPath: relative(dirname(outFile), config).replace(/\\/g, '/'),
            });
        }
    }
    return found;
}

function render(items) {
    const imports = items
        .map(
            (v) =>
                `import { App as ${v.ident}App } from '${v.hostPath}';\n` +
                `import ${v.ident}Config from '${v.configPath}';`
        )
        .join('\n');
    const entries = items
        .map(
            (v) =>
                `    '${v.type}': adaptExtensionViz(${v.ident}App, ${v.ident}Config), // ${v.name}`
        )
        .join('\n');

    return `// ⚠⚠ **このファイルは自動生成です。手で編集しないでください。** ⚠⚠
//
// 生成: node tools/gen-viz-registry.mjs
// 検証: node tools/gen-viz-registry.mjs --check   （CI・再生成忘れの検出）
//
// **新しい Studio 拡張 viz を足したら、このスクリプトを 1 回走らせるだけ**で
// Component Palette / Property Editor / Renderer から使えるようになります。
// 条件は 2 つだけ:
//   1. \`src/host.jsx\` がある（⚠ エントリ \`visualization.jsx\` に export を書かない。
//      esbuild が ESM 出力になり Studio 実機でパネルが真っ黒になります）
//   2. \`config.json\` がある（optionsSchema / editorConfig をそのまま流用します）
//
// 現在 ${items.length} 個の viz を登録しています。

import { adaptExtensionViz } from './extensionAdapter';

${imports}

/** Studio 拡張 viz（iframe なしでホストしているもの）。 */
export const EXTENSION_VIZ = {
${entries}
};
`;
}

const items = discover();
const next = render(items);
const check = process.argv.includes('--check');

if (check) {
    const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (current !== next) {
        console.error(
            `✗ vizRegistry.generated.js が最新ではありません（viz ${items.length} 個）。\n` +
                '  node tools/gen-viz-registry.mjs を実行してコミットしてください。'
        );
        process.exit(1);
    }
    console.log(`✓ vizRegistry.generated.js は最新です（viz ${items.length} 個）`);
} else {
    writeFileSync(outFile, next);
    console.log(`✓ 生成: vizRegistry.generated.js（viz ${items.length} 個）`);
    for (const v of items) console.log(`   - ${v.name} (${v.type})`);
}
