// 追試：invokeImmediately が「①シード→②購読の隙間」を本当に塞ぐか。
//
//   node probe-invoke-immediately2.mjs [dashboard-name]
//
// 前の probe は「完了済みの状態で登録したら即時発火する」ことを示した。
// だが永久スピナーの本質は「**隙間の間に loading:false が届き、以後もう来ない**」こと。
// そこで実際の事故を再現して、invokeImmediately が救えるかを見る:
//
//   シナリオ: リスナー登録を「完了通知が過ぎ去った後」に行う（＝通知を取り逃した状態）。
//     - オプション無し     … 何も来ない（＝loading:true のまま固まる＝永久スピナー）
//     - invokeImmediately … 登録時に現在値(loading:false)が来る（＝救われる）
//
// さらに、公式フックの実装（options を渡さない）が本当にこの穴を持つかも確認する。
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

const out = await vf.evaluate(async () => {
    const API = globalThis.DashboardExtensionAPI;
    const res = {};

    // --- 1. 事故の再現：完了通知を取り逃した後に登録する ---
    // （今この瞬間、サーチは完了済み。つまり「最終通知は過去に流れた」状態）
    const cur = API.getDataSources();
    res.現在値 = { loading: cur.loading, keys: Object.keys(cur.dataSources || {}) };

    const late = (opts) => new Promise((resolve) => {
        let fired = 0, got = null;
        const cleanup = API.addDataSourcesListener((s) => { fired++; if (!got) got = s; }, opts);
        // 2秒待って「もう来ない」ことを確認する
        setTimeout(() => {
            try { if (typeof cleanup === 'function') cleanup(); } catch (e) {}
            resolve({ fired, loading: got ? got.loading : undefined });
        }, 2000);
    });

    res.取り逃し後_オプション無し = await late(undefined);
    res.取り逃し後_invokeImmediately = await late({ invokeImmediately: true });

    // --- 2. 公式フックと同じ呼び方（options を渡さない）で同じ穴が開くか ---
    //     createVisualizationListenerHook は listenerFunction(cb) としか呼ばない
    res.公式フック相当 = await late(undefined);

    // --- 3. cleanup 関数が返るか（購読解除できるか＝リーク対策の可否） ---
    const c = API.addDataSourcesListener(() => {}, { invokeImmediately: true });
    res.cleanupの型 = typeof c;
    try { if (typeof c === 'function') c(); } catch (e) { res.cleanupエラー = String(e); }

    // --- 4. AbortSignal（ListenerOptions のもう1つのフィールド）も効くか ---
    try {
        const ac = new AbortController();
        let n = 0;
        API.addDataSourcesListener(() => { n++; }, { invokeImmediately: true, signal: ac.signal });
        const afterRegister = n;
        ac.abort();
        res.signal = { 登録時発火: afterRegister, abort例外なし: true };
    } catch (e) {
        res.signal = { err: String(e) };
    }

    return res;
});

console.log(JSON.stringify(out, null, 1));

console.log('\n================ 判定 ================');
const no = out.取り逃し後_オプション無し, yes = out.取り逃し後_invokeImmediately;
if (no && yes) {
    console.log(`通知を取り逃した後に登録した場合:`);
    console.log(`  オプション無し     : ${no.fired} 回発火 ${no.fired === 0 ? '← 永久スピナーの正体' : ''}`);
    console.log(`  invokeImmediately : ${yes.fired} 回発火 (loading=${yes.loading}) ${yes.fired > 0 && yes.loading === false ? '← 救済成立' : ''}`);
    if (no.fired === 0 && yes.fired > 0 && yes.loading === false)
        console.log('\n✓ invokeImmediately は隙間を塞ぐ。ポーリングの代替になる。');
    else console.log('\n△ 期待どおりでない。詳細を読むこと。');
}
console.log('======================================');

await browser.close();
