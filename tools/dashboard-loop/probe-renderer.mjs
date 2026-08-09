// どのレンダラー（webgl2 / canvas2d）が選ばれたかをコンソールから確認する
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const name = process.argv[2];
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { const t = m.text(); if (t.includes('world-map')) logs.push(t); });
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${process.env.SPLUNK_APP}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(20000);
console.log('renderer logs:', JSON.stringify(logs));
await browser.close();
