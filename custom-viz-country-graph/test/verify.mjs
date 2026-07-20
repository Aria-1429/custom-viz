// Country Graph viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_country_graph', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 640, height: 420 });
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

const root = doc.createElement('div');
root.id = 'root';
doc.body.appendChild(root);

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

const FIELDS = [{ name: 'country' }, { name: 'attacks' }];
const ROWS = [
    ['United States', '5,200'],   // カンマ付き数値・国名→US
    ['CN', '3100'],               // ISO2 コードそのまま
    ['Russia', '2400'],
    ['Germany', '1800'],
    ['Japan', '900'],
    ['Atlantis', '120'],          // 未知の国 → 🌐 フォールバック
];

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
    getDimensions: () => ({ width: 640, height: 420 }),
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
const rows = () => [...doc.querySelectorAll('.cg-row')];
const bars = () => [...doc.querySelectorAll('.cg-bar')];
const nameOf = (row) => {
    // 国名は .cg-row 内で bar 以外の span。title 属性で拾う
    const spans = [...row.querySelectorAll('span[title]')];
    return spans.length ? spans[spans.length - 1].getAttribute('title') : '';
};

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 既定表示（palette モード・降順） ------------------------------------
console.log('\n[1] default (palette mode, desc sort, dark)');
{
    check('6 rows rendered', rows().length === 6, `got ${rows().length}`);
    check('6 bars rendered', bars().length === 6, `got ${bars().length}`);
    // 降順：先頭は最大値の United States(5200)
    check('sorted desc: top is United States', nameOf(rows()[0]) === 'United States', nameOf(rows()[0]));
    check('sorted desc: last is Atlantis', nameOf(rows()[5]) === 'Atlantis', nameOf(rows()[5]));
    // 数値正規化（5,200）とシェア表示
    const txt = doc.body.textContent;
    check('value 5,200 normalized & shown', txt.includes('5,200'), txt.slice(0, 200));
    check('share % shown', /%/.test(txt));
    // 国旗: 既知5件は SVG、Atlantis は 🌐
    const flags = [...doc.querySelectorAll('.cg-row svg')];
    check('5 flag svgs (known countries)', flags.length === 5, `got ${flags.length}`);
    check('unknown country fallback 🌐', txt.includes('🌐'));
    // palette 既定色（開始 #39d7ff）を含むグラデーション
    const topBarBg = bars()[0].getAttribute('style') || '';
    check('bar uses linear-gradient', topBarBg.includes('linear-gradient'), topBarBg.slice(0, 80));
    check('glow on by default (box-shadow)', topBarBg.includes('box-shadow') && !topBarBg.includes('box-shadow: none'));
}

// ---- 2. 昇順ソート -----------------------------------------------------------
console.log('\n[2] ascending sort (sortDescending=false)');
{
    state.options = { sortDescending: false };
    fire('options', { options: state.options });
    await sleep(200);
    check('asc: top is Atlantis (min)', nameOf(rows()[0]) === 'Atlantis', nameOf(rows()[0]));
    check('asc: last is United States (max)', nameOf(rows()[5]) === 'United States', nameOf(rows()[5]));
}

// ---- 3. 上位N件の絞り込み ----------------------------------------------------
console.log('\n[3] topN = 3 (with desc)');
{
    state.options = { sortDescending: true, topN: 3 };
    fire('options', { options: state.options });
    await sleep(200);
    check('only 3 rows shown', rows().length === 3, `got ${rows().length}`);
    check('top3 are US/CN/Russia', ['United States'].includes(nameOf(rows()[0])) && nameOf(rows()[2]) === 'Russia',
        rows().map(nameOf).join(','));
}

// ---- 4. 値ベース配色（低=緑 → 高=赤、中間なし） -------------------------------
console.log('\n[4] value color mode (low green → high red, no mid)');
{
    state.options = {
        colorByValue: true, useMidColor: false,
        lowColor: '#00ff00', highColor: '#ff0000',
    };
    fire('options', { options: state.options });
    await sleep(200);
    check('all 6 rows back', rows().length === 6, `got ${rows().length}`);
    // 最大値(US=5200)のバー開始色は純赤、最小値(Atlantis=120)は純緑
    const topBg = bars()[0].getAttribute('style') || '';
    const lastBg = bars()[5].getAttribute('style') || '';
    check('max value bar starts red', topBg.includes('rgb(255, 0, 0)'), topBg.slice(0, 120));
    check('min value bar starts green', lastBg.includes('rgb(0, 255, 0)'), lastBg.slice(0, 120));
}

// ---- 5. 反転（高い値＝低い色） ------------------------------------------------
console.log('\n[5] reverseScale');
{
    state.options = { ...state.options, reverseScale: true };
    fire('options', { options: state.options });
    await sleep(200);
    const topBg = bars()[0].getAttribute('style') || '';
    check('reversed: max value bar now green', topBg.includes('rgb(0, 255, 0)'), topBg.slice(0, 120));
}

// ---- 6. 表示トグル（旗・順位・シェア・グローを消す） --------------------------
console.log('\n[6] display toggles off');
{
    state.options = {
        showFlag: false, showRank: false, showShare: false,
        showHeader: false, glow: false, animate: false,
    };
    fire('options', { options: state.options });
    await sleep(200);
    check('no flag svgs', [...doc.querySelectorAll('.cg-row svg')].length === 0);
    check('no header', !doc.body.textContent.includes('COUNTRY') && !doc.body.textContent.includes('country'.toUpperCase()));
    check('no share %', !/%/.test(doc.body.textContent));
    const topBg = bars()[0].getAttribute('style') || '';
    check('glow off (box-shadow: none)', topBg.includes('box-shadow: none'), topBg.slice(0, 120));
    check('animate off (no cg-anim class)', !doc.querySelector('.cg-anim'));
}

// ---- 7. スケール min/max 固定 ------------------------------------------------
console.log('\n[7] value mode with fixed scaleMin/Max');
{
    state.options = {
        colorByValue: true, useMidColor: false,
        lowColor: '#00ff00', highColor: '#ff0000',
        scaleMin: 0, scaleMax: 10400, // 最大値5200が丁度スケール中央(0.5)
    };
    fire('options', { options: state.options });
    await sleep(200);
    const topBg = bars()[0].getAttribute('style') || '';
    // t=0.5 → 緑と赤の中間 rgb(128,128,0) 前後
    check('mid-scale bar is blend (not pure red/green)',
        !topBg.includes('rgb(255, 0, 0)') && !topBg.includes('rgb(0, 255, 0)'), topBg.slice(0, 120));
}

// ---- 8. テーマ切替 -----------------------------------------------------------
console.log('\n[8] theme switch to light');
{
    state.options = {};
    state.theme = 'light';
    fire('options', { options: state.options });
    fire('theme', { theme: 'light' });
    await sleep(200);
    check('still renders 6 rows in light', rows().length === 6, `got ${rows().length}`);
}

// ---- 9. ガード（空データ・columns形式） --------------------------------------
console.log('\n[9] guards');
{
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty data → No data message', doc.body.textContent.includes('No data'));

    state.data = { fields: FIELDS, columns: [['US', 'JP'], ['10', '20']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('columns-form data renders 2 rows', rows().length === 2, `got ${rows().length}`);
}

// ---- 10. debug オーバーレイ --------------------------------------------------
console.log('\n[10] debug overlay');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { debug: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(200);
    check('debug dump visible', doc.body.textContent.includes('"colorMode"'), doc.body.textContent.slice(0, 80));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
