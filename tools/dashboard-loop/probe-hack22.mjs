// ハック22：「サーチ結果 → トークン」（Simple XML の <done><set> 相当）が成立するかを確かめる。
//
//   node probe-hack22.mjs [dashboard-name] [出力先プレフィックス]
//
// 新しい viz を作らずに、既存 vu-console の中で **センサーの中核ロジックを再現**して検証する:
//   1. useDataSources 相当（getDataSources）でデータ到着を検知
//   2. 前回値と比較し、**変化したときだけ** 合成クリックを撃つ（無限ループ防止）
//   3. トークンが「サーチ結果の値」で更新されることを echo パネルで確認
//
// これが通れば「1px の不可視 viz にこのロジックを入れる」だけで
// ハック22 は完成する（＝残りは viz の外見の問題だけ）。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');
assertConfig();
const name = process.argv[2] || 'hack15_probe';
const OUT = process.argv[3] || '/tmp/h22';

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
    await page.click('button[type="submit"], input[type="submit"]').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${config.app}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(22_000);

const readEcho = async () => await page.evaluate(() => {
    for (const t of document.querySelectorAll('table')) {
        const txt = t.innerText.replace(/\s+/g, ' ').trim();
        if (txt.startsWith('sel json_tok')) {
            const m = txt.match(/sel json_tok _time (\S+) (\S+)/);
            return m ? `${m[1]}/${m[2]}` : txt.slice(0, 80);
        }
    }
    return '(なし)';
});

const vf = page.frames().find((f) => f !== page.mainFrame());
console.log('初期のトークン:', await readEcho());

// --- センサーの中核ロジックを iframe 内に仕込む ---
const install = await vf.evaluate(() => {
    const API = globalThis.DashboardExtensionAPI;
    if (!API) return { err: 'API 無し' };

    globalThis.__sensor = { fired: 0, log: [], lastKey: null };

    // 「最悪値の行」を選ぶ（ここでは値が最大のメーター）
    const pickWorst = () => {
        const ds = API.getDataSources();
        if (!ds || ds.loading) return null;
        const d = ds.dataSources?.primary?.data;
        if (!d || !d.fields || !d.columns) return null;
        const names = d.fields.map((f) => f?.name || f);
        let best = null;
        names.forEach((n, i) => {
            const v = Number(d.columns[i]?.[0]);
            if (!Number.isFinite(v)) return;
            if (!best || v > best.value) best = { name: n, value: v, index: i };
        });
        return best;
    };

    // 対応するメーターの DOM を探して合成クリックを撃つ
    const fireFor = (idx) => {
        const svgs = [...document.querySelectorAll('svg')]
            .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 150 && r.height > 80; });
        const t = svgs[idx];
        if (!t) return false;
        const r = t.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) || t;
        hit.dispatchEvent(new Event('click', { bubbles: true }));
        return true;
    };

    // データ到着で発火。⚠ 前回と同じなら撃たない（無限ループ防止）
    const tick = () => {
        const worst = pickWorst();
        if (!worst) return;
        const key = `${worst.name}=${worst.value}`;
        if (key === globalThis.__sensor.lastKey) return;   // ← ガード
        globalThis.__sensor.lastKey = key;
        const ok = fireFor(worst.index);
        globalThis.__sensor.fired++;
        globalThis.__sensor.log.push({ key, fired: ok });
    };

    // 購読（invokeImmediately で登録時にも1回走らせる＝先に確定済みの知見を活用）
    API.addDataSourcesListener(() => tick(), { invokeImmediately: true });
    return { ok: true };
});
console.log('センサー設置:', JSON.stringify(install));

await page.waitForTimeout(8000);
const state1 = await vf.evaluate(() => globalThis.__sensor);
console.log('\n=== 1回目（データ到着時に自動発火） ===');
console.log('発火回数:', state1.fired, JSON.stringify(state1.log));
console.log('トークン:', await readEcho());
await page.screenshot({ path: `${OUT}_1.png` });

// --- 無限ループしないことを確認する（同じデータのまま放置） ---
await page.waitForTimeout(12_000);
const state2 = await vf.evaluate(() => globalThis.__sensor);
console.log('\n=== 12秒放置後（ガードが効いているか） ===');
console.log('発火回数:', state2.fired, '（1回目から増えていなければガードOK）');

console.log('\n================ 判定 ================');
const tok = await readEcho();
console.log(`発火: ${state1.fired > 0 ? '✓' : '✗'} / 暴走なし: ${state2.fired === state1.fired ? '✓' : '✗ ' + state2.fired + '回に増えた'}`);
console.log(`トークン: ${tok}`);
console.log(state1.fired > 0 && state2.fired === state1.fired && tok !== 'init/init'
    ? '✓ ハック22 成立（サーチ結果 → 無人でトークン設定、暴走なし）'
    : '△ 要確認');
console.log('======================================');

await browser.close();
