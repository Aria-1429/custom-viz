// 実機の DOM を調べる（セレクタの推測を事実で置き換えるための道具）。
//   node src/probe-dom.mjs <dashboard-name>
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertConfig, config, webBase } from './config.mjs';

const STATE_FILE = join(homedir(), '.splunk-dev-session.json');
assertConfig();
const name = process.argv[2];

const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    ...(existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {}),
});
const page = await ctx.newPage();
await page.goto(`${webBase()}/en-US/app/${config.app}/${name}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);

const out = await page.evaluate(() => {
    const describe = (sel) =>
        [...document.querySelectorAll(sel)].map((el) => {
            const r = el.getBoundingClientRect();
            const attrs = {};
            for (const a of el.attributes) if (a.name !== 'class' && a.name !== 'style') attrs[a.name] = a.value;
            return { attrs, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
        });
    return {
        vizItem: describe('[data-test="viz-item"]'),
        absoluteItem: describe('[data-test="absolute-item"]'),
        canvasContainer: describe('[data-test="dashboard-canvas-container"]'),
        canvas: describe('[data-test="canvas"]'),
    };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
