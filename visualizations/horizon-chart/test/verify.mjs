// Horizon Chart viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_horizon_chart', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const VW = 900;
const VH = 560;
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now ? performance.now() : 16), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (typeof performance === 'undefined') globalThis.performance = { now: () => 16 };

// コンテナ実寸を固定（オートフィット系のため）
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => VW });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => VH });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
};
// SVG 上のマウス座標計算にも必要
win.SVGElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
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

// timechart 相当（wide）: _time × 3 系列。全体最大 = 300
const WIDE = {
    fields: [{ name: '_time' }, { name: 'web-01' }, { name: 'web-02' }, { name: 'db-01' }],
    rows: [
        ['2026-07-20T00:00:00', '10', '100', '5'],
        ['2026-07-20T01:00:00', '20', '300', '10'],
        ['2026-07-20T02:00:00', '30', '50', '15'],
        ['2026-07-20T03:00:00', '40', '20', '20'],
    ],
};

// 縦持ち（stats ... by _time, host 相当）
const TIDY = {
    fields: [{ name: '_time' }, { name: 'host' }, { name: 'count' }],
    rows: [
        ['2026-07-20T00:00:00', 'h1', '10'],
        ['2026-07-20T00:00:00', 'h2', '40'],
        ['2026-07-20T01:00:00', 'h1', '20'],
        ['2026-07-20T01:00:00', 'h2', '80'],
    ],
};

