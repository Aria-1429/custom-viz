// ダッシュボード JSON を、リポジトリの viz 定義（config.json）と突き合わせて検証する。
//
//   node src/validate-dashboard.mjs <dashboard.json> [...]
//
// **オプション名・選択肢の値を推測で書かない**ための機械検証。
// 2026-08-06 に推測で書いた5件が実機で無効だったのが発端。
// 検査する内容:
//   ① viz type が実在し `<appId>.<appId>` 記法か
//   ② options のキーが optionsSchema に存在するか（`backgroundColor` はホスト共通なので除外）
//   ③ editor.select / editor.radioBar の選択値が許容値のどれかか
//   ④ dataSources の参照が解決できるか／列順に依存する viz に `| table` があるか
//   ⑤ layout の重なり・はみ出し・未配置
//   ⑥ SPL の2重エスケープ（パース後にバックスラッシュが残っていないか）
//   ⑦ eventHandlers の型と key（`name` / `value` / `row.<フィールド名>.value` のみ）
//   ⑧ input の token 宣言と layout.globalInputs への登録
//   ⑨ パネル高さが viz の推奨（config.json の size.initialHeight）の 75% 以上か
//
// ⚠ ここで分かるのは「定義と食い違っていないか」まで。
//    実際に描画されるか・SPL が意図どおり動くかは**実機でしか確認できない**。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ホストが解釈する共通オプション（viz の optionsSchema には無いが正当）
const HOST_OPTS = new Set(['backgroundColor']);
// 列順で判定する viz（SPL に `| table` が要る）
const ORDER_DEP = new Set([
    'custom_viz_network_graph',
    'custom_viz_sankey_flow',
    'custom_viz_country_graph',
]);
// eventHandlers の key に指定できる形（公式ドキュメント準拠）
const KEY_RE = /^row\..+\.value$/;

function loadVizDefs() {
    const schemas = {};
    const allowed = {};
    const sizes = {};
    const vizDir = join(repoRoot, 'visualizations');
    for (const n of readdirSync(vizDir)) {
        const p = join(vizDir, n, 'visualizations');
        if (!existsSync(p)) continue;
        for (const app of readdirSync(p)) {
            const cf = join(p, app, 'config.json');
            if (!existsSync(cf)) continue;
            const cfg = JSON.parse(readFileSync(cf, 'utf8')).config;
            schemas[app] = cfg.optionsSchema || {};
            allowed[app] = {};
            if (cfg.size) sizes[app] = cfg.size;
            const walk = (node) => {
                if (Array.isArray(node)) return node.forEach(walk);
                if (!node || typeof node !== 'object') return undefined;
                if (
                    (node.editor === 'editor.select' || node.editor === 'editor.radioBar') &&
                    node.option &&
                    node.editorProps &&
                    node.editorProps.values
                ) {
                    allowed[app][node.option] = node.editorProps.values.map((v) => v.value);
                }
                return Object.values(node).forEach(walk);
            };
            walk(cfg.editorConfig || []);
        }
    }
    return { schemas, allowed, sizes };
}

