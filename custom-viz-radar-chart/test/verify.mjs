// Radar Chart viz のローカル検証（happy-dom、Splunk実機なし）
// バンドル済み dist/.../visualization.js を実行し、描画・オプション反映・ガード・
// フィールド選択（columnSelector DOS 文字列）・mv セル救済を検証する。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_radar_chart', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 600 });
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

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 600 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, x: 0, y: 0 };
};

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

// 4 軸 × 3 系列。cpu/mem/disk/net を軸に host_a/host_b/host_c を系列で比較。
const FIELDS = [
    { name: 'metric' }, { name: 'host_a' }, { name: 'host_b' }, { name: 'host_c' },
];
const ROWS = [
    ['cpu', '80', '40', '20'],
    ['mem', '55', '70', '30'],
    ['disk', '30', '20', '90'],
    ['net', '65', '50', '45'],
    ['', '1', '1', '1'],   // 空ラベル軸 → 除去される
];

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
    theme: 'dark',
};

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...state.options, ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: 900, height: 600 }),
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

// 系列ポリゴンだけを取り出す（グリッドのリングは fill="none"、系列は fill=rgba(...)）
const seriesPolys = () => [...doc.querySelectorAll('svg polygon')]
    .filter((p) => (p.getAttribute('fill') || '').startsWith('rgba'));
// グリッドリング（fill=none）
const ringPolys = () => [...doc.querySelectorAll('svg polygon')]
    .filter((p) => (p.getAttribute('fill') || '') === 'none');
const axisTexts = () => [...doc.querySelectorAll('svg text')];

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 既定描画（4 軸 × 3 系列） -------------------------------------------
console.log('\n[1] default render (dark, 4 axes × 3 series)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    check('3 series polygons', seriesPolys().length === 3, `got ${seriesPolys().length}`);
    // 既定リング本数 = 4
    check('4 grid rings', ringPolys().length === 4, `got ${ringPolys().length}`);
    const header = doc.body.textContent;
    check('axis label cpu shown', header.includes('cpu'));
    check('axis label net shown', header.includes('net'));
    check('empty-label axis dropped (only 4 axes)', axisTexts().filter((t) => t.textContent === 'cpu' || t.textContent === 'mem' || t.textContent === 'disk' || t.textContent === 'net').length === 4);
    check('legend shows host_a', header.includes('host_a'));
    check('legend shows host_c', header.includes('host_c'));
    // 系列ポリゴンは頂点数 = 軸数 = 4（"x,y" ペアが 4 組）
    const pts = (seriesPolys()[0].getAttribute('points') || '').trim().split(/\s+/);
    check('polygon has 4 vertices', pts.length === 4, `got ${pts.length}`);
}

// ---- 2. 系列色オプションの反映 ------------------------------------------------
console.log('\n[2] custom series colors');
{
    state.options = { seriesColor1: '#ff0000', seriesColor2: '#00ff00' };
    fire('options', { options: state.options });
    await sleep(250);
    const strokes = seriesPolys().map((p) => p.getAttribute('stroke'));
    check('seriesColor1 applied', strokes.includes('#ff0000'), JSON.stringify(strokes));
    check('seriesColor2 applied', strokes.includes('#00ff00'));
}

// ---- 3. リング本数・グロー・ドットのオプション --------------------------------
console.log('\n[3] rings / glow / dots options');
{
    state.options = { rings: 6, glow: false, showDots: false };
    fire('options', { options: state.options });
    await sleep(250);
    check('6 grid rings', ringPolys().length === 6, `got ${ringPolys().length}`);
    // glow=false のとき filter 参照が無い
    const g = [...doc.querySelectorAll('svg g')].find((el) => el.getAttribute('filter'));
    check('glow off → no filter on series group', !g, g ? g.getAttribute('filter') : '');
    // showDots=false のとき circle が無い
    check('dots off → no circles', doc.querySelectorAll('svg circle').length === 0);
}

