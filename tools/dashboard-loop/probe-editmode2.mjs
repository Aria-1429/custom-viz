// 編集モード中、標準 viz（インラインDOM）には入力が届くのかを検証する
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
await page.click('button:has-text("Edit"), a:has-text("Edit")').catch(async () => {
    await page.getByText('編集', { exact: true }).first().click();
});
await page.waitForTimeout(6000);
console.log('=== edit mode ===');

// networkGraph（右パネル・インラインDOM）の状態読み取り
const readNg = async () => page.evaluate(() => {
    // ズームコントロールは viz 直下のボタン。ノード円の半径や transform を観測する
    const panel = [...document.querySelectorAll('[data-input-id], [id], div')].length; // dummy
    const svgs = [...document.querySelectorAll('svg')].filter((s) => {
        const r = s.getBoundingClientRect();
        return r.left > window.innerWidth * 0.35 && r.width > 200;
    });
    const svg = svgs[0] || null;
    const g = svg ? svg.querySelector('g[transform]') : null;
    return {
        svgFound: !!svg,
        transform: g ? g.getAttribute('transform') : null,
    };
});

// ヒットテスト: 右パネル（ng）中央の最前面要素
const hitNg = await page.evaluate(() => {
    const x = window.innerWidth * 0.55;
    const y = window.innerHeight * 0.5;
    const chain = [];
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && i < 5; i += 1) {
        chain.push({ tag: el.tagName, cls: String(el.className?.baseVal ?? el.className).slice(0, 50) });
        el = el.parentElement;
    }
    return chain;
});
console.log('hit-test at ng center:', JSON.stringify(hitNg));

const before = await readNg();
console.log('ng before:', JSON.stringify(before));

// ズーム「+」ボタンを実マウスでクリック（右パネル内、インライン要素）
// ボタンは ng パネル左上の [+][-]。テキスト/アイコンで探す
const zoomBtn = page.locator('button[data-test="zoom-in"], button[aria-label*="zoom" i], [class*="zoom" i] button').first();
let clicked = false;
if (await zoomBtn.count()) {
    const b = await zoomBtn.boundingBox();
    if (b) { await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); clicked = true; }
}
if (!clicked) {
    // フォールバック: スクリーンショットで見えていた位置（ngパネル左上の＋）を直接クリック
    await page.mouse.click(640, 253);
    clicked = 'by-coords';
}
await page.waitForTimeout(1200);
const after = await readNg();
console.log('ng after zoom+ click (', clicked, '):', JSON.stringify(after));
console.log('CHANGED:', before.transform !== after.transform);

// ついでに: ノード円を実マウスでドラッグ（ユーザー観察の「viz 内を直接いじれる」）
const beforeDrag = await readNg();
await page.mouse.move(791, 300); // fw01 の円あたり（スクショ座標）
await page.mouse.down();
await page.mouse.move(730, 380, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(1000);
const afterDrag = await readNg();
console.log('drag on ng body: transform changed =', beforeDrag.transform !== afterDrag.transform);
await page.screenshot({ path: `${outDir}/editmode_ng.png` });
await browser.close();
