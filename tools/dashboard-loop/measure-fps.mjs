// world-map のパフォーマンス計測。
// トップフレームの rAF 間隔と longtask を測る（同一オリジン iframe は
// メインスレッドを共有するので、全パネル合算の負荷がここに出る）。
//
// 使い方: node tools/dashboard-loop/measure-fps.mjs <dashboard-name> [秒数]
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';

const name = process.argv[2];
const secs = Number(process.argv[3] || 6);
if (!name) {
    console.error('usage: measure-fps.mjs <dashboard-name> [seconds]');
    process.exit(1);
}

assertConfig();
const cfg = config;
const base = webBase();
const app = process.env.SPLUNK_APP || cfg.app;

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
});
const page = await ctx.newPage();

// ログイン
await page.goto(`${base}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', cfg.user);
    await page.fill('input[name="password"]', cfg.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}

await page.goto(`${base}/en-US/app/${app}/${name}`, { waitUntil: 'domcontentloaded' });
// サーチ完了とアニメーション開始を待つ
await page.waitForTimeout(20000);

const result = await page.evaluate(
    (ms) =>
        new Promise((resolve) => {
            const gaps = [];
            let long = 0;
            let lo;
            try {
                lo = new PerformanceObserver((l) => {
                    l.getEntries().forEach((e) => {
                        long += e.duration;
                    });
                });
                lo.observe({ entryTypes: ['longtask'] });
            } catch (e) {
                /* longtask 未対応でも fps は測れる */
            }
            let prev = performance.now();
            const t0 = prev;
            const tick = (now) => {
                gaps.push(now - prev);
                prev = now;
                if (now - t0 < ms) requestAnimationFrame(tick);
                else {
                    if (lo) lo.disconnect();
                    gaps.sort((a, b) => a - b);
                    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
                    resolve({
                        frames: gaps.length,
                        meanMs: +mean.toFixed(1),
                        medianMs: +gaps[Math.floor(gaps.length / 2)].toFixed(1),
                        p95Ms: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
                        fps: +(1000 / mean).toFixed(1),
                        longtaskMs: Math.round(long),
                    });
                }
            };
            requestAnimationFrame(tick);
        }),
    secs * 1000
);

const panels = await page.locator('[data-test="visualization"], [data-test="viz"]').count();
console.log(JSON.stringify({ dashboard: name, panels, ...result }, null, 2));

await browser.close();