// ---- 4. フィールド選択（columnSelector DOS 文字列） ---------------------------
console.log('\n[4] field selection via DOS strings');
{
    state.data = {
        fields: [
            { name: 'ignore' }, { name: 'metric' }, { name: 'prod' }, { name: 'stg' },
        ],
        rows: [
            ['x', 'cpu', '90', '10'],
            ['x', 'mem', '40', '60'],
            ['x', 'disk', '70', '30'],
        ],
    };
    // 軸=metric（第2列）, 系列1=prod, 系列2=stg を DOS 文字列で選択
    state.options = {
        axisField: "> primary | seriesByName('metric')",
        seriesField1: "> primary | seriesByName('prod')",
        seriesField2: "> primary | seriesByName('stg')",
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const header = doc.body.textContent;
    check('axis uses metric column (cpu shown)', header.includes('cpu'));
    check('ignore column not used as axis', !axisTexts().some((t) => t.textContent === 'x'));
    check('legend shows selected series prod', header.includes('prod'));
    check('legend shows selected series stg', header.includes('stg'));
    check('exactly 2 series selected', seriesPolys().length === 2, `got ${seriesPolys().length}`);
    // seriesByIndex でも解決できる
    state.options = {
        axisField: "> primary | seriesByIndex(1)",
        seriesField1: "> primary | seriesByIndex(2)",
    };
    fire('options', { options: state.options });
    await sleep(200);
    check('seriesByIndex resolves axis=metric + 1 series', seriesPolys().length === 1 && doc.body.textContent.includes('cpu'), `got ${seriesPolys().length}`);
}

// ---- 5. マルチバリューセル救済 -----------------------------------------------
console.log('\n[5] multivalue cell rescue (parallel expand)');
{
    // 1 行のセルに配列（mvexpand し忘れ相当）。全列トークン数一致 → 平行展開されるはず。
    state.data = {
        fields: [{ name: 'metric' }, { name: 'a' }, { name: 'b' }],
        rows: [
            [['cpu', 'mem', 'disk', 'net'], ['80', '55', '30', '65'], ['40', '70', '20', '50']],
        ],
    };
    state.options = {};
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const header = doc.body.textContent;
    check('mv expanded → 4 axes', axisTexts().filter((t) => ['cpu', 'mem', 'disk', 'net'].includes(t.textContent)).length === 4);
    check('mv expanded → 2 series', seriesPolys().length === 2, `got ${seriesPolys().length}`);
    check('axis label is cpu not the whole array', header.includes('cpu') && !header.includes('cpu,mem'));
}

// ---- 6. テーマ切替 -----------------------------------------------------------
console.log('\n[6] theme switch to light');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {};
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    // ライトモードの軸ラベル色 = #4a5068
    const lbl = axisTexts().find((t) => t.textContent === 'cpu');
    const fill = lbl ? (lbl.getAttribute('fill') || '') : '';
    check('axis label uses light-mode color', /#4a5068/i.test(fill), fill);
}

// ---- 7. ガード（空データ / 3軸未満 / columns 形式） --------------------------
console.log('\n[7] guards');
{
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty → No data', doc.body.textContent.includes('No data'));

    // 軸が 2 行だけ → レーダーにならない旨のメッセージ
    state.data = { fields: FIELDS, rows: [['cpu', '10', '5', '3'], ['mem', '20', '8', '4']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('< 3 axes → guidance message', /at least 3 axes/i.test(doc.body.textContent), doc.body.textContent.slice(0, 120));

    // columns 形式でも動く（4 軸 × 2 系列）
    state.data = {
        fields: [{ name: 'metric' }, { name: 's1' }, { name: 's2' }],
        columns: [['cpu', 'mem', 'disk', 'net'], ['1', '2', '3', '4'], ['4', '3', '2', '1']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('columns-form renders 2 series', seriesPolys().length === 2, `got ${seriesPolys().length}`);
}

// ---- 8. デバッグダンプ --------------------------------------------------------
console.log('\n[8] debug dump');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { debug: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const pre = doc.querySelector('pre');
    check('debug pre rendered', !!pre);
    check('debug dumps fields', pre && pre.textContent.includes('metric'));
    check('debug dumps rawOptions', pre && pre.textContent.includes('rawOptions'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
