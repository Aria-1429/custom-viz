// Heat Matrix viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_heat_matrix', 'visualization.js'
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now ? performance.now() : 16), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (typeof performance === 'undefined') globalThis.performance = { now: () => 16 };

// コンテナ実寸を固定（オートフィット系のため）
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 560 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 560, width: 900, height: 560, x: 0, y: 0 };
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

// クロス集計（chart 出力相当）: 行=host、列=ログレベル。min=0 / max=200 / 総計=515
const MATRIX = {
    fields: [{ name: 'host' }, { name: 'ERROR' }, { name: 'WARN' }, { name: 'INFO' }],
    rows: [
        ['web-01', '10', '40', '100'],
        ['web-02', '90', '20', '50'],
        ['db-01', '0', '5', '200'],
    ],
};
// 縦持ち（stats count by user, action 相当）。u1×login は重複行 → 合算 5+2=7
const TIDY = {
    fields: [{ name: 'user' }, { name: 'action' }, { name: 'count' }],
    rows: [
        ['u1', 'login', '5'],
        ['u1', 'logout', '3'],
        ['u2', 'login', '7'],
        ['u1', 'login', '2'],
    ],
};

let state = {
    data: MATRIX,
    options: { animate: false },
    theme: 'dark',
    mode: 'view',
};

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: 900, height: 560 }),
    addDimensionsListener: mkListener('dimensions'),
    getMode: () => ({ mode: state.mode }),
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
const setOpts = async (o) => {
    state.options = o;
    fire('options', { options: state.options });
    await sleep(250);
};
const setData = async (data) => {
    state.data = data;
    fire('dataSources', { loading: false, dataSources: { primary: { data } } });
    await sleep(250);
};
const q = (sel) => [...doc.querySelectorAll(sel)];
const cells = () => q('rect[data-role="hm-cell"]');
const cellAt = (i, j) => doc.querySelector(`rect[data-role="hm-cell"][data-row="${i}"][data-col="${j}"]`);
const vals = () => q('text[data-role="hm-val"]').map((t) => t.textContent);
const xlabels = () => q('text[data-role="hm-xlabel"]').map((t) => t.textContent);
const ylabels = () => q('text[data-role="hm-ylabel"]').map((t) => t.textContent);
const rowTotals = () => q('text[data-role="hm-rowtotal"]').map((t) => t.textContent);
const colTotals = () => q('text[data-role="hm-coltotal"]').map((t) => t.textContent);
const legendRect = () => doc.querySelector('rect[data-role="hm-legend"]');
const legendMin = () => doc.querySelector('text[data-role="hm-legend-min"]')?.textContent;
const legendMax = () => doc.querySelector('text[data-role="hm-legend-max"]')?.textContent;

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. クロス集計の基本描画（dark） ------------------------------------------
console.log('\n[1] matrix (chart-style) basic rendering, dark');
{
    check('9 cells rendered', cells().length === 9, `got ${cells().length}`);
    check('y labels = hosts', ylabels().join(',') === 'web-01,web-02,db-01', ylabels().join(','));
    check('x labels = level columns', xlabels().join(',') === 'ERROR,WARN,INFO', xlabels().join(','));
    check('min cell (0) = low color', cellAt(2, 0)?.getAttribute('fill') === 'rgb(69,117,180)',
        cellAt(2, 0)?.getAttribute('fill'));
    check('max cell (200) = high color', cellAt(2, 2)?.getAttribute('fill') === 'rgb(215,48,39)',
        cellAt(2, 2)?.getAttribute('fill'));
    check('mid cell (100) = mid color', cellAt(0, 2)?.getAttribute('fill') === 'rgb(254,224,139)',
        cellAt(0, 2)?.getAttribute('fill'));
    check('values shown incl. 100 and 0', vals().includes('100') && vals().includes('0'), JSON.stringify(vals()));
    check('no empty cells in full matrix', cells().every((c) => c.getAttribute('data-empty') === '0'));
    check('legend rendered 0 → 200', legendRect() && legendMin() === '0' && legendMax() === '200',
        `${legendMin()} / ${legendMax()}`);
    const stops = q('linearGradient stop');
    check('legend gradient low→high', stops[0]?.getAttribute('stop-color') === 'rgb(69,117,180)'
        && stops[stops.length - 1]?.getAttribute('stop-color') === 'rgb(215,48,39)',
        stops.map((st) => st.getAttribute('stop-color')).join(','));
    // セル内テキストの自動コントラスト: 黄色セル=濃色文字 / 濃青セル=淡色文字
    const valTexts = q('text[data-role="hm-val"]');
    const midTxt = valTexts.find((t) => t.textContent === '100');
    const lowTxt = valTexts.find((t) => t.textContent === '0');
    check('auto contrast: dark text on light cell', midTxt?.getAttribute('fill') === '#14181c', midTxt?.getAttribute('fill'));
    check('auto contrast: light text on dark cell', lowTxt?.getAttribute('fill') === '#f5f7fa', lowTxt?.getAttribute('fill'));
    // ツールチップ: 値と全体比
    const tips = q('rect[data-role="hm-cell"] title').map((t) => t.textContent);
    check('tooltip has value + share', tips.some((t) => t.includes('web-01 × INFO: 100') && t.includes('全体の 19%')),
        JSON.stringify(tips.slice(0, 3)));
}

