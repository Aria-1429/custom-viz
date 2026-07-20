// Gradient Bar viz のローカル検証（happy-dom、Splunk実機なし）
// happy-dom は sankey-flow の node_modules から借用する（NODE_PATH 経由）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// happy-dom は gradient-bar には入れず、sankey-flow の node_modules から借用する
const HAPPY = join(HERE, '..', '..', 'custom-viz-sankey-flow', 'node_modules', 'happy-dom', 'lib', 'index.js');
const { Window } = await import(HAPPY);
const BUNDLE = join(HERE, '..', 'dist', 'custom_viz_gradient_bar', 'visualization.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
let VW = 900;
let VH = 500;
const win = new Window({ width: VW, height: VH });
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

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VW });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VH });

const observers = [];
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { setTimeout(() => this.cb([{ contentRect: { width: VW, height: VH } }]), 0); }
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

const FIELDS = [{ name: 'host_name' }, { name: 'count' }];
const ROWS = [
    ['web-01', '5,200'],   // カンマ付き数値の正規化を検証
    ['web-02', '1400'],
    ['db-01', '3600'],
    ['db-02', '1500'],
    ['cache-01', '900'],
    ['', '100'],           // 空ラベル → 除去
    ['bad', 'abc'],        // 非数値 → 除去
    ['neg', '-5'],         // 0未満 → 除去
];

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
    theme: 'dark',
    dims: { width: VW, height: VH },
};

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...state.options, ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: state.dims.width, height: state.dims.height }),
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
const setOptions = (patch) => { state.options = { ...state.options, ...patch }; fire('options', { options: state.options }); };

// バーの塗り div（背景に linear-gradient を持つ絶対配置要素）を集める
function bars() {
    return [...doc.querySelectorAll('div')].filter((d) => {
        const s = d.getAttribute('style') || '';
        return s.includes('linear-gradient') && s.includes('position: absolute');
    });
}
function barWidthPct(el) {
    const m = (el.getAttribute('style') || '').match(/width:\s*([\d.]+)%/);
    return m ? parseFloat(m[1]) : null;
}

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(300);

// ---- 1. 既定描画（降順ソート・全件） ---------------------------------------
console.log('\n[1] default render (dark, sort desc)');
{
    const b = bars();
    check('5 valid bars rendered (invalid rows dropped)', b.length === 5, `got ${b.length}`);
    const text = doc.body.textContent;
    check('title from field name shown (HOST NAME)', text.includes('HOST NAME'), text.slice(0, 120));
    check('comma value normalized: shows 5,200', text.includes('5,200'));
    check('percent shown', /%/.test(text));
    // 降順ソート: 最初のバーが最大値(5200) → width 100% 付近（axisMax=6000 なので ~86.7%）
    const w0 = barWidthPct(b[0]);
    check('first bar is widest (sorted desc)', b.every((x) => barWidthPct(x) <= w0 + 0.01), `w0=${w0}`);
    // 単色グラデーション既定: すべて同じ基準色 #9333ea を含む
    check('single-color gradient uses #9333ea', b.every((x) => (x.getAttribute('style') || '').includes('9333ea')));
}

// ---- 2. topN=3 ------------------------------------------------------------
console.log('\n[2] topN = 3');
setOptions({ topN: 3 });
await sleep(120);
{
    check('only 3 bars', bars().length === 3, `got ${bars().length}`);
    const text = doc.body.textContent;
    check('keeps top values (5,200 present)', text.includes('5,200'));
    check('drops small values (cache-01/900 gone)', !text.includes('cache-01'));
}

// ---- 3. sortByValue off → 検索結果順 --------------------------------------
console.log('\n[3] sortByValue = false (input order), topN reset');
setOptions({ topN: 0, sortByValue: false });
await sleep(120);
{
    const labels = [...doc.querySelectorAll('div[title]')].map((d) => d.getAttribute('title'));
    // 入力順の先頭は web-01
    check('first label is web-01 (input order)', labels[0] === 'web-01', JSON.stringify(labels));
}