let state = {
    data: WIDE,
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
    getDimensions: () => ({ width: VW, height: VH }),
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
const lanes = () => q('g[data-role="hz-lane"]');
const laneNames = () => lanes().map((g) => g.getAttribute('data-series'));
const bands = () => q('path[data-role="hz-band"]');
const bandsOf = (laneIdx) => [...lanes()[laneIdx].querySelectorAll('path[data-role="hz-band"]')];
const labels = () => q('text[data-role="hz-label"]').map((t) => t.textContent);
const peaks = () => q('text[data-role="hz-peak"]').map((t) => t.textContent);
const ticks = () => q('text[data-role="hz-tick"]').map((t) => t.textContent);
const legendBands = () => q('rect[data-role="hz-legend-band"]');
const legendText = () => doc.querySelector('text[data-role="hz-legend-text"]')?.textContent;
const crosshair = () => doc.querySelector('line[data-role="hz-crosshair"]');
const hoverInfo = () => doc.querySelector('div[data-role="hz-hoverinfo"]')?.textContent;
const noteText = () => doc.querySelector('text[data-role="hz-note"]')?.textContent;

// パスの最小 y（= 最も高く伸びた点）を取る。ホライズンの「バンドが天井まで到達したか」検証用
function minPathY(d) {
    const nums = String(d).match(/-?\d+(\.\d+)?/g);
    if (!nums) return NaN;
    const ys = [];
    // "M x y L x y ... C x y x y x y" — 偶数番目が x、奇数番目が y
    for (let i = 1; i < nums.length; i += 2) ys.push(Number(nums[i]));
    return Math.min(...ys);
}
function maxPathY(d) {
    const nums = String(d).match(/-?\d+(\.\d+)?/g);
    if (!nums) return NaN;
    const ys = [];
    for (let i = 1; i < nums.length; i += 2) ys.push(Number(nums[i]));
    return Math.max(...ys);
}

// ---- バンド不透明度の期待値（実装と同じ式） ---------------------------------
const expectedOpacity = (b, nBands, floor) =>
    nBands === 1 ? 1 : floor + ((1 - floor) * b) / (nBands - 1);

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. wide（timechart 形式）の基本描画 ---------------------------------------
console.log('\n[1] wide (timechart-style) basic rendering, dark');
{
    check('3 lanes rendered', lanes().length === 3, `got ${lanes().length}`);
    check('lane order = column order', laneNames().join(',') === 'web-01,web-02,db-01', laneNames().join(','));
    check('labels shown', labels().join(',') === 'web-01,web-02,db-01', labels().join(','));
    check('peak values per lane (40/300/20)', peaks().join(',') === '40,300,20', peaks().join(','));
    check('bands rendered', bands().length > 0, `got ${bands().length}`);
    check('time ticks rendered as HH:MM', ticks().length >= 2 && /^\d{2}:\d{2}$/.test(ticks()[0]), ticks().join(','));
    check('legend shows 3 band swatches', legendBands().length === 3, `got ${legendBands().length}`);
    check('legend text mentions 基準', String(legendText()).includes('基準='), legendText());
    // 負側の色見本がテキストと重ならない位置に置かれている
    const negSw = doc.querySelector('rect[data-role="hz-legend-neg"]');
    const lgText = doc.querySelector('text[data-role="hz-legend-text"]');
    check('negative swatch present and right of legend text',
        negSw && Number(negSw.getAttribute('x')) > Number(lgText.getAttribute('x')),
        `neg=${negSw?.getAttribute('x')} text=${lgText?.getAttribute('x')}`);
    check('negative swatch labelled',
        doc.querySelector('text[data-role="hz-legend-negtext"]')?.textContent === '基準より下');
    check('negative swatch uses negative color',
        String(negSw.getAttribute('fill')).startsWith('rgba(215,48,39,'), negSw.getAttribute('fill'));
}

// ---- 2. バンド折り返しの核心ロジック ------------------------------------------
// 全体最大乖離 = 300、bands=3 → exact=100、niceStepDown(100)=100 → step=100
// web-02 の peak=300 は 3 バンド全部を天井まで満たす。
// db-01 の peak=20 は band0 のみ、かつ 20/100 = 20% しか伸びない。
console.log('\n[2] band folding math');
{
    check('legend step = 100 (300/3, nice)', String(legendText()).includes('1段=100'), legendText());

    const web02 = bandsOf(1); // peak=300
    check('web-02 uses all 3 bands', web02.length === 3, `got ${web02.length}`);
    // band0 は 300 → f=clamp((300-0)/100)=1 で天井（y=0）に到達
    const b0 = web02.find((p) => p.getAttribute('data-band') === '0');
    const b2 = web02.find((p) => p.getAttribute('data-band') === '2');
    check('band0 reaches lane ceiling (y=0)', Math.abs(minPathY(b0.getAttribute('d'))) < 0.01,
        `minY=${minPathY(b0.getAttribute('d'))}`);
    // band2 は 300 → f=clamp((300-200)/100)=1 でこちらも天井
    check('band2 also reaches ceiling at peak', Math.abs(minPathY(b2.getAttribute('d'))) < 0.01,
        `minY=${minPathY(b2.getAttribute('d'))}`);

    const db01 = bandsOf(2); // peak=20 → band0 のみ
    check('db-01 uses only band0 (peak 20 < step 100)', db01.length === 1
        && db01[0].getAttribute('data-band') === '0', db01.map((p) => p.getAttribute('data-band')).join(','));
    // laneH を取得して 20% だけ伸びていることを確認
    const laneBg = doc.querySelector('rect[data-role="hz-lane-bg"]');
    const laneH = Number(laneBg.getAttribute('height'));
    const expectedY = laneH - 0.2 * laneH; // 20/100 = 0.2
    check('db-01 band0 height = 20% of lane', Math.abs(minPathY(db01[0].getAttribute('d')) - expectedY) < 0.5,
        `minY=${minPathY(db01[0].getAttribute('d'))} expected=${expectedY} laneH=${laneH}`);

    // 不透明度: 下のバンドほど薄い（floor=0.28 → 0.28 / 0.64 / 1.0）
    const op = (p) => {
        const m = String(p.getAttribute('fill')).match(/rgba\([^)]*,([\d.]+)\)/);
        return m ? Number(m[1]) : NaN;
    };
    const sorted = [...web02].sort((a, b) => Number(a.getAttribute('data-band')) - Number(b.getAttribute('data-band')));
    check('band opacity ascends 0.28 → 0.64 → 1',
        Math.abs(op(sorted[0]) - expectedOpacity(0, 3, 0.28)) < 0.005
        && Math.abs(op(sorted[1]) - expectedOpacity(1, 3, 0.28)) < 0.005
        && Math.abs(op(sorted[2]) - expectedOpacity(2, 3, 0.28)) < 0.005,
        sorted.map(op).join(','));
    check('all bands use positive color', web02.every((p) => p.getAttribute('data-sign') === 'pos'));
    check('positive color is #1f78b4', String(web02[0].getAttribute('fill')).startsWith('rgba(31,120,180,'),
        web02[0].getAttribute('fill'));
}

