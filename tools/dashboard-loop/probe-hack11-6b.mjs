// ハック11/6 の追試：クリック後の画面を撮って、何が起きたかを目で見る。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');
assertConfig();
const name = process.argv[2] || 'hack11_probe';
const OUT = process.argv[3] || '/tmp/hack11';

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 1500, height: 900 },
    ...(existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}),
});
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${config.app}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(20_000);

// URL のトークン（Studio は動的トークンを URL に載せる）も観測する
const snap = async (label) => {
    const url = page.url();
    const panels = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-test="viz-item"], [data-test="absolute-item"]')) {
            const txt = el.innerText.replace(/\s+/g, ' ').trim().slice(0, 150);
            if (txt) out.push(txt);
        }
        return out;
    });
    console.log(`\n--- ${label} ---`);
    console.log('URL tokens:', decodeURIComponent(url.split('?')[1] || '(なし)').slice(0, 400));
    panels.forEach((p) => console.log('  |', p));
    await page.screenshot({ path: `${OUT}_${label}.png` });
};

await snap('before');

const vf = page.frames().find((f) => f !== page.mainFrame());
await vf.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height > 80; });
    const t = svgs[0];
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) || t;
    hit.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, button: 0 }));
});
await page.waitForTimeout(12_000);
await snap('after');

await browser.close();