// ---- 2. 縦持ちの自動判別・重複合算・欠損セル ----------------------------------
console.log('\n[2] tidy auto-detect / duplicate aggregation / missing cell');
{
    await setData(TIDY);
    check('2x2 = 4 cells', cells().length === 4, `got ${cells().length}`);
    check('y labels = users', ylabels().join(',') === 'u1,u2', ylabels().join(','));
    check('x labels = actions', xlabels().join(',') === 'login,logout', xlabels().join(','));
    check('duplicate rows aggregated (5+2=7)', vals().includes('7'), JSON.stringify(vals()));
    const missing = cellAt(1, 1);
    check('missing combo is empty cell', missing?.getAttribute('data-empty') === '1');
    check('empty cell uses neutral fill', missing?.getAttribute('fill') === 'rgba(139,152,165,0.10)',
        missing?.getAttribute('fill'));
    check('no value text on empty cell', vals().length === 3, JSON.stringify(vals()));
    const tips = q('rect[data-role="hm-cell"] title').map((t) => t.textContent);
    check('empty cell tooltip says データなし', tips.some((t) => t.includes('u2 × logout: データなし')));
}

// ---- 3. フィールド明示選択（columnSelector DOS 文字列）で転置 ------------------
console.log('\n[3] explicit field selection transposes tidy data');
{
    await setOpts({
        animate: false,
        rowField: "> primary | seriesByName('action')",
        colField: "> primary | seriesByName('user')",
    });
    check('rows become actions', ylabels().join(',') === 'login,logout', ylabels().join(','));
    check('cols become users', xlabels().join(',') === 'u1,u2', xlabels().join(','));
    check('aggregation preserved (7)', vals().includes('7'), JSON.stringify(vals()));
    await setOpts({ animate: false });
}

// ---- 4. クロス集計で値フィールドを1列に絞る -----------------------------------
console.log('\n[4] matrix mode with single value column selected');
{
    await setData(MATRIX);
    await setOpts({ animate: false, valueField: "> primary | seriesByName('WARN')" });
    check('only WARN column shown', xlabels().join(',') === 'WARN' && cells().length === 3,
        `${xlabels().join(',')} / ${cells().length} cells`);
    check('WARN values shown', vals().includes('40') && vals().includes('5'), JSON.stringify(vals()));
    await setOpts({ animate: false });
}

