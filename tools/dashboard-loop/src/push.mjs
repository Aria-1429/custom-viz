// ダッシュボード JSON を実機へ push する。
//
// 使い方:
//   node src/push.mjs <path/to/dashboard.json> [--name <id>] [--theme dark] [--app <app>]
//
// --name を省略した場合はファイル名（拡張子なし）を ID にする。

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assertConfig, config, webBase } from './config.mjs';
import { checkAuth, ensureApp, pushDashboard, shareWithApp } from './splunk.mjs';

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) flags[key] = true;
            else {
                flags[key] = next;
                i++;
            }
        } else positional.push(a);
    }
    return { positional, flags };
}

export async function pushFile(file, flags = {}) {
    const raw = readFileSync(file, 'utf8');

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`JSON として読めません (${file}): ${e.message}`);
    }

    // SPL の2重エスケープ検査（studio-dashboard-json.md の「最重要」項目）。
    // パース後の SPL にバックスラッシュが残っていたら 2 重エスケープの疑い。
    const suspect = [];
    for (const [key, ds] of Object.entries(parsed.dataSources ?? {})) {
        const q = ds?.options?.query;
        if (typeof q === 'string' && q.includes('\\')) suspect.push(key);
    }
    if (suspect.length) {
        console.warn(`⚠ SPL に残存バックスラッシュ（2重エスケープの疑い）: ${suspect.join(', ')}`);
    }

    const name = String(flags.name || basename(file).replace(/\.json$/i, ''));
    const app = String(flags.app || config.app);

    await ensureApp(app);
    const res = await pushDashboard({
        name,
        definition: parsed,
        label: parsed.title ?? name,
        description: parsed.description ?? '',
        theme: String(flags.theme || 'dark'),
        app,
    });
    await shareWithApp({ name, app }).catch((e) => console.warn(`⚠ 共有設定: ${e.message}`));

    return {
        ...res,
        url: `${webBase()}/en-US/app/${app}/${name}`,
        panelCount: Object.keys(parsed.visualizations ?? {}).length,
        suspect,
    };
}

async function main() {
    assertConfig();
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const file = positional[0];
    if (!file) {
        console.error('使い方: node src/push.mjs <path/to/dashboard.json> [--name <id>]');
        process.exit(2);
    }

    const info = await checkAuth();
    console.log(`✓ 接続: ${info.product} ${info.version} (${info.serverName})`);

    const res = await pushFile(file, flags);
    console.log(`✓ ${res.updated ? '更新' : '作成'}: ${res.name} (${res.panelCount} パネル) → app=${res.app}`);
    console.log(`  ${res.url}`);
}

// 直接実行されたときだけ main を走らせる（sync.mjs からは pushFile を import する）
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((e) => {
        console.error(`✗ ${e.message}`);
        process.exit(1);
    });
}