// ---- 3. バンド数を変えると圧縮率が変わる ---------------------------------------
console.log('\n[3] band count changes compression');
{
    await setOpts({ animate: false, bands: 1 });
    check('bands=1: web-02 has 1 band', bandsOf(1).length === 1, `got ${bandsOf(1).length}`);
    // exact=300 → niceStepDown(300)=200（切り下げ）。200>=150 なので採用。
    // 切り上げ(500)だと peak が 60% までしか伸びず上部が余るため、切り下げが正しい。
    check('bands=1: legend step = 200 (nice step-down)', String(legendText()).includes('1段=200'), legendText());
    check('bands=1: opacity is 1', String(bandsOf(1)[0].getAttribute('fill')).includes(',1)'),
        bandsOf(1)[0].getAttribute('fill'));
    // 切り下げの効果: peak がレーン天井まで到達している
    check('bands=1: peak fills lane to ceiling',
        Math.abs(minPathY(bandsOf(1)[0].getAttribute('d'))) < 0.01,
        `minY=${minPathY(bandsOf(1)[0].getAttribute('d'))}`);

    await setOpts({ animate: false, bands: 6 });
    check('bands=6: legend shows 6 swatches', legendBands().length === 6, `got ${legendBands().length}`);
    // 300/6 = 50 → niceStep(50) = 50
    check('bands=6: legend step = 50', String(legendText()).includes('1段=50'), legendText());
    check('bands=6: web-02 uses all 6 bands', bandsOf(1).length === 6, `got ${bandsOf(1).length}`);

    // niceStepDown が痩せすぎる場合は厳密な等分にフォールバックする。
    // 最大 95 / bands=2 → exact=47.5、niceStepDown(47.5)=20。
    // 20 < 47.5*0.5 なので等分 47.5 が採用され、最上バンドがちょうど埋まる
    // （20 のままだと 95 は全バンドを振り切って階調が失われる）。
    await setData({
        fields: [{ name: '_time' }, { name: 'v' }],
        rows: [['2026-07-20T00:00:00', '95'], ['2026-07-20T01:00:00', '10']],
    });
    await setOpts({ animate: false, bands: 2, valueDecimals: 1, abbreviateValue: false });
    check('too-small nice step falls back to exact division',
        String(legendText()).includes('1段=47.5'), legendText());
    check('exact-division: peak reaches ceiling',
        Math.abs(minPathY(bandsOf(0).find((p) => p.getAttribute('data-band') === '1').getAttribute('d'))) < 0.01,
        `minY=${minPathY(bandsOf(0).find((p) => p.getAttribute('data-band') === '1').getAttribute('d'))}`);
    await setData(WIDE);
    await setOpts({ animate: false });

    // 範囲外は安全側へ丸められる
    await setOpts({ animate: false, bands: 99 });
    check('bands clamped to 6', legendBands().length === 6, `got ${legendBands().length}`);
    await setOpts({ animate: false, bands: 0 });
    check('bands clamped to 1', legendBands().length === 1, `got ${legendBands().length}`);
    await setOpts({ animate: false });
}

// ---- 4. 負値（基準より下）を反対色で折り返す -----------------------------------
console.log('\n[4] negative side folds in opposite color');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'delta' }],
        rows: [
            ['2026-07-20T00:00:00', '100'],
            ['2026-07-20T01:00:00', '-100'],
            ['2026-07-20T02:00:00', '0'],
        ],
    });
    const neg = bands().filter((p) => p.getAttribute('data-sign') === 'neg');
    const pos = bands().filter((p) => p.getAttribute('data-sign') === 'pos');
    check('both positive and negative bands exist', pos.length > 0 && neg.length > 0,
        `pos=${pos.length} neg=${neg.length}`);
    check('negative bands use negative color', neg.every((p) => String(p.getAttribute('fill')).startsWith('rgba(215,48,39,')),
        neg[0]?.getAttribute('fill'));

    await setOpts({ animate: false, showNegative: false });
    check('showNegative=false hides negative bands',
        bands().every((p) => p.getAttribute('data-sign') === 'pos'),
        bands().map((p) => p.getAttribute('data-sign')).join(','));
    await setOpts({ animate: false });
}

// ---- 5. 基準値（bandBase）の変更 -----------------------------------------------
console.log('\n[5] custom band base');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'cpu' }],
        rows: [
            ['2026-07-20T00:00:00', '40'],
            ['2026-07-20T01:00:00', '60'],
            ['2026-07-20T02:00:00', '80'],
        ],
    });
    // base=0 なら全部 positive
    check('base=0: all positive', bands().every((p) => p.getAttribute('data-sign') === 'pos'));

    // base=60 にすると 40 は負側、80 は正側に分かれる
    await setOpts({ animate: false, bandBase: 60 });
    const signs = new Set(bands().map((p) => p.getAttribute('data-sign')));
    check('base=60 splits into pos and neg', signs.has('pos') && signs.has('neg'), [...signs].join(','));
    check('legend shows 基準=60', String(legendText()).includes('基準=60'), legendText());
    await setOpts({ animate: false });
}

// ---- 6. バンド幅の明示指定 ------------------------------------------------------
console.log('\n[6] explicit band step');
{
    await setData(WIDE);
    await setOpts({ animate: false, bandStep: 150 });
    check('explicit step used in legend', String(legendText()).includes('1段=150'), legendText());
    // 300/150 = 2 バンド分だけ埋まる（bands=3 のうち band0,1 のみ）
    check('web-02 fills only 2 of 3 bands with step=150', bandsOf(1).length === 2,
        bandsOf(1).map((p) => p.getAttribute('data-band')).join(','));
    // 0 や負値は自動に落ちる
    await setOpts({ animate: false, bandStep: 0 });
    check('step=0 falls back to auto (100)', String(legendText()).includes('1段=100'), legendText());
    await setOpts({ animate: false });
}

