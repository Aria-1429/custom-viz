// ハック24：編集モードで「Visibility」セクションが実際に出るかを確認する。
//
//   node probe-visibility-ui.mjs [dashboard-name] [出力先プレフィックス]
//
// バンドル解析では実在を確認したが、フィーチャーフラグ
// （enableShowHide / showConditionsEditor）で出し分けられている。
// **実機で出るか**を目で見るのがこのプローブの目的。
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './src/config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');
assertConfig();
const name = process.argv[2] || 'hack15_probe';
const OUT = process.argv[3] || '/tmp/vis';

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 },
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
await page.waitForTimeout(20_000);

// 1) 編集モードへ
const editClicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, a')].find((e) => /^\s*Edit\s*$/i.test(e.innerText || ''));
    if (!b) return false;
    b.click();
    return true;
});
console.log('編集ボタン:', editClicked ? 'クリックした' : '見つからない');
await page.waitForTimeout(10_000);
await page.screenshot({ path: `${OUT}_1_editmode.png` });

// 2) フィーチャーフラグの実値を取れるか（window から探す）
const flags = await page.evaluate(() => {
    const found = {};
    // よくある置き場所を順に見る
    for (const k of Object.keys(window)) {
        if (!/config|feature|flag|splunk/i.test(k)) continue;
        try {
            const v = window[k];
            if (v && typeof v === 'object') {
                const s = JSON.stringify(v).slice(0, 3000);
                if (/enableShowHide|showConditionsEditor/.test(s)) found[k] = s.slice(0, 600);
            }
        } catch (e) { /* skip */ }
    }
    return found;
});
console.log('\n=== window から拾えたフラグ ===');
console.log(Object.keys(flags).length ? JSON.stringify(flags, null, 1).slice(0, 1200) : '(window からは拾えず)');

// 3) パネルを選択する（サイドバーを「そのパネルの設定」に切り替えるため）
//    ⚠ 合成クリックではなく **実マウス** で押す。編集モードの選択はドラッグ基盤の
//    ハンドラで実装されており、座標を伴う実操作でないと選択状態にならない。
//    （最初 dispatchEvent で撃ってダッシュボード全体の Configuration が出た＝選択できていなかった）
let picked = false;
for (const sel of ['[data-test="viz-item"]', '[data-test="absolute-item"]']) {
    const el = await page.$(sel);
    if (!el) continue;
    const box = await el.boundingBox();
    if (!box) continue;
    // パネル上端のタイトル付近を狙う（中身は iframe なのでクリックが吸われる）
    await page.mouse.click(box.x + box.width / 2, box.y + 8);
    picked = true;
    break;
}
console.log('\nパネル選択:', picked ? '実マウスでクリックした' : '見つからない');
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}_2_selected.png` });

// 4) サイドバーに Visibility があるか（data-test で厳密に探す）
const sidebar = await page.evaluate(() => {
    const res = { visibilityPanel: null, allPanels: [], checkbox: null };
    const vp = document.querySelector('[data-test="collapsible-panel-visibility"]');
    if (vp) res.visibilityPanel = (vp.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    for (const el of document.querySelectorAll('[data-test^="collapsible-panel"]')) {
        res.allPanels.push(el.getAttribute('data-test') + ' | ' + (el.innerText || '').split('\n')[0].slice(0, 40));
    }
    const cb = document.querySelector('[data-test="item-visibility-checkbox"]');
    if (cb) res.checkbox = (cb.closest('div')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120);
    return res;
});
console.log('\n=== サイドバーのセクション ===');
sidebar.allPanels.forEach((p) => console.log('  ', p));
console.log('\nVisibility パネル:', sidebar.visibilityPanel ?? '(無い)');
console.log('表示チェックボックス:', sidebar.checkbox ?? '(無い)');

console.log('\n================ 判定 ================');
console.log(sidebar.visibilityPanel
    ? '✓ Visibility セクションが実機に出る（フラグ有効）'
    : '✗ 出ない（フラグ無効か、この viz 型は対象外）');
console.log('======================================');

await browser.close();
