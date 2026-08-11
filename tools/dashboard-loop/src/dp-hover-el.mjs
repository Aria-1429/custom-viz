// 指定テキストの要素にホバーして撮る（凡例のフォーカス確認用）
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';
const [, , path, text, outPng, tab] = process.argv;
assertConfig();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}).catch(()=>{}), page.locator('input[name="password"]').first().press('Enter')]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}${path}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(11000);
if (tab) { await page.getByText(tab, { exact: true }).first().click(); await page.waitForTimeout(1500); }
await page.locator('button', { hasText: text }).last().hover();
await page.waitForTimeout(800);
await page.screenshot({ path: outPng });
console.log('OK:', outPng);
await browser.close();
