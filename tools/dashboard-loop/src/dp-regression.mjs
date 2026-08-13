// ── DPX 回帰スイート ────────────────────────────────────────────
//
// **1 コマンドで全 E2E を回す。**
//
//     node src/dp-regression.mjs [--keep] [--only <name>]
//
// 毎回やること:
//   1. 固定フィクスチャ（`fixtures/dpx-regression.json`）を実機へ push
//   2. 各 E2E を順に実行（**テストごとにフィクスチャを push し直す**）
//   3. 結果をまとめて表示し、1 つでも落ちたら exit 1
//
// ## ⚠ なぜ毎回 push し直すのか
//
// **E2E は実機の定義を書き換える**（ドラッグ→保存など）。
// 前のテストが残した状態で次を走らせると、
// **「前提の座標が違う」だけで落ちる**（実際に踏んだ）。
// テストの独立性はフィクスチャの再投入で担保する。
//
// ## ⚠ パネル id / タイトルはフィクスチャ側の固定値
//
// ツールに決め打ちを書かない（ボードを作り直すたび落ちるため）。
// **引数で渡す**。id を変えたいときはフィクスチャとこの表の両方を直す。
// ────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertConfig } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/dpx-regression.json');
const APP = 'search';
const VIEW = 'dpx_regression';

assertConfig();

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const keep = args.includes('--keep');

/**
 * 実行する E2E の一覧。
 *
 * ⚠ **`needsFresh: false` にしてよいのは、定義を書き換えないテストだけ**。
 *   書き換えるテストで false にすると、次のテストが前提を失って落ちる。
 */
const SUITE = [
    {
        name: 'drag',
        desc: 'ドラッグ移動 → 保存 → 永続化',
        script: 'dp-drag-check.mjs',
        args: [APP, VIEW, 'バー', 'p1'],
    },
    {
        name: 'dragpreview',
        desc: 'ドラッグ中のプレビュー（定義を書かない）',
        script: 'dp-dragpreview-e2e.mjs',
        // ⚠ 右に伸びる余地があるパネルを渡す（クランプされると
        //    「リサイズが効かない」と誤診する）
        args: [APP, VIEW, 'p_g1', '/tmp/dp-reg-dragpreview.png'],
    },
    {
        name: 'groupmove',
        desc: '区画ごと移動（相対位置の保持）',
        script: 'dp-groupmove-e2e.mjs',
        args: [APP, VIEW, 'grp1'],
    },
    {
        name: 'undo',
        desc: 'Ctrl+Z / Ctrl+Shift+Z',
        script: 'dp-undo-e2e.mjs',
        args: [APP, VIEW, 'p1', 'p2', '/tmp/dp-reg-undo.png'],
    },
    {
        name: 'textcommit',
        desc: 'テキスト入力の確定（blur）',
        script: 'dp-textcommit-e2e.mjs',
        args: [APP, VIEW, '/tmp/dp-reg-textcommit.png'],
    },
    {
        name: 'brushui',
        desc: '画材の選択（Design Engine の編集 UI）',
        script: 'dp-brushui-e2e.mjs',
        args: [APP, VIEW, '/tmp/dp-reg-brushui.png'],
    },
    {
        name: 'settings',
        desc: 'ダッシュボード設定（配色プリセット等）',
        script: 'dp-settings-e2e.mjs',
        args: [APP, VIEW],
    },
    {
        name: 'group',
        desc: '区画の作成・解除',
        script: 'dp-group-e2e.mjs',
        args: [APP, VIEW],
    },
    {
        name: 'inputorder',
        desc: '入力の並べ替え',
        script: 'dp-inputorder-e2e.mjs',
        args: [APP, VIEW],
    },
];

const push = () => {
    execFileSync('node', [join(HERE, 'dp-push.mjs'), FIXTURE, APP, VIEW, 'DPX 回帰テスト'], {
        stdio: 'pipe',
    });
};

const run = (t) => {
    const started = Date.now();
    try {
        const out = execFileSync('node', [join(HERE, t.script), ...t.args], {
            stdio: 'pipe',
            timeout: 300_000,
        }).toString();
        const ng = (out.match(/^✗/gm) || []).length;
        const ok = (out.match(/^✓/gm) || []).length;
        return { ...t, pass: ng === 0, ok, ng, ms: Date.now() - started, out };
    } catch (err) {
        const out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
        const ng = (out.match(/^✗/gm) || []).length;
        const ok = (out.match(/^✓/gm) || []).length;
        return { ...t, pass: false, ok, ng: ng || 1, ms: Date.now() - started, out };
    }
};

const targets = only ? SUITE.filter((t) => t.name === only) : SUITE;
if (targets.length === 0) {
    console.error(`--only ${only} に一致するテストがありません`);
    console.error(`  使える名前: ${SUITE.map((t) => t.name).join(', ')}`);
    process.exit(1);
}

console.log(`DPX 回帰スイート（${targets.length} 件）\n`);
const results = [];
for (const t of targets) {
    process.stdout.write(`  ${t.name.padEnd(14)} ${t.desc} … `);
    push(); // ⚠ 毎回フィクスチャを戻す（テストの独立性）
    const r = run(t);
    results.push(r);
    console.log(r.pass ? `OK (✓${r.ok}, ${(r.ms / 1000).toFixed(0)}s)` : `NG (✗${r.ng})`);
}

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
    console.log('\n── 失敗の詳細 ──────────────────────────────');
    for (const f of failed) {
        console.log(`\n### ${f.name}: ${f.desc}`);
        const lines = f.out.split('\n').filter((l) => /^✗|Error|error:/.test(l));
        console.log(lines.slice(0, 12).map((l) => `  ${l}`).join('\n'));
    }
}

if (!keep) {
    // 後片付け（--keep で残せる）
    try {
        execFileSync('node', [join(HERE, 'dp-delete-view.mjs'), APP, VIEW], { stdio: 'pipe' });
    } catch {
        console.log(`\n⚠ 検証ボード ${APP}/${VIEW} が残っています（手で消してください）`);
    }
}

const okCount = results.length - failed.length;
console.log(`\n結果: ${okCount}/${results.length} 成功`);
process.exit(failed.length > 0 ? 1 : 0);
