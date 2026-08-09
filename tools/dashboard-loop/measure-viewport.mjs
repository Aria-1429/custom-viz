// 同じダッシュボードを解像度違いで測る。
// 「塗り面積（＝画面の広さ）が fps を決めているか」を確かめるための計測。
// 使い方: node measure-viewport.mjs <dashboard> <width> <height> [秒]
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';

assertConfig();
const name = process.argv[2];
const W = Number(process.argv[3] || 1400);
const H = Number(process.argv[4] || 900);
const secs = Number(process.argv[5] || 6);
const app = process.env.SPLUNK_APP || config.app;

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: W, height: H },
});
const page = await ctx.newPage();

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}

await page.goto(`${webBase()}/en-US/app/${app}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(20000);

const r = await page.evaluate(
    (ms) =>
        new Promise((resolve) => {
            const gaps = [];
            let prev = performance.now();
            const t0 = prev;
            const tick = (now) => {
                gaps.push(now - prev);
                prev = now;
                if (now - t0 < ms) requestAnimationFrame(tick);
                else {
                    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
                    resolve({ fps: +(1000 / mean).toFixed(1), meanMs: +mean.toFixed(1), frames: gaps.length });
                }
            };
            requestAnimationFrame(tick);
        }),
    secs * 1000
);

console.log(`${name} @ ${W}x${H}:`, JSON.stringify(r));
await browser.close();
