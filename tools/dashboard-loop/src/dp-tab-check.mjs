// DPX タブ自動送りの E2E 検証：表示モードで開き、タブが自動で切り替わるか見る。
// 使い方: node src/dp-tab-check.mjs <app> <view> <出力prefix>
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, prefix] = process.argv;
assertConfig();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1200);
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

// 現在のタブは「DETAIL VIEW」テキストの有無で判定（詳細タブ専用の装飾テキスト）
const isDetail = async () => (await page.getByText('DETAIL VIEW', { exact: true }).count()) > 0;
console.log('初期タブ = ' + ((await isDetail()) ? '詳細' : '概況'));
await page.screenshot({ path: `${prefix}_tab1.png` });

// ⚠ 初回の切替は「ページ表示から intervalSec 後」なので、計測開始時点が
//   描画直後だと短く見える。1 回目の切替を待ってから 2 回目までを測る。
const waitSwitch = async (from, limitMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < limitMs) {
        await page.waitForTimeout(500);
        if ((await isDetail()) !== from) return (Date.now() - t0) / 1000;
    }
    return null;
};
const first = await isDetail();
const s1 = await waitSwitch(first, 30000);
if (s1 === null) {
    console.log('NG: 自動切替しなかった');
} else {
    const s2 = await waitSwitch(!first, 30000);
    console.log(s2 === null ? 'NG: 2回目の切替が来なかった' : `OK: 自動切替の間隔 = ${s2.toFixed(1)}秒`);
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${prefix}_tab2.png` });
await browser.close();
