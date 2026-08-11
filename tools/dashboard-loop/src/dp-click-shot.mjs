// 任意のページで指定テキストをクリックし、その状態を撮影する（UI 確認用）。
// 使い方: node src/dp-click-shot.mjs <path> <クリックする文字列> <out.png> [--edit]
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , path, clickText, outPng] = process.argv;
assertConfig();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
await page.getByText(clickText, { exact: true }).first().click();
await page.waitForTimeout(900);
await page.screenshot({ path: outPng });
console.log('OK:', outPng);
await browser.close();
