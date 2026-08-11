// 自前 Select が実際に選択できるかの検証（開く→項目クリック→反映）
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, outPng] = process.argv;
assertConfig();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}/en-US/app/${app}/${view}?mode=edit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

// 「配色プリセット」の下のドロップダウン（現在ネオン）を開く
const trigger = page.getByText('ネオン', { exact: true }).first();
console.log('プリセットのトリガー:', await trigger.count());
await trigger.click();
await page.waitForTimeout(600);
await page.screenshot({ path: outPng.replace('.png', '_open.png') });

// ポップアップの項目を探す
const optionAurora = page.getByText('オーロラ', { exact: true });
console.log('「オーロラ」候補の数:', await optionAurora.count());
if (await optionAurora.count() > 0) {
    await optionAurora.first().click();
    await page.waitForTimeout(1200);
    console.log('クリック後のトリガー表示:', await page.locator('button.dpx-btn.dpx-input').first().innerText().catch(() => '?'));
}
await page.screenshot({ path: outPng.replace('.png', '_after.png') });
if (errors.length) errors.forEach((e) => console.log(e));
await browser.close();
