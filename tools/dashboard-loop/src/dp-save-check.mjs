// DPX の編集→保存フローの実機検証。
//   1. <view>?mode=edit を開く
//   2. ダッシュボード説明欄にテキストを入力（onDefinitionChange が発火するはず）
//   3. 「保存」を押して「保存しました」を待つ
//   4. REST で定義を読み直し、説明が永続化されたか確認する
//
// 使い方: node src/dp-save-check.mjs <app> <view> <説明テキスト>

import https from 'node:https';
import { chromium } from 'playwright';
import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view, marker] = process.argv;
if (!app || !view || !marker) {
    console.error('usage: dp-save-check.mjs <app> <view> <marker-text>');
    process.exit(1);
}
assertConfig();

function restGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        https
            .get(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname + u.search,
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: `Basic ${Buffer.from(`${config.user}:${config.pass}`).toString('base64')}`,
                    },
                },
                (r) => {
                    let b = '';
                    r.on('data', (c) => (b += c));
                    r.on('end', () => resolve({ status: r.statusCode, body: b }));
                }
            )
            .on('error', reject);
    });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

// ログイン
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);

// 編集モードで開く
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
});
await page.waitForTimeout(8000); // Dashboard の初期化を待つ

// 説明欄に入力。
// ⚠ **DPX の入力欄は自前コンポーネント（`.dpx-input`）で、`aria-label` を持たない。**
//   旧実装は Studio 時代の `aria-label*="description"` を探していたため
//   **常に「見つかりません」で失敗していた**（2026-08-13 に判明。DPX 側の不具合ではない）。
//   インスペクタは「タイトル」「説明」の順に並ぶので、ラベルから辿る。
const descLabel = page.locator('div', { hasText: /^説明$/ }).last();
let desc = page.locator('input.dpx-input').nth(1); // 0=タイトル / 1=説明
if ((await desc.count()) === 0) {
    console.error('NG: 説明欄が見つかりません（インスペクタが開いていない可能性）');
    await page.screenshot({ path: '/tmp/dp-save-check-fail.png' });
    await browser.close();
    process.exit(1);
}
console.log(
    'desc 要素:',
    await desc.evaluate((el) => `${el.tagName} class=${el.className} placeholder=${el.getAttribute('placeholder')}`)
);
// ⚠ **DPX の TextInput は打鍵では反映されない**（blur / Enter で確定する設計）。
//   `fill()` だけだと DOM の value は入るのに保存ボタンが活性にならず、
//   「実装のバグ」に見える。**Tab で blur させるまでが 1 操作**。
await desc.click();
await page.keyboard.press('Control+a');
await desc.type(marker);
await page.keyboard.press('Tab');
await page.waitForTimeout(2000);

// 保存
const saveBtn = page.getByRole('button', { name: '保存' });
const enabled = await saveBtn.isEnabled().catch(() => false);
console.log(`保存ボタン活性: ${enabled}`);
if (!enabled) {
    console.error('NG: 入力しても保存ボタンが活性になりません（onDefinitionChange 不発の疑い）');
    await page.screenshot({ path: '/tmp/dp-save-check-fail.png' });
    await browser.close();
    process.exit(1);
}
await saveBtn.click();
try {
    await page.getByText('保存しました').waitFor({ timeout: 15_000 });
} catch (err) {
    await page.screenshot({ path: '/tmp/dp-save-check-fail.png' });
    console.error('NG: 「保存しました」が出ません（/tmp/dp-save-check-fail.png 参照）');
    await browser.close();
    process.exit(1);
}
console.log('UI: 保存しました を確認');
await browser.close();

// REST で永続化確認
const res = await restGet(
    `${mgmtBase()}/servicesNS/-/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(view)}?output_mode=json`
);
const eai = JSON.parse(res.body).entry[0].content['eai:data'];
const m = eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/);
const def = m ? JSON.parse(m[1]) : null;
if (def && def.description === marker) {
    console.log(`OK: 定義の description に "${marker}" が永続化されている`);
} else {
    console.error(`NG: description = ${JSON.stringify(def?.description)}`);
    process.exit(1);
}
