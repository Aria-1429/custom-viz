// 編集 UI で実際に値を変更できるかの検証。
// タイトル入力に打ち込み、保存ボタンが活性になるか＋コンソールエラーを見る。
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, outPng] = process.argv;
assertConfig();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

// 1. ダッシュボードのタイトル入力に打つ
const titleInput = page.locator('.dpx-input').first();
console.log('入力欄の数:', await page.locator('.dpx-input').count());
await titleInput.click();
await titleInput.fill('変更テスト');
await page.keyboard.press('Tab');
await page.waitForTimeout(800);
console.log('タイトル入力後の値:', await titleInput.inputValue().catch(() => '(取得不可)'));

const saveBtn = page.getByRole('button', { name: '保存' });
console.log('保存ボタン活性:', await saveBtn.isEnabled().catch(() => 'なし'));

// 2. ドロップダウン（配色プリセット）を開いて選ぶ
const selects = page.locator('button.dpx-btn.dpx-input');
console.log('ドロップダウンの数:', await selects.count());
await page.screenshot({ path: outPng.replace('.png', '_1.png') });

if (errors.length) { console.log('--- コンソールエラー ---'); errors.slice(0, 8).forEach((e) => console.log(e)); }
else console.log('コンソールエラーなし');
await browser.close();
