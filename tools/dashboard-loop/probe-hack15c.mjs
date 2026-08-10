// ハック15 追試：成立の条件を絞り込む。
//
//   node probe-hack15c.mjs [dashboard-name]
//
// 確かめること:
//   A. click 単発でも効くか（pointer/mouse 系は不要か）
//   B. 座標を持たない click（new Event('click')）でも効くか
//   C. viz 自身の setTimeout から撃っても効くか（＝viz のコードに書いても動くか）
//      ※ Playwright の evaluate は iframe 内の実コンテキストで動くので同じだが、
//         「注入直後」ではなく「時間差で自走」させて、ホスト側が注入を見ている
//         わけではないことを確かめる
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
await page.waitForTimeout(18_000);

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

// 指定インデックスのメーターへ、指定モードでイベントを撃つ
const fire = async (idx, mode) => await vf.evaluate(({ idx, mode }) => {
    const svgs = [...document.querySelectorAll('svg')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 150 && r.height > 80; });
    const t = svgs[idx];
    if (!t) return { err: 'no target' };
    const r = t.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy) || t;

    if (mode === 'click-only') {
        hit.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
        return { mode, hitTag: hit.tagName };
    }
    if (mode === 'bare-event') {
        // 座標も view も持たない、最小限の Event
        hit.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
        return { mode, hitTag: hit.tagName };
    }
    if (mode === 'deferred') {
        // viz 自身のタイマーから自走させる（注入とは別のタスクで発火）
        setTimeout(() => {
            hit.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
        }, 2000);
        return { mode, hitTag: hit.tagName, note: '2秒後に自走発火を予約' };
    }
    if (mode === 'node-click') {
        // HTMLElement.click() / SVGElement には click() が無い場合がある
        try { hit.click(); return { mode, hitTag: hit.tagName, hasClickFn: typeof hit.click }; }
        catch (e) { return { mode, err: String(e) }; }
    }
    return { err: 'unknown mode' };
}, { idx, mode });

const step = async (label, idx, mode, waitMs = 6000) => {
    const before = await readEcho();
    const res = await fire(idx, mode);
    await page.waitForTimeout(waitMs);
    const after = await readEcho();
    console.log(`${label.padEnd(28)} ${before} -> ${after}  ${before !== after ? '✓ 効いた' : '✗ 効かない'}   ${JSON.stringify(res)}`);
    return before !== after;
};

console.log(`初期: ${await readEcho()}\n`);
// メーターは cpu(0) / mem(1) / disk(2)。毎回別のメーターを狙って区別する
await step('A. click 単発 (disk)', 2, 'click-only');
await step('B. 座標なし Event (cpu)', 0, 'bare-event');
await step('C. .click() (mem)', 1, 'node-click');
await step('D. 自走 setTimeout (disk)', 2, 'deferred', 8000);

await browser.close();