// ---- 4. 値ベースのカラースケール ------------------------------------------
console.log('\n[4] useValueColors = true (green→red)');
setOptions({ sortByValue: true, sortAscending: false, useValueColors: true, useMidColor: false });
await sleep(150);
{
    const b = bars();
    // 最大値バー=high(#ef4d4d 近似)、最小値バー=low(#3fb950 近似)。
    // gradientFor は基準色を挟むので、最大バーの style に赤系、最小バーに緑系が出る想定。
    const styleMax = b[0].getAttribute('style') || '';
    const styleMin = b[b.length - 1].getAttribute('style') || '';
    // 補間結果は hex。赤成分/緑成分の優劣で判定する。
    const hexes = (s) => [...s.matchAll(/#([0-9a-f]{6})/gi)].map((m) => m[1]);
    const avg = (arr, i) => arr.reduce((sum, h) => sum + parseInt(h.slice(i, i + 2), 16), 0) / arr.length;
    const maxHex = hexes(styleMax);
    const minHex = hexes(styleMin);
    check('max-value bar is red-dominant', avg(maxHex, 0) > avg(maxHex, 2), styleMax.slice(0, 80));
    check('min-value bar is green-dominant', avg(minHex, 2) > avg(minHex, 0), styleMin.slice(0, 80));
    // 凡例（連続グラデーションバー）が出る
    const legend = [...doc.querySelectorAll('div')].some((d) => {
        const s = d.getAttribute('style') || '';
        return s.includes('linear-gradient') && /#ef4d4d|#3fb950|rgb/.test(s) && s.includes('height: 8px');
    });
    check('scale legend rendered', legend);
}

// ---- 5. reverse（高い値＝緑側） -------------------------------------------
console.log('\n[5] reverse = true');
setOptions({ reverse: true });
await sleep(150);
{
    const b = bars();
    const hexes = (s) => [...s.matchAll(/#([0-9a-f]{6})/gi)].map((m) => m[1]);
    const avg = (arr, i) => arr.reduce((sum, h) => sum + parseInt(h.slice(i, i + 2), 16), 0) / arr.length;
    const maxHex = hexes(b[0].getAttribute('style') || '');
    check('reversed: max-value bar now green-dominant', avg(maxHex, 2) > avg(maxHex, 0));
}

// ---- 6. 表示トグル（値・％・軸・トラック・発光を全部OFF） -----------------
console.log('\n[6] hide value/percent/axis/track/glow');
setOptions({
    useValueColors: false, reverse: false,
    showValue: false, showPercent: false, showAxis: false, showTrack: false, glow: false,
});
await sleep(150);
{
    const text = doc.body.textContent;
    check('no percent text', !/%/.test(text));
    // 軸目盛りの K 表記が消える
    check('no axis tick (6K) shown', !/\b6K\b/.test(text));
    const b = bars();
    check('bars still rendered', b.length === 5, `got ${b.length}`);
    check('glow off (no box-shadow with rgba)', b.every((x) => {
        const s = x.getAttribute('style') || '';
        return /box-shadow:\s*none/.test(s) || !/box-shadow/.test(s);
    }));
}

// ---- 7. showTitle off -----------------------------------------------------
console.log('\n[7] showTitle = false');
setOptions({ showTitle: false });
await sleep(120);
{
    check('title HOST NAME hidden', !doc.body.textContent.includes('HOST NAME'));
}

// ---- 8. barThickness 指定 -------------------------------------------------
console.log('\n[8] barThickness = 30');
setOptions({ showTitle: true, barThickness: 30 });
await sleep(120);
{
    const b = bars();
    // 親（height:30px の相対配置行）の高さを確認
    const hasThick = [...doc.querySelectorAll('div')].some((d) => /height:\s*30px/.test(d.getAttribute('style') || ''));
    check('row height honors barThickness=30', hasThick);
}

// ---- 9. ライトテーマ切替 --------------------------------------------------
console.log('\n[9] light theme');
setOptions({ barThickness: 0 });
state.theme = 'light';
fire('theme', { theme: 'light' });
await sleep(150);
{
    check('still renders 5 bars in light', bars().length === 5, `got ${bars().length}`);
    check('title uses light color #1f2440', (doc.body.innerHTML || '').includes('1f2440'));
}

// ---- 10. 空データガード ---------------------------------------------------
console.log('\n[10] empty data guard');
state.data = { fields: FIELDS, rows: [] };
fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
await sleep(150);
{
    check('shows No data message', doc.body.textContent.includes('No data available'));
    check('no bars rendered', bars().length === 0, `got ${bars().length}`);
}

// ---- 11. データ復帰 -------------------------------------------------------
console.log('\n[11] data returns');
state.data = { fields: FIELDS, rows: ROWS };
fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
await sleep(150);
{
    check('bars render again', bars().length === 5, `got ${bars().length}`);
}

// ---- 12. フィールド選択（3列データ・DOS 文字列/生名） ---------------------
console.log('\n[12] field selection (columnSelector)');
{
    // 3列: host, region, bytes。既定は label=第1列(host), value=第2列(region=非数値→全滅)
    const FIELDS3 = [{ name: 'host' }, { name: 'region' }, { name: 'bytes' }];
    const ROWS3 = [
        ['web-01', 'us', '5200'],
        ['web-02', 'eu', '1400'],
        ['db-01', 'us', '3600'],
    ];
    state.data = { fields: FIELDS3, rows: ROWS3 };
    state.options = {}; // 既定に戻す
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(150);

    // 既定（value=第2列=region）は非数値なので全行除外 → No data
    check('default value col (region, non-numeric) → No data', doc.body.textContent.includes('No data available'));

    // 値フィールドを DOS 文字列で bytes に、ラベルを生名 host に指定
    setOptions({
        valueField: "> primary | seriesByName('bytes')",
        labelField: 'host',
    });
    await sleep(150);
    check('after selecting bytes: 3 bars', bars().length === 3, `got ${bars().length}`);
    const text = doc.body.textContent;
    check('shows bytes value 5,200', text.includes('5,200'));
    check('title reflects label field (HOST)', text.includes('HOST'), text.slice(0, 120));

    // ラベルを region に、値を seriesByIndex(2)=bytes に切替
    setOptions({ labelField: "> primary | seriesByName('region')", valueField: '> primary | seriesByIndex(2)' });
    await sleep(150);
    const labels = [...doc.querySelectorAll('div[title]')].map((d) => d.getAttribute('title'));
    check('labels now from region field', labels.includes('us') && labels.includes('eu'), JSON.stringify(labels));

    // 解釈不能/存在しないフィールド → フォールバック（label=第1列, value=第2列）
    setOptions({ labelField: 'does_not_exist', valueField: 'also_missing' });
    await sleep(150);
    // value=第2列(region=非数値) にフォールバック → No data（壊れず安全に退避）
    check('unknown fields fall back safely (No data, not crash)', doc.body.textContent.includes('No data available'));
}

// ---- 集計 -----------------------------------------------------------------
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAIL'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
