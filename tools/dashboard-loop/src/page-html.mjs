// ログイン済みセッションで任意ページの生 HTML を取る（テンプレート検証・500 調査用）。
//
// 使い方:
//   node src/page-html.mjs <パス> [--grep <文字列>] [--max <bytes>]
//   例: node src/page-html.mjs /en-US/app/dash_platform/dp_demo --grep STATIC-TEMPLATE-OK

import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const args = process.argv.slice(2);
const path = args[0];
const grepIdx = args.indexOf('--grep');
const grep = grepIdx >= 0 ? args[grepIdx + 1] : null;
const maxIdx = args.indexOf('--max');
const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 1200;

if (!path) {
    console.error('usage: page-html.mjs <path> [--grep <str>] [--max <bytes>]');
    process.exit(1);
}

assertConfig();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);
if (page.url().includes('/account/login')) {
    console.error('ログイン失敗');
    process.exit(1);
}

const res = await page.goto(`${webBase()}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
console.log(`HTTP ${res.status()}`);
const body = await page.content();
if (grep) {
    console.log(body.includes(grep) ? `GREP HIT: ${grep}` : `GREP MISS: ${grep}`);
}
console.log(body.slice(0, max));
await browser.close();