// ---- 7. 系列ごとの正規化 --------------------------------------------------------
console.log('\n[7] per-series normalization');
{
    await setData(WIDE);
    // 通常は db-01（peak 20）は band0 だけ、しかも 20% しか伸びない
    check('global scale: db-01 barely visible', bandsOf(2).length === 1);

    await setOpts({ animate: false, perSeriesScale: true });
    // 系列ごと正規化なら db-01 も自分の変動幅で全バンドを使い切る
    check('per-series: db-01 now uses all 3 bands', bandsOf(2).length === 3,
        bandsOf(2).map((p) => p.getAttribute('data-band')).join(','));
    const b0 = bandsOf(2).find((p) => p.getAttribute('data-band') === '0');
    check('per-series: db-01 band0 reaches ceiling', Math.abs(minPathY(b0.getAttribute('d'))) < 0.01,
        `minY=${minPathY(b0.getAttribute('d'))}`);
    check('legend notes per-series normalization', String(legendText()).includes('系列ごとに正規化'), legendText());
    check('legend drops fixed 基準 in per-series mode', !String(legendText()).includes('基準='), legendText());
    await setOpts({ animate: false });
}

// ---- 7b. 正規化は「最小〜最大」を展開する（0起点ではない） ---------------------
// 0 から遠い高水準で推移する系列（120〜132）で、旧実装は最大値÷段数=44 としたため
// 平常値 120 でも 2.7 段に達し、下2段が常時満杯の塗り潰しになっていた。
// 修正後は基準=最小値(120)・1段=変動幅/段数(4) となり、変動が3段に展開される。
console.log('\n[7b] per-series normalization spans min..max (not 0..max)');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'plateau' }],
        rows: [
            ['2026-07-20T00:00:00', '120'],
            ['2026-07-20T01:00:00', '132'],
            ['2026-07-20T02:00:00', '126'],
        ],
    });
    await setOpts({ animate: false, perSeriesScale: true, curve: false });

    const laneH = Number(doc.querySelector('rect[data-role="hz-lane-bg"]').getAttribute('height'));
    const byBand = {};
    for (const b of bandsOf(0)) byBand[b.getAttribute('data-band')] = b.getAttribute('d');

    // 最小値(120) の時刻では、どの段も描画されない（基準ちょうど = 高さ0）
    // 最大値(132) の時刻では、全3段が天井に達する
    check('min value sits at the baseline (no fill)',
        Math.abs(maxPathY(byBand['0']) - laneH) < 0.01, `maxY=${maxPathY(byBand['0'])} laneH=${laneH}`);
    check('max value fills all 3 bands to ceiling',
        ['0', '1', '2'].every((b) => byBand[b] && Math.abs(minPathY(byBand[b])) < 0.01),
        ['0', '1', '2'].map((b) => byBand[b] && minPathY(byBand[b])).join(','));
    // 旧実装のバグ再現防止: 下2段が「全時刻で満杯」になっていないこと
    // （満杯なら band0 のパスは全点が y=0 になり、最大 y も 0 付近になる）
    check('lower bands are NOT permanently saturated',
        maxPathY(byBand['0']) > laneH * 0.5, `band0 maxY=${maxPathY(byBand['0'])}`);
    check('tooltip shows the lane baseline',
        String(doc.querySelector('g[data-role="hz-lane"] title')?.textContent).includes('基準=120'),
        doc.querySelector('g[data-role="hz-lane"] title')?.textContent);

    // 変動ゼロ（全時刻が同値）の系列でも破綻しない
    await setData({
        fields: [{ name: '_time' }, { name: 'flat' }],
        rows: [
            ['2026-07-20T00:00:00', '50'],
            ['2026-07-20T01:00:00', '50'],
        ],
    });
    check('zero-variation series renders without crash', lanes().length === 1, `got ${lanes().length}`);
    check('zero-variation series draws no bands', bands().length === 0, `got ${bands().length}`);

    await setData(WIDE);
    await setOpts({ animate: false });
}

