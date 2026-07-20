// Bullet Graph viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_bullet_graph', 'visualization.js'
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

// 目標・前回列は名前で自動検出させる（達成率: 売上82%=可 / 新規顧客110%=良 / 応答率55%=不可）
const KPIS = {
    fields: [{ name: 'KPI' }, { name: '実績' }, { name: '目標' }, { name: '前回' }],
    rows: [
        ['売上', '8200', '10000', '7900'],
        ['新規顧客', '132', '120', '95'],
        ['応答率', '55', '100', '60'],
    ],
};

let state = {
    data: KPIS,
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
const bars = () => q('rect[data-role="bg-bar"]');
const targets = () => q('rect[data-role="bg-target"]');
const compares = () => q('rect[data-role="bg-compare"]');
const bandRects = () => q('rect[data-role="bg-band"]');
const labels = () => q('text[data-role="bg-label"]').map((t) => t.textContent);
const vals = () => q('text[data-role="bg-val"]').map((t) => t.textContent);
const pcts = () => q('text[data-role="bg-pct"]').map((t) => t.textContent);

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 基本描画（目標・前回列は名前で自動検出・dark） ------------------------
console.log('\n[1] basic rendering with auto-detected target/compare (dark)');
{
    const bs = bars();
    check('3 rows rendered', q('g[data-role="bg-row"]').length === 3, `got ${q('g[data-role="bg-row"]').length}`);
    check('3 measure bars', bs.length === 3, `got ${bs.length}`);
    check('9 band rects (3 per row)', bandRects().length === 9, `got ${bandRects().length}`);
    check('3 target ticks (auto-detected 目標)', targets().length === 3, `got ${targets().length}`);
    check('3 compare markers (auto-detected 前回)', compares().length === 3, `got ${compares().length}`);
    check('row1 status=warn (82%)', bs[0]?.getAttribute('data-status') === 'warn' && bs[0]?.getAttribute('fill') === '#d29922',
        bs[0] && `${bs[0].getAttribute('data-status')}/${bs[0].getAttribute('fill')}`);
    check('row2 status=good (110%)', bs[1]?.getAttribute('data-status') === 'good' && bs[1]?.getAttribute('fill') === '#3fb950',
        bs[1] && `${bs[1].getAttribute('data-status')}/${bs[1].getAttribute('fill')}`);
    check('row3 status=bad (55%)', bs[2]?.getAttribute('data-status') === 'bad' && bs[2]?.getAttribute('fill') === '#f85149',
        bs[2] && `${bs[2].getAttribute('data-status')}/${bs[2].getAttribute('fill')}`);
    check('labels rendered', labels().join(',') === '売上,新規顧客,応答率', labels().join(','));
    check('values formatted (8,200)', vals().includes('8,200'), JSON.stringify(vals()));
    check('percent shown (82% / 110% / 55%)',
        pcts().includes('82%') && pcts().includes('110%') && pcts().includes('55%'), JSON.stringify(pcts()));
    check('tooltip has 目標/達成率/前回', q('g[data-role="bg-row"] title').some((t) =>
        t.textContent.includes('目標 10,000') && t.textContent.includes('達成率 82%') && t.textContent.includes('前回 7,900')));
    // 幾何: 110% の行は実績バーの右端が目標ティックを超える
    const barEnd = Number(bs[1].getAttribute('x')) + Number(bs[1].getAttribute('width'));
    const tickX = Number(targets()[1].getAttribute('x'));
    check('over-target bar extends past target tick', barEnd > tickX, `${barEnd} vs ${tickX}`);
    // 幾何: 82% の行は実績バーの右端が目標ティックの手前
    const barEnd0 = Number(bs[0].getAttribute('x')) + Number(bs[0].getAttribute('width'));
    const tickX0 = Number(targets()[0].getAttribute('x'));
    check('under-target bar stops before target tick', barEnd0 < tickX0, `${barEnd0} vs ${tickX0}`);
}

// ---- 2. 英語名の自動検出・列順の入れ替え --------------------------------------
console.log('\n[2] english auto-detect / column order independence');
{
    await setData({
        fields: [{ name: 'kpi' }, { name: 'target' }, { name: 'value' }],
        rows: [['A', '200', '100']],
    });
    check('target column before value: pct=50%', pcts().includes('50%'), JSON.stringify(pcts()));
    check('status=bad (50% < 60%)', bars()[0]?.getAttribute('data-status') === 'bad');
}

// ---- 3. 目標の位置フォールバック・目標なし ------------------------------------
console.log('\n[3] positional target fallback / no target');
{
    await setData({
        fields: [{ name: 'name' }, { name: 'count' }, { name: 'baseline_x' }],
        rows: [['A', '80', '100']],
    });
    check('2nd numeric column used as target (80%)', pcts().includes('80%'), JSON.stringify(pcts()));

    await setData({
        fields: [{ name: 'name' }, { name: 'count' }],
        rows: [['A', '80'], ['B', '40']],
    });
    check('no target: no ticks, no percent', targets().length === 0 && pcts().length === 0,
        `${targets().length} ticks, ${JSON.stringify(pcts())}`);
    check('bands still rendered from max', bandRects().length === 6);
    check('values still shown', vals().includes('80') && vals().includes('40'), JSON.stringify(vals()));
}

// ---- 4. フィールド選択（columnSelector DOS 文字列） ---------------------------
console.log('\n[4] field selection via DOS string');
{
    await setData({
        fields: [{ name: 'kpi' }, { name: 'ignored' }, { name: 'v' }, { name: 't' }],
        rows: [['X', '999', '90', '120']],
    });
    await setOpts({
        animate: false,
        valueField: "> primary | seriesByName('v')",
        targetField: "> primary | seriesByName('t')",
    });
    check('value/target from selected columns (75%)', pcts().includes('75%'), JSON.stringify(pcts()));
    check('value 90 shown', vals().includes('90'), JSON.stringify(vals()));
    await setOpts({ animate: false });
}

// ---- 5. バンド境界（目標比% の変更・range 列の絶対値指定） ---------------------
console.log('\n[5] band boundaries: pct options / absolute range columns');
{
    await setData(KPIS);
    await setOpts({ animate: false, band2Pct: 80 });
    check('band2Pct=80 → 82% becomes good', bars()[0]?.getAttribute('data-status') === 'good',
        bars()[0]?.getAttribute('data-status'));
    await setOpts({ animate: false });

    await setData({
        fields: [{ name: 'KPI' }, { name: '実績' }, { name: '目標' }, { name: 'range1' }, { name: 'range2' }],
        rows: [['稼働率', '70', '60', '75', '90']],
    });
    // 実績70は目標60を超える(117%)が、絶対バンド range1=75 未満なので不可
    check('absolute ranges override pct bands (70 < 75 → bad)',
        bars()[0]?.getAttribute('data-status') === 'bad', bars()[0]?.getAttribute('data-status'));
    check('percent still vs target (117%)', pcts().includes('117%'), JSON.stringify(pcts()));
}

// ---- 6. 表示トグル・色オプション ----------------------------------------------
console.log('\n[6] visibility toggles / color options');
{
    await setData(KPIS);
    await setOpts({ animate: false, showBands: false });
    check('bands hidden', bandRects().length === 0);
    await setOpts({ animate: false, showTarget: false });
    check('target ticks hidden', targets().length === 0);
    await setOpts({ animate: false, showCompare: false });
    check('compare markers hidden', compares().length === 0);
    await setOpts({ animate: false, showValues: false });
    check('values and percent hidden', vals().length === 0 && pcts().length === 0);
    await setOpts({ animate: false, showPercent: false });
    check('percent hidden, values kept', pcts().length === 0 && vals().length === 3);
    await setOpts({ animate: false, useValueColors: false });
    check('single color mode', bars().every((b) => b.getAttribute('fill') === '#4f8ff7'),
        bars().map((b) => b.getAttribute('fill')).join(','));
    await setOpts({ animate: false, useValueColors: false, barColor: '#aa00ff' });
    check('custom bar color applied', bars().every((b) => b.getAttribute('fill') === '#aa00ff'));
    await setOpts({ animate: false, warnColor: '#ff8800' });
    check('custom warn color applied', bars()[0]?.getAttribute('fill') === '#ff8800', bars()[0]?.getAttribute('fill'));
    await setOpts({ animate: false });
}

// ---- 7. 同一スケール ----------------------------------------------------------
console.log('\n[7] sharedScale');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }, { name: 'target' }],
        rows: [['A', '50', '100'], ['B', '500', '1000']],
    });
    let ws = bars().map((b) => Number(b.getAttribute('width')));
    check('per-row scale: equal fractions → equal widths', Math.abs(ws[0] - ws[1]) < 1.5, ws.join(' vs '));
    await setOpts({ animate: false, sharedScale: true });
    ws = bars().map((b) => Number(b.getAttribute('width')));
    check('shared scale: row A much shorter', ws[0] < ws[1] * 0.2, ws.join(' vs '));
    await setOpts({ animate: false });
}

