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

const probe = async (label) => {
    const r = await page.evaluate(() => {
        const ifr = [...document.querySelectorAll('iframe')].find((f) => {
            const rr = f.getBoundingClientRect();
            return rr.width > 300 && rr.left < window.innerWidth / 2;
        });
        if (!ifr) return { found: false };
        const rr = ifr.getBoundingClientRect();
        const top = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
        // 最前面要素の詳細と、iframe との DOM 上の位置関係
        const isDesc = ifr.contains(top);
        // 兄弟オーバーレイなら iframe の後ろに同階層で置かれているはず
        const parent = ifr.parentElement;
        const overlaySiblings = parent ? [...parent.children].filter(c=>c!==ifr).map(c=>({
            tag:c.tagName, cls:String(c.className).slice(0,40),
            data:[...c.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name+'='+a.value).join(','),
            pe:getComputedStyle(c).pointerEvents,
        })) : [];
        return {
            found:true,
            topTag: top?.tagName, topCls:String(top?.className).slice(0,40),
            topData:[...(top?.attributes||[])].filter(a=>a.name.startsWith('data-')).map(a=>a.name+'='+a.value).join(','),
            topIsIframeDescendant: isDesc,
            iframeParentTag: parent?.tagName,
            overlaySiblings,
        };
    });
    console.log(label, JSON.stringify(r, null, 1));
};

console.log('### VIEW MODE ###');
await probe('view:');
// 編集モードへ
await page.click('button:has-text("Edit"), a:has-text("Edit")');
await page.waitForTimeout(6000);
console.log('### EDIT MODE ###');
await probe('edit:');
await browser.close();