function validate(file, defs) {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const { schemas, allowed, sizes } = defs;
    const errs = [];
    const notes = [];
    const warn = (m) => errs.push(m);

    for (const [k, v] of Object.entries(d.visualizations || {})) {
        if (String(v.type).startsWith('splunk.')) continue;
        const app = String(v.type).split('.')[0];
        if (!schemas[app]) {
            warn(`未知の viz type: ${k} (${v.type})`);
            continue;
        }
        if (v.type !== `${app}.${app}`) warn(`type 記法が <appId>.<appId> でない: ${k} (${v.type})`);
        for (const [key, val] of Object.entries(v.options || {})) {
            if (HOST_OPTS.has(key)) continue;
            if (!(key in schemas[app])) warn(`未知オプション: ${k}.${key}`);
            const ok = allowed[app][key];
            if (ok && !ok.includes(val)) {
                warn(`無効な選択値: ${k}.${key} = ${JSON.stringify(val)} → ${JSON.stringify(ok)}`);
            }
        }
        const ds = v.dataSources && v.dataSources.primary;
        if (ds && !(d.dataSources || {})[ds]) warn(`未定義 dataSource: ${k} → ${ds}`);
        if (ORDER_DEP.has(app) && ds && d.dataSources[ds]) {
            const q = d.dataSources[ds].options.query;
            if (!q.includes('| table') && !q.includes('| fields')) {
                warn(`列順に依存する viz なのに | table が無い: ${k} (${ds})`);
            }
        }
        for (const h of v.eventHandlers || []) {
            if (h.type !== 'drilldown.setToken' && h.type !== 'drilldown.customUrl') {
                warn(`未知の eventHandler: ${k} (${h.type})`);
            }
            for (const t of (h.options && h.options.tokens) || []) {
                if (!(t.key === 'name' || t.key === 'value' || KEY_RE.test(t.key))) {
                    warn(`eventHandlers の key が不正: ${k} (${t.key})`);
                }
            }
        }
    }

    // layout は単一ページ（structure 直下）とタブ付き（layoutDefinitions）の2形式
    const layouts = d.layout.structure ? [d.layout] : Object.values(d.layout.layoutDefinitions || {});
    for (const L of layouts) {
        const S = L.structure || [];
        for (const s of S) {
            if (!d.visualizations[s.item]) warn(`layout の item が未定義: ${s.item}`);
            const p = s.position;
            if (p.x < 0 || p.y < 0 || p.x + p.w > L.options.width || p.y + p.h > L.options.height) {
                warn(`はみ出し: ${s.item}`);
            }
        }
        for (let i = 0; i < S.length; i += 1) {
            for (let j = i + 1; j < S.length; j += 1) {
                const a = S[i].position;
                const b = S[j].position;
                if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                    warn(`重なり: ${S[i].item} と ${S[j].item}`);
                }
            }
        }
        const placed = new Set(S.map((s) => s.item));
        Object.keys(d.visualizations).forEach((k) => {
            if (!placed.has(k)) warn(`未配置: ${k}`);
        });
        // パネルが低すぎると viz が要素を落とす（ラベル・凡例が消える）
        for (const s of S) {
            const v = d.visualizations[s.item];
            if (!v) continue;
            const rec = sizes[String(v.type).split('.')[0]];
            if (!rec) continue;
            const r = s.position.h / rec.initialHeight;
            if (r < 0.75) {
                // 低いと viz が要素を落とす（ラベル・凡例が消える）。ただし
                // spotlight-frame を細い帯として使う等、意図的に低くする設計もあるので警告扱い。
                notes.push(
                    `パネルが低い: ${s.item} h=${s.position.h} / 推奨 ${rec.initialHeight} (${Math.round(r * 100)}%)`
                );
            }
        }
    }

    for (const [k, v] of Object.entries(d.dataSources || {})) {
        if (v.options.query.includes('\\')) warn(`SPL に残存バックスラッシュ（2重エスケープの疑い）: ${k}`);
    }

    const globalInputs = (d.layout && d.layout.globalInputs) || [];
    for (const [k, i] of Object.entries(d.inputs || {})) {
        if (!(i.options && i.options.token)) warn(`input に token がない: ${k}`);
        if (!globalInputs.includes(k)) warn(`layout.globalInputs に登録されていない input: ${k}`);
    }

    return { errs, notes };
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error('使い方: node src/validate-dashboard.mjs <dashboard.json> [...]');
    process.exit(2);
}
const defs = loadVizDefs();
let total = 0;
for (const f of files) {
    const { errs, notes } = validate(f, defs);
    total += errs.length;
    console.log(`${errs.length === 0 ? '✓' : '✗'} ${f}${errs.length ? ` (${errs.length} 件)` : ''}`);
    errs.forEach((e) => console.log(`   ✗ ${e}`));
    notes.forEach((n) => console.log(`   ⚠ ${n}`));
}
process.exit(total === 0 ? 0 : 1);
