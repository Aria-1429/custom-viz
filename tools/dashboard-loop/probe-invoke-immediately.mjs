// `{ invokeImmediately: true }` が実機ホストで効くかを確かめる。
//
//   node probe-invoke-immediately.mjs [dashboard-name]
//
// 検証の要点:
//   README は「Always pass { invokeImmediately: true } to addDataSourcesListener so the
//   callback fires immediately with the current state when registered.」と書いている。
//   → **登録した「その場で」コールバックが1回走るか**を、同期的に測って判定する。
//
//   ⚠ 判定を誤らないための設計:
//     - 「登録直後（同期）」と「その後（非同期）」を分けて数える。
//       ホストが setTimeout(0) 等で遅延して呼ぶ可能性もあるため、両方記録する。
//     - **対照実験**として、オプション無しでも同じことをやる。
//       オプション無しでも即時発火するなら、それは invokeImmediately の効果ではない
//       （＝そもそもホストは常に再送している、という別の事実になる）。
//     - 例外が出ないことは証拠にしない（triggerDrilldown の前例）。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');
assertConfig();
const name = process.argv[2] || 'hack15_probe';

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1500, height: 900 },
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
// サーチが完全に終わった状態で試す（loading:false が「現在値」として存在する状態）
await page.waitForTimeout(22_000);

const vizFrame = page.frames().find((f) => f !== page.mainFrame());
if (!vizFrame) { console.log('✗ viz iframe なし'); await browser.close(); process.exit(1); }

const result = await vizFrame.evaluate(async () => {
    const API = globalThis.DashboardExtensionAPI;
    if (!API) return { err: 'DashboardExtensionAPI が無い' };

    // このホストが公開している API の一覧（事実の記録）
    const apiKeys = Object.keys(API).sort();

    // 1つのリスナーを登録して、同期／非同期それぞれの発火回数を数える
    const probe = (fnName, opts) => {
        const fn = API[fnName];
        if (typeof fn !== 'function') return { fnName, err: '関数が無い' };
        let sync = 0, async_ = 0, firstArg = null;
        let registered = false;
        let threw = null;
        let cleanup = null;
        try {
            cleanup = fn((state) => {
                if (!registered) { sync++; if (firstArg === null) firstArg = state; }
                else { async_++; }
            }, opts);
        } catch (e) {
            threw = String(e);
        }
        registered = true;   // これ以降の発火は「非同期」に数える
        return { fnName, opts: opts ? JSON.stringify(opts) : '(なし)', sync, threw,
                 cleanupType: typeof cleanup,
                 // 実際に値が来たなら、その形も見る（loading の有無で本物か判断できる）
                 got: firstArg ? Object.keys(firstArg).slice(0, 6) : null,
                 loading: firstArg && 'loading' in firstArg ? firstArg.loading : undefined,
                 _handle: cleanup };
    };

    // --- 本題：invokeImmediately あり ---
    const withOpt = [
        probe('addDataSourcesListener', { invokeImmediately: true }),
        probe('addThemeListener', { invokeImmediately: true }),
        probe('addOptionsListener', { invokeImmediately: true }),
        probe('addTokensListener', { invokeImmediately: true }),
        probe('addModeListener', { invokeImmediately: true }),
        probe('addDimensionsListener', { invokeImmediately: true }),
    ];
    // --- 対照実験：オプション無し ---
    const without = [
        probe('addDataSourcesListener', undefined),
        probe('addThemeListener', undefined),
    ];

    // 非同期の発火も拾うため少し待つ
    await new Promise((r) => setTimeout(r, 1500));

    const strip = (r) => { const { _handle, ...rest } = r; return rest; };
    return { apiKeys, withOpt: withOpt.map(strip), without: without.map(strip) };
});

console.log('=== ホストが公開している API ===');
console.log((result.apiKeys || []).join(', '));

console.log('\n=== invokeImmediately: true あり ===');
for (const r of result.withOpt || []) {
    console.log(`  ${r.fnName.padEnd(26)} 同期発火=${r.sync}  loading=${r.loading}  keys=${JSON.stringify(r.got)}  ${r.threw ? 'threw=' + r.threw : ''}`);
}
console.log('\n=== 対照：オプション無し ===');
for (const r of result.without || []) {
    console.log(`  ${r.fnName.padEnd(26)} 同期発火=${r.sync}  ${r.threw ? 'threw=' + r.threw : ''}`);
}

const ds = (result.withOpt || []).find((r) => r.fnName === 'addDataSourcesListener');
const dsNo = (result.without || []).find((r) => r.fnName === 'addDataSourcesListener');
console.log('\n================ 判定 ================');
if (!ds) console.log('判定不能');
else if (ds.sync > 0 && dsNo && dsNo.sync === 0)
    console.log('✓ invokeImmediately は効く（オプション有りだけ即時発火）→ ポーリング置換の可能性あり');
else if (ds.sync > 0 && dsNo && dsNo.sync > 0)
    console.log('△ オプション無しでも即時発火する＝ホストは常に再送している（別の事実）');
else
    console.log('✗ 即時発火しない＝README にあるが実装されていない（不成立）');
console.log('======================================');

await browser.close();
