// 区画（グループ）まわりを**拡大して撮る**ための検証ツール。
//   node src/dp-zoom.mjs <app> <view> [mode]
//
// ⚠ 意匠の粗（罫の途切れ・見出しの重なり・パネル枠との衝突）は
//   **全画面のスクリーンショットでは見えない**。実際、1600x1000 の全体像では
//   「直った」ように見えた重なりが、拡大すると残っていた（2026-08-12）。
//   deviceScaleFactor=2 ＋ clip で該当箇所だけを切り出す。
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, mode = 'view'] = process.argv;
if (!app || !view) {
    console.error('usage: dp-zoom.mjs <app> <view> [view|edit]');
    process.exit(1);
}
assertConfig();
const OUT = process.env.DPX_SHOT_DIR || '/tmp';

const browser = await chromium.launch();
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
});
const page = await ctx.newPage();

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('input[name="username"]').first().fill(config.user);
const pass = page.locator('input[name="password"]').first();
await pass.fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    pass.press('Enter'),
]);

const url = `${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}${mode === 'edit' ? '&mode=edit' : ''}`;
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15_000);

// 区画ごとに「左上（見出しと罫の始まり）」「右上（罫の終わり）」「下辺」を撮る
const groups = page.locator('[data-group-id]');
const n = await groups.count();
console.log(`区画: ${n} 件`);

for (let i = 0; i < n; i++) {
    const g = groups.nth(i);
    const id = await g.getAttribute('data-group-id');
    const b = await g.boundingBox();
    if (!b) continue;
    console.log(`${id}: x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)}`);

    const clip = (x, y, w, h) => ({
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: Math.min(w, 1600 - Math.max(0, x)),
        height: Math.min(h, 1000 - Math.max(0, y)),
    });
    // 左上：見出しと罫の始まり
    await page.screenshot({ path: `${OUT}/zoom-${id}-TL.png`, clip: clip(b.x - 20, b.y - 30, 420, 130) });
    // 右上：罫の終わりと隣接パネル
    await page.screenshot({
        path: `${OUT}/zoom-${id}-TR.png`,
        clip: clip(b.x + b.width - 400, b.y - 30, 420, 130),
    });
    // 下辺：区画の終わりと次のパネルの境目
    await page.screenshot({
        path: `${OUT}/zoom-${id}-BL.png`,
        clip: clip(b.x - 20, b.y + b.height - 60, 420, 130),
    });
}

await browser.close();
console.log('ok');
