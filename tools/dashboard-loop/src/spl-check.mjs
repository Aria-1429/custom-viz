// ダッシュボード JSON の中の SPL を、実機で1本ずつ実行して検算する。
//
//   node src/spl-check.mjs <dashboard.json> [...]
//
// **なぜ必要か**：`validate-dashboard.mjs` は「定義と食い違っていないか」しか見ない。
// SPL が実際に走るかは実機でしか分からず、これまでは
// 「push → スクショ → パネルにエラーが出ている」でしか気づけなかった。
// このツールは REST の oneshot 検索で**先に**潰す。
//
// 実際に捕まえた例（2026-08-07）:
//   - `| eval x=round(3*係数,0)` … **日本語のフィールド名を eval の演算に引用符なしで使うと落ちる**
//     `Error in 'EvalCommand': The expression is malformed. An unexpected character is reached at '係数,0)'.`
//     → `'係数'` と単一引用符で囲むか、ASCII 名で計算して最後に `rename` する。
//     （**代入先**が日本語なのは問題ない: `| eval 選択ホスト=…` は通る）
//   - SPL の2重エスケープ（`\"m\"`）… こちらは静的検査でも拾えるが、実行すると確実に分かる
//
// トークン（`$foo$`）は `inputs` の `defaultValue` で置換してから実行する。
// 置換できないトークンが残る SPL はスキップして報告する（実行しても意味がないため）。

import { readFileSync } from 'node:fs';
import https from 'node:https';
import { assertConfig, config, mgmtBase } from './config.mjs';

assertConfig();

function runSearch(spl) {
    return new Promise((resolve) => {
        const u = new URL(`${mgmtBase()}/services/search/jobs?output_mode=json`);
        const body = new URLSearchParams({
            search: spl,
            exec_mode: 'oneshot',
            earliest_time: '-15m',
            latest_time: 'now',
        }).toString();
        const req = https.request(
            {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method: 'POST',
                rejectUnauthorized: false, // 開発機の自己署名証明書
                timeout: 60_000,
                headers: {
                    Authorization:
                        'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    } catch (e) {
                        /* JSON でない応答はそのまま扱う */
                    }
                    const messages = (parsed && parsed.messages) || [];
                    const fatal = messages.find((m) => /error|fatal/i.test(m.type || ''));
                    resolve({
                        status: res.statusCode,
                        rows: parsed && Array.isArray(parsed.results) ? parsed.results.length : 0,
                        fields:
                            parsed && Array.isArray(parsed.fields)
                                ? parsed.fields.map((f) => f.name).filter((n) => !n.startsWith('_'))
                                : [],
                        error: fatal ? fatal.text : null,
                        raw: text.slice(0, 200),
                    });
                });
            }
        );
        req.on('error', (e) => resolve({ status: 0, rows: 0, fields: [], error: e.message }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ status: 0, rows: 0, fields: [], error: 'timeout' });
        });
        req.write(body);
        req.end();
    });
}

/** inputs の defaultValue で `$token$` を埋める。 */
function fillTokens(spl, d) {
    const defaults = {};
    for (const i of Object.values(d.inputs || {})) {
        const o = i.options || {};
        if (o.token && o.defaultValue !== undefined) defaults[o.token] = String(o.defaultValue);
    }
    let out = spl;
    for (const [k, v] of Object.entries(defaults)) out = out.split(`$${k}$`).join(v);
    return out;
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error('使い方: node src/spl-check.mjs <dashboard.json> [...]');
    process.exit(2);
}

let failed = 0;
for (const file of files) {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`\n=== ${file}`);
    for (const [name, ds] of Object.entries(d.dataSources || {})) {
        const raw = (ds.options && ds.options.query) || '';
        const spl = fillTokens(raw, d);
        const left = spl.match(/\$[A-Za-z0-9_.]+\$/g);
        if (left) {
            console.log(`  - ${name}: スキップ（既定値の無いトークン ${[...new Set(left)].join(', ')}）`);
            continue;
        }
        const r = await runSearch(spl);
        if (r.error) {
            failed += 1;
            console.log(`  ✗ ${name}: ${r.error}`);
        } else if (r.rows === 0) {
            failed += 1;
            console.log(`  ✗ ${name}: 0 行（サーチは通ったが結果が空）`);
        } else {
            console.log(`  ✓ ${name}: ${r.rows} 行 [${r.fields.join(', ')}]`);
        }
    }
}
console.log(failed === 0 ? '\n✓ すべての SPL が実機で結果を返した' : `\n✗ ${failed} 件`);
process.exit(failed === 0 ? 0 : 1);
