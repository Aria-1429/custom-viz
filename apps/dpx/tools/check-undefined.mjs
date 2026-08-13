// ── 未定義参照の検出（分割・移動の事故を防ぐ）─────────────────────
//
// ⚠ **webpack のビルドは通るのに実機で落ちる**種類の事故を捕まえる。
//   `nativeViz.jsx`（2,516 行）を viz ごとに分割したとき、
//   **共有していた定数が別ファイルへ行ってしまい**、
//   実機で `ReferenceError: DEFAULT_STATUS_MATCHES is not defined` が出た。
//   ビルドは成功していた（バンドラは実行時の参照を追わない）。
//
// やること: ファイルごとに
//   「大文字始まり / 既知の識別子」の**参照**を集め、
//   そのファイル内の宣言・import・グローバルに無いものを報告する。
//
// ⚠ **完全な静的解析ではない**（正規表現ベース）。
//   取りこぼしはありうるが、**分割事故の主要因（トップレベル定数の置き去り）は捕まる**。
//
// 実行: node tools/check-undefined.mjs
// ────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../src/main/webapp/components');

/** ブラウザ / 標準の組み込み。ここに無いものだけを疑う。 */
const GLOBALS = new Set([
    'React', 'window', 'document', 'console', 'Math', 'Number', 'String', 'Boolean',
    'Object', 'Array', 'JSON', 'Date', 'Map', 'Set', 'WeakMap', 'Promise', 'Error',
    'RegExp', 'Symbol', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false',
    'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'requestAnimationFrame',
    'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'fetch', 'URL', 'URLSearchParams', 'Intl', 'navigator', 'location', 'history',
    'CustomEvent', 'Event', 'Blob', 'FileReader', 'TextEncoder', 'TextDecoder',
    'globalThis', 'structuredClone', 'performance', 'getComputedStyle', 'Image',
    'SVGElement', 'HTMLElement', 'Node', 'DOMParser', 'AbortController', 'BigInt',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
    'btoa', 'atob', 'crypto', 'localStorage', 'sessionStorage', 'alert', 'confirm',
    'Uint8Array', 'Float32Array', 'Int32Array', 'ArrayBuffer', 'Proxy', 'Reflect',
    'WeakSet', 'Function', 'process',
]);

function filesUnder(dir) {
    const out = [];
    const walk = (d) => {
        for (const n of readdirSync(d)) {
            const p = join(d, n);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.jsx?$/.test(n)) out.push(p);
        }
    };
    walk(dir);
    return out;
}

let problems = 0;
let checked = 0;

for (const file of filesUnder(ROOT)) {
    const raw = readFileSync(file, 'utf8');
    checked += 1;
    // ⚠ **コメントと文字列を先に落とす。** 落とさないと日本語コメント中の
    //   'DPX' 'REST' 'HTTP' のような語まで「未定義の識別子」に見えて
    //   誤検出だらけになり、**本物の 1 件が埋もれる**（実際にそうなった）。
    const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')     // ブロックコメント
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')   // 行コメント（URL の // は残す）
        .replace(/`(?:\\.|[^`\\])*`/g, '``')      // テンプレート文字列
        .replace(/'(?:\\.|[^'\\\n])*'/g, "''")   // 文字列
        .replace(/"(?:\\.|[^"\\\n])*"/g, '""');

    // 宣言されているもの
    const declared = new Set();
    // ⚠ **行頭限定にしない。** 関数の中の `const ROW_H = 19;` も宣言なので、
    //   限定すると「関数内で定義した定数」が全部未定義に見える（誤検出の主因）。
    for (const m of src.matchAll(/(?:^|[\s;{(])(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        declared.add(m[1]);
    }
    // import されているもの（{a, b as c} / default / * as ns）
    for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]/g)) {
        const clause = m[1];
        for (const n of clause.matchAll(/([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/g)) {
            declared.add(n[2] || n[1]);
        }
    }
    // ローカル束縛（雑に拾う。過剰に許容する側に倒す＝誤検出を避ける）
    for (const m of src.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
        for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(n[1]);
    }
    for (const m of src.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
        for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(n[1]);
    }
    for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
        for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(n[1]);
    }
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
    // オブジェクトのキー・プロパティ参照は対象外にしたいので、
    // 「大文字始まりの定数風」だけを検査対象にする（分割事故の実態に合わせる）
    // export { A, B } の再輸出は「参照」ではないので除く
    let scan = src.replace(/export\s*\{[\s\S]*?\}\s*(?:from\s*['"][^'"]*['"])?;?/g, ' ');
    // ⚠ JSX のテキスト（`<span>● AUTO 15s</span>` の AUTO）は識別子ではない。
    // ⚠ `{...}` の補間を挟むテキスト（`DPX v{SCHEMA_VERSION} / ...`）もある。
    //   先に補間を潰してからテキストを落とす（2 段階）。
    scan = scan.replace(/>[^<>]*</g, (mm) => (mm.includes('{') ? mm.replace(/[^<>{}]/g, ' ') : '><'));
    const suspects = new Set();
    for (const m of scan.matchAll(/(?<![.\w$'"`])([A-Z][A-Z0-9_]{2,})\b/g)) {
        const at = m.index + m[0].length;
        // `FULL:` のようなオブジェクトのキーは参照ではない
        if (/^\s*:/.test(scan.slice(at, at + 4))) continue;
        suspects.add(m[1]);
    }

    const missing = [...suspects].filter(
        (s) => !declared.has(s) && !GLOBALS.has(s)
    );
    if (missing.length > 0) {
        problems += missing.length;
        const rel = file.slice(ROOT.length + 1);
        console.error(`✗ ${rel}`);
        for (const s of missing) console.error(`    未定義の可能性: ${s}`);
    }
}

console.log(
    problems === 0
        ? `✓ 未定義の参照は見つかりませんでした（${checked} ファイル）`
        : `\n${problems} 件の疑いがあります（${checked} ファイル）`
);
process.exit(problems > 0 ? 1 : 0);
