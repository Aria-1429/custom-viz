// DPX のホバー同期（vizBus）検証。
// 左パネルの指定ラベル行にマウスを乗せ、その状態で全体を撮影する。
// 右パネルの同じラベルがハイライトされ、他の行が淡くなっていれば成立。
//
// 使い方: node src/dp-hover-check.mjs <app> <view> <ラベル文字列> <出力PNG>

import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, label, outPng] = process.argv;
if (!app || !view || !label || !outPng) {
    console.error('usage: dp-hover-check.mjs <app> <view> <label> <out.png>');
    process.exit(1);
}
assertConfig();

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);

await page.goto(`${webBase()}/en-US/app/${app}/${view}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(12_000); // サーチ完了と描画を待つ

const target = page.getByText(label, { exact: true }).first();
if ((await target.count()) === 0) {
    console.error(`NG: ラベル「${label}」が見つかりません`);
    await page.screenshot({ path: outPng });
    await browser.close();
    process.exit(1);
}
await target.hover();
await page.waitForTimeout(600); // opacity トランジションを待つ
await page.screenshot({ path: outPng });
console.log(`hover(${label}) の状態を撮影: ${outPng}`);
await browser.close();
