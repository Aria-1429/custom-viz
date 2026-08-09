// フロー一覧のヘッダーを実マウスでドラッグし、移動と setOptions 保存を確認する
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 500 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${process.env.SPLUNK_APP}/wm_ui`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(18000);

// 右パネル（展開テーブル）のヘッダーを探す
let header = null;
let frame = null;
for (const f of page.frames()) {
    try {
        const h = f.locator('[data-gtm="flow-table-toggle"]').first();
        if (await h.count()) { header = h; frame = f; break; }
    } catch (e) { /* 次へ */ }
}
if (!header) { console.log('header not found'); process.exit(1); }

const before = await frame.evaluate(() => {
    const el = document.querySelector('[data-gtm="flow-table-toggle"]').closest('[data-viz-ui]');
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), style: el.style.left };
});

// 実マウスでドラッグ（左上方向へ 200,-150）
const hb = await header.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2 - 200, hb.y + hb.height / 2 - 150, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(800);

const after = await frame.evaluate(() => {
    const el = document.querySelector('[data-gtm="flow-table-toggle"]').closest('[data-viz-ui]');
    const r = el.getBoundingClientRect();
    // viz に届いた options を直接確認（保存が効いたかの証拠）
    let tablePos = null;
    try { tablePos = globalThis.DashboardExtensionAPI.getOptions().options.tablePos; } catch (e) {}
    return {
        left: Math.round(r.left), top: Math.round(r.top),
        styleLeft: el.style.left, styleTop: el.style.top,
        tablePos,
        collapsed: !document.querySelector('[data-gtm="flow-table-toggle"]')?.closest('[data-viz-ui]')?.querySelector('table') ? 'maybe' : 'expanded',
        resetShown: !!document.querySelector('[data-gtm="flow-table-reset-pos"]'),
    };
});
console.log('before:', JSON.stringify(before));
console.log('after :', JSON.stringify(after));
await page.screenshot({ path: out });
console.log('moved:', after.left !== before.left || after.top !== before.top);
await browser.close();
