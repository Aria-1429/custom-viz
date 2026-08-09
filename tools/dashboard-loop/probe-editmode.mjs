// 編集モードでカスタム viz(iframe) への入力が本当に遮断されるかを実マウスで検証する
import { chromium } from 'playwright';
import { assertConfig, config, webBase } from './src/config.mjs';
assertConfig();
const outDir = process.argv[2] || '.';
const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 700 } });
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded' });
if (await page.locator('input[name="username"]').count()) {
    await page.fill('input[name="username"]', config.user);
    await page.fill('input[name="password"]', config.pass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('networkidle').catch(() => {});
}
await page.goto(`${webBase()}/en-US/app/${process.env.SPLUNK_APP}/wm_edit_test`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);

// world-map の iframe frame を特定
const findWmFrame = async () => {
    for (const f of page.frames()) {
        try {
            const has = await f.evaluate(() => !!document.querySelector('[data-gtm="flow-table-toggle"]'));
            if (has) return f;
        } catch (e) { /* 次へ */ }
    }
    return null;
};
let wm = await findWmFrame();
if (!wm) { console.log('wm frame not found'); process.exit(1); }

const readState = async () => wm.evaluate(() => ({
    dropdownOpen: !!document.querySelector('[role="listbox"]'),
    filterBtn: !!document.querySelector('button[aria-haspopup="listbox"]'),
    tableStyleLeft: (document.querySelector('[data-gtm="flow-table-toggle"]')?.closest('[data-viz-ui]')||{}).style?.left || '',
    dirty: !!document.querySelector('[data-gtm="flow-table-dirty"]'),
}));

// --- 編集モードに入る ---
await page.click('button:has-text("Edit"), a:has-text("Edit")').catch(async () => {
    await page.getByText('編集', { exact: true }).first().click();
});
await page.waitForTimeout(6000);
wm = await findWmFrame();
if (!wm) { console.log('wm frame lost after edit'); process.exit(1); }
console.log('=== edit mode entered ===');

// 親DOM: iframe とその祖先の pointer-events / 覆い要素を調べる
const domInfo = await page.evaluate(() => {
    // カスタム viz の iframe は about:srcdoc。左パネル（x<700相当）に居る iframe を選ぶ
    const ifr = [...document.querySelectorAll('iframe')].find((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 300 && r.left < window.innerWidth / 2;
    });
    if (!ifr) return { found: false };
    const r = ifr.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // iframe 中央のヒットテスト: 一番上に居る要素は何か
    const top = document.elementFromPoint(cx, cy);
    const chain = [];
    let el = top;
    for (let i = 0; el && i < 6; i += 1) {
        chain.push({
            tag: el.tagName,
            cls: String(el.className).slice(0, 60),
            pe: getComputedStyle(el).pointerEvents,
        });
        el = el.parentElement;
    }
    return {
        found: true,
        iframePE: getComputedStyle(ifr).pointerEvents,
        topAtCenter: chain,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
});
console.log('DOM:', JSON.stringify(domInfo, null, 1));

// --- テスト A: 未選択状態でフィルタボタンを実マウスクリック ---
const btnBox = async () => {
    const b = wm.locator('button[aria-haspopup="listbox"]').first();
    return (await b.count()) ? b.boundingBox() : null;
};
let bb = await btnBox();
if (bb) {
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(800);
    const s1 = await readState();
    console.log('A) click filter (unselected panel):', JSON.stringify(s1));
    // 閉じる（開いていたら）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
}

// --- テスト B: もう一度クリック（1回目でパネル選択済みの状態） ---
bb = await btnBox();
if (bb) {
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(800);
    const s2 = await readState();
    console.log('B) click filter (after selection):', JSON.stringify(s2));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
}

// --- テスト C: フロー一覧ヘッダーを実マウスでドラッグ ---
const hb = await wm.locator('[data-gtm="flow-table-toggle"]').first().boundingBox().catch(() => null);
if (hb) {
    await page.mouse.move(hb.x + 30, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 30 - 150, hb.y + hb.height / 2 - 100, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const s3 = await readState();
    console.log('C) drag table header in edit mode:', JSON.stringify(s3));
}

await page.screenshot({ path: `${outDir}/editmode.png` });
console.log('screenshot saved');
await browser.close();
