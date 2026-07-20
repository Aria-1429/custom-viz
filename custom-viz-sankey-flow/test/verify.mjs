// Sankey Flow viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_sankey_flow', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 500 });
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
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// コンテナ実寸を固定（オートフィット系のため）
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 500 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, x: 0, y: 0 };
};

// ResizeObserver 簡易モック（observe 時に即 callback）
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

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

const FIELDS3 = [{ name: 'source' }, { name: 'target' }, { name: 'count' }];
const ROWS3 = [
    ['Internet', 'Firewall', '5,200'],   // カンマ付き数値の正規化を検証
    ['Internet', 'VPN', '1400'],
    ['Firewall', 'WebServer', '3600'],
    ['Firewall', 'AppServer', '1500'],
    ['VPN', 'AppServer', '900'],
    ['WebServer', 'Database', '2100'],
    ['AppServer', 'Database', '1700'],
    ['Database', 'Internet', '400'],     // 循環リンク → 除去されるはず
    ['AppServer', 'AppServer', '50'],    // 自己ループ → 除去
    ['Ghost', '', '10'],                 // 空カテゴリ → 除去
    ['Ghost', 'X', 'abc'],               // 非数値 → 除去
    ['Ghost', 'X', '-5'],                // 0以下 → 除去
];

let state = {
    data: { fields: FIELDS3, rows: ROWS3 },
    options: {},
    theme: 'dark',
};

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({
        loading: false,
        dataSources: { primary: { data: state.data } },
    }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...state.options, ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: 900, height: 500 }),
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

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 自由グラフモード（3列） ---------------------------------------------
console.log('\n[1] free-graph mode (3 cols, dark theme)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    const paths = [...doc.querySelectorAll('svg path')];
    // 有効リンク: 7本（循環1・自己ループ1・不正3行を除去）
    check('7 link paths', paths.length === 7, `got ${paths.length}`);
    const rects = [...doc.querySelectorAll('svg rect')];
    // ノード: Internet, Firewall, VPN, WebServer, AppServer, Database + Ghost系は全滅 → 6
    check('6 node rects', rects.length === 6, `got ${rects.length}`);
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('labels include Internet', texts.some((t) => t.includes('Internet')));
    check('labels include Database', texts.some((t) => t.includes('Database')));
    // 値併記（showValues 既定 ON）: Internet 総流量 6600 → "6.6k"
    check('label shows compact value 6.6k', texts.some((t) => t.includes('6.6k')), JSON.stringify(texts));
    const header = doc.body.textContent;
    check('header shows total 6,600', header.includes('6,600'), header.slice(0, 200));
    check('header notes dropped cyclic', header.includes('1 cyclic'));
    // グラデーションリンク既定 ON
    const grads = doc.querySelectorAll('svg defs linearGradient');
    check('gradient defs = links', grads.length === 7, `got ${grads.length}`);
    check('paths use gradient url', paths.every((p) => (p.getAttribute('stroke') || '').startsWith('url(#')));
    // 不透明度既定 40%
    check('stroke-opacity 0.4', paths.every((p) => Math.abs(parseFloat(p.getAttribute('stroke-opacity')) - 0.4) < 1e-6));
}

// ---- 2. 値ベースカラースケール ON --------------------------------------------
console.log('\n[2] useValueColors on (low green → high red, no mid)');
{
    state.options = {
        useValueColors: true, useMidColor: false,
        lowColor: '#00ff00', highColor: '#ff0000', linkOpacity: 80,
    };
    fire('options', { options: state.options });
    await sleep(250);
    const paths = [...doc.querySelectorAll('svg path')];
    const strokes = paths.map((p) => p.getAttribute('stroke'));
    check('strokes are rgb() scale colors', strokes.every((s) => s.startsWith('rgb(')), JSON.stringify(strokes));
    // 最大値リンク(5200)は highColor=赤、最小値リンク(900)は lowColor=緑
    check('max link is pure red', strokes.includes('rgb(255,0,0)'), JSON.stringify(strokes));
    check('min link is pure green', strokes.includes('rgb(0,255,0)'));
    check('opacity updated to 0.8', paths.every((p) => Math.abs(parseFloat(p.getAttribute('stroke-opacity')) - 0.8) < 1e-6));
    check('legend gradient bar in header', doc.body.innerHTML.includes('linear-gradient'));
}

// ---- 3. reverse 反転 ---------------------------------------------------------
console.log('\n[3] reverse');
{
    state.options = { ...state.options, reverse: true };
    fire('options', { options: state.options });
    await sleep(250);
    const strokes = [...doc.querySelectorAll('svg path')].map((p) => p.getAttribute('stroke'));
    // 反転: 最大値リンクが緑側になる
    const maxIsGreen = strokes.includes('rgb(0,255,0)');
    check('reversed scale applies', maxIsGreen, JSON.stringify(strokes));
}

// ---- 4. ステージモード（4列） ------------------------------------------------
console.log('\n[4] staged mode (4 cols)');
{
    state.options = {};
    state.data = {
        fields: [{ name: 'region' }, { name: 'product' }, { name: 'channel' }, { name: 'revenue' }],
        rows: [
            ['APAC', 'Widgets', 'Online', '100'],
            ['APAC', 'Gadgets', 'Retail', '80'],
            ['EMEA', 'Widgets', 'Online', '60'],
            ['EMEA', 'Widgets', 'Retail', '40'],
        ],
    };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    const rects = [...doc.querySelectorAll('svg rect')];
    // ノード: stage0 {APAC,EMEA} stage1 {Widgets,Gadgets} stage2 {Online,Retail} → 6
    check('6 staged nodes', rects.length === 6, `got ${rects.length}`);
    const paths = [...doc.querySelectorAll('svg path')];
    // リンク: APAC→Widgets, APAC→Gadgets, EMEA→Widgets, Widgets→Online, Widgets→Retail, Gadgets→Retail → 6
    check('6 staged links (aggregated)', paths.length === 6, `got ${paths.length}`);
    const header = doc.body.textContent;
    check('3 stages in header', header.includes('3 stages'), header.slice(0, 160));
    check('total = 280', header.includes('280'));
    // 同名ノード（Widgets）はステージ内で1つに合算されている
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('Widgets label appears once', texts.filter((t) => t.includes('Widgets')).length === 1);
}

// ---- 5. テーマ切替 -----------------------------------------------------------
console.log('\n[5] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const text = doc.querySelector('svg text');
    check('label color switches to light-mode text', text && text.getAttribute('fill') === '#31373e',
        text && text.getAttribute('fill'));
}

// ---- 6. 列不足 / 空データ ----------------------------------------------------
console.log('\n[6] guards');
{
    state.data = { fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', '1']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('2-col message', doc.body.textContent.includes('at least 3 columns'));

    state.data = { fields: FIELDS3, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty data message', doc.body.textContent.includes('No data'));

    // 全行不正 → nolinks メッセージ
    state.data = { fields: FIELDS3, rows: [['a', 'b', 'xyz'], ['', 'b', '5']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('no valid links message', doc.body.textContent.includes('No valid flow links'));

    // columns 形式でも動く
    state.data = {
        fields: FIELDS3,
        columns: [['A', 'B'], ['B', 'C'], ['10', '20']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    const paths = [...doc.querySelectorAll('svg path')];
    check('columns-form data renders 2 links', paths.length === 2, `got ${paths.length}`);
}

// ---- 7. debug オーバーレイ ----------------------------------------------------
console.log('\n[7] debug overlay');
{
    state.options = { debug: true };
    fire('options', { options: state.options });
    await sleep(200);
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
