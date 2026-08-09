// フロー一覧のスクロール領域に gtm-scroll が付いていてスクロール可能かを確認
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
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
for (const f of page.frames()) {
    try {
        const r = await f.evaluate(() => {
            const el = document.querySelector('.gtm-scroll');
            if (!el) return null;
            return {
                cls: el.className,
                scrollable: el.scrollHeight > el.clientHeight,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                ffWidth: getComputedStyle(el).scrollbarWidth || '(n/a)',
            };
        });
        if (r) { console.log(JSON.stringify(r)); break; }
    } catch (e) { /* 次のフレームへ */ }
}
await browser.close();
