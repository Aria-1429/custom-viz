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

const readOverlay = async () => page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe')].find((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 300 && r.left < window.innerWidth / 2;
    });
    const ov = ifr?.parentElement ? [...ifr.parentElement.children].find(c => c.getAttribute('data-test')==='custom-viz-overlay') : null;
    if (!ov) return { found:false };
    const cs = getComputedStyle(ov);
    const r = ov.getBoundingClientRect();
    return {
        found:true,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        position: cs.position,
        background: cs.backgroundColor,
        cursor: cs.cursor,
        w: Math.round(r.width), h: Math.round(r.height),
        // iframe 自体の属性
        iframeAttrs: [...ifr.attributes].map(a=>a.name+'='+String(a.value).slice(0,40)),
    };
});

console.log('VIEW overlay:', JSON.stringify(await readOverlay()));
await page.click('button:has-text("Edit"), a:has-text("Edit")');
await page.waitForTimeout(6000);
console.log('EDIT overlay:', JSON.stringify(await readOverlay(), null, 1));

// 実験: 編集モードで overlay の pointer-events を none にしたら iframe に届くか
const exp = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe')].find((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 300 && r.left < window.innerWidth / 2;
    });
    const ov = [...ifr.parentElement.children].find(c => c.getAttribute('data-test')==='custom-viz-overlay');
    ov.style.pointerEvents = 'none';
    const r = ifr.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return { topTag: top?.tagName, topData: top?.getAttribute?.('data-test'), isIframe: top===ifr || ifr.contains(top) };
});
console.log('EXPERIMENT (overlay pe:none):', JSON.stringify(exp));
await browser.close();
