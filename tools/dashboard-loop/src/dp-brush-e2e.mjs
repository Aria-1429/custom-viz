// 時間ブラシ（クロスパネル）の E2E。
//   node src/dp-brush-e2e.mjs <app> <view> <panelId>
//
// 折れ線の上を横にドラッグして、**ダッシュボード全体の時間範囲**（時間範囲入力の
// トークン）が書き換わり、**他のパネルも同じ期間に追従する**ことを確かめる。
//
// Studio ではパネルが iframe に隔離されているため、パネル内のドラッグ座標を
// ホストの時間ピッカーへ渡せない。DPX でしか成立しない機能なので、
// 「本当に全パネルへ効いているか」を実機で見るところまでやる。
//
// ⚠ 検証の観点（どれも実際に外しうる）:
//   - 時間ピッカーの表示が変わっただけでは不十分（トークンは書けても
//     パネルが再サーチしていないことがある）。**別パネルの内容の変化**を見る
//   - ドラッグ中の帯が出るか（出ないと「掴めたのか」が分からない）
//   - 1バケットも動かない「ただのクリック」で期間が絞られないこと
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, panelId = 'p_traffic'] = process.argv;
if (!app || !view) {
    console.error('usage: dp-brush-e2e.mjs <app> <view> [panelId]');
    process.exit(1);
}
assertConfig();

const OUT = process.env.DPX_SHOT_DIR || '/tmp';
let ng = 0;
const check = (cond, msg) => {
    console.log(cond ? `✓ ${msg}` : `✗ ${msg}`);
    if (!cond) ng++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('input[name="username"]').first().fill(config.user);
const pass = page.locator('input[name="password"]').first();
await pass.fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    pass.press('Enter'),
]);

// 表示モードで開く（ブラシは表示モード専用。編集中はパネル選択が優先）
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(16_000);

// 時間ピッカーの表示（ブラシ前）
const pickerText = async () =>
    (await page.locator('.dpx-input, [class*="dpx"]').filter({ hasText: '時間' }).first().textContent().catch(() => '')) ?? '';
const timeLabelBefore = await page
    .getByText(/直近|Last|〜/)
    .first()
    .textContent()
    .catch(() => '');

// 「期間: …」のテキストパネルでトークンの中身を読む（人が読める形で残る）
const tokenLine = page.getByText(/期間:/).first();
const tokenBefore = (await tokenLine.textContent().catch(() => '')) ?? '';
console.log(`ブラシ前のトークン: ${tokenBefore.trim()}`);

// 別パネル（エラー数）の1行目の値を控えておく。**追従したかの判定に使う**
const tableRowBefore = (await page.locator('table tbody tr').first().textContent().catch(() => '')) ?? '';
console.log(`ブラシ前の明細1行目: ${tableRowBefore.trim().slice(0, 60)}`);

// ⚠ **X 軸のラベルを控えるのが本命の判定**（2026-08-12 にこれで実バグを検出）。
//   明細の行内容だけを見ていると、`makeresults` のようにサーチの度に値が変わる
//   データでは**期間が絞られていなくてもテキストが変わる**ので、
//   「追従した」と誤判定する。実際それで一度見逃し、スクリーンショットで気づいた。
//   軸の左端ラベルは期間が変われば必ず変わるので、こちらを正とする。
const axisLabels = async (sel) =>
    (await page.locator(`${sel} svg text`).allTextContents().catch(() => [])).slice(0, 6).join(',');
const axisBefore = await axisLabels(`[data-panel-id="${panelId}"]`);
const axisOtherBefore = await axisLabels('[data-panel-id="p_err"]');
console.log(`ブラシ前の X 軸(対象): ${axisBefore}`);
console.log(`ブラシ前の X 軸(別パネル): ${axisOtherBefore}`);

await page.screenshot({ path: `${OUT}/dp-brush-1-before.png` });

// ── 対象パネルのプロット領域を掴む ─────────────────────────────
const panel = page.locator(`[data-panel-id="${panelId}"]`).first();
if ((await panel.count()) === 0) {
    console.error(`NG: パネル ${panelId} が見つかりません`);
    await page.screenshot({ path: `${OUT}/dp-brush-fail.png` });
    await browser.close();
    process.exit(1);
}
const svg = panel.locator('svg').first();
const box = await svg.boundingBox();
if (!box) {
    console.error('NG: SVG の矩形が取れません');
    await browser.close();
    process.exit(1);
}

