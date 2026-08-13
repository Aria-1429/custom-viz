// DPX トークン連鎖の E2E 検証：
//   1. 表示モードで開き、詳細パネルのタイトルが「詳細: svc-1」（既定値）であることを確認
//   2. 一覧パネルの svc-3 行をクリック → タイトルが「詳細: svc-3」に変わり再サーチされることを確認
// 使い方: node src/dp-token-check.mjs <app> <view> <out前.png> <out後.png>
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, outBefore, outAfter] = process.argv;
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
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

await page.getByText('詳細: svc-1', { exact: true }).waitFor({ timeout: 10000 });
console.log('OK: 既定トークンでタイトル「詳細: svc-1」');
await page.screenshot({ path: outBefore });

// 入力ドロップダウンの <option> ではなくパネル内の行ラベル（div）を狙う
await page.locator('div:text-is("svc-3")').first().click();
await page.getByText('詳細: svc-3', { exact: true }).waitFor({ timeout: 10000 });
console.log('OK: クリックでトークン更新 →「詳細: svc-3」');
await page.waitForTimeout(4000); // 再サーチの完了を待つ
await page.screenshot({ path: outAfter });
console.log('done');
await browser.close();
