// Radial Bar viz のローカル検証（happy-dom、Splunk実機なし）
// バンドル済み dist/.../visualization.js を実行し、描画・オプション反映・ガード・
// フィールド選択（columnSelector DOS 文字列）・mv セル救済・値ベース色を検証する。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_radial_bar', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 700, height: 640 });
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

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 700 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 640 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 700, bottom: 640, width: 700, height: 640, x: 0, y: 0 };
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

const FIELDS = [{ name: 'product_group' }, { name: 'revenue' }];
const ROWS = [
    ['DC-SG-G02', '9,800'],   // カンマ付き数値の正規化を検証
    ['MB-AG-G07', '8200'],
    ['WC-SH-G05', '7100'],
    ['DB-SG-G01', '6400'],
    ['FI-AG-G08', '5600'],
    ['FS-SG-G03', '4900'],
    ['SC-MG-G10', '4100'],
    ['MG-G09', '3300'],
    ['CU-PG-G06', '2600'],
    ['MB-AG-T01', '13'],
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
    getDimensions: () => ({ width: 700, height: 640 }),
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

// ホバー当たり判定レイヤーの path（<title> を持ち fill=transparent）。1カテゴリ=1枚。
const hitPaths = () => [...doc.querySelectorAll('svg path')].filter(
    (p) => p.querySelector('title') && (p.getAttribute('fill') === 'transparent')
);
// 本体バー（色付き path）。track(rgba) / sheen(url()) / hit(transparent) は fill で除外、
// glow レイヤー（親 g に filter=glow）は親で除外。残る実色 path が本体バー1本ずつ。
const barPaths = () => [...doc.querySelectorAll('svg path')].filter((p) => {
    const f = p.getAttribute('fill') || '';
    if (!/^(#|rgb\()/.test(f)) return false; // 実色（hex か rgb()）のみ。rgba/url/transparent 除外
    const pg = p.parentElement;
    if (pg && (pg.getAttribute('filter') || '').includes('glow')) return false; // glow 除外
    return true;
});

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(450);

// ---- 1. 既定描画（10件・値ベース色・中央合計） --------------------------------
console.log('\n[1] default render (dark, valueColors)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    // 有効行 10件。不正3行は除去。maxBars=12 なので全 10 本描画。
    const bars = barPaths();
    check('10 bars', bars.length === 10, `got ${bars.length}`);
    const header = doc.body.textContent;
    // 合計 = 9800+8200+7100+6400+5600+4900+4100+3300+2600+13 = 52013
    check('center total 52,013', header.includes('52,013'), header.slice(0, 160));
    check('title from field name (PRODUCT GROUP)', header.includes('PRODUCT GROUP'), header.slice(0, 80));
    check('label DC-SG-G02 shown', header.includes('DC-SG-G02'));
    // 値ベース色: 最大値バーは high色(#38bdf8=rgb(56,189,248))寄り、最小はlow色寄り
    const fills = bars.map((p) => p.getAttribute('fill'));
    check('bars use rgb() value-scale colors', fills.some((f) => /^rgb\(/.test(f)), JSON.stringify(fills.slice(0, 3)));
}

// ---- 1b. 背景トラック（グレー部分）にホバー → 中央がそのカテゴリにフォーカス ----
console.log('\n[1b] hover on hit-area (grey track) focuses category in center');
{
    const hits = hitPaths();
    check('one hit-area path per bar (10)', hits.length === 10, `got ${hits.length}`);
    // 最大値 DC-SG-G02(9800) のスライスにホバー。中央値がそのバーの値になるはず。
    hits[0].dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: true }));
    await sleep(150);
    const focused = doc.body.textContent;
    check('center swaps to hovered value (9,800)', focused.includes('9,800'), focused.slice(0, 160));
    check('center swaps to hovered label (DC-SG-G02)', focused.includes('DC-SG-G02'));
    hits[0].dispatchEvent(new win.MouseEvent('mouseleave', { bubbles: true }));
    await sleep(150);
    check('center returns to total (52,013) after leave', doc.body.textContent.includes('52,013'), doc.body.textContent.slice(0, 160));
}

// ---- 2. maxBars を絞る（上位のみ・切り捨て） ----------------------------------
console.log('\n[2] maxBars=5 → keep top 5');
{
    state.options = { maxBars: 5 };
    fire('options', { options: state.options });
    await sleep(250);
    const bars = barPaths();
    check('5 bars after limit', bars.length === 5, `got ${bars.length}`);
    // 上位5 = DC(9800),MB-AG-G07(8200),WC(7100),DB(6400),FI(5600)。最小の T01(13) は落ちる。
    check('smallest bar dropped', !doc.body.textContent.includes('MB-AG-T01'), doc.body.textContent.slice(0, 200));
}

// ---- 3. 値ベース色OFF → カテゴリ別色の反映 ------------------------------------
console.log('\n[3] useValueColors=false → per-category colors');
{
    state.options = { maxBars: 12, useValueColors: false, color1: '#ff0000', color2: '#00ff00' };
    fire('options', { options: state.options });
    await sleep(250);
    const fills = barPaths().map((p) => p.getAttribute('fill'));
    check('color1 applied to largest bar', fills.includes('#ff0000'), JSON.stringify(fills.slice(0, 3)));
    check('color2 applied to 2nd bar', fills.includes('#00ff00'));
}

// ---- 4. フィールド選択（columnSelector DOS 文字列） ---------------------------
console.log('\n[4] field selection via DOS strings');
{
    state.data = {
        fields: [{ name: 'host' }, { name: 'category' }, { name: 'bytes' }],
        rows: [
            ['h1', 'web', '300'],
            ['h2', 'db', '700'],
            ['h3', 'cache', '0'],
        ],
    };
    state.options = {
        categoryField: "> primary | seriesByName('category')",
        valueField: "> primary | seriesByName('bytes')",
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const header = doc.body.textContent;
    check('title from selected category field (CATEGORY)', header.includes('CATEGORY'), header.slice(0, 80));
    check('labels use category values (web/db)', header.includes('web') && header.includes('db'));
    check('total = 1,000', header.includes('1,000'), header.slice(0, 160));
    // seriesByIndex でも解決できる
    state.options = { categoryField: "> primary | seriesByIndex(0)", valueField: "> primary | seriesByIndex(2)" };
    fire('options', { options: state.options });
    await sleep(200);
    check('seriesByIndex resolves category=host', doc.body.textContent.includes('HOST'), doc.body.textContent.slice(0, 80));
}

// ---- 5. マルチバリューセル救済 -----------------------------------------------
console.log('\n[5] multivalue cell rescue (parallel expand)');
{
    state.data = {
        fields: FIELDS,
        rows: [
            [['A', 'B', 'C'], ['100', '40', '10']],
        ],
    };
    state.options = { maxBars: 12 };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const bars = barPaths();
    check('mv expanded to 3 bars', bars.length === 3, `got ${bars.length}`);
    const header = doc.body.textContent;
    check('total = 150 (no digit concat)', header.includes('150'), header.slice(0, 160));
    check('label is A not the whole array', header.includes('A') && !header.includes('A,B'));
}

// ---- 6. USD 接頭辞（中央合計に $） -------------------------------------------
console.log('\n[6] usdCenter=true → $ prefix on center total');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { usdCenter: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    check('center shows $52,013', doc.body.textContent.includes('$52,013'), doc.body.textContent.slice(0, 160));
}

// ---- 7. テーマ切替 -----------------------------------------------------------
console.log('\n[7] theme switch to light');
{
    state.options = {};
    fire('options', { options: state.options });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    // 中央合計テキストのライトモード色 #141a30
    const texts = [...doc.querySelectorAll('svg text')];
    const anyLight = texts.some((t) => /#141a30/i.test(t.getAttribute('style') || ''));
    check('center value uses light-mode color', anyLight, texts.map((t) => (t.getAttribute('style') || '').slice(0, 30)).join(' | ').slice(0, 160));
}

// ---- 8. ガード（空データ / columns 形式 / 全行不正） --------------------------
console.log('\n[8] guards');
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
    const bars = barPaths();
    check('columns-form renders 2 bars', bars.length === 2, `got ${bars.length}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
