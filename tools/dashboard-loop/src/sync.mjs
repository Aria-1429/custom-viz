// push → 撮影 を1コマンドで回す。開発ループの入口。
//
// 使い方:
//   node src/sync.mjs <path/to/dashboard.json> [--name <id>] [--panels] [--wait 45]
//
// 実行後、出力された PNG を見れば描画結果が分かる。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { assertConfig } from './config.mjs';
import { checkAuth } from './splunk.mjs';
import { pushFile } from './push.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    const passthrough = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            const val = next === undefined || next.startsWith('--') ? true : next;
            flags[key] = val;
            if (val !== true) i++;
            // 撮影側にも渡すフラグ
            if (['panels', 'wait', 'settle', 'width', 'height', 'out', 'probe', 'tab', 'scale', 'full'].includes(key)) {
                passthrough.push(`--${key}`);
                if (val !== true) passthrough.push(String(val));
            }
        } else positional.push(a);
    }
    return { positional, flags, passthrough };
}

async function main() {
    assertConfig();
    const { positional, flags, passthrough } = parseArgs(process.argv.slice(2));
    const file = positional[0];
    if (!file) {
        console.error('使い方: node src/sync.mjs <path/to/dashboard.json> [--name <id>] [--panels]');
        process.exit(2);
    }

    const info = await checkAuth();
    console.log(`✓ 接続: ${info.product} ${info.version} (${info.serverName})`);

    const res = await pushFile(file, flags);
    console.log(`✓ ${res.updated ? '更新' : '作成'}: ${res.name} (${res.panelCount} パネル)`);
    console.log(`  ${res.url}`);

    const name = String(flags.name || basename(file).replace(/\.json$/i, ''));
    const r = spawnSync('node', [join(here, 'shot.mjs'), name, ...passthrough], {
        stdio: 'inherit',
    });
    process.exit(r.status ?? 0);
}

main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
});
