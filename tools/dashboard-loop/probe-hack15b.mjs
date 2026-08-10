// ハック15 本番：合成クリックでトークンが入るかを、実マウスクリックと比較して判定する。
//
//   node probe-hack15b.mjs [dashboard-name]
//
// 判定基準（厳格）:
//   - 実マウスクリック → echo が変わる … これが「土俵に乗っている」ことの確認（対照実験）
//   - 合成クリック     → echo が変わる … ハック15 成立
//   例外が出ないことは証拠にならない（triggerDrilldown の前例）。echo の値だけを見る。
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
await page.waitForTimeout(18_000);

// echo テーブルから「sel / json_tok」の行だけを読む
const readEcho = async () => {
    return await page.evaluate(() => {
        for (const t of document.querySelectorAll('table')) {
            const txt = t.innerText.replace(/\s+/g, ' ').trim();
            if (txt.startsWith('sel json_tok')) return txt.slice(0, 160);
        }
        return '(echo テーブルが見つからない)';
    });
};

const vizFrame = page.frames().find((f) => f !== page.mainFrame());
if (!vizFrame) { console.log('✗ viz iframe なし'); await browser.close(); process.exit(1); }

const base = await readEcho();
console.log(`初期:            ${base}`);

// ---------------------------------------------------------------
// STEP 1: 実マウスクリック（対照実験）
//   iframe 内のメーター中心をページ座標に直して、本物のマウスで押す
// ---------------------------------------------------------------
const frameEl = await vizFrame.frameElement();
const fbox = await frameEl.boundingBox();

// メーター（cpu = 左端）の中心付近を iframe 内座標で取得
const meterRects = await vizFrame.evaluate(() => {
    // 各メーターは svg。幅 200px 超のものを拾う
    return [...document.querySelectorAll('svg')]
        .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
        .filter((r) => r.w > 150 && r.h > 80);
});
console.log(`メーター候補: ${meterRects.length} 個`);
if (!meterRects.length) { console.log('✗ メーターが見つからない'); await browser.close(); process.exit(1); }

const m0 = meterRects[0];
const clickX = fbox.x + m0.x + m0.w / 2;
const clickY = fbox.y + m0.y + m0.h / 2;
console.log(`実クリック座標: (${Math.round(clickX)}, ${Math.round(clickY)})`);

await page.mouse.click(clickX, clickY);
await page.waitForTimeout(6000);
const afterReal = await readEcho();
console.log(`実クリック後:    ${afterReal}`);
const realWorked = afterReal !== base;
console.log(realWorked ? '  → ✓ 実クリックでトークンが変わった（土俵に乗っている）'
                       : '  → ✗ 実クリックでも変わらない（この時点で対照実験が失敗＝以降は無意味）');

// ---------------------------------------------------------------
// STEP 2: 合成クリック（本題）
//   別のメーター（2番目）に dispatchEvent でクリックを撃つ。
//   実クリックとは別のノードを狙うことで「値が変わったか」を区別できる。
// ---------------------------------------------------------------
const dispatchResult = await vizFrame.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height > 80; });
    if (svgs.length < 2) return { err: 'メーターが2個未満' };

    const target = svgs[1];   // 2番目（mem）を狙う
    const r = target.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;

    // 実際にイベントを受け取るのは登録されたノード。バブリングするので
    // 最深部の要素から撃つ（elementFromPoint で実クリックと同じ経路にする）
    const hit = document.elementFromPoint(cx, cy) || target;

    const log = [];
    const mk = (type) => new MouseEvent(type, {
        view: window, bubbles: true, cancelable: true,
        clientX: cx, clientY: cy, button: 0, buttons: type === 'mouseup' ? 0 : 1,
    });

    let threw = null;
    try {
        // 実クリックと同じ順序で撃つ（pointer 系も含める）
        hit.dispatchEvent(new PointerEvent('pointerdown', { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true }));
        hit.dispatchEvent(mk('mousedown'));
        hit.dispatchEvent(new PointerEvent('pointerup', { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 0, pointerId: 1, isPrimary: true }));
        hit.dispatchEvent(mk('mouseup'));
        hit.dispatchEvent(mk('click'));
        log.push('dispatch 完了（例外なし）');
    } catch (e) {
        threw = String(e);
    }

    return {
        hitTag: hit.tagName,
        hitClass: (hit.getAttribute && hit.getAttribute('class') || '').slice(0, 50),
        coords: { cx: Math.round(cx), cy: Math.round(cy) },
        isTrustedOfSynthetic: new MouseEvent('click').isTrusted,   // 常に false のはず
        threw, log,
    };
});
console.log(`\n合成クリック: ${JSON.stringify(dispatchResult)}`);

await page.waitForTimeout(6000);
const afterSynth = await readEcho();
console.log(`合成クリック後:  ${afterSynth}`);

const synthWorked = afterSynth !== afterReal;
console.log('\n================ 判定 ================');
console.log(`実クリック  : ${realWorked ? '✓ 効いた' : '✗ 効かない'}`);
console.log(`合成クリック: ${synthWorked ? '✓ 効いた（ハック15 成立）' : '✗ 効かない（ハック15 不成立）'}`);
console.log('======================================');

await browser.close();
