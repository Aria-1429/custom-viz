// 6つ目：loading:true の最中に登録して、完了通知まで受け取れるかを確実に測る。
//
//   node probe-invoke-immediately6.mjs
//
// これまで追加イベントを観測できなかったのは、登録時点で既にサーチが完了していたから。
// そこで **ページ読み込み直後（サーチ実行中）に割り込んで登録**する。
//   - iframe が現れた瞬間にリスナーを張る（addInitScript ではなく短いポーリングで捕まえる）
//   - loading:true を1回でも観測できれば「進行中に張れた」証拠
//   - その後 loading:false が同じリスナーに来れば「購読は継続している」＝置き換え安全
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');
assertConfig();
const name = process.argv[2] || 'hack11_probe';

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

// キャッシュに当たらない時間範囲を毎回作る（秒単位でずらす）
const uniq = `-${30 + (Date.now() % 47)}m@m`;
const url = `${webBase()}/en-US/app/${config.app}/${name}`
          + `?form.global_time.earliest=${encodeURIComponent(uniq)}&form.global_time.latest=now`;
console.log('開く URL の時間範囲:', uniq, '(ジョブキャッシュを避けるため毎回変える)');
await page.goto(url, { waitUntil: 'domcontentloaded' });

// iframe が出た瞬間を狙って、できるだけ早くリスナーを張る
let attached = false;
for (let i = 0; i < 200 && !attached; i++) {
    const f = page.frames().find((fr) => fr !== page.mainFrame());
    if (f) {
        try {
            const ok = await f.evaluate(() => {
                const API = globalThis.DashboardExtensionAPI;
                if (!API || globalThis.__attached) return false;
                globalThis.__attached = true;
                globalThis.__t0 = performance.now();
                globalThis.__L1 = [];
                globalThis.__L2 = [];
                API.addDataSourcesListener((s) => {
                    globalThis.__L1.push({ dt: Math.round(performance.now() - globalThis.__t0), loading: s.loading });
                }, { invokeImmediately: true });
                API.addDataSourcesListener((s) => {
                    globalThis.__L2.push({ dt: Math.round(performance.now() - globalThis.__t0), loading: s.loading });
                });
                return true;
            });
            if (ok) { attached = true; console.log(`リスナー登録成功（試行 ${i + 1} 回目）`); }
        } catch (e) { /* frame 入れ替わり中。次のループで再試行 */ }
    }
    if (!attached) await page.waitForTimeout(100);
}
if (!attached) { console.log('✗ リスナーを張れなかった'); await browser.close(); process.exit(1); }

// サーチ完了まで十分待つ
await page.waitForTimeout(30_000);

const res = await page.frames().find((f) => f !== page.mainFrame())
    .evaluate(() => ({ L1: globalThis.__L1 || [], L2: globalThis.__L2 || [] }))
    .catch(() => ({ L1: null, L2: null, err: 'frame が入れ替わった' }));

console.log('\n=== L1 (invokeImmediately: true) ===');
console.log(JSON.stringify(res.L1));
console.log('=== L2 (オプション無し) ===');
console.log(JSON.stringify(res.L2));

const l1 = res.L1 || [], l2 = res.L2 || [];
const l1Late = l1.filter((e) => e.dt > 100);
console.log('\n================ 判定 ================');
console.log(`L1: 即時発火=${l1.some((e) => e.dt <= 100) ? 'あり' : 'なし'} / 登録後の発火=${l1Late.length} 件`);
console.log(`L2: 発火=${l2.length} 件`);
if (l1Late.length > 0 || l1.length > 1)
    console.log('→ ✓ 即時発火のあとも購読は継続（one-shot ではない）。置き換えは安全。');
else if (l2.length > 0)
    console.log('→ ⚠ L2 だけ発火。invokeImmediately が one-shot の疑い。置き換えは危険。');
else
    console.log('→ 判定不能（どちらも追加発火なし＝登録時点で既に完了していた可能性）');
console.log('======================================');

await browser.close();
