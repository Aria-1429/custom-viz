// テキスト欄の「確定時だけ JSON に書く」の実機検証。
//
// ⚠ ここを変えると**入力が壊れる**（打てない・確定できない・IME が飛ぶ）ので、
//   「履歴が1手」だけでなく **普通に入力できること**を必ず確かめる。
//
// 検証すること:
//   1. 打っている最中は**保存ボタンが押せない**（＝定義をまだ書いていない）
//   2. 入力欄の表示は打鍵に追従する（draft が効いている）
//   3. フォーカスを外すと確定し、保存ボタンが押せる
//   4. Ctrl+Z 一発で打つ前に戻る
//   5. Enter でも確定する
//   6. Escape で打ちかけを捨てられる（定義は変わらない）
//   7. 日本語入力（IME）でも確定できる
//
// 使い方: node src/dp-textcommit-e2e.mjs <app> <view> [出力PNG]

import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, out = '/tmp/dp-textcommit.png'] = process.argv;
if (!app || !view) {
    console.error('usage: dp-textcommit-e2e.mjs <app> <view> [out.png]');
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
/**
 * ダッシュボードの「タイトル」欄。
 * ⚠ **`input[type=text]` では掴めない**（ロケータからは visible=false に見える。
 *   実機の DOM を probe して確認済み）。**`input.dpx-input` の先頭**が
 *   ダッシュボードのタイトル欄で、これは普通に読み書きできる。
 */
const titleBox = page.locator('input.dpx-input').first();
const blurAway = async () => {
    await page.mouse.click(8, 300);
    await page.waitForTimeout(400);
};

ok(!(await saveEnabled()), '開いた直後は保存ボタンが押せない');
const before = await titleBox.inputValue();
console.log(`  元のタイトル: "${before}"`);

console.log('--- ① 打っている間は JSON に書かない ---');
await titleBox.click();
// ⚠ `fill('')` は**クリアボタンを押してしまう**（クリアは「操作」なので即確定する仕様）。
//   「打鍵中」を再現したいので、**全選択して上書き**する
await titleBox.press('Control+a');
await titleBox.type('abcde', { delay: 90 });
await page.waitForTimeout(600);
ok((await titleBox.inputValue()) === 'abcde', '⭐ 入力欄の表示は打鍵に追従する');
ok(!(await saveEnabled()), '⭐ 打っている間は保存ボタンが押せない（定義をまだ書いていない）');

console.log('--- ② フォーカスを外すと確定 ---');
await blurAway();
ok(await saveEnabled(), '⭐ 確定したので保存ボタンが押せる');
ok((await titleBox.inputValue()) === 'abcde', '確定後も入力欄の値は残る');

console.log('--- ③ Ctrl+Z 一発で戻る ---');
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
ok((await titleBox.inputValue()) === before, `⭐ Ctrl+Z 一発で打つ前に戻った（"${before}"）`);
ok(!(await saveEnabled()), '⭐ 戻しきったので保存ボタンが押せない');

console.log('--- ④ Enter でも確定する ---');
await titleBox.click();
await titleBox.press('Control+a');
await titleBox.type('xyz', { delay: 80 });
await page.waitForTimeout(400);
ok(!(await saveEnabled()), 'Enter 前はまだ書いていない');
await titleBox.press('Enter');
await page.waitForTimeout(700);
ok(await saveEnabled(), '⭐ Enter で確定して保存ボタンが押せる');
await blurAway();
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
ok(!(await saveEnabled()), 'Ctrl+Z で戻せる');

console.log('--- ⑤ Escape で打ちかけを捨てる ---');
await titleBox.click();
await titleBox.press('Control+a');
await titleBox.type('discard-me', { delay: 60 });
await page.waitForTimeout(400);
await titleBox.press('Escape');
await page.waitForTimeout(700);
ok((await titleBox.inputValue()) === before, `⭐ Escape で元の値に戻る（"${before}"）`);
ok(!(await saveEnabled()), '⭐ Escape なら定義は変わらない（保存ボタンは押せない）');

console.log('--- ⑥ 日本語入力（IME）---');
// CDP で本物の composition を起こす（type では IME を再現できない）
await titleBox.click();
await titleBox.press('Control+a');
const cdp = await ctx.newCDPSession(page);
await cdp.send('Input.imeSetComposition', {
    text: 'にほんご',
    selectionStart: 4,
    selectionEnd: 4,
});
await page.waitForTimeout(400);
ok((await titleBox.inputValue()) === 'にほんご', '変換中の文字が入力欄に出る');
ok(!(await saveEnabled()), '⭐ 変換中は定義を書かない');
// 変換確定
await cdp.send('Input.insertText', { text: '日本語' });
await page.waitForTimeout(400);
ok((await titleBox.inputValue()) === '日本語', '変換を確定できた');
await blurAway();
ok(await saveEnabled(), '⭐ IME 入力もフォーカスを外せば確定する');
const jp = await titleBox.inputValue();
ok(jp === '日本語', `確定後の値が保たれる（"${jp}"）`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(800);
ok((await titleBox.inputValue()) === before, '⭐ Ctrl+Z 一発で戻る（IME 入力も1手）');
ok(!(await saveEnabled()), '戻しきったので保存ボタンが押せない');

await page.screenshot({ path: out });
console.log(`\nスクリーンショット: ${out}`);
await browser.close();
console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng === 0 ? 0 : 1);
