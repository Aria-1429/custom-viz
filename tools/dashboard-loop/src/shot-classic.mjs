// クラシック（Simple XML）ダッシュボードのパネル個別撮影。
//
// shot.mjs の --panels は Studio のセレクタ（[data-test="viz-item"]）専用で、
// クラシックでは 0 枚になる。クラシックは Backbone 製で DOM が別物なので分けてある。
//
// 使い方:
//   node src/shot-classic.mjs <dashboard-name> --out <dir> [--wait 30] [--probe]
//
// --probe を付けるとパネルらしき要素のクラス名を列挙する（セレクタが外れたときの調査用）。

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertConfig, config, webBase } from './config.mjs';

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const k = argv[i].slice(2);
            const n = argv[i + 1];
            if (n === undefined || n.startsWith('--')) flags[k] = true;
            else { flags[k] = n; i++; }
        } else positional.push(argv[i]);
    }
    return { positional, flags };
}

async function login(page) {
    await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const user = page.locator('input[name="username"]').first();
    if (await user.count()) {
        await user.fill(config.user);
        await page.locator('input[name="password"]').first().fill(config.pass);
        await page.locator('input[type="submit"], button[type="submit"]').first().click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);
    }
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const name = positional[0];
if (!name) {
    console.error('使い方: node src/shot-classic.mjs <dashboard-name> --out <dir>');
    process.exit(1);
}
assertConfig();
const outDir = flags.out || '.';
mkdirSync(outDir, { recursive: true });
const app = flags.app || config.app;
const waitMs = Number(flags.wait ?? 30) * 1000;

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({
    viewport: { width: Number(flags.width ?? 1600), height: Number(flags.height ?? 1200) },
    deviceScaleFactor: Number(flags.scale ?? 1),
    ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
const consoleMsgs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleMsgs.push(m.text().slice(0, 300)); });

await login(page);
await page.goto(`${webBase()}/en-US/app/${app}/${name}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(waitMs);

const result = { name, app, panels: [], consoleErrors: consoleMsgs };

if (flags.probe) {
    result.probe = await page.evaluate(() => {
        const classes = new Set();
        for (const el of document.querySelectorAll('div[class]')) {
            const c = el.className;
            if (typeof c === 'string' && /panel|dashboard|viz|element/i.test(c)) classes.add(c.slice(0, 90));
        }
        return { title: document.title, candidates: [...classes].slice(0, 80) };
    });
}

// クラシックのパネルは .dashboard-panel（Backbone）。実機で確認して確定させる。
const sel = flags.selector || '.dashboard-panel';
const items = page.locator(sel);
const count = await items.count();
for (let i = 0; i < count; i++) {
    const el = items.nth(i);
    const title = (await el.locator('.panel-title, h2, h3').first().textContent().catch(() => null)) || `panel${i}`;
    const slug = String(title).trim().replace(/[^\wぁ-んァ-ヶ一-龠]+/g, '_').slice(0, 40) || `panel${i}`;
    const p = join(outDir, `${name}__${String(i).padStart(2, '0')}_${slug}.png`);
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await el.screenshot({ path: p }).catch((e) => { result.panels.push({ i, error: e.message }); });
    result.panels.push({ i, title: String(title).trim(), path: p });
}

// 全体（フルページ）も1枚
const full = join(outDir, `${name}__full.png`);
await page.screenshot({ path: full, fullPage: true });

await browser.close();
writeFileSync(join(outDir, `${name}.classic-report.json`), JSON.stringify(result, null, 2));
console.log(`パネル ${count} 枚 / 全体: ${full}`);
if (result.probe) console.log(JSON.stringify(result.probe, null, 2));
if (consoleMsgs.length) console.log(`⚠ コンソールエラー ${consoleMsgs.length} 件`);
