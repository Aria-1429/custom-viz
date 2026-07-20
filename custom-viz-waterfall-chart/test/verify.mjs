// Waterfall Chart viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_waterfall_chart', 'visualization.js'
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

// 利益ブリッジ型（種別列あり: start/total は自動検出させる）
const BRIDGE = {
    fields: [{ name: '項目' }, { name: '増減' }, { name: '種別' }],
    rows: [
        ['期首', '500', 'start'],
        ['新規獲得', '300', ''],
        ['解約', '-150', ''],
        ['プラン変更', '80', ''],
        ['期末', '', 'total'],
    ],
};

let state = {
    data: BRIDGE,
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
const bars = () => [...doc.querySelectorAll('rect[data-role="wf-bar"]')];
const vals = () => [...doc.querySelectorAll('text[data-role="wf-val"]')].map((t) => t.textContent);

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 基本描画（利益ブリッジ・種別列は自動検出・dark） ----------------------
console.log('\n[1] bridge with auto-detected type column (dark)');
{
    const bs = bars();
    check('5 bars rendered', bs.length === 5, `got ${bs.length}`);
    check('bar1 is start (blue)', bs[0]?.getAttribute('data-type') === 'start' && bs[0]?.getAttribute('fill') === '#4f8ff7',
        bs[0] && `${bs[0].getAttribute('data-type')}/${bs[0].getAttribute('fill')}`);
    check('bar2 increase is green', bs[1]?.getAttribute('fill') === '#3fb950', bs[1]?.getAttribute('fill'));
    check('bar3 decrease is red', bs[2]?.getAttribute('fill') === '#f85149', bs[2]?.getAttribute('fill'));
    check('bar5 is total (blue)', bs[4]?.getAttribute('data-type') === 'total' && bs[4]?.getAttribute('fill') === '#4f8ff7',
        bs[4] && `${bs[4].getAttribute('data-type')}/${bs[4].getAttribute('fill')}`);
    const v = vals();
    check('value labels signed (+300 / -150)', v.includes('+300') && v.includes('-150'), JSON.stringify(v));
    check('total label unsigned 730', v.includes('730'), JSON.stringify(v));
    check('4 connectors', doc.querySelectorAll('line[data-role="wf-conn"]').length === 4);
    check('zero line rendered', !!doc.querySelector('line[data-role="wf-zero"]'));
    check('y-axis ticks rendered', doc.querySelectorAll('text[data-role="wf-tick"]').length >= 3);
    check('x labels rendered', doc.querySelectorAll('text[data-role="wf-xlabel"]').length === 5);
    check('tooltip has 累計', [...doc.querySelectorAll('rect[data-role="wf-bar"] title')].some((t) => t.textContent.includes('累計 800')));
    // バーの幾何: total バー(0→730) は start バー(0→500) より高い
    const h1 = Number(bs[0].getAttribute('height'));
    const h5 = Number(bs[4].getAttribute('height'));
    check('total bar taller than start bar', h5 > h1, `${h1} vs ${h5}`);
    // 減少バーは前の累計 800 から 650 へ下がる: y = y(800)
    const yBar2Top = Number(bs[1].getAttribute('y')) + 0; // 新規: 500→800, top=y(800)
    const yBar3Top = Number(bs[2].getAttribute('y')); // 解約: 800→650, top=y(800)
    check('decrease bar starts at previous level', Math.abs(yBar2Top - yBar3Top) < 1.5, `${yBar2Top} vs ${yBar3Top}`);
}

// ---- 2. 合計バーの自動追加（2列データ） ---------------------------------------
console.log('\n[2] auto total bar (2-column data)');
{
    await setData({
        fields: [{ name: 'ステップ' }, { name: 'count' }],
        rows: [['A', '100'], ['B', '-30'], ['C', '50']],
    });
    const bs = bars();
    check('3 deltas + auto total = 4 bars', bs.length === 4, `got ${bs.length}`);
    check('last bar is total', bs[3]?.getAttribute('data-type') === 'total');
    check('auto total label 合計 shown', doc.body.textContent.includes('合計'));
    check('total value 120', vals().includes('120'), JSON.stringify(vals()));

    await setOpts({ animate: false, showTotal: false });
    check('showTotal=false → 3 bars', bars().length === 3, `got ${bars().length}`);
    await setOpts({ animate: false });
}

// ---- 3. 色の変更・増減反転 ----------------------------------------------------
console.log('\n[3] color options / invertColors');
{
    await setOpts({ animate: false, increaseColor: '#ffaa00', totalColor: '#aa00ff' });
    let bs = bars();
    check('custom increase color applied', bs[0]?.getAttribute('fill') === '#ffaa00', bs[0]?.getAttribute('fill'));
    check('custom total color applied', bs[3]?.getAttribute('fill') === '#aa00ff', bs[3]?.getAttribute('fill'));

    await setOpts({ animate: false, invertColors: true });
    bs = bars();
    check('inverted: increase is red', bs[0]?.getAttribute('fill') === '#f85149', bs[0]?.getAttribute('fill'));
    check('inverted: decrease is green', bs[1]?.getAttribute('fill') === '#3fb950', bs[1]?.getAttribute('fill'));
    await setOpts({ animate: false });
}

// ---- 4. 累計値モード ----------------------------------------------------------
console.log('\n[4] cumulativeInput');
{
    await setData({
        fields: [{ name: '月' }, { name: 'ライセンス数' }],
        rows: [['1月', '100'], ['2月', '160'], ['3月', '130']],
    });
    await setOpts({ animate: false, cumulativeInput: true });
    const bs = bars();
    check('start + 2 deltas + total = 4 bars', bs.length === 4, `got ${bs.length}`);
    check('first bar is start', bs[0]?.getAttribute('data-type') === 'start');
    const v = vals();
    check('deltas derived (+60 / -30)', v.includes('+60') && v.includes('-30'), JSON.stringify(v));
    check('total equals last snapshot 130', v.filter((x) => x === '130').length >= 1, JSON.stringify(v));
    await setOpts({ animate: false });
}

// ---- 5. フィールド選択（columnSelector DOS 文字列） ---------------------------
console.log('\n[5] field selection via DOS string');
{
    await setData({
        fields: [{ name: 'step' }, { name: 'ignored' }, { name: 'diff' }],
        rows: [['s1', '999', '10'], ['s2', '999', '-4']],
    });
    await setOpts({ animate: false, valueField: "> primary | seriesByName('diff')" });
    const v = vals();
    check('values from diff column (+10 / -4)', v.includes('+10') && v.includes('-4'), JSON.stringify(v));
    check('total 6', v.includes('6'), JSON.stringify(v));
    await setOpts({ animate: false });
}

// ---- 6. 表示トグル ------------------------------------------------------------
console.log('\n[6] visibility toggles');
{
    await setData(BRIDGE);
    await setOpts({ animate: false, showValues: false });
    check('value labels hidden', vals().length === 0);
    await setOpts({ animate: false, showConnectors: false });
    check('connectors hidden', doc.querySelectorAll('line[data-role="wf-conn"]').length === 0);
    await setOpts({ animate: false, showAxis: false });
    check('axis ticks hidden', doc.querySelectorAll('text[data-role="wf-tick"]').length === 0);
    await setOpts({ animate: false, showXLabels: false });
    check('x labels hidden', doc.querySelectorAll('text[data-role="wf-xlabel"]').length === 0);
    await setOpts({ animate: false, showGlow: true });
    check('glow filter applied', bars().every((b) => (b.getAttribute('style') || '').includes('drop-shadow')));
    await setOpts({ animate: false });
}

// ---- 7. 省略表記・小数桁 ------------------------------------------------------
console.log('\n[7] abbreviate / decimals');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: [['a', '1200000'], ['b', '-300000']],
    });
    await setOpts({ animate: false, abbreviateValue: true });
    const v = vals();
    check('abbreviated +1.2M', v.includes('+1.2M'), JSON.stringify(v));
    check('abbreviated total 900K', v.includes('900K'), JSON.stringify(v));

    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [['a', '1.25'], ['b', '2.5']] });
    await setOpts({ animate: false, valueDecimals: 2 });
    check('decimals=2 → +1.25', vals().includes('+1.25'), JSON.stringify(vals()));
    await setOpts({ animate: false });
}