// ---- 8. 達成率で並べ替え ------------------------------------------------------
console.log('\n[8] sortByAchievement');
{
    await setData(KPIS);
    await setOpts({ animate: false, sortByAchievement: true });
    check('lowest achievement first', labels().join(',') === '応答率,売上,新規顧客', labels().join(','));
    await setOpts({ animate: false });
}

// ---- 9. columns 形式・1列データ・マルチバリュー救済 ---------------------------
console.log('\n[9] columns-form / single column / multivalue rescue');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }, { name: 'goal' }],
        columns: [['x', 'y'], ['40', '90'], ['100', '100']],
    });
    check('columns-form renders 2 rows', bars().length === 2, `got ${bars().length}`);
    check('columns-form pct (40% / 90%)', pcts().includes('40%') && pcts().includes('90%'), JSON.stringify(pcts()));

    await setData({ fields: [{ name: 'v' }], rows: [['5'], ['7']] });
    check('single-column: auto labels #1/#2', labels().join(',') === '#1,#2', labels().join(','));

    await setData({
        fields: [{ name: 'k' }, { name: 'v' }, { name: 'goal' }],
        rows: [[['A', 'B'], ['10', '20'], ['20', '20']]],
    });
    check('multivalue row expanded to 2 rows', bars().length === 2, `got ${bars().length}`);
    check('expanded pct (50% / 100%)', pcts().includes('50%') && pcts().includes('100%'), JSON.stringify(pcts()));
}

