// `setError` / `clearError` が実機で何をするかを確かめる。
//
//   node probe-seterror.mjs [dashboard-name] [出力先プレフィックス]
//
// 確かめること:
//   A. setError('...') を呼ぶと画面に何が出るか（撮って目で見る）
//   B. viz 自身の描画は残るのか、置き換わるのか
//   C. clearError() で元に戻るのか
//   D. addErrorListener / getError に値が入るか（状態として観測できるか）
//   E. 空文字・長文・HTML っぽい文字列の扱い
//
// ⚠ 判定は「例外が出ないこと」ではなく **画面と getError の値** で行う。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');
assertConfig();
const name = process.argv[2] || 'hack15_probe';
const OUT = process.argv[3] || '/tmp/seterror';

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 1500, height: 900 },
    ...(existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}),
});
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${config.app}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(22_000);

const vf = page.frames().find((f) => f !== page.mainFrame());
if (!vf) { console.log('✗ viz iframe なし'); await browser.close(); process.exit(1); }

// viz パネルの見た目を要約する（何が描かれているか）
const describePanel = async (label) => {
    const inner = await vf.evaluate(() => {
        const body = document.body;
        return {
            text: (body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
            svgCount: document.querySelectorAll('svg').length,
            html: (body.innerHTML || '').length,
        };
    }).catch((e) => ({ err: String(e) }));
    // 親ページ側（パネル枠）に何か出ていないかも見る
    const outer = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-test="viz-item"], [role="alert"], [data-test*="error"], [data-test*="message"]')) {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t) out.push(t.slice(0, 160));
        }
        return [...new Set(out)];
    });
    console.log(`\n--- ${label} ---`);
    console.log('  iframe内:', JSON.stringify(inner));
    outer.forEach((o) => console.log('  親パネル:', o));
    await page.screenshot({ path: `${OUT}_${label}.png` });
    return { inner, outer };
};

const call = async (fn, arg) => await vf.evaluate(({ fn, arg }) => {
    const API = globalThis.DashboardExtensionAPI;
    let threw = null;
    try { arg === undefined ? API[fn]() : API[fn](arg); } catch (e) { threw = String(e); }
    let got = null;
    try { got = API.getError ? API.getError() : null; } catch (e) { got = { err: String(e) }; }
    return { threw, getError: got };
}, { fn, arg });

await describePanel('0_before');

// --- A/B: setError を呼ぶ ---
console.log('\n=== setError("検証用のエラーメッセージです") ===');
console.log(JSON.stringify(await call('setError', '検証用のエラーメッセージです')));
await page.waitForTimeout(3000);
await describePanel('1_after_setError');

// --- C: clearError で戻るか ---
console.log('\n=== clearError() ===');
console.log(JSON.stringify(await call('clearError')));
await page.waitForTimeout(3000);
await describePanel('2_after_clearError');

// --- E: 空文字 ---
console.log('\n=== setError("") ===');
console.log(JSON.stringify(await call('setError', '')));
await page.waitForTimeout(2000);
await describePanel('3_empty');

// --- E: 長文 ---
console.log('\n=== setError(長文200文字) ===');
console.log(JSON.stringify(await call('setError', 'あ'.repeat(200))));
await page.waitForTimeout(2000);
await describePanel('4_long');

// --- E: HTML っぽい文字列（エスケープされるか） ---
console.log('\n=== setError("<b>bold</b><img src=x onerror=alert(1)>") ===');
console.log(JSON.stringify(await call('setError', '<b>bold</b><img src=x onerror=alert(1)>')));
await page.waitForTimeout(2000);
const htmlCase = await describePanel('5_html');
const escaped = await vf.evaluate(() => document.body.innerHTML.includes('&lt;b&gt;')
    || !document.body.innerHTML.includes('<b>bold</b>')).catch(() => null);
console.log('  → HTML はエスケープされているか:', escaped);

// 後片付け
await call('clearError');

await browser.close();