// ---- 8. 負の累計 --------------------------------------------------------------
console.log('\n[8] negative running total');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: [['a', '-100'], ['b', '-50']],
    });
    const bs = bars();
    check('3 bars (2 deltas + total)', bs.length === 3, `got ${bs.length}`);
    check('total -150 shown', vals().includes('-150'), JSON.stringify(vals()));
    const zero = doc.querySelector('line[data-role="wf-zero"]');
    const zeroY = Number(zero.getAttribute('y1'));
    // 減少バーはゼロ線より下（y が大きい）
    check('bars extend below zero line', Number(bs[0].getAttribute('y')) >= zeroY - 1, `${bs[0].getAttribute('y')} vs ${zeroY}`);
}

// ---- 9. columns 形式・1列データ ----------------------------------------------
console.log('\n[9] columns-form / single column');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }],
        columns: [['x', 'y'], ['40', '-10']],
    });
    check('columns-form renders (+40/-10, total 30)',
        vals().includes('+40') && vals().includes('-10') && vals().includes('30'), JSON.stringify(vals()));

    await setData({ fields: [{ name: 'v' }], rows: [['5'], ['7'], ['-2']] });
    const bs = bars();
    check('single-column → 4 bars with total 10', bs.length === 4 && vals().includes('10'),
        `${bs.length} bars, ${JSON.stringify(vals())}`);
}

// ---- 10. アニメーション -------------------------------------------------------
console.log('\n[10] grow animation reaches full height');
{
    await setData(BRIDGE);
    await setOpts({});
    await sleep(1300);
    const bs = bars();
    const conn = doc.querySelectorAll('line[data-role="wf-conn"]');
    check('bars have height after animation', bs.every((b) => Number(b.getAttribute('height')) > 1));
    check('connectors fully visible', [...conn].every((c) => Number(c.getAttribute('opacity')) === 1));
    await setOpts({ animate: false });
}

// ---- 11. テーマ切替 -----------------------------------------------------------
console.log('\n[11] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const tick = doc.querySelector('text[data-role="wf-tick"]');
    check('light-mode tick color', tick && tick.getAttribute('fill') === '#5c6773', tick && tick.getAttribute('fill'));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const tickDark = doc.querySelector('text[data-role="wf-tick"]');
    check('dark-mode tick color', tickDark && tickDark.getAttribute('fill') === '#8b98a5', tickDark && tickDark.getAttribute('fill'));
}

// ---- 12. ガード ---------------------------------------------------------------
console.log('\n[12] guards');
{
    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [['a', 'xyz'], ['b', 'www']] });
    check('non-numeric message', doc.body.textContent.includes('数値データ'));

    await setData(BRIDGE);
    check('recovers after guard', bars().length === 5, `got ${bars().length}`);
}

// ---- 13. debug オーバーレイ ----------------------------------------------------
console.log('\n[13] debug overlay');
{
    await setOpts({ animate: false, debug: true });
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
    await setOpts({ animate: false });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
