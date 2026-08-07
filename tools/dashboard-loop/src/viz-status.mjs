// 実機に入っている viz アプリのバージョンと、ローカルの package.json を突き合わせる。
//
// カスタム viz を撮影して見た目を直すとき、**実機に古いバンドルが入ったまま**だと
// 「直したのに直らない」と誤診する。撮る前にこれを回して差異が無いことを確かめる。
//
//   node src/viz-status.mjs            … 差異があるものだけ表示
//   node src/viz-status.mjs --all      … 全件表示
//   node src/viz-status.mjs <name>     … 特定の viz だけ（フォルダ名 or アプリ ID）

import https from 'node:https';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig, config, mgmtBase } from './config.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function get(path) {
    return new Promise((resolve, reject) => {
        const u = new URL(mgmtBase() + path);
        https
            .request(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname + u.search,
                    method: 'GET',
                    rejectUnauthorized: false,
                    headers: {
                        Authorization:
                            'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64'),
                    },
                },
                (r) => {
                    const c = [];
                    r.on('data', (d) => c.push(d));
                    r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString() }));
                }
            )
            .on('error', reject)
            .end();
    });
}

/** ローカルの viz を { appId: {folder, version} } で集める。 */
function localVizzes() {
    const out = {};
    const base = join(repoRoot, 'visualizations');
    if (!existsSync(base)) return out;
    for (const folder of readdirSync(base)) {
        const pkgPath = join(base, folder, 'package.json');
        const vizDir = join(base, folder, 'visualizations');
        if (!existsSync(pkgPath) || !existsSync(vizDir)) continue;
        const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
        for (const appId of readdirSync(vizDir)) out[appId] = { folder, version };
    }
    return out;
}

async function main() {
    assertConfig();
    const args = process.argv.slice(2);
    const showAll = args.includes('--all');
    const filter = args.find((a) => !a.startsWith('--'));

    const res = await get('/services/apps/local?count=0&output_mode=json');
    if (res.status !== 200) {
        console.error(`✗ アプリ一覧の取得に失敗 (HTTP ${res.status})`);
        process.exit(1);
    }
    const installed = {};
    for (const e of JSON.parse(res.body).entry) installed[e.name] = e.content.version || null;

    const local = localVizzes();
    const rows = [];
    for (const [appId, { folder, version }] of Object.entries(local)) {
        if (filter && folder !== filter && appId !== filter) continue;
        const remote = installed[appId];
        const state = remote == null ? '未導入' : remote === version ? '一致' : 'ズレ';
        if (showAll || state !== '一致') rows.push({ folder, appId, local: version, remote, state });
    }

    if (rows.length === 0) {
        console.log('✓ ローカルと実機のバージョンは全て一致しています');
        return;
    }

    const w = Math.max(...rows.map((r) => r.folder.length), 8);
    for (const r of rows) {
        const mark = r.state === '一致' ? '✓' : r.state === '未導入' ? '—' : '✗';
        console.log(
            `${mark} ${r.folder.padEnd(w)}  ローカル v${r.local}  実機 ${r.remote ? 'v' + r.remote : '(未導入)'}  ${r.state}`
        );
    }
    if (rows.some((r) => r.state !== '一致')) {
        console.log('');
        console.log('⚠ ズレ／未導入がある状態で撮影すると、古いバンドルを見て誤診する。');
        console.log('  `yarn build:prod && yarn package` して .spl を作り、');
        console.log('  Splunk Web からインストール（Upgrade にチェック）→ /en-US/_bump してから撮ること。');
        console.log('  ※ この操作は install_apps 権限が要るため自動化できない（手動）。');
    }
}

main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
});
