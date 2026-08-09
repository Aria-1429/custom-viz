// フレーム時間の内訳を Chrome DevTools プロトコルで取る。
// 「何が重いのか」を推測せずに確かめるための計測（Layout/Paint/Composite/Script の別）。
// 使い方: node measure-breakdown.mjs <dashboard> <width> <height> [秒]
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';

assertConfig();
const name = process.argv[2];
const W = Number(process.argv[3] || 1920);
const H = Number(process.argv[4] || 1080);
const secs = Number(process.argv[5] || 5);
const app = process.env.SPLUNK_APP || config.app;

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H } });
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

const client = await page.context().newCDPSession(page);
await client.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
    transferMode: 'ReturnAsStream',
});
await page.waitForTimeout(secs * 1000);
const done = new Promise((r) => client.once('Tracing.tracingComplete', r));
await client.send('Tracing.end');
const { stream } = await done;

let raw = '';
for (;;) {
    const c = await client.send('IO.read', { handle: stream, size: 1 << 20 });
    raw += c.data;
    if (c.eof) break;
}
await client.send('IO.close', { handle: stream });

const events = JSON.parse(raw).traceEvents || [];
const totals = {};
for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    totals[e.name] = (totals[e.name] || 0) + e.dur / 1000;
}
const top = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([k, v]) => `${k}: ${v.toFixed(0)}ms`);
console.log(`--- ${name} @ ${W}x${H} (${secs}s) ---`);
console.log(top.join('\n'));

await browser.close();
