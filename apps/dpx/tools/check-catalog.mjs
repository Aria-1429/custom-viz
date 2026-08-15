// カタログ定義のオプション名・viz キー・データソース参照を実装と突き合わせる。
//
// ⚠ **推測で書いたオプション名は実機で黙って無視される**（過去に5件やらかしている）。
//   「描画されている＝正しい」ではないので、機械で突き合わせる。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'src/main/webapp/components/viz');
// 既定はリポジトリ同梱のカタログ（引数で他の定義も検査できる）
const target = process.argv[2] ?? join(root, 'examples/native-viz-catalog.json');
const def = JSON.parse(readFileSync(target, 'utf8'));

/**
 * `optionsSchema:` の後ろを**波括弧の対応で**切り出す。
 *
 * ⚠ 正規表現で `\n    },` を終端にすると、入れ子の項目（`radius: { ... },`）や
 *   後続 viz の定義まで飲み込んで誤判定する（実際にやった）。
 */
function readSchemaBlock(src, from) {
    const open = src.indexOf('{', from);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(open + 1, i);
        }
    }
    return null;
}

const schemas = new Map();
const files = [
    ...readdirSync(`${base}/native`)
        .filter((f) => f.endsWith('.jsx'))
        .map((f) => `${base}/native/${f}`),
    `${base}/deco.jsx`,
    `${base}/shapes.jsx`,
    `${base}/DpxLinkLine.jsx`,
];

for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const km of s.matchAll(/key: '([^']+)'/g)) {
        const key = km[1];
        const at = s.indexOf('optionsSchema:', km.index);
        if (at < 0) continue;
        // 次の viz 定義より後ろにある optionsSchema は、この viz のものではない
        const nextKey = s.indexOf("key: '", km.index + 6);
        if (nextKey >= 0 && at > nextKey) {
            schemas.set(key, { keys: new Set(), spread: true });
            continue;
        }
        const tail = s.slice(at + 'optionsSchema:'.length, at + 60).trim();
        // `optionsSchema: COMMON_SCHEMA,` のようにオブジェクトを直接渡す形は検査しない
        if (!tail.startsWith('{')) {
            schemas.set(key, { keys: new Set(), spread: true });
            continue;
        }
        const body = readSchemaBlock(s, at) ?? '';
        const keys = new Set();
        for (const om of body.matchAll(/^\s{8}(\w+):/gm)) keys.add(om[1]);
        schemas.set(key, { keys, spread: /\.\.\.[A-Z_]+/.test(body) });
    }
}

const problems = [];
const dsIds = new Set(Object.keys(def.dataSources ?? {}));
const tabIds = new Set((def.tabs ?? []).map((t) => t.id));

for (const p of def.panels ?? []) {
    const impl = schemas.get(p.viz);
    if (!impl) {
        problems.push(`${p.id}: 未登録の viz "${p.viz}"`);
        continue;
    }
    if (!impl.spread) {
        for (const k of Object.keys(p.options ?? {})) {
            if (!impl.keys.has(k)) {
                problems.push(
                    `${p.id}: "${p.viz}" にオプション "${k}" は無い（実在: ${[...impl.keys].join(', ')}）`
                );
            }
        }
    }
    const ref = p.search?.ref;
    if (ref && !dsIds.has(ref)) problems.push(`${p.id}: データソース "${ref}" が無い`);
    if (p.tab && !tabIds.has(p.tab)) problems.push(`${p.id}: タブ "${p.tab}" が無い`);
}

const used = new Set((def.panels ?? []).map((p) => p.search?.ref).filter(Boolean));
for (const id of dsIds) if (!used.has(id)) problems.push(`データソース "${id}" が未使用`);

// 全ネイティブ viz を網羅しているか（カタログの目的そのもの）
const shown = new Set((def.panels ?? []).map((p) => p.viz));
const missing = [...schemas.keys()].filter((k) => !shown.has(k));
if (missing.length) problems.push(`カタログに出ていない viz: ${missing.join(', ')}`);

if (problems.length) {
    console.error(`✗ 問題あり:\n  ${problems.join('\n  ')}`);
    process.exit(1);
}
console.log(
    `✓ 検証 OK（パネル ${def.panels.length} / viz ${shown.size} 種を網羅 / データソース ${dsIds.size}）`
);
