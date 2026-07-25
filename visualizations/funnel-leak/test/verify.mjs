// Funnel Leak viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_funnel_leak', 'visualization.js'
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

const FIELDS = [{ name: 'step' }, { name: 'users' }];
const ROWS = [
    ['サイト訪問', '10,000'],   // カンマ付き
    ['カート追加', '6000'],
    ['決済開始', '3500'],
    ['購入完了', '1400'],
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
    getDimensions: () => ({ width: 900, height: 560 }),
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

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 基本描画（4段, dark） -----------------------------------------------
console.log('\n[1] basic funnel (4 steps, dark)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    // 段バーは roundedRectPath（path）で描く。4段 → バー本体 path 4本以上
    const rects = [...doc.querySelectorAll('svg rect')];
    check('4 track rects (one per step)', rects.length === 4, `got ${rects.length}`);
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('step label サイト訪問', texts.some((t) => t.includes('サイト訪問')));
    check('step label 購入完了', texts.some((t) => t.includes('購入完了')));
    // 件数: 10,000 が表示（カンマ正規化して再フォーマット）
    check('count 10,000 shown', texts.some((t) => t.includes('10,000')), JSON.stringify(texts));
    check('count 1,400 shown', texts.some((t) => t.includes('1,400')));
    // 通過率: カート追加は 6000/10000 = 60%
    check('pass rate 60.0% shown', texts.some((t) => t.includes('通過 60.0%')), JSON.stringify(texts));
    // 離脱: カート追加で 4000 離脱
    check('leak −4,000 shown', texts.some((t) => t.includes('−4,000')));
    // ヘッダー総合通過率 14.0%
    const header = doc.body.textContent;
    check('header overall 14.0%', header.includes('14.0%'), header.slice(0, 160));
    check('header 4 段', header.includes('4 段'));
    // 既定ではフローの帯（リボン/リーク塗り）は非表示。粒子だけ。
    const bandPaths = [...doc.querySelectorAll('svg path')].filter((p) => {
        const f = p.getAttribute('fill') || '';
        return f.startsWith('url(#fl-ribbon-') || f.startsWith('url(#fl-leak-');
    });
    check('no flow bands by default', bandPaths.length === 0, `got ${bandPaths.length}`);
    const ribbonGrads = doc.querySelectorAll('svg defs linearGradient[id^="fl-ribbon-"]');
    check('no ribbon gradient defs by default', ribbonGrads.length === 0, `got ${ribbonGrads.length}`);
    // 粒子は既定で流れている（アニメON）
    check('particles present by default', doc.querySelectorAll('svg circle').length > 0);
}

// ---- 1b. フローの帯を表示 ON → 帯が復活 --------------------------------------
console.log('\n[1b] showFlowBands on → bands reappear');
{
    state.options = { showFlowBands: true };
    fire('options', { options: state.options });
    await sleep(250);
    const bandPaths = [...doc.querySelectorAll('svg path')].filter((p) => {
        const f = p.getAttribute('fill') || '';
        return f.startsWith('url(#fl-ribbon-') || f.startsWith('url(#fl-leak-');
    });
    check('ribbon/leak bands rendered when enabled', bandPaths.length > 0, `got ${bandPaths.length}`);
    state.options = {}; // 既定に戻す
    fire('options', { options: state.options });
    await sleep(200);
}

// ---- 2. 通過率カラースケール ------------------------------------------------
console.log('\n[2] useRateColors on (low red → high green)');
{
    state.options = { useRateColors: true, lowColor: '#ff0000', highColor: '#00ff00' };
    fire('options', { options: state.options });
    await sleep(250);
    // バーは縦グラデ（url(#fl-bar-N)）。カラースケールはグラデの stop 色で確認する。
    const barPaths = [...doc.querySelectorAll('svg path')].filter((p) =>
        (p.getAttribute('fill') || '').startsWith('url(#fl-bar-'));
    check('bars use per-step gradient fill', barPaths.length >= 4, `got ${barPaths.length}`);
    // 先頭段(fl-bar-0)は passRate=1 → highColor(緑)。中央 stop が base 色。
    const grad0 = doc.querySelector('#fl-bar-0');
    const midStop = grad0 && [...grad0.querySelectorAll('stop')].find((s) => s.getAttribute('offset') === '46%');
    check('first step base color is green (rate=1)',
        midStop && midStop.getAttribute('stop-color') === 'rgb(0,255,0)',
        midStop && midStop.getAttribute('stop-color'));
    // 最終段(通過率23%)は赤寄り。base 色の緑成分がフルではない
    const gradLast = doc.querySelector('#fl-bar-3');
    const lastMid = gradLast && [...gradLast.querySelectorAll('stop')].find((s) => s.getAttribute('offset') === '46%');
    check('last step base color is red-ish (low rate)',
        lastMid && lastMid.getAttribute('stop-color') !== 'rgb(0,255,0)',
        lastMid && lastMid.getAttribute('stop-color'));
}

// ---- 3. アニメ停止 / 密度 ---------------------------------------------------
console.log('\n[3] animation off (period=0) → no particles');
{
    state.options = { animationPeriod: 0 };
    fire('options', { options: state.options });
    await sleep(300);
    const circles = [...doc.querySelectorAll('svg circle')];
    // period=0 では粒子は生成されない（プールを空にする）
    check('no particle circles when period=0', circles.length === 0, `got ${circles.length}`);
}

console.log('\n[3b] animation on → particles exist');
{
    state.options = { animationPeriod: 6, particleDensity: 60 };
    fire('options', { options: state.options });
    await sleep(300);
    const circles = [...doc.querySelectorAll('svg circle')];
    check('particles created', circles.length > 0, `got ${circles.length}`);
}

// ---- 4. フィールド選択（columnSelector DOS 文字列） -------------------------
console.log('\n[4] field selection via DOS string (columnSelector)');
{
    state.data = {
        fields: [{ name: 'phase' }, { name: 'label' }, { name: 'cnt' }],
        rows: [
            ['1', 'A 認証', '800'],
            ['2', 'B 閲覧', '500'],
            ['3', 'C 購入', '200'],
        ],
    };
    state.options = {
        stepField: "> primary | seriesByName('label')",
        valueField: "> primary | seriesByName('cnt')",
    };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('label field resolved (A 認証)', texts.some((t) => t.includes('A 認証')), JSON.stringify(texts));
    check('value field resolved (800)', texts.some((t) => t.includes('800')));
    // 500/800 = 62.5%
    check('pass rate uses cnt field', texts.some((t) => t.includes('62.5%')), JSON.stringify(texts));
}

// ---- 5. テーマ切替 -----------------------------------------------------------
console.log('\n[5] theme switch to light');
{
    // データを基本に戻す
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {};
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    // 件数テキストの色はライトテキスト(#1a1c20)。段階名はバー内で白のまま。
    const countText = [...doc.querySelectorAll('svg text')].find((t) => t.textContent.includes('10,000'));
    check('count text uses light-mode color', countText && countText.getAttribute('fill') === '#1a1c20',
        countText && countText.getAttribute('fill'));
}

// ---- 6. ガード -----------------------------------------------------------
console.log('\n[6] guards');
{
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    // 空データ
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    // 1列のみ → columns 不足
    state.data = { fields: [{ name: 'a' }], rows: [['x']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('1-col message', doc.body.textContent.includes('列が不足'));

    // 全行非数値 → empty steps
    state.data = { fields: FIELDS, rows: [['a', 'xyz'], ['b', 'www']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('no valid steps message', doc.body.textContent.includes('有効なステップ'));

    // columns 形式でも動く
    state.data = { fields: FIELDS, columns: [['s1', 's2', 's3'], ['100', '60', '30']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    const rects = [...doc.querySelectorAll('svg rect')];
    check('columns-form renders 3 steps', rects.length === 3, `got ${rects.length}`);
}

// ---- 7. debug オーバーレイ ----------------------------------------------------
console.log('\n[7] debug overlay');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { debug: true };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
