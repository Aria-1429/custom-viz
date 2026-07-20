// waterfall-chart の実バンドルを happy-dom で描画し、examples/example.svg を生成する
import { Window } from 'happy-dom';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/ishitsuki/custom-viz/custom-viz-waterfall-chart';
const BUNDLE = join(ROOT, 'dist', 'custom_viz_waterfall_chart', 'visualization.js');
const OUT_DIR = join(ROOT, 'examples');
const OUT = join(OUT_DIR, 'example.svg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = 720;
const H = 420;

const win = new Window({ width: W, height: H });
const doc = win.document;
globalThis.window = win;
globalThis.document = doc;
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
globalThis.HTMLElement = win.HTMLElement;
globalThis.SVGElement = win.SVGElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.MouseEvent = win.MouseEvent;
globalThis.CustomEvent = win.CustomEvent;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now ? performance.now() : 16), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => W });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => H });
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() { setTimeout(() => this.cb([]), 0); }
    disconnect() {}
    unobserve() {}
};
win.ResizeObserver = globalThis.ResizeObserver;

const root = doc.createElement('div');
root.id = 'root';
doc.body.appendChild(root);

const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => {};
};

const DATA = {
    fields: [{ name: '項目' }, { name: '金額' }, { name: '種別' }],
    rows: [
        ['期首残高', '5000', 'start'],
        ['新規売上', '3200', ''],
        ['返品', '-450', ''],
        ['値引き', '-380', ''],
        ['追加受注', '900', ''],
        ['期末残高', '', 'total'],
    ],
};

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: DATA } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: { animate: false } }),
    setOptions: () => {},
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: 'dark' }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: W, height: H }),
    addDimensionsListener: mkListener('dimensions'),
    getMode: () => ({ mode: 'view' }),
    addModeListener: mkListener('mode'),
    getTokens: () => ({}),
    addTokensListener: () => () => {},
    setToken: () => {},
    getError: () => null,
    addErrorListener: () => () => {},
    drilldown: () => {},
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

(0, eval)(readFileSync(BUNDLE, 'utf8'));
await sleep(500);

const svg = doc.querySelector('svg');
if (!svg) {
    console.error('SVG not rendered');
    process.exit(1);
}
let markup = svg.outerHTML;
// GitHub 上で単体表示できるよう、背景・フォント・名前空間を付与
markup = markup.replace(
    '<svg ',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif" `
);
markup = markup.replace('>', `><rect width="${W}" height="${H}" fill="#0d1020" rx="10"/>`);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, markup);
console.log(`wrote ${OUT} (${markup.length} bytes)`);
console.log(markup.slice(0, 400));
process.exit(0);
