// Donut Timechart viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_donut_timechart', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 560 });
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
let VW = 900;
let VH = 560;
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VW });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VH });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
};

// ResizeObserver 簡易モック（observe 時に即 callback。手動 flush 用に集める）
const observers = [];
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { setTimeout(() => this.cb([]), 0); }
    disconnect() {}
    unobserve() {}
};
win.ResizeObserver = globalThis.ResizeObserver;
const resize = (w, h) => { VW = w; VH = h; observers.forEach((o) => o.cb([])); };

const root = doc.createElement('div');
root.id = 'root';
doc.body.appendChild(root);

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

// timechart 形式データ: _time, Protected, "At Risk", Offline
const TC_FIELDS = [{ name: '_time' }, { name: 'Protected' }, { name: 'At Risk' }, { name: 'Offline' }];
const TC_ROWS = [
    ['08:00', '820', '90', '30'],
    ['08:15', '840', '70', '25'],
    ['08:30', '855', '60', '20'],
    ['08:45', '1,180', '48', '15'],  // カンマ付き数値の正規化を検証（最新行）
];

let state = {
    data: { fields: TC_FIELDS, rows: TC_ROWS },
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
    getDimensions: () => ({ width: VW, height: VH }),
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
const setData = (data) => { state.data = data; fire('dataSources', { loading: false, dataSources: { primary: { data } } }); };
const setOptions = (o) => { state.options = o; fire('options', { options: o }); };

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. timechart モード ----------------------------------------------------
console.log('\n[1] timechart mode (_time + 3 series, dark)');
{
    const svgs = [...doc.querySelectorAll('svg')];
    check('donut svg + trend svg rendered', svgs.length >= 2, `got ${svgs.length}`);
    // ドーナツのセグメント本体（rotate g 内の circle。track 含むので数だけ確認）
    const circles = [...doc.querySelectorAll('svg circle')];
    check('donut has segment circles', circles.length >= 4, `got ${circles.length}`);
    const body = doc.body.textContent;
    // 最新行（08:45）: Protected 1180 → 凡例に 1,180
    check('legend shows latest Protected 1,180', body.includes('1,180'), body.slice(0, 300));
    check('legend shows series At Risk', body.includes('At Risk'));
    // Total = 1180+48+15 = 1,243
    check('total row = 1,243', body.includes('1,243'), body.slice(0, 300));
    // 中央: 最大セグメント(Protected)の割合 = 1180/1243 = 94.9%
    const donutTexts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('center shows top-segment percent 94.9%', donutTexts.some((t) => t === '94.9%'), JSON.stringify(donutTexts));
    // トレンド: 4点のポリライン。線パスは "M...L...L...L" で始まり、エリアパスは
    // その後ろに閉じ（L<W>,<H> L0,<H> Z）が付く。閉じの前までの M/L 数で点数を数える。
    const paths = [...doc.querySelectorAll('svg path')];
    const line = paths.find((p) => (p.getAttribute('d') || '').startsWith('M'));
    const lineHead = line ? line.getAttribute('d').replace(/\sL600,100.*$/, '') : '';
    check('trend line has 4 points', (lineHead.match(/[ML]/g) || []).length === 4,
        line && line.getAttribute('d'));
}

// ---- 2. glow OFF → セグメントが二重にならない ------------------------------
console.log('\n[2] glow off');
{
    setOptions({ glow: false });
    await sleep(250);
    // glow OFF なので filter g が消え、glow circle が無くなる
    const filters = [...doc.querySelectorAll('svg filter')];
    check('no glow filter defs', filters.length === 0, `got ${filters.length}`);
}

// ---- 3. centerPercent OFF → 中央が合計値 -----------------------------------
console.log('\n[3] centerPercent off → total in center');
{
    setOptions({ centerPercent: false });
    await sleep(250);
    const donutTexts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('center shows total 1,243', donutTexts.includes('1,243'), JSON.stringify(donutTexts));
    check('center sub label Total', donutTexts.includes('Total'));
}

// ---- 4. トレンド非表示 ------------------------------------------------------
console.log('\n[4] showSparkline off');
{
    setOptions({ showSparkline: false });
    await sleep(250);
    const svgs = [...doc.querySelectorAll('svg')];
    check('trend svg removed (only donut svg)', svgs.length === 1, `got ${svgs.length}`);
}

// ---- 5. 色オプションが反映される -------------------------------------------
console.log('\n[5] custom color applies to first segment');
{
    setOptions({ color1: '#123456', showSparkline: true });
    await sleep(250);
    const strokes = [...doc.querySelectorAll('svg circle')].map((c) => c.getAttribute('stroke'));
    check('segment uses custom color1 #123456', strokes.includes('#123456'), JSON.stringify(strokes));
}

// ---- 6. 時刻フィールドを DOS 文字列で指定 -----------------------------------
console.log('\n[6] timeField via columnSelector DOS string');
{
    // _time 以外の名前を時刻列に指定しても解決できること（ここでは Offline を軸に）
    setData({
        fields: [{ name: 'bucket' }, { name: 'ok' }, { name: 'ng' }],
        rows: [['t1', '10', '2'], ['t2', '20', '4'], ['t3', '30', '6']],
    });
    setOptions({ timeField: "> primary | seriesByName('bucket')" });
    await sleep(300);
    const svgs = [...doc.querySelectorAll('svg')];
    check('resolves non-_time time field → trend renders', svgs.length >= 2, `got ${svgs.length}`);
    const body = doc.body.textContent;
    // 最新行 t3: ok=30, ng=6 → total 36
    check('total 36 from resolved series', body.includes('36'), body.slice(0, 200));
}

// ---- 7. stats モード + フィールド指定 ---------------------------------------
console.log('\n[7] stats mode + category/value field selection');
{
    setData({
        fields: [{ name: 'status' }, { name: 'extra' }, { name: 'cnt' }],
        rows: [['Protected', 'x', '800'], ['At Risk', 'y', '120'], ['Offline', 'z', '40']],
    });
    // カテゴリ=status(第1列), 値=cnt(第3列)を明示指定。extra(第2列)は無視される
    setOptions({ categoryField: "> primary | seriesByName('status')", valueField: "> primary | seriesByName('cnt')" });
    await sleep(300);
    const svgs = [...doc.querySelectorAll('svg')];
    check('stats mode: no trend chart (1 svg)', svgs.length === 1, `got ${svgs.length}`);
    const body = doc.body.textContent;
    check('value from cnt column: 800', body.includes('800'), body.slice(0, 200));
    check('total 960', body.includes('960'));
}

// ---- 8. マルチバリューセルの救済 --------------------------------------------
console.log('\n[8] multivalue cell rescue (parallel expand)');
{
    // 各セルが改行区切りの mv。全列のトークン数が揃う行は平行展開される。
    setData({
        fields: [{ name: 'status' }, { name: 'cnt' }],
        rows: [['Protected\nAt Risk\nOffline', '500\n300\n200']],
    });
    setOptions({});
    await sleep(300);
    const body = doc.body.textContent;
    // 桁連結事故が起きていれば 500300200 のような巨大値になる。正しく展開されれば total 1,000
    check('mv rescued: total 1,000 (not concatenated)', body.includes('1,000'), body.slice(0, 200));
    check('mv rescued: no monster concat value', !body.includes('500300200'), body.slice(0, 200));
    check('mv rescued: Protected label present', body.includes('Protected'));
}

// ---- 9. autoFit: リサイズで凡例フォントが変わる -----------------------------
console.log('\n[9] autoFit rescales legend on resize');
{
    setData({ fields: TC_FIELDS, rows: TC_ROWS });
    setOptions({ autoFit: true });
    await sleep(300);
    const legendSpanBig = [...doc.querySelectorAll('div span')].find((s) => s.textContent === 'Protected');
    const fsWide = legendSpanBig ? parseFloat(legendSpanBig.style.fontSize) : 0;
    resize(360, 560); // 狭くする → fontScale が下がる
    await sleep(300);
    const legendSpanSmall = [...doc.querySelectorAll('div span')].find((s) => s.textContent === 'Protected');
    const fsNarrow = legendSpanSmall ? parseFloat(legendSpanSmall.style.fontSize) : 0;
    check('legend font shrinks when panel narrows', fsNarrow > 0 && fsNarrow < fsWide, `wide ${fsWide} narrow ${fsNarrow}`);
    resize(900, 560);
    await sleep(200);
}

// ---- 10. テーマ切替 ---------------------------------------------------------
console.log('\n[10] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(300);
    // ライトモードのトラック色に切り替わる（centerLabel など light パレット）
    const svg = doc.querySelector('svg');
    check('still renders after theme switch', !!svg);
    const donutTexts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('center percent still present in light', donutTexts.some((t) => /%$/.test(t)));
}

// ---- 11. ガード（空データ / 列不足） ----------------------------------------
console.log('\n[11] guards');
{
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    setData({ fields: TC_FIELDS, rows: [] });
    await sleep(250);
    check('empty data → No data message', doc.body.textContent.includes('No data'));

    // 全行非数値 → items 0 → No data
    setData({ fields: [{ name: 'status' }, { name: 'cnt' }], rows: [['A', 'xyz'], ['B', 'nope']] });
    await sleep(250);
    check('all non-numeric → No data', doc.body.textContent.includes('No data'));

    // columns 形式でも動く
    setData({ fields: [{ name: 'status' }, { name: 'cnt' }], columns: [['A', 'B'], ['30', '10']] });
    await sleep(250);
    check('columns-form renders', !!doc.querySelector('svg circle'));
}

// ---- 12. debug オーバーレイ -------------------------------------------------
console.log('\n[12] debug overlay dumps normalized options');
{
    setData({ fields: TC_FIELDS, rows: TC_ROWS });
    setOptions({ debug: true });
    await sleep(250);
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
    check('debug shows mode timechart', doc.body.textContent.includes('timechart'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