// ---- 5. 色オプション（反転・中間色なし・カスタム色・スケール上限） --------------
console.log('\n[5] color options');
{
    await setOpts({ animate: false, reverseScale: true });
    check('reversed: min cell gets high color', cellAt(2, 0)?.getAttribute('fill') === 'rgb(215,48,39)',
        cellAt(2, 0)?.getAttribute('fill'));
    check('reversed legend gradient starts high color',
        q('linearGradient stop')[0]?.getAttribute('stop-color') === 'rgb(215,48,39)');

    await setOpts({ animate: false, useMidColor: false });
    // t=0.5 → low と high の中間: round((69+215)/2)=142, (117+48)/2=82.5→83, (180+39)/2=109.5→110
    check('no-mid: value 100 = lerp(low,high,0.5)', cellAt(0, 2)?.getAttribute('fill') === 'rgb(142,83,110)',
        cellAt(0, 2)?.getAttribute('fill'));

    await setOpts({ animate: false, lowColor: '#000000', highColor: '#ffffff', useMidColor: false });
    check('custom low color applied', cellAt(2, 0)?.getAttribute('fill') === 'rgb(0,0,0)',
        cellAt(2, 0)?.getAttribute('fill'));
    check('custom high color applied', cellAt(2, 2)?.getAttribute('fill') === 'rgb(255,255,255)',
        cellAt(2, 2)?.getAttribute('fill'));

    await setOpts({ animate: false, scaleMax: 400 });
    // max=200 は t=0.5 → 中間色
    check('scaleMax=400: value 200 = mid color', cellAt(2, 2)?.getAttribute('fill') === 'rgb(254,224,139)',
        cellAt(2, 2)?.getAttribute('fill'));
    check('legend max shows 400', legendMax() === '400', legendMax());
    await setOpts({ animate: false });
}

// ---- 6. 行ごとの色正規化 ------------------------------------------------------
console.log('\n[6] normalize by row');
{
    await setOpts({ animate: false, normalizeByRow: true });
    // 各行の最大値（INFO=100 / ERROR=90 / INFO=200）が行内で high color になる
    check('row max cells all high color',
        cellAt(0, 2)?.getAttribute('fill') === 'rgb(215,48,39)'
        && cellAt(1, 0)?.getAttribute('fill') === 'rgb(215,48,39)'
        && cellAt(2, 2)?.getAttribute('fill') === 'rgb(215,48,39)',
        [cellAt(0, 2), cellAt(1, 0), cellAt(2, 2)].map((c) => c?.getAttribute('fill')).join(','));
    check('row min cells all low color',
        cellAt(0, 0)?.getAttribute('fill') === 'rgb(69,117,180)'
        && cellAt(1, 1)?.getAttribute('fill') === 'rgb(69,117,180)'
        && cellAt(2, 0)?.getAttribute('fill') === 'rgb(69,117,180)');
    check('legend shows 低/高 with note', legendMin() === '低' && String(legendMax()).includes('行内'),
        `${legendMin()} / ${legendMax()}`);
    await setOpts({ animate: false });
}

// ---- 7. 行・列の合計 ----------------------------------------------------------
console.log('\n[7] row/column totals');
{
    await setOpts({ animate: false, showRowTotals: true, showColTotals: true });
    check('row totals 150/160/205', rowTotals().join(',') === '150,160,205', rowTotals().join(','));
    check('col totals 100/65/350', colTotals().join(',') === '100,65,350', colTotals().join(','));
    await setOpts({ animate: false });
}

// ---- 8. 合計順ソート ----------------------------------------------------------
console.log('\n[8] sort by totals');
{
    await setOpts({ animate: false, sortRowsByTotal: true });
    check('rows sorted by total desc', ylabels().join(',') === 'db-01,web-02,web-01', ylabels().join(','));
    await setOpts({ animate: false, sortColsByTotal: true });
    check('cols sorted by total desc', xlabels().join(',') === 'INFO,ERROR,WARN', xlabels().join(','));
    await setOpts({ animate: false });
}

// ---- 9. 表示トグル ------------------------------------------------------------
console.log('\n[9] visibility toggles');
{
    await setOpts({ animate: false, showValues: false });
    check('values hidden', vals().length === 0);
    await setOpts({ animate: false, showXLabels: false });
    check('x labels hidden', xlabels().length === 0);
    await setOpts({ animate: false, showYLabels: false });
    check('y labels hidden', ylabels().length === 0);
    await setOpts({ animate: false, showLegend: false });
    check('legend hidden', !legendRect());
    await setOpts({ animate: false });
}

