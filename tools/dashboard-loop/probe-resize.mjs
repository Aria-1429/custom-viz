// フロー一覧のグリップを実マウスでドラッグし、リサイズと保存を確認する
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

// 展開テーブル（右パネル）のグリップを探す
let grip = null;
let frame = null;
for (const f of page.frames()) {
    try {
        const g = f.locator('[data-gtm="flow-table-resize"]').first();
        if (await g.count()) { grip = g; frame = f; break; }
    } catch (e) { /* 次へ */ }
}
if (!grip) { console.log('grip not found'); process.exit(1); }

const readBox = () => frame.evaluate(() => {
    const el = document.querySelector('[data-gtm="flow-table-resize"]').closest('[data-viz-ui]');
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             styleW: el.style.width, styleH: el.style.height,
             dirty: !!document.querySelector('[data-gtm="flow-table-dirty"]'),
             reset: !!document.querySelector('[data-gtm="flow-table-reset-pos"]') };
});
const before = await readBox();

// まずヘッダーを実マウスでドラッグして、テーブルを Splunk のホバーツールバーが
// 被らない中央付近へ移動する（実運用と同じ流れ）
const header = frame.locator('[data-gtm="flow-table-toggle"]').first();
const hb0 = await header.boundingBox();
await page.mouse.move(hb0.x + 40, hb0.y + hb0.height / 2);
await page.mouse.down();
await page.mouse.move(hb0.x + 40 - 250, hb0.y + hb0.height / 2 - 120, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(600);

const gb = await grip.boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
await page.mouse.move(gb.x + gb.width / 2 + 100, gb.y + gb.height / 2 + 60, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(800);

const after = await readBox();
console.log('before:', JSON.stringify(before));
console.log('after :', JSON.stringify(after));
console.log('resized:', after.w !== before.w || after.h !== before.h);
await page.screenshot({ path: out });
await browser.close();
