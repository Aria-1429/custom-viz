// World Map viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_worldmap', 'visualization.js'
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

const FIELDS = ['src_lat', 'src_lon', 'dst_lat', 'dst_lon', 'severity', 'count', 'src_name', 'dst_name']
    .map((name) => ({ name }));
const ROWS = [
    ['51.5', '-0.12', '35.68', '139.69', 'low', '120', 'London', 'Tokyo'],
    ['31.2', '121.47', '35.68', '139.69', 'high', '300', 'Shanghai', 'Tokyo'],
    ['55.75', '37.61', '35.68', '139.69', 'HIGH', '50', 'Moscow', 'Tokyo'],   // 大文字違い → high に合流
    ['-23.5', '-46.6', '35.68', '139.69', 'medium', '80', 'Sao Paulo', 'Tokyo'],
    ['40.7', '-74.0', '35.68', '139.69', '', '10', 'New York', 'Tokyo'],      // 空severity → low
    ['48.85', '2.35', '35.68', '139.69', 'worm', '40', 'Paris', 'Tokyo'],     // 未知severity → extraColor1
    ['99.9', '10', '35.68', '139.69', 'high', '5', 'BadLat', 'Tokyo'],        // 緯度>90 → 除去
    ['abc', '10', '35.68', '139.69', 'low', '5', 'NaN', 'Tokyo'],             // 非数値 → 除去
];
// 有効な脅威 = 6 行

let state = {
    data: { fields: FIELDS, rows: ROWS },
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
const streaks = () => [...doc.querySelectorAll('svg path[pathLength]')];
const strokes = () => streaks().map((p) => p.getAttribute('stroke'));
const titles = () => [...doc.querySelectorAll('svg title')].map((t) => t.textContent);

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 初期表示（dark・自動フィールド判定） --------------------------------
console.log('\n[1] initial render (dark, auto field detection)');
{
    check('svg rendered', !!doc.querySelector('svg'));
    check('land path drawn', !!doc.querySelector('svg path[fill="#0d2b52"]'));
    check('6 streak paths (2 invalid rows dropped)', streaks().length === 6, `got ${streaks().length}`);
    check('high uses default color', strokes().includes('rgb(255, 90, 46)'), JSON.stringify(strokes()));
    check('unknown severity uses extraColor1', strokes().includes('rgb(177, 122, 255)'));
    const body = doc.body.textContent;
    check('title shown', body.includes('GLOBAL THREAT MAP'));
    check('legend/filter include worm severity', body.includes('worm'));
    check('arc tooltip src → dst', titles().some((t) => t.includes('Shanghai') && t.includes('Tokyo')), JSON.stringify(titles().slice(0, 4)));
    check('hotspot tooltip has target name', titles().some((t) => t.startsWith('Target: Tokyo')));
    check('pulse/streak animations present', doc.querySelectorAll('svg animate').length > 0);
}

// ---- 2. 色オプションの反映 ---------------------------------------------------
console.log('\n[2] color option change');
{
    state.options = { highColor: '#00ff00' };
    fire('options', { options: state.options });
    await sleep(250);
    check('high arcs turn green', strokes().includes('rgb(0, 255, 0)'), JSON.stringify(strokes()));
    check('old high color gone', !strokes().includes('rgb(255, 90, 46)'));
}

// ---- 3. 表示トグルとアニメーション停止 ---------------------------------------
console.log('\n[3] display toggles + animation off');
{
    state.options = { showTitle: false, showLegend: false, showFilter: false, animDuration: 0 };
    fire('options', { options: state.options });
    await sleep(250);
    const body = doc.body.textContent;
    check('title hidden', !body.includes('GLOBAL THREAT MAP'));
    check('filter hidden', !body.includes('All Threats'));
    check('legend hidden', !doc.body.innerHTML.includes('0 0 8px'));
    check('no animate elements when animDuration=0', doc.querySelectorAll('svg animate').length === 0,
        `got ${doc.querySelectorAll('svg animate').length}`);
    check('no streak paths (static mode)', streaks().length === 0);
    // 静的モードでは本線が濃くなる
    const staticArcs = [...doc.querySelectorAll('svg path[opacity="0.7"]')];
    check('static arcs drawn brighter', staticArcs.length === 6, `got ${staticArcs.length}`);
}

// ---- 4. タイトル文字列の変更 -------------------------------------------------
console.log('\n[4] custom title text');
{
    state.options = { titleText: 'MY SOC MAP' };
    fire('options', { options: state.options });
    await sleep(250);
    check('custom title shown', doc.body.textContent.includes('MY SOC MAP'));
}

// ---- 5. editor.columnSelector（DOS文字列）でのフィールド指定 ------------------
console.log('\n[5] columnSelector DOS strings on renamed fields');
{
    const renamed = ['la1', 'lo1', 'la2', 'lo2', 'sev', 'cnt', 'n1', 'n2'].map((name) => ({ name }));
    state.data = { fields: renamed, rows: ROWS };
    state.options = {};
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    // 自動判定は候補名に一致しない → 必須フィールド欠損メッセージ
    check('auto-detect fails on renamed fields', doc.body.textContent.includes('Required fields'));

    state.options = {
        srcLatField: "> primary | seriesByName('la1')",
        srcLonField: "> primary | seriesByName('lo1')",
        dstLatField: "> primary | seriesByName('la2')",
        dstLonField: '> primary | seriesByIndex(3)',
        severityField: "> primary | seriesByName('sev')",
        srcNameField: "> primary | seriesByName('n1')",
        dstNameField: "> primary | seriesByName('n2')",
    };
    fire('options', { options: state.options });
    await sleep(250);
    check('renders via columnSelector fields', streaks().length === 6, `got ${streaks().length}`);
    check('severity resolved via selector', doc.body.textContent.includes('worm'));
    check('names resolved via selector', titles().some((t) => t.includes('Shanghai')));
}

// ---- 6. ガードと columns 形式 ------------------------------------------------
console.log('\n[6] guards + columns format');
{
    state.options = {};
    state.data = { fields: FIELDS, rows: [] };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty data message', doc.body.textContent.includes('No data available'));

    state.data = { fields: [{ name: 'a' }, { name: 'b' }], rows: [['1', '2']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('missing fields message', doc.body.textContent.includes('Required fields'));

    // columns 形式でも動く
    state.data = {
        fields: FIELDS,
        columns: FIELDS.map((_, ci) => ROWS.map((r) => r[ci])),
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('columns format renders', streaks().length === 6, `got ${streaks().length}`);
}

// ---- 7. テーマ切替 -----------------------------------------------------------
console.log('\n[7] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    check('light land color applied', !!doc.querySelector('svg path[fill="#c3d4e6"]'));
    check('still 6 streaks', streaks().length === 6, `got ${streaks().length}`);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