// ---- 8. 縦持ちの自動判別・重複合算 -----------------------------------------------
console.log('\n[8] tidy auto-detect');
{
    await setData(TIDY);
    check('2 lanes from tidy data', lanes().length === 2, `got ${lanes().length}`);
    check('lane names = hosts', laneNames().join(',') === 'h1,h2', laneNames().join(','));
    check('peaks 20 / 80', peaks().join(',') === '20,80', peaks().join(','));

    // 同一 (時刻, 系列) の重複行は合算
    await setData({
        fields: [{ name: '_time' }, { name: 'host' }, { name: 'count' }],
        rows: [
            ['2026-07-20T00:00:00', 'h1', '5'],
            ['2026-07-20T00:00:00', 'h1', '7'],
            ['2026-07-20T01:00:00', 'h1', '1'],
        ],
    });
    check('duplicate (time,series) aggregated 5+7=12', peaks().join(',') === '12', peaks().join(','));
}

// ---- 9. フィールド明示選択（columnSelector DOS 文字列） --------------------------
console.log('\n[9] explicit field selection');
{
    await setData(WIDE);
    await setOpts({ animate: false, valueField: "> primary | seriesByName('web-02')" });
    check('single value column selected', lanes().length === 1 && laneNames()[0] === 'web-02',
        `${lanes().length} lanes: ${laneNames().join(',')}`);

    // 縦持ちで系列フィールドを明示
    await setData(TIDY);
    await setOpts({
        animate: false,
        timeField: "> primary | seriesByName('_time')",
        seriesField: "> primary | seriesByName('host')",
        valueField: "> primary | seriesByName('count')",
    });
    check('explicit tidy selection works', laneNames().join(',') === 'h1,h2', laneNames().join(','));

    // seriesByIndex も解決できる
    await setOpts({ animate: false, seriesField: '> primary | seriesByIndex(1)' });
    check('seriesByIndex resolves', laneNames().join(',') === 'h1,h2', laneNames().join(','));
    await setOpts({ animate: false });
}

// ---- 10. 並べ替えと最大系列数 ----------------------------------------------------
console.log('\n[10] sorting and series cap');
{
    await setData(WIDE);
    check('default order preserved', laneNames().join(',') === 'web-01,web-02,db-01', laneNames().join(','));

    // sortMode='none' は明示指定でも検索結果順
    await setOpts({ animate: false, sortMode: 'none' });
    check('sortMode=none keeps input order', laneNames().join(',') === 'web-01,web-02,db-01', laneNames().join(','));

    // 最大値: web-01=40, web-02=300, db-01=20
    await setOpts({ animate: false, sortMode: 'peak' });
    check('sortMode=peak sorts by peak desc (300,40,20)', laneNames().join(',') === 'web-02,web-01,db-01', laneNames().join(','));

    // 合計: web-01=100, web-02=470, db-01=50
    await setOpts({ animate: false, sortMode: 'total' });
    check('sortMode=total sorts by total desc', laneNames().join(',') === 'web-02,web-01,db-01', laneNames().join(','));

    // 未知値は既定（none）へ丸める
    await setOpts({ animate: false, sortMode: 'bogus' });
    check('unknown sortMode falls back to none', laneNames().join(',') === 'web-01,web-02,db-01', laneNames().join(','));

    await setOpts({ animate: false, sortMode: 'peak', maxSeries: 2 });
    check('maxSeries caps to 2 lanes', lanes().length === 2, `got ${lanes().length}`);
    check('cap keeps top by peak', laneNames().join(',') === 'web-02,web-01', laneNames().join(','));
    check('truncation note shown', String(noteText()).includes('省略'), noteText());
    await setOpts({ animate: false });

    // peak と total で並びが変わるデータで、モードごとの違いを実際に確認する。
    //   spiky : 最大 100 / 合計 106（瞬間的に跳ねるが平常は低い）
    //   steady: 最大  40 / 合計 160（常時高いが跳ねない）
    await setData({
        fields: [{ name: '_time' }, { name: 'spiky' }, { name: 'steady' }],
        rows: [
            ['2026-07-20T00:00:00', '2', '40'],
            ['2026-07-20T01:00:00', '100', '40'],
            ['2026-07-20T02:00:00', '2', '40'],
            ['2026-07-20T03:00:00', '2', '40'],
        ],
    });
    await setOpts({ animate: false, sortMode: 'peak' });
    check('peak ≠ total: peak puts spiky first', laneNames().join(',') === 'spiky,steady', laneNames().join(','));
    await setOpts({ animate: false, sortMode: 'total' });
    check('peak ≠ total: total puts steady first', laneNames().join(',') === 'steady,spiky', laneNames().join(','));
    await setData(WIDE);
    await setOpts({ animate: false });
}

