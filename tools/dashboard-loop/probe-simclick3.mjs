import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 700 } });
const page = await ctx.newPage();
// ネットワークで流れた全 .js を記録（動的 import 含む）
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
// 編集モードにも入って追加チャンクを読み込ませる
await page.click('button:has-text("Edit"), a:has-text("Edit")').catch(()=>{});
await page.waitForTimeout(6000);

const urls = [...jsUrls].filter(u => u.startsWith(page.url().split('/en-US')[0]));
const out = await page.evaluate(async (urls) => {
    const kws = ['SimulatedClick','simulatedClick','supportsSimulatedClicks','viz-supports-simulated','custom-viz-overlay','postMessage'];
    const found = {};
    for (const src of urls) {
        try {
            const t = await (await fetch(src)).text();
            for (const kw of kws) {
                if (t.includes(kw)) {
                    (found[kw] ||= []).push(src.split('/').pop());
                    if (kw === 'SimulatedClick' || kw === 'supportsSimulatedClicks' || kw==='viz-supports-simulated') {
                        let idx = t.indexOf(kw);
                        found['_snip_'+kw] = t.slice(Math.max(0,idx-400), idx+500).replace(/\s+/g,' ');
                    }
                }
            }
        } catch(e){}
    }
    return found;
}, urls);
console.log('scanned', urls.length, 'js files');
for (const [k,v] of Object.entries(out)) {
    if (k.startsWith('_snip_')) console.log(`\n### ${k} ###\n${v}`);
    else console.log(`${k}: ${Array.isArray(v)?v.join(','):v}`);
}
await browser.close();
