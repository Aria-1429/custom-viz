// 既存 Studio 拡張 viz を DPX でもホストできるようにする（world-map と同じ2点）。
//   1. visualization.jsx の末尾に globalThis.__<NAME>_APP__ = App; を追加
//   2. 自己マウントを if (!globalThis.__DASH_PLATFORM_HOST__) { ... } で囲む
//   3. host.jsx を生成（export を書けるのはこのファイルだけ）
//
// ⚠ visualization.jsx に `export` を書いてはいけない（esbuild が export{} を吐き、
//   Studio の iframe がクラシックスクリプトとして読んで SyntaxError → パネル真っ黒）。
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/ishitsuki/work/custom-viz/visualizations';
const SKIP = new Set(['editor-probe', 'world-map']); // probe=検証用 / world-map=適用済み
const apply = !process.argv.includes('--dry');

// 自己マウント呼び出し（IIFE 形。29 viz 共通であることを grep で確認済み）
const MOUNT_RE = /\n\(function mountWhenReady\(\) \{\n([\s\S]*?)\n\}\)\(\);\n?$/;

// severity-table だけ形が違う（DOMContentLoaded 分岐 + App は props を取るので
// エクスポートするのは Root）。実コードを読んで確認済み。
const ALT_MOUNT_RE =
    /\nif \(document\.readyState === 'loading'\) \{\n([\s\S]*?)\n\}\n?$/;
const ROOT_COMPONENT = { 'severity-table': 'Root' };

const results = [];
for (const name of readdirSync(ROOT).sort()) {
    if (SKIP.has(name)) continue;
    const dir = join(ROOT, name);
    if (!statSync(dir).isDirectory()) continue;
    const vizDirRoot = join(dir, 'visualizations');
    if (!existsSync(vizDirRoot)) { results.push([name, 'skip', 'visualizations/ なし']); continue; }
    const appId = readdirSync(vizDirRoot)[0];
    const src = join(vizDirRoot, appId, 'src');
    const entry = join(src, 'visualization.jsx');
    if (!existsSync(entry)) { results.push([name, 'skip', 'visualization.jsx なし']); continue; }

    let code = readFileSync(entry, 'utf8');
    // グローバル名: custom_viz_kpi_tile -> __KPI_TILE_APP__
    const globalName = `__${appId.replace(/^custom_viz_/, '').toUpperCase()}_APP__`;

    if (code.includes('__DASH_PLATFORM_HOST__')) {
        results.push([name, 'already', globalName]);
        continue;
    }
    const comp = ROOT_COMPONENT[name] ?? 'App';
    if (!new RegExp(`\\nfunction ${comp}\\(`).test(code)) {
        results.push([name, 'FAIL', `function ${comp}( が無い`]);
        continue;
    }

    // 標準形（IIFE）と severity-table 形（DOMContentLoaded 分岐）の両対応
    const m = code.match(MOUNT_RE);
    const alt = m ? null : code.match(ALT_MOUNT_RE);
    if (!m && !alt) { results.push([name, 'FAIL', '自己マウント部が想定形と違う']); continue; }

    const indent = (s) => s.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
    const head =
        `\n// DPX（apps/dash-platform）が iframe なしでこの viz をホストする場合の受け渡し口。\n` +
        `// \`export\` を使わないのは、esbuild が成果物末尾に export{} を出力して\n` +
        `// Studio の iframe が SyntaxError になるため（実機で確認済み）。\n` +
        `// DPX 側は host.jsx がこのファイルを副作用 import してから受け取る。\n` +
        `globalThis.${globalName} = ${comp};\n\n` +
        `// DPX にホストされている場合は自己マウントしない（ホストがコンポーネントとして描画する）。\n` +
        `// iframe（Studio 拡張）では従来どおり自己マウントする。\n`;

    if (alt) {
        code = code.replace(
            ALT_MOUNT_RE,
            `${head}if (!globalThis.__DASH_PLATFORM_HOST__) {\n` +
                `    if (document.readyState === 'loading') {\n` +
                indent(alt[1]) +
                `\n    }\n}\n`
        );
        if (apply) {
            writeFileSync(entry, code);
            writeFileSync(join(src, 'host.jsx'), makeHost(globalName));
        }
        results.push([name, apply ? 'PATCHED*' : 'would-patch*', `${appId} / ${globalName} (${comp})`]);
        continue;
    }

    const body = m[1];
    const replacement =
        head +
        `if (!globalThis.__DASH_PLATFORM_HOST__) {\n` +
        `    (function mountWhenReady() {\n` +
        indent(body) +
        `\n    })();\n}\n`;
    code = code.replace(MOUNT_RE, replacement);

    if (apply) {
        writeFileSync(entry, code);
        writeFileSync(join(src, 'host.jsx'), makeHost(globalName));
    }
    results.push([name, apply ? 'PATCHED' : 'would-patch', `${appId} / ${globalName} (${comp})`]);
}

/** host.jsx の中身（DPX 用エントリ。ここにだけ export を書く）。 */
function makeHost(globalName) {
    return `// dash-platform（DPX）用のホストエントリ。
//
// なぜ別ファイルなのか:
//   visualization.jsx は Studio 拡張の esbuild エントリで、format:'esm' でビルドされる。
//   そこに \`export\` を1つでも書くと成果物末尾に \`export{...}\` が出力され、
//   Studio の iframe がクラシックスクリプトとして読んだ瞬間
//   \`Uncaught SyntaxError: Unexpected token 'export'\` でバンドル全体が実行されず、
//   パネルが真っ黒になる（2026-08-10 に実機で確認）。
//
//   一方 DPX は webpack で viz のソースを直接束ねるため、名前付き export が要る。
//   両者を両立させるには「esbuild が読むファイルには export を書かない」しかないので、
//   export はこのファイル（esbuild のエントリではない）に置く。
//
// ⚠ 評価順に依存しないこと:
//   visualization.jsx は import された瞬間に自己マウントの要否を
//   \`__DASH_PLATFORM_HOST__\` で判定する。extensionAdapter も同じフラグを立てるが、
//   それに頼ると import 文の並び順で判定が変わる（整列で順序が入れ替わると二重マウント）。
//   そこで visualization.jsx を読み込む「前」にここで自分で立てておく。
//   ※ 静的 import は巻き上げられるため require 相当の順序保証を使う。

globalThis.__DASH_PLATFORM_HOST__ = true;

// eslint-disable-next-line global-require, import/no-unresolved
require('./visualization.jsx');

export const App = globalThis.${globalName};
`;
}

const w = Math.max(...results.map((r) => r[0].length));
for (const [n, s, d] of results) console.log(`${n.padEnd(w)}  ${s.padEnd(11)} ${d}`);
const c = results.reduce((a, [, s]) => ((a[s] = (a[s] ?? 0) + 1), a), {});
console.log('\n集計:', JSON.stringify(c));