// ---- 10b. 旧 boolean オプションは読み替えない（回帰） ----------------------------
// キー名変更時に旧オプションへフォールバックすると「既定値を選んだときだけ直らない」
// 不具合になる（skills/splunk-viz 参照）。旧値は完全に無視され既定順になること。
console.log('\n[10b] legacy sort booleans are ignored');
{
    await setData(WIDE);
    await setOpts({ animate: false, sortByPeak: true });
    check('legacy sortByPeak ignored → input order', laneNames().join(',') === 'web-01,web-02,db-01', laneNames().join(','));

    await setOpts({ animate: false, sortByTotal: true });
    check('legacy sortByTotal ignored → input order', laneNames().join(',') === 'web-01,web-02,db-01', laneNames().join(','));

    // 旧 boolean と新 sortMode が同居しても、新オプションだけが効く
    await setOpts({ animate: false, sortByPeak: true, sortMode: 'none' });
    check('sortMode wins over legacy booleans', laneNames().join(',') === 'web-01,web-02,db-01', laneNames().join(','));
    await setOpts({ animate: false });
}

// ---- 11. 時刻の各種フォーマット ---------------------------------------------------
console.log('\n[11] time parsing formats');
{
    // epoch 秒
    await setData({
        fields: [{ name: '_time' }, { name: 'v' }],
        rows: [['1769000000', '1'], ['1769003600', '5'], ['1769007200', '3']],
    });
    check('epoch seconds parsed (3 ticks)', lanes().length === 1 && ticks().length >= 2, ticks().join(','));
    check('epoch seconds → HH:MM ticks', /^\d{2}:\d{2}$/.test(ticks()[0]), ticks().join(','));

    // epoch ミリ秒
    await setData({
        fields: [{ name: '_time' }, { name: 'v' }],
        rows: [['1769000000000', '1'], ['1769003600000', '5']],
    });
    check('epoch millis parsed', lanes().length === 1 && /^\d{2}:\d{2}$/.test(ticks()[0]), ticks().join(','));

    // 日付のみ（ローカル日付として解釈され UTC ずれしない）
    await setData({
        fields: [{ name: 'day' }, { name: 'v' }],
        rows: [['2026-07-18', '1'], ['2026-07-19', '5'], ['2026-07-20', '3']],
    });
    check('date-only → M/D ticks, no UTC shift', ticks().includes('7/18') && ticks().includes('7/20'),
        ticks().join(','));

    // 時刻列が無い（カテゴリ軸フォールバック）
    await setData({
        fields: [{ name: 'step' }, { name: 'v' }],
        rows: [['a', '1'], ['b', '5'], ['c', '3']],
    });
    check('no time column → renders with index axis', lanes().length === 1, `got ${lanes().length}`);
    check('index axis ticks are 1..n', ticks().includes('1'), ticks().join(','));
}

// ---- 12. クロスヘアとホバー ------------------------------------------------------
console.log('\n[12] crosshair and hover');
{
    await setData(WIDE);
    await setOpts({ animate: false });
    check('no crosshair before hover', !crosshair());

    const svg = doc.querySelector('svg');
    // web-02 レーン（2番目）の中ほどにカーソルを置く
    const laneBg = doc.querySelector('rect[data-role="hz-lane-bg"]');
    const laneH = Number(laneBg.getAttribute('height'));
    const evt = new win.MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(evt, 'clientX', { value: 450 });
    Object.defineProperty(evt, 'clientY', { value: 8 + laneH + 2 + laneH / 2 });
    svg.dispatchEvent(evt);
    await sleep(150);

    check('crosshair appears on hover', !!crosshair());
    check('hover info panel shows series + value', String(hoverInfo()).includes('web-02'), hoverInfo());
    check('hover info shows a timestamp', /\d{4}-\d{2}-\d{2}/.test(String(hoverInfo())), hoverInfo());
    check('hover dot rendered', !!doc.querySelector('circle[data-role="hz-hoverdot"]'));

    // React 18 の onMouseLeave は mouseout から合成されるため、
    // 生の 'mouseleave' を dispatch しても発火しない。relatedTarget を
    // SVG の外（body）にした mouseout を投げるのが実際の離脱に相当する。
    const leave = new win.MouseEvent('mouseout', { bubbles: true });
    Object.defineProperty(leave, 'relatedTarget', { value: doc.body });
    svg.dispatchEvent(leave);
    await sleep(150);
    check('crosshair cleared on leave', !crosshair());
    check('hover info cleared on leave', !hoverInfo());

    await setOpts({ animate: false, showCrosshair: false });
    const evt2 = new win.MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(evt2, 'clientX', { value: 450 });
    Object.defineProperty(evt2, 'clientY', { value: 20 });
    doc.querySelector('svg').dispatchEvent(evt2);
    await sleep(150);
    check('showCrosshair=false suppresses crosshair', !crosshair());
    await setOpts({ animate: false });
}

