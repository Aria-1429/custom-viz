// Spotlight Frame viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_spotlight_frame', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 400 });
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
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 400 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 400, width: 900, height: 400, x: 0, y: 0 };
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

// 既定データ: ホスト×severity（1件 critical / 複数 warning / 残り ok）
const FIELDS = [{ name: 'host' }, { name: 'severity' }];
const ROWS = [
    ['web-01', 'ok'],
    ['web-02', 'warning'],
    ['api-01', 'critical'],
    ['api-02', 'warning'],
    ['db-01', 'ok'],
];

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
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
    getDimensions: () => ({ width: 900, height: 400 }),
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
    await sleep(220);
};
const setData = async (data) => {
    state.data = data;
    fire('dataSources', { loading: false, dataSources: { primary: { data } } });
    await sleep(220);
};

const frame = () => doc.querySelector('[data-role="frame"]');
const badge = () => doc.querySelector('[data-role="status-badge"]');

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 文字列 severity → 最悪(critical)に丸める ------------------------------
console.log('\n[1] worst-of text severity (critical wins)');
{
    const f = frame();
    check('frame rendered', !!f);
    check('frame status = crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    check('border uses crit color #ef4444', f && f.style.border.includes('#ef4444'), f && f.style.border);
    const b = badge();
    check('badge shows CRITICAL', b && b.textContent.includes('CRITICAL'), b && b.textContent);
    const body = doc.body.textContent;
    check('counts: Crit 1', body.includes('Crit 1'), body.slice(0, 200));
    check('counts: Warn 2', body.includes('Warn 2'));
    check('counts: OK 2', body.includes('OK 2'));
    check('crit sample host shown (api-01)', body.includes('api-01'), body.slice(0, 300));
    check('title = severity field name', body.includes('severity'));
}

// ---- 2. critical を除くと warning に落ちる -----------------------------------
console.log('\n[2] downgrade to warning when no critical');
{
    await setData({ fields: FIELDS, rows: [['web-01', 'ok'], ['web-02', 'warning'], ['db-01', 'ok']] });
    const f = frame();
    check('frame status = warn', f && f.getAttribute('data-status') === 'warn', f && f.getAttribute('data-status'));
    check('border uses warn color #f59e0b', f && f.style.border.includes('#f59e0b'), f && f.style.border);
    check('badge WARNING', badge() && badge().textContent.includes('WARNING'));
}

// ---- 3. 全て正常 → OK -------------------------------------------------------
console.log('\n[3] all ok → OK');
{
    await setData({ fields: FIELDS, rows: [['web-01', 'up'], ['db-01', 'healthy'], ['api', 'normal']] });
    const f = frame();
    check('frame status = ok', f && f.getAttribute('data-status') === 'ok', f && f.getAttribute('data-status'));
    check('border uses ok color #22c55e', f && f.style.border.includes('#22c55e'), f && f.style.border);
    check('badge OK', badge() && badge().textContent.includes('OK'));
}

// ---- 4. 数値しきい値モード（matchMode=1, higherIsWorse） -----------------------
console.log('\n[4] numeric threshold mode');
{
    await setData({ fields: [{ name: 'host' }, { name: 'errors' }], rows: [['a', '0'], ['b', '3'], ['c', '12']] });
    // crit>=10, warn>=3
    await setOpts({ matchMode: 1, warnThreshold: 3, critThreshold: 10, higherIsWorse: true });
    let f = frame();
    check('num: worst is crit (12>=10)', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    const body = doc.body.textContent;
    check('num counts Crit 1', body.includes('Crit 1'), body.slice(0, 200));
    check('num counts Warn 1', body.includes('Warn 1'));
    check('num counts OK 1', body.includes('OK 1'));

    // しきい値を上げると warn 止まり
    await setOpts({ matchMode: 1, warnThreshold: 3, critThreshold: 100, higherIsWorse: true });
    f = frame();
    check('num: raised crit threshold → warn', f && f.getAttribute('data-status') === 'warn', f && f.getAttribute('data-status'));
}

// ---- 5. lowerIsWorse（可用性%など小さいほど悪い） -----------------------------
console.log('\n[5] higherIsWorse=false');
{
    await setData({ fields: [{ name: 'svc' }, { name: 'uptime' }], rows: [['a', '99.9'], ['b', '95'], ['c', '80']] });
    await setOpts({ matchMode: 1, warnThreshold: 98, critThreshold: 90, higherIsWorse: false });
    const f = frame();
    check('low-is-worse: 80<=90 → crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
}

// ---- 6. フィールド選択（columnSelector DOS 文字列） --------------------------
console.log('\n[6] field selection via DOS string');
{
    await setData({
        fields: [{ name: 'host' }, { name: 'label' }, { name: 'state' }],
        rows: [['h1', 'foo', 'ok'], ['h2', 'bar', 'critical'], ['h3', 'baz', 'ok']],
    });
    await setOpts({ matchMode: 2, valueField: "> primary | seriesByName('state')", labelField: "> primary | seriesByName('host')" });
    const f = frame();
    check('DOS: value field state → crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    check('DOS: crit sample from host (h2)', doc.body.textContent.includes('h2'), doc.body.textContent.slice(0, 300));
}

// ---- 7. 単値データ（1列/1行） ------------------------------------------------
console.log('\n[7] single scalar value');
{
    await setOpts({});
    await setData({ fields: [{ name: 'status' }], rows: [['CRITICAL']] });
    const f = frame();
    check('scalar: single critical → crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
}

// ---- 8. 点滅（pulseMode=2, crit のみ） --------------------------------------
console.log('\n[8] pulse animation on critical');
{
    await setData({ fields: FIELDS, rows: ROWS }); // critical あり
    await setOpts({ pulseMode: 2, pulsePeriod: 1.6 });
    let f = frame();
    check('pulse active on crit', f && /spotlightFramePulse/.test(f.style.animation), f && f.style.animation);

    // OK データでは点滅しない
    await setData({ fields: FIELDS, rows: [['a', 'ok'], ['b', 'up']] });
    f = frame();
    check('no pulse when ok', f && (!f.style.animation || f.style.animation === 'none'), f && f.style.animation);

    // pulsePeriod=0 で停止
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ pulseMode: 2, pulsePeriod: 0 });
    f = frame();
    check('pulsePeriod 0 disables pulse', f && (!f.style.animation || f.style.animation === 'none'), f && f.style.animation);
    check('keyframes injected', !!doc.getElementById('spotlight-frame-pulse-keyframes'));
}

// ---- 9. frameOnly（中央透明） -----------------------------------------------
console.log('\n[9] frameOnly transparent center');
{
    await setOpts({ frameOnly: true });
    const f = frame();
    check('center transparent', f && f.style.background === 'transparent', f && f.style.background);

    await setOpts({ frameOnly: false });
    const f2 = frame();
    check('center filled when not frameOnly', f2 && f2.style.background !== 'transparent' && f2.style.background !== '', f2 && f2.style.background.slice(0, 40));
}

// ---- 10. light テーマ -------------------------------------------------------
console.log('\n[10] light theme');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(220);
    const f = frame();
    check('renders in light theme (crit border)', f && f.style.border.includes('#ef4444'), f && f.style.border);
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(150);
}

// ---- 11. ガード（空データ / 判定不能） ---------------------------------------
console.log('\n[11] guards');
{
    await setData({ fields: [{ name: 'x' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    // 判定不能（未知の文字列のみ、文字列一致モード）
    await setData({ fields: [{ name: 'x' }], rows: [['zzz'], ['qqq']] });
    await setOpts({ matchMode: 2 });
    check('unclassifiable message', doc.body.textContent.includes('状態を判定できませんでした'), doc.body.textContent.slice(0, 160));
}

// ---- 結果 -------------------------------------------------------------------
console.log(`\n${'='.repeat(48)}`);
console.log(`  PASS ${pass}  /  FAIL ${fail}`);
console.log('='.repeat(48));
if (fail > 0) process.exit(1);
