// Radar Chart viz のローカル検証（happy-dom、Splunk実機なし）
// バンドル済み dist/.../visualization.js を実行し、描画・オプション反映・ガード・
// フィールド選択（軸=columnSelector の DOS 文字列 / 系列=生のフィールド名配列）・
// 系列数の可変対応・mv セル救済を検証する。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_radar_chart', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 600 });
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
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 600 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, x: 0, y: 0 };
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

// 4 軸 × 3 系列。cpu/mem/disk/net を軸に host_a/host_b/host_c を系列で比較。
const FIELDS = [
    { name: 'metric' }, { name: 'host_a' }, { name: 'host_b' }, { name: 'host_c' },
];
const ROWS = [
    ['cpu', '80', '40', '20'],
    ['mem', '55', '70', '30'],
    ['disk', '30', '20', '90'],
    ['net', '65', '50', '45'],
    ['', '1', '1', '1'],   // 空ラベル軸 → 除去される
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
    getDimensions: () => ({ width: 900, height: 600 }),
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

// 系列ポリゴンだけを取り出す（グリッドのリングは fill="none"、系列は fill=rgba(...)）
const seriesPolys = () => [...doc.querySelectorAll('svg polygon')]
    .filter((p) => (p.getAttribute('fill') || '').startsWith('rgba'));
// グリッドリング（fill=none）
const ringPolys = () => [...doc.querySelectorAll('svg polygon')]
    .filter((p) => (p.getAttribute('fill') || '') === 'none');
const axisTexts = () => [...doc.querySelectorAll('svg text')];

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 既定描画（4 軸 × 3 系列） -------------------------------------------
console.log('\n[1] default render (dark, 4 axes × 3 series)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    check('3 series polygons', seriesPolys().length === 3, `got ${seriesPolys().length}`);
    // 既定リング本数 = 4
    check('4 grid rings', ringPolys().length === 4, `got ${ringPolys().length}`);
    const header = doc.body.textContent;
    check('axis label cpu shown', header.includes('cpu'));
    check('axis label net shown', header.includes('net'));
    check('empty-label axis dropped (only 4 axes)', axisTexts().filter((t) => t.textContent === 'cpu' || t.textContent === 'mem' || t.textContent === 'disk' || t.textContent === 'net').length === 4);
    check('legend shows host_a', header.includes('host_a'));
    check('legend shows host_c', header.includes('host_c'));
    // 系列ポリゴンは頂点数 = 軸数 = 4（"x,y" ペアが 4 組）
    const pts = (seriesPolys()[0].getAttribute('points') || '').trim().split(/\s+/);
    check('polygon has 4 vertices', pts.length === 4, `got ${pts.length}`);
}

// ---- 2. 系列色パレット（editor.seriesColors）の反映 ---------------------------
console.log('\n[2] custom series colors via seriesColors palette');
{
    state.options = { seriesColors: ['#ff0000', '#00ff00'] };
    fire('options', { options: state.options });
    await sleep(250);
    const strokes = seriesPolys().map((p) => p.getAttribute('stroke'));
    check('1st palette entry applied', strokes.includes('#ff0000'), JSON.stringify(strokes));
    check('2nd palette entry applied', strokes.includes('#00ff00'));
    // 3系列 / 2色 → 3番目は循環して 1色目に戻る（既定色に落ちない）
    check(
        'short palette cycles instead of falling back',
        strokes.length > 0 && strokes.every((s) => s === '#ff0000' || s === '#00ff00'),
        JSON.stringify(strokes)
    );
}

// ---- 2b. 旧 seriesColor1..6 は読まない（既定値はoptionsに載らない罠の回帰） ----
console.log('\n[2b] legacy seriesColor keys must not leak');
{
    state.options = { seriesColor1: '#ff0000', seriesColor2: '#00ff00' };
    fire('options', { options: state.options });
    await sleep(250);
    const strokes = seriesPolys().map((p) => p.getAttribute('stroke'));
    check('legacy seriesColor1 ignored', !strokes.includes('#ff0000'), JSON.stringify(strokes));
    check('falls back to default palette', strokes.includes('#5b8def'), JSON.stringify(strokes));
}

// ---- 3. リング本数・グロー・ドットのオプション --------------------------------
console.log('\n[3] rings / glow / dots options');
{
    state.options = { rings: 6, glow: false, showDots: false };
    fire('options', { options: state.options });
    await sleep(250);
    check('6 grid rings', ringPolys().length === 6, `got ${ringPolys().length}`);
    // glow=false のとき filter 参照が無い
    const g = [...doc.querySelectorAll('svg g')].find((el) => el.getAttribute('filter'));
    check('glow off → no filter on series group', !g, g ? g.getAttribute('filter') : '');
    // showDots=false のとき circle が無い
    check('dots off → no circles', doc.querySelectorAll('svg circle').length === 0);
}

// ---- 4. フィールド選択（軸=columnSelector DOS / 系列=生のフィールド名配列） ----
console.log('\n[4] field selection (axis DOS string + seriesFields name array)');
{
    state.data = {
        fields: [
            { name: 'ignore' }, { name: 'metric' }, { name: 'prod' }, { name: 'stg' },
        ],
        rows: [
            ['x', 'cpu', '90', '10'],
            ['x', 'mem', '40', '60'],
            ['x', 'disk', '70', '30'],
        ],
    };
    // 軸=metric（第2列）は columnSelector の DOS 文字列。
    // 系列は columnMultiSelectionByFieldNameEditor＝生のフィールド名配列。
    state.options = {
        axisField: "> primary | seriesByName('metric')",
        seriesFields: ['prod', 'stg'],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const header = doc.body.textContent;
    check('axis uses metric column (cpu shown)', header.includes('cpu'));
    check('ignore column not used as axis', !axisTexts().some((t) => t.textContent === 'x'));
    check('legend shows selected series prod', header.includes('prod'));
    check('legend shows selected series stg', header.includes('stg'));
    check('exactly 2 series selected', seriesPolys().length === 2, `got ${seriesPolys().length}`);
    check('unselected column ignore not drawn', !header.includes('ignore'));
    // 軸だけ seriesByIndex（生名でない DOS）でも解決できる
    state.options = {
        axisField: "> primary | seriesByIndex(1)",
        seriesFields: ['prod'],
    };
    fire('options', { options: state.options });
    await sleep(200);
    check('seriesByIndex resolves axis=metric + 1 series', seriesPolys().length === 1 && doc.body.textContent.includes('cpu'), `got ${seriesPolys().length}`);
}

// ---- 4b. seriesFields は選択順に、選んだ列だけを描く ---------------------------
console.log('\n[4b] seriesFields honours selection order');
{
    state.data = {
        fields: [{ name: 'metric' }, { name: 'cpu' }, { name: 'mem' }, { name: 'disk' }],
        rows: [
            ['r1', '10', '20', '30'],
            ['r2', '11', '21', '31'],
            ['r3', '12', '22', '32'],
        ],
    };
    // 既定パレット順: 1色目=#5b8def, 2色目=#2dd4bf
    state.options = { seriesFields: ['mem', 'cpu'] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    check('exactly 2 series for 2 selected names', seriesPolys().length === 2, `got ${seriesPolys().length}`);
    check('disk (unselected) not drawn', !doc.body.textContent.includes('disk'));
    // 選択順（mem→cpu）が保たれる = 1色目が mem のポリゴンに付く
    const memValues = ['20', '21', '22'];
    const strokes = seriesPolys().map((p) => p.getAttribute('stroke'));
    check('order preserved: first polygon uses 1st palette color', strokes[0] === '#5b8def', JSON.stringify(strokes));
    check('order preserved: second polygon uses 2nd palette color', strokes[1] === '#2dd4bf', JSON.stringify(strokes));
    // 凡例の並びも mem → cpu
    const legendText = doc.body.textContent;
    check('legend contains both selected names', legendText.includes('mem') && legendText.includes('cpu'));
    check('legend order is mem before cpu', legendText.indexOf('mem') < legendText.lastIndexOf('cpu'), legendText.slice(0, 80));
    void memValues;
}

// ---- 4c. 6 系列より多くても描ける（パレット長を超えたら循環） ------------------
console.log('\n[4c] more than 6 series (8 selected, 6-color palette)');
{
    const names = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    state.data = {
        fields: [{ name: 'metric' }, ...names.map((n) => ({ name: n }))],
        rows: [
            ['cpu', ...names.map((_, i) => String(10 + i))],
            ['mem', ...names.map((_, i) => String(20 + i))],
            ['disk', ...names.map((_, i) => String(30 + i))],
            ['net', ...names.map((_, i) => String(40 + i))],
        ],
    };
    // 既定の 6 色パレットに対し 8 系列 → 7,8 番目は 1,2 色目へ循環するはず
    state.options = { seriesFields: names };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(300);
    const strokes = seriesPolys().map((p) => p.getAttribute('stroke'));
    check('8 series polygons rendered (no 6-series ceiling)', strokes.length === 8, `got ${strokes.length}`);
    const PALETTE = ['#5b8def', '#2dd4bf', '#f0912e', '#ef4d6a', '#a78bfa', '#f5c518'];
    check('7th series cycles to 1st palette color', strokes[6] === PALETTE[0], String(strokes[6]));
    check('8th series cycles to 2nd palette color', strokes[7] === PALETTE[1], String(strokes[7]));
    check('all strokes come from the palette', strokes.every((s) => PALETTE.includes(s)), JSON.stringify(strokes));
    check('legend lists all 8 series', names.every((n) => doc.body.textContent.includes(n)));

    // 短いパレット（2色）× 8 系列でも循環して落ちない
    state.options = { seriesFields: names, seriesColors: ['#ff0000', '#00ff00'] };
    fire('options', { options: state.options });
    await sleep(250);
    const s2 = seriesPolys().map((p) => p.getAttribute('stroke'));
    check('8 series with 2-color palette still renders', s2.length === 8, `got ${s2.length}`);
    check('2-color palette cycles across 8 series', s2.every((s) => s === '#ff0000' || s === '#00ff00') && s2[0] === '#ff0000' && s2[1] === '#00ff00', JSON.stringify(s2));
}

// ---- 4d. seriesFields 未設定 → 自動検出（従来動作） ---------------------------
console.log('\n[4d] empty/absent seriesFields falls back to auto-detect');
{
    state.data = {
        fields: [{ name: 'metric' }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
        rows: [
            ['cpu', '1', '2', '3'],
            ['mem', '4', '5', '6'],
            ['disk', '7', '8', '9'],
        ],
    };
    state.options = {};   // 未設定
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    check('absent seriesFields → auto-detect 3 series', seriesPolys().length === 3, `got ${seriesPolys().length}`);

    state.options = { seriesFields: [] };   // 既定値の空配列
    fire('options', { options: state.options });
    await sleep(200);
    check('empty seriesFields → auto-detect 3 series', seriesPolys().length === 3, `got ${seriesPolys().length}`);

    // 自動検出は MAX_AUTO_SERIES=12 で頭打ち（列数が多いサーチの安全弁）
    const many = Array.from({ length: 30 }, (_, i) => `f${i}`);
    state.data = {
        fields: [{ name: 'metric' }, ...many.map((n) => ({ name: n }))],
        rows: [
            ['cpu', ...many.map(() => '1')],
            ['mem', ...many.map(() => '2')],
            ['disk', ...many.map(() => '3')],
        ],
    };
    state.options = {};
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(300);
    check('auto-detect capped at 12 series', seriesPolys().length === 12, `got ${seriesPolys().length}`);

    // ただし明示選択なら 12 を超えても全部描く（上限は自動検出のみ）
    state.options = { seriesFields: many.slice(0, 20) };
    fire('options', { options: state.options });
    await sleep(300);
    check('explicit selection is unbounded (20 series)', seriesPolys().length === 20, `got ${seriesPolys().length}`);
}

// ---- 4e. 旧 seriesField1..6 は読まない（既定値はoptionsに載らない罠の回帰） ----
console.log('\n[4e] legacy seriesField1..6 keys must be ignored');
{
    state.data = {
        fields: [{ name: 'metric' }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
        rows: [
            ['cpu', '1', '2', '3'],
            ['mem', '4', '5', '6'],
            ['disk', '7', '8', '9'],
        ],
    };
    // 旧キーだけがある options。読まれてしまうと 1 系列（a のみ）になるはず。
    state.options = {
        seriesField1: "> primary | seriesByName('a')",
        seriesField2: "> primary | seriesByName('b')",
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    check('legacy seriesField1/2 ignored → auto-detect all 3', seriesPolys().length === 3, `got ${seriesPolys().length}`);
    check('column c (not in legacy keys) still drawn', doc.body.textContent.includes('c'));
}

// ---- 4f. ゴミ入力に耐える -----------------------------------------------------
console.log('\n[4f] garbage seriesFields entries do not crash');
{
    state.data = {
        fields: [{ name: 'metric' }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
        rows: [
            ['cpu', '1', '2', '3'],
            ['mem', '4', '5', '6'],
            ['disk', '7', '8', '9'],
        ],
    };
    // 未知名 / 非文字列 / null / 空文字 に混じって 1 つだけ有効な 'b'
    state.options = { seriesFields: ['nope', 42, null, '', { x: 1 }, 'b'] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    check('garbage filtered → only valid field b rendered', seriesPolys().length === 1, `got ${seriesPolys().length}`);
    check('still renders (no crash)', !!doc.querySelector('svg'));

    // 全部ゴミ → 解決できるものが 0 なので自動検出へフォールバック
    state.options = { seriesFields: ['nope', 'alsonope'] };
    fire('options', { options: state.options });
    await sleep(200);
    check('all-unknown names → auto-detect fallback (3 series)', seriesPolys().length === 3, `got ${seriesPolys().length}`);

    // DOS 文字列が紛れ込んでも resolveFieldIndex が吸収する
    state.options = { seriesFields: ["> primary | seriesByName('c')"] };
    fire('options', { options: state.options });
    await sleep(200);
    check('DOS string entry still resolves to 1 series', seriesPolys().length === 1, `got ${seriesPolys().length}`);

    // seriesFields が配列でない（文字列 / null）ときも落ちない
    state.options = { seriesFields: "> primary | frameBySeriesNames('a')" };
    fire('options', { options: state.options });
    await sleep(200);
    check('non-array seriesFields → auto-detect, no crash', seriesPolys().length === 3, `got ${seriesPolys().length}`);
}

// ---- 5. マルチバリューセル救済 -----------------------------------------------
console.log('\n[5] multivalue cell rescue (parallel expand)');
{
    // 1 行のセルに配列（mvexpand し忘れ相当）。全列トークン数一致 → 平行展開されるはず。
    state.data = {
        fields: [{ name: 'metric' }, { name: 'a' }, { name: 'b' }],
        rows: [
            [['cpu', 'mem', 'disk', 'net'], ['80', '55', '30', '65'], ['40', '70', '20', '50']],
        ],
    };
    state.options = {};
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    const header = doc.body.textContent;
    check('mv expanded → 4 axes', axisTexts().filter((t) => ['cpu', 'mem', 'disk', 'net'].includes(t.textContent)).length === 4);
    check('mv expanded → 2 series', seriesPolys().length === 2, `got ${seriesPolys().length}`);
    check('axis label is cpu not the whole array', header.includes('cpu') && !header.includes('cpu,mem'));
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
    // ライトモードの軸ラベル色 = #4a5068
    const lbl = axisTexts().find((t) => t.textContent === 'cpu');
    const fill = lbl ? (lbl.getAttribute('fill') || '') : '';
    check('axis label uses light-mode color', /#4a5068/i.test(fill), fill);
}

// ---- 7. ガード（空データ / 3軸未満 / columns 形式） --------------------------
console.log('\n[7] guards');
{
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty → データなしメッセージ', doc.body.textContent.includes('データがありません'));

    // 軸が 2 行だけ → レーダーにならない旨のメッセージ
    state.data = { fields: FIELDS, rows: [['cpu', '10', '5', '3'], ['mem', '20', '8', '4']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('< 3 axes → guidance message', /at least 3 axes/i.test(doc.body.textContent), doc.body.textContent.slice(0, 120));

    // columns 形式でも動く（4 軸 × 2 系列）
    state.data = {
        fields: [{ name: 'metric' }, { name: 's1' }, { name: 's2' }],
        columns: [['cpu', 'mem', 'disk', 'net'], ['1', '2', '3', '4'], ['4', '3', '2', '1']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('columns-form renders 2 series', seriesPolys().length === 2, `got ${seriesPolys().length}`);
}

// ---- 8. debug オプションは廃止済み（ダンプが出ないこと） ----------------------
console.log('\n[8] debug option removed → no dump panel');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { debug: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(250);
    check('no debug <pre> rendered', doc.querySelectorAll('pre').length === 0);
    check('no rawOptions dump in body', !doc.body.textContent.includes('rawOptions'));
    check('chart still renders normally', seriesPolys().length > 0);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
