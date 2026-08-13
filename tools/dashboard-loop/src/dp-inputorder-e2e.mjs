// 入力の並べ替え E2E: インスペクタで2番目の入力を上へ移動→保存→REST 検証
import https from 'node:https';
import { chromium } from 'playwright';
import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view] = process.argv;
assertConfig();
const restGet = (url) => new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, rejectUnauthorized: false,
        headers: { Authorization: 'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64') } },
        (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(b)); }).on('error', reject);
});
const readInputs = async () => {
    const body = await restGet(`${mgmtBase()}/servicesNS/-/${app}/data/ui/views/${view}?output_mode=json`);
    const eai = JSON.parse(body).entry[0].content['eai:data'];
    return JSON.parse(eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/)[1]).inputs ?? [];
};
const before = await readInputs();
console.log('before:', before.map((x) => x.token).join(' , '));

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

// ⚠ 並べ替えボタンは**キャンバス上の入力カード**に出る（インスペクタではない）。
//   以前は「入力（トークン）」セクションを開こうとしていたが、
//   **そのセクションは既に存在しない**（入力ごとの `入力：<名前>` に変わった）。
//   フィクスチャには入力が 2 つ以上必要。
//
// ⚠ **並べ替えは「↑↓ ボタン」ではなく HTML5 のドラッグ&ドロップ**（2026-08 時点）。
//   以前このツールは `button[title="左（上）へ"]` を押していたが、
//   **その UI は既に存在しない**（`draggable` なカードを掴んで動かす形に変わった）。
//   実装が変わったのに古い操作を試し続けると「壊れている」と誤診する。

const cards = page.locator('[draggable="true"]');
const n = await cards.count();
console.log('入力カード数:', n);
if (n < 2) {
    console.error('NG: 入力が 2 つ未満（フィクスチャを確認）');
    process.exit(1);
}

// 2 番目のカードを 1 番目の位置へドラッグする。
// ⚠ Playwright の dragTo は HTML5 DnD を再現しないことがあるので、
//    DataTransfer を自前で作って dragstart / dragover / drop を送る。
// ⚠ **1 回の evaluate で全部投げない。** `dragstart` が呼ぶ `setDragIdx` は
//   React の状態更新なので**次のレンダーまで反映されない**。同じ同期ブロックで
//   `drop` まで投げると、ハンドラが `dragIdx == null` を見て**何もせず終わる**
//   （「イベントは届いているのに動かない」ように見える）。
//   → dragstart と drop の間で必ず待つ。
await page.evaluate(() => {
    window.__dt = new DataTransfer();
    const el = document.querySelectorAll('[draggable="true"]')[1];
    el.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt })
    );
});
await page.waitForTimeout(300);
await page.evaluate(() => {
    const el = document.querySelectorAll('[draggable="true"]')[0];
    const fire = (type) =>
        el.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__dt })
        );
    fire('dragenter');
    fire('dragover');
    fire('drop');
});
await page.waitForTimeout(800);

const saveBtn = page.getByRole('button', { name: '保存' });
if (!(await saveBtn.isEnabled())) { console.error('NG: 保存が活性にならない'); process.exit(1); }
await saveBtn.click();
await page.getByText('保存しました').waitFor({ timeout: 15000 });
await browser.close();

const after = await readInputs();
console.log('after :', after.map((x) => x.token).join(' , '));
const swapped = before.length >= 2 && after[0].token === before[1].token && after[1].token === before[0].token;
console.log(swapped ? '✓ 入力の並べ替えが永続化' : '✗ 並べ替えが反映されていない');
if (!swapped) process.exit(1);
