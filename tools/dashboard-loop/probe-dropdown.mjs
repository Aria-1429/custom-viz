// フィルタのドロップダウンを開いた状態を撮影する
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const name = process.argv[2];
const out = process.argv[3];
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
await page.goto(`${webBase()}/en-US/app/${process.env.SPLUNK_APP}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(18000);
// viz iframe の中のフィルタボタンを探して押す（最初のパネル）
let clicked = false;
for (const f of page.frames()) {
    try {
        const btn = f.locator('button[aria-haspopup="listbox"]').first();
        if (await btn.count()) {
            await btn.click({ timeout: 3000 });
            clicked = true;
            break;
        }
    } catch (e) { /* 次のフレームへ */ }
}
console.log('dropdown clicked:', clicked);
await page.waitForTimeout(1200);
await page.screenshot({ path: out, fullPage: false });
console.log('saved:', out);
await browser.close();
