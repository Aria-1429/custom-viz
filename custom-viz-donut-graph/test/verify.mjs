// Donut Graph viz のローカル検証（happy-dom、Splunk実機なし）
// バンドル済み dist/.../visualization.js を実行し、描画・オプション反映・ガード・
// フィールド選択（columnSelector DOS 文字列）・mv セル救済を検証する。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_donut_graph', 'visualization.js'
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

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 500 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, x: 0, y: 0 };
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

const FIELDS = [{ name: 'log_level' }, { name: 'count' }];
const ROWS = [
    ['INFO', '494,612'],   // カンマ付き数値の正規化を検証
    ['WARN', '50669'],
    ['ERROR', '217'],
    ['DEBUG', '65'],
    ['TRACE', '12'],
    ['NONE', '1'],
    ['BAD', 'abc'],        // 非数値 → 除去
    ['NEG', '-5'],         // 0未満 → 除去
    ['', '99'],            // 空ラベル → 除去
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

// 本体セグメント circle のみ（glow レイヤーの複製は <title> を持たないので除外）
const bodySegs = () => [...doc.querySelectorAll('svg circle')].filter((c) => c.querySelector('title'));

// dasharray から各セグメントの弧長を取り出す（"len circumference"）
const arcLens = () => bodySegs()
    .map((c) => parseFloat((c.getAttribute('stroke-dasharray') || '0 0').split(' ')[0]))
    .filter((n) => Number.isFinite(n) && n > 0);

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 既定描画（6件 + Others 集約） ----------------------------------------
console.log('\n[1] default render (dark, maxSegments=6)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    // 有効行 6件（INFO,WARN,ERROR,DEBUG,TRACE,NONE）。不正3行は除去。
    // maxSegments=6 なので集約なしで 6 セグメント（本体レイヤーの circle）。
    const segCircles = bodySegs();
    check('6 body segments', segCircles.length === 6, `got ${segCircles.length}`);
    const header = doc.body.textContent;
    // 合計 = 494612+50669+217+65+12+1 = 545576
    check('center total 545,576', header.includes('545,576'), header.slice(0, 120));
    check('title from field name (LOG LEVEL)', header.includes('LOG LEVEL'), header.slice(0, 60));
    check('legend shows INFO', header.includes('INFO'));
    // 割合バー（既定 ON）と パーセント（既定 ON）
    check('legend shows a percent', /%/.test(header));
    // 最大セグメント INFO は最大弧長
    const lens = arcLens();
    check('6 arcs drawn', lens.length === 6, `got ${lens.length}`);
    check('largest arc is substantial', Math.max(...lens) > 200, `max=${Math.max(...lens)}`);
}

// ---- 2. maxSegments を絞って Others 集約 --------------------------------------
console.log('\n[2] maxSegments=3 → Others aggregation');
{
    state.options = { maxSegments: 3 };
    fire('options', { options: state.options });
    await sleep(250);
    // 上位2 + Others = 3 セグメント
    const segCircles = bodySegs();
    check('3 segments after aggregation', segCircles.length === 3, `got ${segCircles.length}`);
    check('Others label with count', doc.body.textContent.includes('Others (4)'), doc.body.textContent.slice(0, 200));
}

// ---- 3. 色オプションの反映 ----------------------------------------------------
console.log('\n[3] custom segment colors');
{
    state.options = { maxSegments: 6, color1: '#ff0000', color2: '#00ff00' };
    fire('options', { options: state.options });
    await sleep(250);
    const strokes = bodySegs().map((c) => c.getAttribute('stroke'));
    check('color1 applied to largest segment', strokes.includes('#ff0000'), JSON.stringify(strokes));
    check('color2 applied to 2nd segment', strokes.includes('#00ff00'));
}

// ---- 4. フィールド選択（columnSelector DOS 文字列） ---------------------------
console.log('\n[4] field selection via DOS strings');
{
    state.data = {
        fields: [{ name: 'host' }, { name: 'category' }, { name: 'bytes' }],
        rows: [
            ['h1', 'web', '300'],
            ['h2', 'db', '700'],
            ['h3', 'web', '0'],
        ],
    };
    // カテゴリ=category, 値=bytes を DOS 文字列で選択（実機と同じ届き方）
    state.options = {
        categoryField: "> primary | seriesByName('category')",
        valueField: "> primary | seriesByName('bytes')",
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const header = doc.body.textContent;
    check('title from selected category field (CATEGORY)', header.includes('CATEGORY'), header.slice(0, 60));
    check('legend uses category values (web/db)', header.includes('web') && header.includes('db'));
    check('total = 1,000', header.includes('1,000'), header.slice(0, 120));
    // seriesByIndex でも解決できる
    state.options = { categoryField: "> primary | seriesByIndex(0)", valueField: "> primary | seriesByIndex(2)" };
    fire('options', { options: state.options });
    await sleep(200);
    check('seriesByIndex resolves category=host', doc.body.textContent.includes('HOST'), doc.body.textContent.slice(0, 60));
}

// ---- 5. マルチバリューセル救済 -----------------------------------------------
console.log('\n[5] multivalue cell rescue (parallel expand)');
{
    // 1行のセルに配列（mvexpand し忘れ相当）。全列トークン数一致 → 平行展開されるはず。
    state.data = {
        fields: FIELDS,
        rows: [
            [['INFO', 'WARN', 'ERROR'], ['100', '40', '10']],
        ],
    };
    state.options = { maxSegments: 6 };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const segCircles = bodySegs();
    check('mv expanded to 3 segments', segCircles.length === 3, `got ${segCircles.length}`);
    const header = doc.body.textContent;
    // 桁連結が起きていなければ合計 = 150
    check('total = 150 (no digit concat)', header.includes('150'), header.slice(0, 120));
    check('label is INFO not the whole array', header.includes('INFO') && !header.includes('INFO,WARN'));
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
    const bigText = [...doc.querySelectorAll('svg text')][0];
    // fill は style 経由。ライトモードの centerValue = #141a30
    const fillStyle = bigText ? (bigText.getAttribute('style') || '') : '';
    check('center value uses light-mode color', /#141a30/i.test(fillStyle), fillStyle.slice(0, 120));
}

// ---- 7. ガード（空データ / columns 形式 / 全行不正） --------------------------
console.log('\n[7] guards');
{
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty → No data', doc.body.textContent.includes('No data'));

    state.data = { fields: FIELDS, rows: [['a', 'xyz'], ['', '5'], ['c', '-1']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('all invalid → No data', doc.body.textContent.includes('No data'));

    // columns 形式でも動く
    state.data = { fields: FIELDS, columns: [['A', 'B'], ['10', '20']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    const segCircles = bodySegs();
    check('columns-form renders 2 segments', segCircles.length === 2, `got ${segCircles.length}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