// プロット中央の高さで、横に 1/4 → 1/2 の位置までドラッグする
const y = box.y + box.height * 0.5;
const x1 = box.x + box.width * 0.30;
const x2 = box.x + box.width * 0.55;
console.log(`ドラッグ: (${Math.round(x1)},${Math.round(y)}) → (${Math.round(x2)},${Math.round(y)})`);

await page.mouse.move(x1, y);
await page.mouse.down();
await page.mouse.move(x1 + (x2 - x1) * 0.4, y, { steps: 6 });
await page.mouse.move(x2, y, { steps: 6 });
await page.waitForTimeout(400);

// ドラッグ中：選択帯と範囲ラベルが出ているか
const dragShot = `${OUT}/dp-brush-2-dragging.png`;
await page.screenshot({ path: dragShot });
const bodyDuringDrag = (await page.locator('body').innerText().catch(() => '')) ?? '';
// 範囲ラベルは「3.5時間  2026-08-12 05:00:00 → …」の形
const hasRangeLabel = /→/.test(bodyDuringDrag) && /(秒|分|時間|日)/.test(bodyDuringDrag);
check(hasRangeLabel, `ドラッグ中に範囲ラベルが出る（${dragShot}）`);

await page.mouse.up();
await page.waitForTimeout(12_000); // 再サーチの完了を待つ

await page.screenshot({ path: `${OUT}/dp-brush-3-after.png` });

const tokenAfter = (await tokenLine.textContent().catch(() => '')) ?? '';
console.log(`ブラシ後のトークン: ${tokenAfter.trim()}`);
check(tokenAfter.trim() !== tokenBefore.trim(), '時間トークンが書き換わった');
// 絶対時刻（YYYY-MM-DDTHH:MM:SS）になっていること＝ブラシが書いた形
check(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(tokenAfter), 'トークンが絶対時刻の形になっている');

const tableRowAfter = (await page.locator('table tbody tr').first().textContent().catch(() => '')) ?? '';
console.log(`ブラシ後の明細1行目: ${tableRowAfter.trim().slice(0, 60)}`);
check(
    tableRowAfter.trim() !== tableRowBefore.trim(),
    '別パネル（明細）が新しい期間で再サーチされた'
);

// ★ 本命の判定：軸そのものが絞られたか（値の揺らぎに騙されない）
const axisAfter = await axisLabels(`[data-panel-id="${panelId}"]`);
const axisOtherAfter = await axisLabels('[data-panel-id="p_err"]');
console.log(`ブラシ後の X 軸(対象): ${axisAfter}`);
console.log(`ブラシ後の X 軸(別パネル): ${axisOtherAfter}`);
check(axisAfter !== axisBefore, '★ 対象パネルの X 軸が新しい期間に狭まった');
check(axisOtherAfter !== axisOtherBefore, '★ 別パネルの X 軸も同じ期間に追従した');

// 「絞り込みを戻す」が出ているか＝戻り道があるか
const undoBtn = page.getByRole('button', { name: /絞り込みを戻す/ });
check((await undoBtn.count()) > 0, '「絞り込みを戻す」ボタンが出ている');

if ((await undoBtn.count()) > 0) {
    await undoBtn.first().click();
    await page.waitForTimeout(10_000);
    const tokenUndone = (await tokenLine.textContent().catch(() => '')) ?? '';
    console.log(`戻した後のトークン: ${tokenUndone.trim()}`);
    check(tokenUndone.trim() === tokenBefore.trim(), '戻すと元の期間に復帰する');
    await page.screenshot({ path: `${OUT}/dp-brush-4-undone.png` });
}

// ── ただのクリックでは絞られないこと ───────────────────────────
const tokenBeforeClick = (await tokenLine.textContent().catch(() => '')) ?? '';
await page.mouse.move(box.x + box.width * 0.5, y);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(3_000);
const tokenAfterClick = (await tokenLine.textContent().catch(() => '')) ?? '';
check(tokenAfterClick.trim() === tokenBeforeClick.trim(), 'ただのクリックでは期間が変わらない');

await browser.close();
console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
