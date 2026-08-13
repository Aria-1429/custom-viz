// ドラッグ中のプレビュー（定義を書かずに見た目だけ動く）の実機検証。
//
// ⚠ これを確かめないと、**掴んでも絵が動かない**退行に気づけない。
//   「離した時に1回だけ定義へ書く」に変えた副作用として最も起きやすい。
//
// 検証すること:
//   1. ドラッグ中に**画面上のパネルが動く**（プレビューが効いている）
//   2. ドラッグ中は**保存ボタンが押せない**（＝定義をまだ書いていない）
//   3. 離した瞬間に保存ボタンが押せる（＝1回だけ書いた）
//   4. Ctrl+Z 一発で戻る
//
// 使い方: node src/dp-dragpreview-e2e.mjs <app> <view> [パネルid] [出力PNG]

import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, panelId = 'p1', out = '/tmp/dp-dragpreview.png'] = process.argv;
// ⚠ パネル ID は引数で受ける。ボードごとに違うので決め打ちにすると
//    「ボードを作り直したら E2E が落ちる」（実際に p1 決め打ちで落ちた）。
if (!app || !view) {
    console.error('usage: dp-dragpreview-e2e.mjs <app> <view> [out.png]');
    process.exit(1);
}
assertConfig();

let ng = 0;
const ok = (c, m) => {
    console.log(c ? `✓ ${m}` : `✗ ${m}`);
    if (!c) ng++;
};

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
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
});
await page.waitForTimeout(9000);

const saveBtn = page.getByRole('button', { name: '保存', exact: true });
const saveEnabled = () => saveBtn.isEnabled().catch(() => false);
const boxOf = (id) => page.locator(`[data-panel-id="${id}"]`).first().boundingBox();

ok(!(await saveEnabled()), '開いた直後は保存ボタンが押せない');

console.log('--- パネルのドラッグ ---');
const before = await boxOf(panelId);
await page.mouse.move(before.x + 40, before.y + 10);
await page.mouse.down();
// 複数セルを跨ぐように動かし、**押したまま**画面を測る
for (let i = 1; i <= 8; i++) {
    await page.mouse.move(before.x + 40, before.y + 10 + i * 24, { steps: 2 });
    await page.waitForTimeout(50);
}
await page.waitForTimeout(400);
const during = await boxOf(panelId);
ok(during.y > before.y + 20, `⭐ ドラッグ中に絵が動いている (y: ${Math.round(before.y)} → ${Math.round(during.y)})`);
ok(!(await saveEnabled()), '⭐ ドラッグ中は保存ボタンが押せない（定義をまだ書いていない）');
await page.screenshot({ path: out.replace(/\.png$/, '-during.png') });

await page.mouse.up();
await page.waitForTimeout(900);
const after = await boxOf(panelId);
ok(await saveEnabled(), '⭐ 離した瞬間に保存ボタンが押せる（1回だけ書いた）');
ok(Math.abs(after.y - during.y) < 30, `離した後も同じ位置にいる (${Math.round(after.y)})`);

console.log('--- Ctrl+Z ---');
await page.mouse.click(8, 300);
await page.waitForTimeout(300);
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
const undone = await boxOf(panelId);
ok(Math.abs(undone.y - before.y) < 6, `⭐ Ctrl+Z 一発でドラッグ前に戻った (${Math.round(undone.y)})`);
ok(!(await saveEnabled()), '⭐ 戻しきったので保存ボタンが押せない');

console.log('--- リサイズも同じか ---');
const rBefore = await boxOf(panelId);
// 右下の掴み手（パネルの右下隅）。
// ⚠ **オフセット 4px では掴めない**。掴み手は right:2/bottom:2 の 16px だが、
//   その外周はタイトルバー側の "move" 用オーバーレイに覆われている（実機で観測）。
//   → 8〜12px 内側を掴む。
// ⚠ **右に伸びる余地があるパネルを渡すこと。** 右隣にパネルがある／グリッド右端に
//   接している場合はクランプされて**幅が変わらないのが正常**であり、
//   それを「リサイズが壊れた」と誤診しやすい（実際に誤診しかけた）。
await page.mouse.move(rBefore.x + rBefore.width - 10, rBefore.y + rBefore.height - 10);
await page.mouse.down();
for (let i = 1; i <= 6; i++) {
    await page.mouse.move(rBefore.x + rBefore.width - 10 + i * 26, rBefore.y + rBefore.height - 10, { steps: 2 });
    await page.waitForTimeout(50);
}
await page.waitForTimeout(400);
const rDuring = await boxOf(panelId);
const resized = rDuring.width > rBefore.width + 20;
ok(resized, `⭐ リサイズ中に絵が変わる (w: ${Math.round(rBefore.width)} → ${Math.round(rDuring.width)})`);
if (resized) ok(!(await saveEnabled()), '⭐ リサイズ中も保存ボタンが押せない');
await page.mouse.up();
await page.waitForTimeout(800);
if (resized) {
    ok(await saveEnabled(), '離したら保存ボタンが押せる');
    await page.mouse.click(8, 300);
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(800);
    ok(!(await saveEnabled()), '⭐ Ctrl+Z 一発でリサイズが戻った');
}

await page.screenshot({ path: out });
console.log(`\nスクリーンショット: ${out}`);
await browser.close();
console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