// ---- 13. 表示トグル --------------------------------------------------------------
console.log('\n[13] visibility toggles');
{
    await setOpts({ animate: false, showLabels: false });
    check('labels hidden', labels().length === 0);
    await setOpts({ animate: false, showPeakValue: false });
    check('peak values hidden', peaks().length === 0);
    await setOpts({ animate: false, showTimeAxis: false });
    check('time axis hidden', ticks().length === 0);
    await setOpts({ animate: false, showLegend: false });
    check('legend hidden', legendBands().length === 0);
    await setOpts({ animate: false, showLaneSeparator: false });
    check('separators hidden', q('line[data-role="hz-sep"]').length === 0);
    await setOpts({ animate: false });
    check('all restored', labels().length === 3 && peaks().length === 3 && legendBands().length === 3);
}

// ---- 14. 色オプション ------------------------------------------------------------
console.log('\n[14] color options');
{
    await setOpts({ animate: false, positiveColor: '#00ff00' });
    check('custom positive color applied',
        bands().every((p) => p.getAttribute('data-sign') !== 'pos' || String(p.getAttribute('fill')).startsWith('rgba(0,255,0,')),
        bands()[0]?.getAttribute('fill'));

    // 不正な色はデフォルトに落ちる
    await setOpts({ animate: false, positiveColor: 'not-a-color' });
    check('invalid color falls back to default',
        String(bands()[0].getAttribute('fill')).startsWith('rgba(31,120,180,'), bands()[0].getAttribute('fill'));

    // 最下バンドの濃さ
    await setOpts({ animate: false, bandOpacityFloor: 0.6 });
    const b0 = bandsOf(1).find((p) => p.getAttribute('data-band') === '0');
    const op = Number(String(b0.getAttribute('fill')).match(/,([\d.]+)\)/)[1]);
    check('bandOpacityFloor=0.6 applied to band0', Math.abs(op - 0.6) < 0.005, String(op));
    await setOpts({ animate: false });
}

// ---- 15. レーン高さ・オートフィット・スクロール -------------------------------------
console.log('\n[15] lane height / autofit / scroll');
{
    await setData(WIDE);
    await setOpts({ animate: false, autoFitLanes: true, laneHeight: 200 });
    const laneBg = doc.querySelector('rect[data-role="hz-lane-bg"]');
    const fitH = Number(laneBg.getAttribute('height'));
    // 3レーンがパネル高さ（560）に収まるよう配分される
    check('autofit spreads lanes across panel', fitH > 100 && fitH < 200, `laneH=${fitH}`);

    await setOpts({ animate: false, autoFitLanes: false, laneHeight: 30 });
    const fixedH = Number(doc.querySelector('rect[data-role="hz-lane-bg"]').getAttribute('height'));
    check('fixed lane height honored', Math.abs(fixedH - 30) < 0.01, `laneH=${fixedH}`);

    // 多系列 → 縦スクロール（svg がコンテナより高い）
    await setData({
        fields: [{ name: '_time' }, ...Array.from({ length: 80 }, (_, i) => ({ name: `s${i + 1}` }))],
        rows: [
            ['2026-07-20T00:00:00', ...Array.from({ length: 80 }, (_, i) => String(i + 1))],
            ['2026-07-20T01:00:00', ...Array.from({ length: 80 }, (_, i) => String(80 - i))],
        ],
    });
    await setOpts({ animate: false, maxSeries: 80, autoFitLanes: true });
    check('80 lanes all rendered', lanes().length === 80, `got ${lanes().length}`);
    const svgH = Number(doc.querySelector('svg').getAttribute('height'));
    check('svg taller than panel → scrolls', svgH > VH, `svgH=${svgH}`);
    await setOpts({ animate: false });
}

// ---- 16. columns 形式・マルチバリュー救済 ------------------------------------------
console.log('\n[16] columns-form / multivalue rescue');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'a' }, { name: 'b' }],
        columns: [
            ['2026-07-20T00:00:00', '2026-07-20T01:00:00'],
            ['1', '2'],
            ['3', '4'],
        ],
    });
    check('columns-form renders 2 lanes', lanes().length === 2, `got ${lanes().length}`);
    check('columns-form peaks 2/4', peaks().join(',') === '2,4', peaks().join(','));

    // マルチバリュー: 1行に配列で届くケースを平行展開
    await setData({
        fields: [{ name: '_time' }, { name: 'host' }, { name: 'v' }],
        rows: [[
            ['2026-07-20T00:00:00', '2026-07-20T01:00:00'],
            ['h1', 'h1'],
            ['10', '20'],
        ]],
    });
    check('multivalue row expanded', lanes().length === 1 && peaks().join(',') === '20',
        `${lanes().length} lanes, peaks=${peaks().join(',')}`);
}

