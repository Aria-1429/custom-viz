// 任意の Splunk Web ページを開いてスクリーンショットを撮る（ダッシュボード以外も対象）。
//
// shot.mjs はダッシュボード専用（/app/<app>/<dashboard> を開いてパネルを待つ）だが、
// こちらは「独立 React アプリのページ」のような任意のパスを撮るためのもの。
// コンソールエラーと失敗リクエストも拾うので、真っ白なページの原因調査に使える。
//
// 使い方:
//   node src/shot-page.mjs <パス> [--out <dir>] [--name <ファイル名>]
//                                 [--width 1600] [--height 1000] [--wait 30] [--settle 2]
//
//   例: node src/shot-page.mjs /en-US/app/ops_console/overview --out /tmp/shots

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertConfig, config, webBase } from './config.mjs';

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

async function login(page) {
    await page.goto(`${webBase()}/en-US/account/login`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
    });
    const user = page.locator('input[name="username"]').first();
    const pass = page.locator('input[name="password"]').first();
    if ((await user.count()) === 0 || (await pass.count()) === 0) {
        throw new Error('ログインフォームが見つかりません');
    }
    await user.fill(config.user);
    await pass.fill(config.pass);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
        pass.press('Enter'),
    ]);
    await page.waitForTimeout(1500);
    if (page.url().includes('/account/login')) {
        throw new Error('ログインに失敗しました（認証情報を確認してください）');
    }
}

/** 画面が2回連続で同じになったら描画完了とみなす（アニメーションがあれば maxWait で打ち切り）。 */
async function waitForRender(page, { maxWaitMs, settleMs }) {
    const deadline = Date.now() + maxWaitMs;
    let prev = null;
    let stableSince = null;
    while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
        const same = prev && buf.equals(prev);
        prev = buf;
        if (same) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= settleMs) return { settled: true };
        } else {
            stableSince = null;
        }
    }
    return { settled: false };
}

async function main() {
    assertConfig();
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const path = positional[0];
    if (!path) {
        console.error('使い方: node src/shot-page.mjs <パス> [--out <dir>] [--name <名前>]');
        process.exit(2);
    }

    const outDir = flags.out || join(process.cwd(), 'shots');
    const name = flags.name || path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    const width = Number(flags.width || 1600);
    const height = Number(flags.height || 1000);
    const maxWaitMs = Number(flags.wait || 30) * 1000;
    const settleMs = Number(flags.settle || 2) * 1000;

    mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const failedRequests = [];
    page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) =>
        failedRequests.push(`${r.url()} — ${r.failure()?.errorText ?? 'failed'}`)
    );
    page.on('response', (r) => {
        if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
    });

    try {
        await login(page);
        const url = path.startsWith('http') ? path : `${webBase()}${path}`;
        console.log(`→ ${url}`);
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        console.log(`  HTTP ${resp ? resp.status() : '?'}`);

        const { settled } = await waitForRender(page, { maxWaitMs, settleMs });

        const file = join(outDir, `${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`✓ 保存: ${file} (settled: ${settled})`);

        const title = await page.title();
        const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
        console.log(`  title: ${title}`);
        console.log(`  本文の先頭:\n${bodyText.replace(/^/gm, '    ')}`);

        if (consoleErrors.length) {
            console.log(`\n⚠ コンソールエラー ${consoleErrors.length} 件:`);
            consoleErrors.slice(0, 15).forEach((e) => console.log(`   - ${e.slice(0, 300)}`));
        }
        if (failedRequests.length) {
            console.log(`\n⚠ 失敗リクエスト ${failedRequests.length} 件:`);
            [...new Set(failedRequests)].slice(0, 15).forEach((e) => console.log(`   - ${e.slice(0, 300)}`));
        }
    } finally {
        await browser.close();
    }
}

main().catch((e) => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
});
