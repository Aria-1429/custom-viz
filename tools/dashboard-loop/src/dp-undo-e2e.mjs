// DPX の Ctrl+Z（編集履歴）の実機検証。
//
// 検証すること（ユーザー要件そのまま）:
//   1. あらゆる操作が戻せる … 文字入力・複製・削除・移動・区画追加
//   2. 戻しきったら保存ボタンが押せなくなる
//   3. ドラッグ1回＝Ctrl+Z 1回（1セルずつ戻らない）
//
// ⚠ **セレクタを推測しない**（2026-08-12 に実際に外した）。
//   実機の DOM は _probe で確認済み:
//   - パネルは `[data-panel-id]`。**タイトルバー（上端 10px 付近）を掴む**。
//     中央をクリックすると、隣のパネルの子 div が pointer を奪って
//     `subtree intercepts pointer events` で固まる
//   - インスペクタの「タイトル」欄は**パネル未選択だとダッシュボードのタイトル**を指す。
//     選択の前後で同じ座標にあるので、**値で判別しないと別物を掴む**（実際に掴んだ）
//   - ⚠ **テキスト欄は素の `input[type=text]` では掴めない**（自前コンポーネントで、
//     ロケータからは `visible=false` に見える）。**数値欄（配置 x,y,w,h）は掴める**ので、
//     文字入力のまとめ検証は「配置の数値欄」で代用する（同じ patch 経路を通る）。
//   - ⚠ viz の type は `dpx.table` / `dpx.bar`。`table` と書くと
//     「未登録の viz」と表示され、パネルは出るが中身が描かれない
//
// ⚠ **DOM の数値だけで「直った」と言わない**（2026-08-12 のユーザー指示）。
//   最後にスクリーンショットを撮るので、必ず目で見て確認すること。
//
// 使い方: node src/dp-undo-e2e.mjs <app> <view> [出力PNG]

import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, panelId = 'p1', panelId2 = 'p2', out = '/tmp/dp-undo-e2e.png'] = process.argv;
// ⚠ パネル ID は引数で受ける（決め打ちはボードを作り直すたびに落ちる）。
if (!app || !view) {
    console.error('usage: dp-undo-e2e.mjs <app> <view> [パネルid] [パネルid2] [out.png]');
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

// ⚠ DPX は1ビュー集約（SPA）。`/app/<app>/<view>` ではなく
//   `/app/dpx/dpx?id=<app>/<view>` で開く
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
});
await page.waitForTimeout(9000);

const saveBtn = page.getByRole('button', { name: '保存', exact: true });
const saveEnabled = () => saveBtn.isEnabled().catch(() => false);
const panelCount = () => page.locator('[data-panel-id]').count();
/**
 * パネルの配置（x,y,w,h）を定義値で読む。
 * ⚠ **数値欄は先頭4つが配置**（実機で確認）。テキスト欄は掴めないので、
 *   「入力→履歴」の検証はここで行う（patch の経路はタイトル欄と同じ）。
 */
const layoutOf = async () => {
    const nums = page.locator('input[type="number"]');
    if ((await nums.count()) < 4) return null;
    const v = [];
    for (let i = 0; i < 4; i++) v.push(await nums.nth(i).inputValue());
    return v.join(',');
};
/** 配置の「幅 w」欄に数字を打ち込む（1打鍵ごとに patch が飛ぶ状況を作る）。 */
const typeWidth = async (text) => {
    const w = page.locator('input[type="number"]').nth(2);
    await w.click();
    await w.fill('');
    await w.type(text, { delay: 120 });
    await page.waitForTimeout(600);
};
const undo = async (n = 1) => {
    for (let i = 0; i < n; i++) {
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(260);
    }
};
/** パネルを**タイトルバー**で選択する（中央だと隣のパネルに邪魔される） */
const selectPanel = async (id) => {
    const box = await page.locator(`[data-panel-id="${id}"]`).first().boundingBox();
    await page.mouse.click(box.x + 40, box.y + 10);
    await page.waitForTimeout(1000);
    return box;
};
/** キーボード操作の前にフォーカスを入力欄から外す（入力中はキー操作が無効な仕様） */
const blur = async () => {
    await page.mouse.click(8, 300);
    await page.waitForTimeout(350);
};

console.log('--- 前提 ---');
ok(!(await saveEnabled()), '開いた直後は保存ボタンが押せない（未編集）');
const n0 = await panelCount();
console.log(`  パネル ${n0} 枚から開始`);

