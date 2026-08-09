import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 700 } });
const page = await ctx.newPage();
// custom-viz 関連の JS チャンクを収集
const chunks = [];
page.on('response', (r) => {
    const u = r.url();
    if (u.endsWith('.js') && /dashboard|studio|viz/i.test(u)) chunks.push(u);
});
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${process.env.SPLUNK_APP}/wm_edit_test`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(14000);

// 全 <script src> を集め、simulated-clicks / custom-viz-overlay を含むチャンクを探す
const scripts = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map(s=>s.src));
const auth = 'Basic ' + Buffer.from(config.user+':'+config.pass).toString('base64');
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
let hits = [];
for (const src of [...new Set(scripts)]) {
    try {
        const res = await fetch(src, { headers: { Cookie: (await page.context().cookies()).map(c=>c.name+'='+c.value).join('; ') } });
        if (!res.ok) continue;
        const txt = await res.text();
        if (/simulated-clicks|simulateClick|SimulatedClick|custom-viz-overlay|supportsSimulatedClicks/.test(txt)) {
            hits.push({ src: src.split('/').pop(), size: txt.length });
            // 該当箇所の周辺を抜き出す
            for (const kw of ['supportsSimulatedClicks','simulateClick','custom-viz-overlay','SIMULATED']) {
                let idx = txt.indexOf(kw);
                if (idx >= 0) {
                    console.log(`\n--- [${kw}] in ${src.split('/').pop()} ---`);
                    console.log(txt.slice(Math.max(0,idx-300), idx+400).replace(/\s+/g,' '));
                }
            }
        }
    } catch (e) { /* skip */ }
}
console.log('\nHIT chunks:', JSON.stringify(hits));
await browser.close();
