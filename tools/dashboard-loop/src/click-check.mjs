// viz のクリック（インタラクション）が実機で効くかを確かめる。
//
// カスタム viz のドリルダウンは「登録した DOM ノードのクリック」でしか発火しないので、
// **実際に押してみる以外に確認する方法がない**。トークンが入ったかどうかは、
// トークンを使うパネル（`| eval x="$tok$"` など）を同じダッシュボードに置いて
// クリック前後のスクリーンショットを見比べる。
//
//   node src/click-check.mjs <dashboard-name> <出力先> [押すセルの文字列]
//
// ⚠ 表示モードで実行すること。編集モード中はホストが viz（iframe）への入力を遮断するため、
//    押しても何も起きない（Studio の仕様であって不具合ではない）。
// ⚠ カスタム viz は iframe（`about:srcdoc`）の中に描画されるので、
//    ページ本体の DOM を探しても要素は見つからない。frame を辿ること。

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertConfig, config, webBase } from './config.mjs';

assertConfig();

const [name, outDir, cellText] = process.argv.slice(2);
if (!name || !outDir || !cellText) {
    console.error('使い方: node src/click-check.mjs <dashboard-name> <出力先> <押すセルの文字列>');
    process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1050 },
});
const page = await ctx.newPage();

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name=username]').first().fill(config.user);
await page.locator('input[name=password]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation().catch(() => {}),
    page.locator('input[name=password]').first().press('Enter'),
]);
await page.waitForTimeout(1500);

await page.goto(`${webBase()}/en-US/app/${config.app}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(20_000); // サーチ完了まで待つ（足りないとパネルが空のまま写る）
await page.screenshot({ path: join(outDir, 'click-before.png') });

let clicked = false;
for (const frame of page.frames()) {
    const target = frame.locator(`tbody td:has-text("${cellText}")`).first();
    if ((await target.count().catch(() => 0)) > 0) {
        await target.click({ timeout: 5000 }).catch((e) => console.log('click err:', e.message));
        clicked = true;
        break;
    }
}
console.log(clicked ? `✓ "${cellText}" をクリックした` : `✗ "${cellText}" が見つからない`);

await page.waitForTimeout(15_000); // トークンで動くサーチの完了を待つ
await page.screenshot({ path: join(outDir, 'click-after.png') });
console.log(`保存: ${join(outDir, 'click-before.png')} / ${join(outDir, 'click-after.png')}`);
await browser.close();
