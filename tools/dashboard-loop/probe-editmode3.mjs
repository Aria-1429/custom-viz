// 標準 viz のズームボタンを正確に特定してクリックする（編集モード）
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const outDir = process.argv[2] || '.';
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
await page.waitForTimeout(15000);
await page.click('button:has-text("Edit"), a:has-text("Edit")');
await page.waitForTimeout(6000);

const readNg = async () => page.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')].filter((s) => {
        const r = s.getBoundingClientRect();
        return r.left > window.innerWidth * 0.35 && r.width > 200;
    });
    const g = svgs[0] ? svgs[0].querySelector('g[transform]') : null;
    return g ? g.getAttribute('transform') : null;
});

// ng パネル領域内のボタン候補を列挙
const btns = await page.evaluate(() => {
    return [...document.querySelectorAll('button, [role="button"]')]
        .map((b) => {
            const r = b.getBoundingClientRect();
            return {
                x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
                text: (b.textContent || '').trim().slice(0, 20),
                aria: b.getAttribute('aria-label') || '',
                test: b.getAttribute('data-test') || '',
            };
        })
        .filter((b) => b.x > innerWidth * 0.35 && b.x < innerWidth * 0.8 && b.y > 150 && b.w < 60 && b.w > 5);
});
console.log('ng-area buttons:', JSON.stringify(btns, null, 1));

const before = await readNg();
// 最上段の小さいボタン（＋）をクリック
if (btns.length) {
    const plus = btns.sort((a, b2) => a.y - b2.y)[0];
    await page.mouse.click(plus.x + plus.w / 2, plus.y + plus.h / 2);
    await page.waitForTimeout(1200);
}
const after = await readNg();
console.log('before:', before);
console.log('after :', after);
console.log('ZOOM WORKED IN EDIT MODE:', before !== after);
await page.screenshot({ path: `${outDir}/editmode_ng2.png` });
await browser.close();
