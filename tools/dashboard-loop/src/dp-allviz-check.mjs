// ── 全 viz が描けているかを判定して撮る ──────────────────────────
//
// パネルごとに「中身が描かれているか」を **DOM から機械判定**し、
// あわせて画面を分割して撮影する。
//
//   node src/dp-allviz-check.mjs <app> <view> <出力ディレクトリ>
//
// ## 判定のしかた（⚠ ここが肝）
//
// **「パネルが在る」では判定にならない**（空でも枠は出る）。
//   - `svg` / `canvas` の有無と大きさ
//   - 「データがありません」等のテキスト
//   - 中身の要素数
// を見て `ok / empty / error` に分ける。
//
// ⚠ **アニメーションする viz があるので画面は永久に安定しない。**
//   `waitForLoadState('networkidle')` は待ち切らない。固定待機にする。
// ────────────────────────────────────────────────────────────────

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { assertConfig, config, webBase } from './config.mjs';

const [, , app, view, outDir = '/tmp/dp-allviz'] = process.argv;
if (!app || !view) {
    console.error('usage: dp-allviz-check.mjs <app> <view> [出力ディレクトリ]');
    process.exit(1);
}
assertConfig();
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1800, height: 1100 } });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) pageErrors.push(m.text().slice(0, 200));
});

await page.goto(`${webBase()}/en-US/account/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('input[name="username"]').first().fill(config.user);
await page.locator('input[name="password"]').first().fill(config.pass);
await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {}),
    page.locator('input[name="password"]').first().press('Enter'),
]);
await page.waitForTimeout(1500);
await page.goto(`${webBase()}/en-US/app/dpx/dpx?id=${app}/${view}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
});

// ⚠ サーチが 9 本走る。焦って撮ると「データがありません」だらけになる。
console.log('サーチの完了を待っています…（60 秒）');
await page.waitForTimeout(60_000);

// ── パネルごとの状態を判定 ─────────────────────────────────────
const results = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-panel-id]')) {
        const id = el.getAttribute('data-panel-id');
        const title = (el.innerText || '').split('\n')[0].trim().slice(0, 24);
        const text = el.innerText || '';
        const svgs = [...el.querySelectorAll('svg')];
        const canvases = [...el.querySelectorAll('canvas')];
        const drawn =
            svgs.some((s) => s.getBoundingClientRect().width > 20 && s.querySelectorAll('*').length > 2) ||
            canvases.some((c) => c.getBoundingClientRect().width > 20);
        // 表など SVG を使わない viz のために、中身の要素数も見る
        const nodes = el.querySelectorAll('*').length;
        const emptyMsg = /データがありません|データが取得できません|列を選択|フィールドの選択|設定してください/.test(text);
        const errMsg = /エラー|失敗|Error|undefined is not/.test(text);
        // ⚠ **図形・装飾は要素数が少ないのが正常**（矩形は div 1 枚、時計は文字だけ）。
        //   一律に「要素が少ない＝描けていない」と判定すると、
        //   **正常なものを不具合として報告する**（実際に 4 件を誤判定した）。
        const viz = el.getAttribute('data-viz') || '';
        const simple = /^(shape\.|deco\.)/.test(viz) || /^(shape|deco)/.test(id);
        const hasInk = drawn || nodes >= 3 || text.trim().length > 0;

        let state = 'ok';
        if (errMsg) state = 'error';
        else if (emptyMsg) state = 'empty';
        else if (simple) state = hasInk ? 'ok' : 'blank';
        else if (!drawn && nodes < 12) state = 'blank';
        out.push({ id, title, state, nodes, svg: svgs.length, canvas: canvases.length,
                   hint: emptyMsg || errMsg ? text.replace(/\s+/g, ' ').slice(0, 90) : '' });
    }
    return out;
});

// ── 分割して撮影 ───────────────────────────────────────────────
// ⚠ **`window.scrollTo` では動かない。** DPX は内側のコンテナがスクロールするので、
//   実際にスクロールしている要素を探して動かす（これを間違えると
//   **同じ絵が何枚も撮れて「全部見た」と誤認する**）。
const scroller = await page.evaluateHandle(() => {
    const cands = [document.scrollingElement, ...document.querySelectorAll('div')];
    let best = document.scrollingElement;
    let max = 0;
    for (const el of cands) {
        if (!el) continue;
        const over = el.scrollHeight - el.clientHeight;
        if (over > max) {
            max = over;
            best = el;
        }
    }
    return best;
});
const info = await scroller.evaluate((el) => ({
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 40),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
}));
console.log(`スクロール対象: ${info.tag}.${info.cls} (${info.clientHeight} / ${info.scrollHeight})`);

const step = Math.max(600, info.clientHeight - 120);
const shots = Math.min(Math.ceil(info.scrollHeight / step), 16);
for (let i = 0; i < shots; i += 1) {
    await scroller.evaluate((el, y) => {
        el.scrollTop = y;
    }, i * step);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(outDir, `part${String(i + 1).padStart(2, '0')}.png`) });
}

await browser.close();

// ── 集計 ───────────────────────────────────────────────────────
const by = (s) => results.filter((r) => r.state === s);
console.log(`\nパネル ${results.length} 枚`);
console.log(`  ok    : ${by('ok').length}`);
console.log(`  empty : ${by('empty').length}`);
console.log(`  blank : ${by('blank').length}`);
console.log(`  error : ${by('error').length}`);

for (const s of ['error', 'blank', 'empty']) {
    for (const r of by(s)) {
        console.log(`  [${s}] ${r.id} ${r.title} (nodes=${r.nodes} svg=${r.svg} canvas=${r.canvas}) ${r.hint}`);
    }
}
if (pageErrors.length) {
    console.log('\nページのエラー:');
    [...new Set(pageErrors)].slice(0, 10).forEach((e) => console.log(`  ${e}`));
}
console.log(`\nスクリーンショット: ${outDir}/part*.png（${shots} 枚）`);
process.exit(by('error').length + by('blank').length > 0 ? 1 : 0);