// ---- 17. 数値フォーマット --------------------------------------------------------
console.log('\n[17] number formatting');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'bytes' }],
        rows: [['2026-07-20T00:00:00', '1500000'], ['2026-07-20T01:00:00', '2300000']],
    });
    await setOpts({ animate: false, abbreviateValue: true });
    check('abbreviated peak (2.3M)', peaks().join(',') === '2.3M', peaks().join(','));
    await setOpts({ animate: false, abbreviateValue: false });
    check('full peak with commas', peaks().join(',') === '2,300,000', peaks().join(','));
    await setOpts({ animate: false, abbreviateValue: false, valueDecimals: 2 });
    check('decimals honored', peaks().join(',') === '2,300,000.00', peaks().join(','));

    // カンマ入り数値の入力も正しく読む
    await setData({
        fields: [{ name: '_time' }, { name: 'v' }],
        rows: [['2026-07-20T00:00:00', '1,234'], ['2026-07-20T01:00:00', '2,000']],
    });
    await setOpts({ animate: false, abbreviateValue: false });
    check('comma-separated input parsed', peaks().join(',') === '2,000', peaks().join(','));
    await setOpts({ animate: false });
}

// ---- 18. テーマ切替 --------------------------------------------------------------
console.log('\n[18] theme switch');
{
    await setData(WIDE);
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const lab = doc.querySelector('text[data-role="hz-label"]');
    check('light-mode label color', lab && lab.getAttribute('fill') === '#5c6773', lab && lab.getAttribute('fill'));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const labD = doc.querySelector('text[data-role="hz-label"]');
    check('dark-mode label color', labD && labD.getAttribute('fill') === '#8b98a5', labD && labD.getAttribute('fill'));
}

// ---- 19. アニメーション ----------------------------------------------------------
console.log('\n[19] draw-in animation completes');
{
    await setOpts({});
    await setData(WIDE);
    await sleep(1200);
    // アニメーション完了後は全時刻点が描かれている（パス末尾 x = プロット右端付近）
    const b = bandsOf(1)[0];
    const xs = String(b.getAttribute('d')).match(/-?\d+(\.\d+)?/g).filter((_, i) => i % 2 === 0).map(Number);
    check('animation reaches right edge', Math.max(...xs) > VW * 0.7, `maxX=${Math.max(...xs)}`);
    check('lanes intact after animation', lanes().length === 3, `got ${lanes().length}`);
    await setOpts({ animate: false });
}

// ---- 20. 曲線/直線の切替 ----------------------------------------------------------
console.log('\n[20] curve vs linear paths');
{
    await setOpts({ animate: false, curve: true });
    check('curve=true emits cubic segments', String(bandsOf(1)[0].getAttribute('d')).includes('C'));
    await setOpts({ animate: false, curve: false });
    const d = String(bandsOf(1)[0].getAttribute('d'));
    check('curve=false emits only line segments', !d.includes('C') && d.includes('L'), d.slice(0, 60));
    await setOpts({ animate: false });
}

// ---- 21. ガード -------------------------------------------------------------------
console.log('\n[21] guards');
{
    await setData({ fields: [{ name: '_time' }, { name: 'v' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', 'yy'], ['z', 'ww']] });
    check('non-numeric data guarded', doc.body.textContent.includes('データがありません'));

    // 全系列が同値でも潰れずに描ける（globalMaxDev=0 のフォールバック）
    await setData({
        fields: [{ name: '_time' }, { name: 'flat' }],
        rows: [['2026-07-20T00:00:00', '0'], ['2026-07-20T01:00:00', '0']],
    });
    check('all-zero data renders without crash', lanes().length === 1, `got ${lanes().length}`);

    // 単一時刻点
    await setData({
        fields: [{ name: '_time' }, { name: 'v' }],
        rows: [['2026-07-20T00:00:00', '42']],
    });
    check('single time point renders', lanes().length === 1 && peaks().join(',') === '42', peaks().join(','));

    // 欠損セル混じり
    await setData({
        fields: [{ name: '_time' }, { name: 'host' }, { name: 'v' }],
        rows: [
            ['2026-07-20T00:00:00', 'h1', '10'],
            ['2026-07-20T01:00:00', 'h2', '20'],
            ['2026-07-20T02:00:00', 'h1', ''],
        ],
    });
    check('sparse/missing values tolerated', lanes().length === 2, `got ${lanes().length}`);

    await setData(WIDE);
    check('recovers after guards', lanes().length === 3, `got ${lanes().length}`);
}

// ---- 22. debug オーバーレイは廃止された ------------------------------------------
console.log('\n[22] debug overlay removed');
{
    await setOpts({ animate: false, debug: true });
    check('no debug dump even with debug:true', !doc.body.textContent.includes('"normalized"'));
    check('no options dump rendered', !doc.body.textContent.includes('"abbreviateValue"'));
    check('chart still renders normally', lanes().length === 3, `got ${lanes().length}`);
    await setOpts({ animate: false });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
