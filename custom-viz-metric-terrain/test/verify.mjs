// Metric Terrain viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_metric_terrain', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 640 });
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
// rAF は setTimeout で代替（ループが回るよう毎回スケジュール）
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now ? performance.now() : Date.now()), 8);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (typeof globalThis.performance === 'undefined') {
    globalThis.performance = { now: () => Date.now() };
}

// コンテナ実寸を固定（オートフィット系のため）
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 640 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 640, width: 900, height: 640, x: 0, y: 0 };
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

// tidy 形式: 3x3 グリッド。値が明確に高低差を持つ。
const TIDY_FIELDS = [{ name: 'host' }, { name: 'hour' }, { name: 'cpu' }];
const TIDY_ROWS = [
    ['web01', 'h1', '10'], ['web01', 'h2', '20'], ['web01', 'h3', '30'],
    ['web02', 'h1', '40'], ['web02', 'h2', '90'], ['web02', 'h3', '50'], // 90 が最大（peak）
    ['web03', 'h1', '15'], ['web03', 'h2', '25'], ['web03', 'h3', '5'],  // 5 が最小
    ['web01', 'h1', '5'],  // 同一セル合算 → web01/h1 = 15
    ['web03', 'x', 'abc'], // 非数値 → 無視
];

let state = {
    data: { fields: TIDY_FIELDS, rows: TIDY_ROWS },
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
    getDimensions: () => ({ width: 900, height: 640 }),
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
await sleep(400);

// ---- 1. tidy 形式（3x3, dark, 自動回転OFFで安定検証） ----------------------
console.log('\n[1] tidy grid 3x3 (dark)');
{
    // 回転を止めて安定させる
    state.options = { autoRotate: false };
    fire('options', { options: state.options });
    await sleep(300);

    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    const faces = [...doc.querySelectorAll('polygon.mt-face')];
    check('9 surface faces (3x3)', faces.length === 9, `got ${faces.length}`);
    check('faces have points', faces.every((p) => (p.getAttribute('points') || '').length > 5));
    check('faces filled with rgb', faces.every((p) => (p.getAttribute('fill') || '').startsWith('rgb(')));
    // ワイヤー既定 ON
    const wires = [...doc.querySelectorAll('polygon.mt-wire')];
    check('9 wire polygons', wires.length === 9, `got ${wires.length}`);
    check('wires have stroke', wires.every((p) => (p.getAttribute('stroke') || '').includes('rgba')));
    // 土台既定 ON（側面）
    const sides = [...doc.querySelectorAll('polygon.mt-side')];
    check('side faces present', sides.length > 0, `got ${sides.length}`);
    // ヘッダー: 最大 90、最小 5
    const header = doc.body.textContent;
    check('header shows grid 3×3', header.includes('3×3'), header.slice(0, 200));
    check('header max 90', header.includes('90'));
    check('header min 5', header.includes('5'));
    // 凡例グラデーション（backgroundImage を検査。happy-dom は shorthand background を落とす）
    // happy-dom は background-image の linear-gradient を style から落とすので、
    // 算出したグラデーション文字列を data-gradient に載せて検証する（実機の style には反映される）。
    const legendEl = doc.querySelector('[data-legend="scale"]');
    check('legend bar present', !!legendEl);
    const grad = legendEl && legendEl.getAttribute('data-gradient');
    check('legend gradient computed', !!grad && grad.includes('linear-gradient') && grad.includes('rgb('),
        grad || '(none)');
}

// ---- 2. 標高カラースケール（peak 強調） -------------------------------------
console.log('\n[2] elevation color scale');
{
    state.options = {
        autoRotate: false,
        lowColor: '#0000ff', midColor: '#00ff00', highColor: '#ffff00',
        useMidColor: true, usePeakColor: true, peakColor: '#ff0000',
    };
    fire('options', { options: state.options });
    await sleep(300);
    const fills = [...doc.querySelectorAll('polygon.mt-face')].map((p) => p.getAttribute('fill'));
    // 何らかの面が青系（低）に、別の面が黄～赤系（高）に寄っているはず
    const rgbs = fills.map((s) => s.match(/rgb\((\d+),(\d+),(\d+)\)/)).filter(Boolean).map((m) => ({ r: +m[1], g: +m[2], b: +m[3] }));
    check('has bluish low face', rgbs.some((c) => c.b > c.r && c.b > c.g), JSON.stringify(rgbs.slice(0, 3)));
    check('has warm high face (r dominant)', rgbs.some((c) => c.r > 120 && c.r >= c.b), JSON.stringify(rgbs.slice(0, 3)));
}

// ---- 3. reverse 反転 --------------------------------------------------------
console.log('\n[3] reverse');
{
    const before = [...doc.querySelectorAll('polygon.mt-face')].map((p) => p.getAttribute('fill'));
    state.options = { ...state.options, reverse: true };
    fire('options', { options: state.options });
    await sleep(300);
    const after = [...doc.querySelectorAll('polygon.mt-face')].map((p) => p.getAttribute('fill'));
    // 反転で色配置が変わる（完全一致でない）
    check('reverse changes fills', JSON.stringify(before) !== JSON.stringify(after));
}

// ---- 4. 回転アニメーション（yaw が進むと points が変わる） -------------------
console.log('\n[4] auto-rotate animates geometry');
{
    state.options = { autoRotate: true, rotateSpeed: 300 };
    fire('options', { options: state.options });
    await sleep(120);
    const snap1 = [...doc.querySelectorAll('polygon.mt-face')].map((p) => p.getAttribute('points'));
    await sleep(320);
    const snap2 = [...doc.querySelectorAll('polygon.mt-face')].map((p) => p.getAttribute('points'));
    check('geometry changes over time (rotation)', JSON.stringify(snap1) !== JSON.stringify(snap2));
}

// ---- 5. matrix 形式（chart 出力）を自動判別 ---------------------------------
console.log('\n[5] matrix form auto-detected');
{
    state.options = { autoRotate: false };
    state.data = {
        fields: [{ name: 'region' }, { name: 'Q1' }, { name: 'Q2' }, { name: 'Q3' }, { name: 'Q4' }],
        rows: [
            ['APAC', '10', '20', '30', '40'],
            ['EMEA', '50', '60', '70', '80'],
        ],
    };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(320);
    const faces = [...doc.querySelectorAll('polygon.mt-face')];
    // 2 行 × 4 列 = 8 セル
    check('8 faces (2x4 matrix)', faces.length === 8, `got ${faces.length}`);
    const header = doc.body.textContent;
    check('header grid 4×2', header.includes('4×2'), header.slice(0, 200));
    check('header max 80', header.includes('80'));
}

// ---- 6. テーマ切替（light では影/グロー無し） -------------------------------
console.log('\n[6] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(320);
    const faces = [...doc.querySelectorAll('polygon.mt-face')];
    check('faces still render in light', faces.length === 8, `got ${faces.length}`);
    // light では glow filter は付かない
    check('no glow filter in light', faces.every((p) => p.getAttribute('filter') !== 'url(#mt-glow)'));
    // light では接地影は敷かれない（shadow プールが空）
    const shadows = [...doc.querySelectorAll('polygon.mt-shadow')];
    check('no ground shadow in light', shadows.length === 0, `got ${shadows.length}`);
}

// ---- 7. ガード（空データ / 列不足） ----------------------------------------
console.log('\n[7] guards');
{
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    state.data = { fields: TIDY_FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('empty data message', doc.body.textContent.includes('表示できるデータがありません'));

    // 全行非数値 → 空グリッド → メッセージ
    state.data = { fields: TIDY_FIELDS, rows: [['a', 'b', 'xyz'], ['c', 'd', 'zzz']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('all-invalid message', doc.body.textContent.includes('表示できるデータがありません'));

    // columns 形式でも動く（tidy 3列）
    state.data = {
        fields: TIDY_FIELDS,
        columns: [['a', 'a', 'b'], ['p', 'q', 'p'], ['1', '2', '3']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    const faces = [...doc.querySelectorAll('polygon.mt-face')];
    // x={a,b}, y={p,q} → 2x2 = 4 セル
    check('columns-form renders 4 faces', faces.length === 4, `got ${faces.length}`);
}

// ---- 8. スタイルトグル（ワイヤー/土台 OFF） --------------------------------
console.log('\n[8] style toggles');
{
    state.data = { fields: TIDY_FIELDS, rows: TIDY_ROWS };
    state.options = { autoRotate: false, wireframe: false, showBase: false, showShadow: false };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(320);
    check('no wires when off', doc.querySelectorAll('polygon.mt-wire').length === 0);
    check('no sides when base off', doc.querySelectorAll('polygon.mt-side').length === 0);
    check('faces still present', doc.querySelectorAll('polygon.mt-face').length === 9);
}

// ---- 9. debug オーバーレイ --------------------------------------------------
console.log('\n[9] debug overlay');
{
    state.options = { autoRotate: false, debug: true };
    fire('options', { options: state.options });
    await sleep(250);
    check('debug dump visible', doc.body.textContent.includes('rawOptions'));
    check('debug shows grid', doc.body.textContent.includes('"count"'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
