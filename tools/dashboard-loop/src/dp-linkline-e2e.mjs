// コネクタ線（dpx.linkLine）の**編集モードでのドラッグ編集**が
// 定義に永続化されるかを E2E で確かめる。
//   node src/dp-linkline-e2e.mjs <app> <view> <panelId>
//
// Studio 拡張（link-line）では編集モード中にドラッグできなかった。
// DPX でそれが可能になったことを「実際に掴んで動かして REST で読む」ところまでやる。
import https from 'node:https';
import { chromium } from 'playwright';
import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view, panelId] = process.argv;
if (!app || !view || !panelId) {
    console.error('usage: dp-linkline-e2e.mjs <app> <view> <panelId>');
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

async function readPoints() {
    const res = await restGet(
        `${mgmtBase()}/servicesNS/-/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(view)}?output_mode=json`
    );
    const eai = JSON.parse(res.body).entry[0].content['eai:data'];
    const m = eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/);
    const def = m ? JSON.parse(m[1]) : null;
    const p = (def?.panels ?? []).find((x) => x.id === panelId);
    return p?.options?.points ?? null;
}

const before = await readPoints();
console.log('編集前の points:', JSON.stringify(before));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
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

// ★ 編集モードで開く
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}&mode=edit`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(14_000);

// 対象パネルのハンドル（円）を探す。編集モードでは既定でハンドルが出ている
const handles = page.locator(`[data-panel-id="${panelId}"] circle[style*="grab"]`);
let count = await handles.count();
if (count === 0) {
    // data-panel-id が無い実装なら、全 circle から grab カーソルのものを拾う
    const all = page.locator('circle[style*="grab"]');
    count = await all.count();
    console.log(`（パネル限定セレクタで 0 件。ページ全体の grab ハンドル: ${count} 件）`);
    if (count === 0) {
        await page.screenshot({ path: '/tmp/dp-linkline-e2e-fail.png' });
        console.error('NG: 編集モードでハンドルが見つかりません（/tmp/dp-linkline-e2e-fail.png）');
        await browser.close();
        process.exit(1);
    }
}
console.log(`編集モードのハンドル数: ${count}`);

const target = (await handles.count()) > 0 ? handles.first() : page.locator('circle[style*="grab"]').first();
// ⚠ 画面外の要素を掴もうとしても mouse.move は当たらない（ビューポート座標なので、
//   y がビューポート高を超えていると別の場所を押すことになる）。先に見える位置へ送る。
await target.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
const box = await target.boundingBox();
if (!box) {
    console.error('NG: ハンドルの矩形が取れません');
    await browser.close();
    process.exit(1);
}
const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const to = { x: from.x + 60, y: from.y + 45 };
console.log(`ドラッグ: (${Math.round(from.x)},${Math.round(from.y)}) → (${Math.round(to.x)},${Math.round(to.y)})`);

await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x - 20, to.y - 15, { steps: 8 });
await page.mouse.move(to.x, to.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(1200);

// 保存ボタンが活性化しているか（＝定義が変わったと DPX が認識したか）
const saveBtn = page.getByRole('button', { name: '保存' }).first();
const enabled = await saveBtn.isEnabled().catch(() => false);
console.log(`保存ボタン活性: ${enabled}`);
if (!enabled) {
    await page.screenshot({ path: '/tmp/dp-linkline-e2e-fail.png' });
    console.error('NG: ドラッグしても保存ボタンが活性になりません（定義に反映されていない）');
    await browser.close();
    process.exit(1);
}

await saveBtn.click();
try {
    await page.getByText('保存しました').waitFor({ timeout: 15_000 });
    console.log('UI: 保存しました');
} catch {
    await page.screenshot({ path: '/tmp/dp-linkline-e2e-fail.png' });
    console.error('NG: 「保存しました」が出ません');
    await browser.close();
    process.exit(1);
}
await page.screenshot({ path: '/tmp/dp-linkline-e2e-after.png' });
await browser.close();

const after = await readPoints();
console.log('編集後の points:', JSON.stringify(after));

if (!after) {
    console.error('NG: points が定義に保存されていません');
    process.exit(1);
}
if (JSON.stringify(after) === JSON.stringify(before)) {
    console.error('NG: points が変化していません（ドラッグが効いていない）');
    process.exit(1);
}
console.log('✓ OK: 編集モードのドラッグが定義に永続化された');
