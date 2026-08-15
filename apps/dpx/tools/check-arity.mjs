// ── import した関数の引数の数を検査する ──────────────────────────
//
// ⚠ **ビルドも lint も通るのに、実機で「何も出ない」種類の事故**を捕まえる。
//
// 実害（2026-08-15）: `Panel` を切り出す際、Renderer 内のローカル関数
// `panelsOfTab(tabId)`（1 引数）と、切り出し先から import した
// `panelsOfTab(panels, tabs, tabId)`（3 引数）が**同名で衝突**した。
// JS は引数の数を検査しないので、
//   panelsOfTab(tabId)  →  panels=tabId, tabs=undefined, tabId=undefined
// となり、**例外も警告も出さずに空配列**を返した。
// 結果は「パネルが 1 枚も描かれない」で、**pageErrors はゼロ**。
// 静的検査も既存テストも素通りし、実機のスクリーンショットで初めて気づいた。
//
// やること: 各ファイルが import した関数について、
//   - 定義元の**宣言引数の数**（既定値・レスト引数を考慮）
//   - 呼び出し側の**実引数の数**
// を突き合わせ、**明らかに少ない**呼び出しを報告する。
//
// ⚠ **完全な静的解析ではない**（正規表現ベース）。
//   多く渡す側は正当なことがある（JS は余剰引数を無視する）ので**少ない側だけ**見る。
//
// ⚠ **誤検出を出さないことを最優先にする**（試作で 7 件中 5 件が誤検出だった）:
//   - **末尾の引数を省くのは JS の日常**（`applyTokens(text, tokens)` の第3引数
//     `optional` は undefined でよい）。既定値が無くても**省略可能な設計**はありうる。
//     → **「最後の 1 個だけ足りない」は報告しない。** 2 個以上足りない呼び出しだけ見る
//     （実害だった `panelsOfTab(tabId)` は 3 個中 1 個＝2 個不足で捕まる）。
//   - **コメントや文字列の中の "関数っぽい字面"** を数えない（`clamp(0, columns - w)`
//     という解説文で誤検出した）。→ 先にコメントと文字列を潰してから走査する。
//
// 実行: node tools/check-arity.mjs
// ────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../src/main/webapp/components');

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(js|jsx)$/.test(name) && !/\.generated\./.test(name)) out.push(p);
    }
    return out;
}

/** 関数宣言から「必須引数の数」と「可変長か」を取り出す。 */
function signaturesOf(src) {
    const sigs = new Map();
    // export function name(a, b = 1, ...rest)
    for (const m of src.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
        const [, name, argsRaw] = m;
        const args = argsRaw.trim();
        if (args === '') {
            sigs.set(name, { min: 0, variadic: false });
            continue;
        }
        // トップレベルのカンマで分割（{a, b} や [x, y] の中は数えない）
        const parts = [];
        let depth = 0;
        let cur = '';
        for (const ch of args) {
            if ('([{'.includes(ch)) depth += 1;
            if (')]}'.includes(ch)) depth -= 1;
            if (ch === ',' && depth === 0) {
                parts.push(cur);
                cur = '';
            } else cur += ch;
        }
        if (cur.trim()) parts.push(cur);
        const variadic = parts.some((p) => p.trim().startsWith('...'));
        // 既定値つき（`=` を含む）・レストは「必須」ではない
        const min = parts.filter((p) => !p.includes('=') && !p.trim().startsWith('...')).length;
        sigs.set(name, { min, variadic });
    }
    return sigs;
}

const files = walk(ROOT);
// 定義側のシグネチャを全ファイルぶん集める（モジュールパス → 関数名 → 情報）
const byModule = new Map();
for (const f of files) byModule.set(f, signaturesOf(readFileSync(f, 'utf8')));

/** import 文の specifier を実ファイルへ解決する。 */
function resolveModule(fromFile, spec) {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), spec);
    for (const cand of [base, `${base}.js`, `${base}.jsx`, join(base, 'index.js'), join(base, 'index.jsx')]) {
        if (byModule.has(cand)) return cand;
    }
    return null;
}

/**
 * コメントと文字列を空白に潰す（中身の字面を「呼び出し」と誤認しないため）。
 * ⚠ 行数を変えないよう、改行は残す。
 */
function stripNoise(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
        .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => ' '.repeat(m.length))
        .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => ' '.repeat(m.length))
        .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '));
}

let problems = 0;
for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const src = stripNoise(raw);
    // import { a, b as c } from './x'
    for (const im of raw.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const target = resolveModule(file, im[2]);
        if (!target) continue;
        const sigs = byModule.get(target);
        for (const one of im[1].split(',')) {
            const [origRaw, aliasRaw] = one.split(/\s+as\s+/);
            const orig = (origRaw || '').trim();
            const local = (aliasRaw || origRaw || '').trim();
            if (!orig || !local) continue;
            const sig = sigs.get(orig);
            if (!sig || sig.min === 0 || sig.variadic) continue;

            // 呼び出しを探す（`local(` の形。プロパティ参照は除く）
            // ⚠ **同名の「定義」を呼び出しと数えない。** オブジェクトのメソッド
            //   短縮記法（`markSaved() { … }`）や `function markSaved(` は
            //   呼び出しではない（実際これを誤検出した）。
            const callRe = new RegExp(`(?<![.\\w$])${local}\\s*\\(`, 'g');
            for (const call of src.matchAll(callRe)) {
                const before = src.slice(Math.max(0, call.index - 40), call.index);
                if (/\b(?:function|class)\s+$/.test(before)) continue;
                // メソッド短縮記法: 直前が行頭 or `{` or `,` で、直後の `)` の後が `{`
                const lineHead = src.slice(src.lastIndexOf('\n', call.index) + 1, call.index).trim();
                if (lineHead === '' || /[,{]$/.test(lineHead)) {
                    const closeAt = src.indexOf(')', call.index);
                    if (closeAt >= 0 && /^\s*\{/.test(src.slice(closeAt + 1))) continue;
                }
                // 括弧の対応を取って実引数を数える
                const start = call.index + call[0].length;
                let depth = 1;
                let i = start;
                let args = '';
                while (i < src.length && depth > 0) {
                    const ch = src[i];
                    if ('([{'.includes(ch)) depth += 1;
                    else if (')]}'.includes(ch)) depth -= 1;
                    if (depth > 0) args += ch;
                    i += 1;
                }
                const body = args.trim();
                let count = 0;
                if (body !== '') {
                    let depth2 = 0;
                    count = 1;
                    for (const ch of body) {
                        if ('([{'.includes(ch)) depth2 += 1;
                        else if (')]}'.includes(ch)) depth2 -= 1;
                        else if (ch === ',' && depth2 === 0) count += 1;
                    }
                }
                // ⚠ **最後の 1 個の省略は正当**（末尾引数を undefined で使う設計は普通）。
                //   2 個以上足りない呼び出しだけを「取り違え」として報告する。
                if (sig.min - count >= 2) {
                    problems += 1;
                    const line = raw.slice(0, call.index).split('\n').length;
                    console.error(
                        `✗ ${file.slice(ROOT.length + 1)}:${line}: ${local}(...) の引数が ${count} 個` +
                            `（${orig} は ${sig.min} 個必要）`
                    );
                }
            }
        }
    }
}

console.log(
    problems === 0
        ? `✓ import した関数の引数の数に矛盾はありません（${files.length} ファイル）`
        : `\n${problems} 件の引数の数の不一致（実機で「何も出ない」形の事故になります）`
);
process.exit(problems > 0 ? 1 : 0);
