import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 700 } });
const page = await ctx.newPage();
const jsUrls = new Set();
page.on('response', (r) => { if (r.url().endsWith('.js')) jsUrls.add(r.url()); });
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${process.env.SPLUNK_APP}/wm_edit_test`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
await page.click('button:has-text("Edit"), a:has-text("Edit")').catch(()=>{});
await page.waitForTimeout(5000);
const urls = [...jsUrls];
const out = await page.evaluate(async (urls) => {
    // ZDINEZ2F を含むチャンクを探し、simulated clicks / overlay / message listener 周辺を抜く
    const target = urls.find(u => u.includes('ZDINEZ2F'));
    if (!target) return { err:'chunk not found', urls: urls.filter(u=>u.includes('chunk')).map(u=>u.split('/').pop()) };
    const t = await (await fetch(target)).text();
    const grab = (kw, before=200, after=600) => {
        const snips=[]; let idx=t.indexOf(kw);
        while(idx>=0 && snips.length<2){ snips.push(t.slice(Math.max(0,idx-before), idx+after).replace(/\s+/g,' ')); idx=t.indexOf(kw, idx+after); }
        return snips;
    };
    return {
        overlay: grab('custom-viz-overlay', 500, 700),
        createListener: grab('createIframeMessageListener', 60, 700),
        simClickType: grab('simulatedClick', 200, 400).concat(grab('SIMULATED', 100, 300)),
        onOverlayClick: grab('onOverlayClick', 100, 500).concat(grab('OverlayClick', 100, 400)),
    };
}, urls);
console.log(JSON.stringify(out, null, 1).slice(0, 4500));
await browser.close();
