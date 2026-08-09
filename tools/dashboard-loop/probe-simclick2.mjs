import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 700 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${process.env.SPLUNK_APP}/wm_edit_test`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(14000);

// ページのコンテキスト（同一オリジン）で fetch すれば cookie が付く
const out = await page.evaluate(async () => {
    const scripts = [...new Set([...document.querySelectorAll('script[src]')].map(s=>s.src))]
        .filter(s => s.startsWith(location.origin));
    const kws = ['supportsSimulatedClicks','simulateClick','custom-viz-overlay','SimulatedClick','dispatchSimulated','simulated-clicks'];
    const results = [];
    for (const src of scripts) {
        try {
            const t = await (await fetch(src)).text();
            for (const kw of kws) {
                let idx = t.indexOf(kw);
                while (idx >= 0) {
                    results.push({ file: src.split('/').pop(), kw, snip: t.slice(Math.max(0,idx-260), idx+360).replace(/\s+/g,' ') });
                    idx = t.indexOf(kw, idx + 1);
                    if (results.filter(r=>r.kw===kw).length >= 3) break;
                }
            }
        } catch (e) {}
    }
    return results;
});
for (const r of out) {
    console.log(`\n=== [${r.kw}] ${r.file} ===\n${r.snip}`);
}
console.log('\ntotal hits:', out.length);
await browser.close();
