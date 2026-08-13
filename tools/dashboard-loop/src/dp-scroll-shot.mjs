// インスペクタ内をスクロールして撮る（下部セクションの確認用）
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';
const [, , app, view, clickText, outPng] = process.argv;
assertConfig();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}).catch(()=>{}), page.locator('input[name="password"]').first().press('Enter')]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
if (clickText && clickText !== '-') { await page.getByText(clickText, { exact: true }).first().click(); await page.waitForTimeout(800); }
// インスペクタ（右ペイン）を最下部までスクロール
await page.evaluate(() => {
  const panes = [...document.querySelectorAll('.dpx-scroll')].filter((el) => el.scrollHeight > el.clientHeight + 40);
  const pane = panes.find((el) => el.getBoundingClientRect().right > window.innerWidth - 400);
  if (pane) pane.scrollTop = pane.scrollHeight;
});
await page.waitForTimeout(700);
await page.screenshot({ path: outPng });
console.log('OK:', outPng);
await browser.close();