// ---- 10. 時刻ラベルの自動整形 -------------------------------------------------
console.log('\n[10] time label formatting');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'web' }, { name: 'db' }],
        rows: [
            ['2026-07-20T10:00:00', '1', '2'],
            ['2026-07-20T11:00:00', '3', '4'],
            ['2026-07-20T12:00:00', '5', '6'],
        ],
    });
    check('same-day times → HH:MM', ylabels().join(',') === '10:00,11:00,12:00', ylabels().join(','));
    await setData({
        fields: [{ name: 'day' }, { name: 'a' }, { name: 'b' }],
        rows: [
            ['2026-07-18', '1', '2'],
            ['2026-07-19', '3', '4'],
            ['2026-07-20', '5', '6'],
        ],
    });
    check('date-only → M/D (local, no UTC shift)', ylabels().join(',') === '7/18,7/19,7/20', ylabels().join(','));
}

// ---- 11. columns 形式・マルチバリュー救済 -------------------------------------
console.log('\n[11] columns-form / multivalue rescue');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v1' }, { name: 'v2' }],
        columns: [['a', 'b'], ['1', '2'], ['3', '4']],
    });
    check('columns-form renders 2x2', cells().length === 4, `got ${cells().length}`);
    check('columns-form values', vals().includes('1') && vals().includes('4'), JSON.stringify(vals()));

    await setData({
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: [[['h1', 'h2'], ['10', '20']]],
    });
    check('multivalue row expanded to 2 rows', cells().length === 2, `got ${cells().length}`);
    check('expanded values 10/20', vals().includes('10') && vals().includes('20'), JSON.stringify(vals()));
}

// ---- 12. 多数行スクロール・列数上限の省略注記 ---------------------------------
console.log('\n[12] many rows scroll / column cap notice');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: Array.from({ length: 60 }, (_, i) => [`row-${i + 1}`, String(i + 1)]),
    });
    check('60 rows all rendered', cells().length === 60, `got ${cells().length}`);
    const svg = doc.querySelector('svg');
    check('svg taller than scroll area', Number(svg.getAttribute('height')) > 530, svg.getAttribute('height'));

    const wide = {
        fields: [{ name: 'k' }, ...Array.from({ length: 130 }, (_, j) => ({ name: `c${j + 1}` }))],
        rows: [
            ['r1', ...Array.from({ length: 130 }, (_, j) => String(j + 1))],
            ['r2', ...Array.from({ length: 130 }, (_, j) => String(130 - j))],
        ],
    };
    await setData(wide);
    check('columns capped at 120', cells().length === 240, `got ${cells().length}`);
    check('truncation notice shown', doc.body.textContent.includes('表示上限'),
        doc.body.textContent.slice(0, 80));
    check('tiny cells: values auto-hidden', vals().length === 0, `${vals().length} value texts`);
}

// ---- 13. テーマ切替 -----------------------------------------------------------
console.log('\n[13] theme switch to light');
{
    await setData(MATRIX);
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const lab = doc.querySelector('text[data-role="hm-ylabel"]');
    check('light-mode y label color', lab && lab.getAttribute('fill') === '#2b3033', lab && lab.getAttribute('fill'));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const labD = doc.querySelector('text[data-role="hm-ylabel"]');
    check('dark-mode y label color', labD && labD.getAttribute('fill') === '#c9d1d9', labD && labD.getAttribute('fill'));
}

// ---- 14. アニメーション -------------------------------------------------------
console.log('\n[14] fade-in animation completes');
{
    await setOpts({});
    await setData(MATRIX);
    await sleep(1200);
    check('cells fully opaque after animation', cells().every((c) => Number(c.getAttribute('opacity')) === 1),
        cells().map((c) => c.getAttribute('opacity')).join(','));
    await setOpts({ animate: false });
}

// ---- 15. ガード ---------------------------------------------------------------
console.log('\n[15] guards');
{
    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [['a', 'xyz'], ['b', 'www']] });
    check('non-numeric message', doc.body.textContent.includes('数値データ'));

    await setData(MATRIX);
    check('recovers after guard', cells().length === 9, `got ${cells().length}`);
}

// ---- 16. debug オーバーレイ ---------------------------------------------------
console.log('\n[16] debug overlay');
{
    await setOpts({ animate: false, debug: true });
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
    await setOpts({ animate: false });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