console.log('--- ① 数値の連続入力は1手にまとまる ---');
await selectPanel(panelId);
const before1 = await layoutOf();
// ⚠ **座標を決め打ちしない**（ボードごとに違う。以前 '0,0,4,3' 固定で
//    別ボードでは必ず落ちていた）。ここで見たいのは「選べているか」だけ。
ok(/^\d+,\d+,\d+,\d+$/.test(before1 || ''), `パネルを選べている（配置 = ${before1}）`);
// 「4」→「10」と2打鍵。素直に積むと2手になる
await typeWidth('10');
const typed1 = await layoutOf();
ok(typed1 !== before1, `幅を変えられた (${before1} → ${typed1})`);
ok(await saveEnabled(), '入力したので保存ボタンが押せる');
await blur();
await undo();
await selectPanel(panelId);
const back1 = await layoutOf();
ok(back1 === before1, `⭐ Ctrl+Z 一発で打つ前に戻った (${back1})`);
ok(!(await saveEnabled()), '⭐ 戻しきったので保存ボタンが押せない');

console.log('--- ② ドラッグ1回＝Ctrl+Z 1回 ---');
const box = await selectPanel(panelId2);
const beforeLayout = await layoutOf();
await page.mouse.move(box.x + 40, box.y + 10);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + 40, box.y + 10 + i * 22, { steps: 2 });
    await page.waitForTimeout(45);
}
await page.mouse.up();
await page.waitForTimeout(900);
const movedLayout = await layoutOf();
ok(movedLayout !== beforeLayout, `ドラッグで動いた (${beforeLayout} → ${movedLayout})`);
await blur();
await undo();
await selectPanel(panelId2);
const backLayout = await layoutOf();
ok(backLayout === beforeLayout, `⭐ Ctrl+Z 一発でドラッグ前に戻った（1セルずつではない）(${backLayout})`);
ok(!(await saveEnabled()), '⭐ 戻しきったので保存ボタンが押せない');

console.log('--- ③ 複製を戻せる ---');
await selectPanel(panelId);
await blur();
await selectPanel(panelId);
await page.keyboard.press('Control+d');
await page.waitForTimeout(1000);
const nDup = await panelCount();
ok(nDup === n0 + 1, `複製でパネルが1枚増えた (${n0} → ${nDup})`);
await undo();
ok((await panelCount()) === n0, `⭐ Ctrl+Z で複製が消えた (${nDup} → ${n0})`);
ok(!(await saveEnabled()), '⭐ 戻しきったので保存ボタンが押せない');

console.log('--- ④ 削除を戻せる ---');
await selectPanel(panelId);
await page.keyboard.press('Delete');
await page.waitForTimeout(900);
const nDel = await panelCount();
ok(nDel === n0 - 1, `削除でパネルが1枚減った (${n0} → ${nDel})`);
await undo();
ok((await panelCount()) === n0, `⭐ Ctrl+Z で削除したパネルが戻った (${nDel} → ${n0})`);
ok(!(await saveEnabled()), '⭐ 戻しきったので保存ボタンが押せない');

console.log('--- ⑤ 矢印移動を戻せる ---');
await selectPanel(panelId);
const beforeArrow = await layoutOf();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(700);
const afterArrow = await layoutOf();
ok(afterArrow !== beforeArrow, `矢印で動いた (${beforeArrow} → ${afterArrow})`);
ok(await saveEnabled(), '動かしたので保存ボタンが押せる');
// 矢印の連打はまとめキーで1手になる想定
await undo();
await selectPanel(panelId);
const backArrow = await layoutOf();
ok(backArrow === beforeArrow, `⭐ Ctrl+Z 一発で矢印移動が戻った (${backArrow})`);
ok(!(await saveEnabled()), '⭐ 戻しきったので保存ボタンが押せない');

console.log('--- ⑥ 区画の追加を戻せる ---');
// ⚠ **メンバーが居ない区画は枠を描かない**（外接矩形が無いため。addGroup の仕様）。
//   なので「枠の数」ではなく **「編集が起きたか（保存可）」と「Ctrl+Z で消えるか」**で見る。
//   枠の数で判定して「区画が増えていない」と誤診した実例あり。
const addGroup = page.locator('button[title^="区画を追加"]').first();
ok((await addGroup.count()) === 1, '区画ボタンがある');
await addGroup.click();
await page.waitForTimeout(900);
ok(await saveEnabled(), '区画を追加したので保存ボタンが押せる');
await blur();
await undo();
ok(!(await saveEnabled()), '⭐ Ctrl+Z で区画の追加が戻った（保存ボタンが押せない）');

console.log('--- ⑦ redo ---');
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(800);
ok(await saveEnabled(), 'Ctrl+Shift+Z でやり直すと保存ボタンが押せる');
await undo();
ok(!(await saveEnabled()), 'また戻せば押せなくなる');

console.log('--- ⑧ 最終状態 ---');
ok((await panelCount()) === n0, `パネル枚数が最初と同じ (${n0})`);

await page.screenshot({ path: out, fullPage: false });
console.log(`\nスクリーンショット: ${out}`);
await browser.close();
console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