// ---- 10. 負値・目標ゼロ -------------------------------------------------------
console.log('\n[10] negative value / zero target');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }, { name: 'goal' }],
        rows: [['neg', '-5', '10'], ['zt', '5', '0']],
    });
    const bs = bars();
    check('negative value → zero-width bar', Number(bs[0]?.getAttribute('width')) === 0,
        bs[0]?.getAttribute('width'));
    check('negative value label shown', vals().includes('-5'), JSON.stringify(vals()));
    // 負値行(-5/10)の -50% は正当。目標ゼロ行の達成率だけが非表示になる
    check('zero target → no percent for that row', pcts().join(',') === '-50%', JSON.stringify(pcts()));
}

// ---- 11. アニメーション -------------------------------------------------------
console.log('\n[11] grow animation reaches full width');
{
    await setData(KPIS);
    await setOpts({});
    await sleep(1300);
    check('bars have width after animation', bars().every((b) => Number(b.getAttribute('width')) > 5),
        bars().map((b) => b.getAttribute('width')).join(','));
    check('target ticks fully visible', targets().every((t) => Number(t.getAttribute('opacity')) === 1));
    await setOpts({ animate: false });
}

// ---- 12. テーマ切替 -----------------------------------------------------------
console.log('\n[12] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const lab = doc.querySelector('text[data-role="bg-label"]');
    check('light-mode label color', lab && lab.getAttribute('fill') === '#2b3033', lab && lab.getAttribute('fill'));
    check('light-mode target tick color', targets()[0]?.getAttribute('fill') === '#2b3033', targets()[0]?.getAttribute('fill'));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const labD = doc.querySelector('text[data-role="bg-label"]');
    check('dark-mode label color', labD && labD.getAttribute('fill') === '#c9d1d9', labD && labD.getAttribute('fill'));
}

// ---- 13. 多数行はスクロール ---------------------------------------------------
console.log('\n[13] many rows → vertical scroll');
{
    const many = {
        fields: [{ name: 'k' }, { name: 'v' }, { name: 'goal' }],
        rows: Array.from({ length: 30 }, (_, i) => [`KPI-${i + 1}`, String(50 + i), '100']),
    };
    await setData(many);
    check('30 rows all rendered', bars().length === 30, `got ${bars().length}`);
    const svg = doc.querySelector('svg');
    check('svg taller than container (scrolls)', Number(svg.getAttribute('height')) > 560,
        svg.getAttribute('height'));
}

// ---- 14. 省略表記・小数桁 -----------------------------------------------------
console.log('\n[14] abbreviate / decimals');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }, { name: 'goal' }],
        rows: [['big', '1200000', '2000000']],
    });
    await setOpts({ animate: false, abbreviateValue: true });
    check('abbreviated 1.2M', vals().includes('1.2M'), JSON.stringify(vals()));
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }, { name: 'goal' }],
        rows: [['d', '1.25', '2']],
    });
    await setOpts({ animate: false, valueDecimals: 2 });
    check('decimals=2 → 1.25', vals().includes('1.25'), JSON.stringify(vals()));
    await setOpts({ animate: false });
}

// ---- 15. ガード ---------------------------------------------------------------
console.log('\n[15] guards');
{
    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [['a', 'xyz'], ['b', 'www']] });
    check('non-numeric message', doc.body.textContent.includes('数値データ'));

    await setData(KPIS);
    check('recovers after guard', bars().length === 3, `got ${bars().length}`);
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
