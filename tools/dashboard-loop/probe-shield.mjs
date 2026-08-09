// 編集モードで iframe を覆っているシールドの正体を特定する
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
await page.click('button:has-text("Edit"), a:has-text("Edit")');
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
    // 左パネル（カスタム viz iframe）を特定
    const ifr = [...document.querySelectorAll('iframe')].find((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 300 && r.left < window.innerWidth / 2;
    });
    if (!ifr) return { found: false };
    const r = ifr.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);

    // iframe の祖先を辿って pointer-events と属性を記録
    const anc = [];
    let el = ifr;
    for (let i = 0; el && i < 8; i += 1) {
        const cs = getComputedStyle(el);
        anc.push({
            tag: el.tagName, cls: String(el.className).slice(0, 55),
            pe: cs.pointerEvents,
            dataAttrs: [...el.attributes].filter(a=>a.name.startsWith('data-')).map(a=>`${a.name}=${a.value}`.slice(0,40)),
        });
        el = el.parentElement;
    }

    // シールド = elementFromPoint で最前面に来た要素と iframe の関係
    const shieldIsIframe = top === ifr;
    const shieldRect = top ? top.getBoundingClientRect() : null;

    // iframe 自体の sandbox 属性
    return {
        found: true,
        iframeSandbox: ifr.getAttribute('sandbox'),
        iframePE: getComputedStyle(ifr).pointerEvents,
        topTag: top?.tagName, topCls: String(top?.className).slice(0,55),
        topPE: top ? getComputedStyle(top).pointerEvents : null,
        shieldIsIframe,
        shieldCoversIframe: shieldRect ? (Math.abs(shieldRect.width - r.width) < 5 && Math.abs(shieldRect.height - r.height) < 5) : null,
        ancestors: anc,
    };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
