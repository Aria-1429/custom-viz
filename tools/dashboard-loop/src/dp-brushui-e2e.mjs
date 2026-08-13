// ── 編集パネルの「グラフの画材」E2E ─────────────────────────────
//
//   node src/dp-brushui-e2e.mjs <app> <view> [出力PNG]
//
// 検証すること:
//   1. デザインセクションに「グラフの画材」がある
//   2. 選ぶと**実際に描画が変わる**（filter が適用される）
//   3. 選ぶと「画材の強さ」が出る（flat では出ない）
//   4. 保存すると定義に `style.brush` が入る
//   5. Ctrl+Z 一発で戻る
//
// ⚠ **「UI に出た」で終わらせない。** 描画と定義の両方を見る
//   （選べるが効かない、という状態がありうる）。
// ────────────────────────────────────────────────────────────────

import https from 'node:https';

import { chromium } from 'playwright';

import { assertConfig, config, mgmtBase, webBase } from './config.mjs';

const [, , app, view, out = '/tmp/dp-brushui.png'] = process.argv;
if (!app || !view) {
    console.error('usage: dp-brushui-e2e.mjs <app> <view> [out.png]');
    process.exit(1);
}
assertConfig();

let ng = 0;
const ok = (c, m) => {
    console.log(c ? `✓ ${m}` : `✗ ${m}`);
    if (!c) ng += 1;
};

const readDef = () =>
    new Promise((resolve, reject) => {
        const u = new URL(`${mgmtBase()}/servicesNS/-/${app}/data/ui/views/${view}?output_mode=json`);
        https
            .get(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname + u.search,
                    rejectUnauthorized: false,
                    headers: {
                        Authorization:
                            'Basic ' + Buffer.from(`${config.user}:${config.pass}`).toString('base64'),
                    },
                },
                (r) => {
                    let b = '';
                    r.on('data', (c) => (b += c));
                    r.on('end', () => {
                        const eai = JSON.parse(b).entry[0].content['eai:data'];
                        const m = eai.match(/<definition><!\[CDATA\[([\s\S]*?)\]\]><\/definition>/);
                        resolve(JSON.parse(m[1]));
                    });
                }
            )
            .on('error', reject);
    });

const before = await readDef();
console.log(`before: brush=${before.style?.brush ?? '(未設定)'}`);

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
await page.waitForTimeout(15_000);

const saveBtn = page.getByRole('button', { name: '保存', exact: true });
const saveEnabled = async () => !(await saveBtn.isDisabled().catch(() => true));

// 適用されているフィルタ数（描画が変わった証拠）
const filterCount = () =>
    page.evaluate(() => {
        let n = 0;
        document.querySelectorAll('[data-panel-id] *').forEach((e) => {
            const f = getComputedStyle(e).filter;
            if (f && f.includes('url(')) n += 1;
        });
        return n;
    });

// ── 1. UI があるか ─────────────────────────────────────────────
const label = page.getByText('グラフの画材', { exact: true });
ok((await label.count()) > 0, 'デザインに「グラフの画材」がある');
ok(
    (await page.getByText('画材の強さ', { exact: false }).count()) === 0,
    'flat では「画材の強さ」を出さない'
);

const baseFilters = await filterCount();
console.log(`  filter 適用数（変更前）: ${baseFilters}`);

// ── 2. 画材を選ぶ ──────────────────────────────────────────────
// ⚠ DPX の Select は**自前実装**。トリガーは `button.dpx-btn` で、
//   **現在の選択ラベルを表示している**。ラベル文字で掴むのが一番確実
//   （DOM 構造をたどると入れ子が変わるたびに落ちる）。
const brushSelect = page.locator('button.dpx-btn').filter({ hasText: 'なし（通常）' }).first();
await brushSelect.scrollIntoViewIfNeeded();
await brushSelect.click();
await page.waitForTimeout(500);
await page.getByText('水彩', { exact: true }).first().click();
await page.waitForTimeout(1500);

const afterFilters = await filterCount();
console.log(`  filter 適用数（水彩）: ${afterFilters}`);
ok(afterFilters > baseFilters, `⭐ 選ぶと描画が変わる（filter ${baseFilters} → ${afterFilters}）`);
ok(
    (await page.getByText('画材の強さ', { exact: false }).count()) > 0,
    '⭐ 画材を選ぶと「画材の強さ」が出る'
);
ok(await saveEnabled(), '変更したので保存ボタンが押せる');

await page.screenshot({ path: out });

// ── 3. 保存 → 定義に入るか ─────────────────────────────────────
await saveBtn.click();
await page.getByText('保存しました').waitFor({ timeout: 15_000 });
await page.waitForTimeout(800);

const saved = await readDef();
console.log(`after : brush=${saved.style?.brush ?? '(未設定)'}`);
ok(saved.style?.brush === 'watercolor', '⭐ 保存すると定義に style.brush が入る');

// ── 4. Ctrl+Z ──────────────────────────────────────────────────
await page.mouse.click(8, 300);
await page.waitForTimeout(300);
await page.keyboard.press('Control+z');
await page.waitForTimeout(1200);
const undone = await filterCount();
ok(undone <= baseFilters, `⭐ Ctrl+Z で描画が戻る（filter ${afterFilters} → ${undone}）`);

await browser.close();
console.log(`\nスクリーンショット: ${out}`);
console.log(ng === 0 ? '\n全て成功' : `\n${ng} 件失敗`);
process.exit(ng > 0 ? 1 : 0);
