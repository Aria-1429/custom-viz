// Editor Probe / ROUND 7 のローカル検証（happy-dom、Splunk 実機なし）
// ドリルダウン／トークン API が「例外なく呼べて、正しい引数で渡っているか」を検査する。
// 実際にダッシュボードが反応するか（インタラクションタブ／トークン伝播）は実機でしか分からない。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'custom_viz_editor_probe', 'visualization.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

const win = new Window({ width: 900, height: 620 });
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (typeof performance === 'undefined') globalThis.performance = { now: () => 16 };

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 620 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 620, width: 900, height: 620, x: 0, y: 0 };
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

const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [], tokens: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

let state = {
    data: { fields: [{ name: '_time' }, { name: 'count' }], rows: [['t1', '5'], ['t2', '9']] },
    options: {},
    theme: 'dark',
    mode: 'view',
    tokens: {},
};

// ドリルダウン系の呼び出しを記録する
const drilldownCalls = [];
const listenerRegistrations = [];

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: 900, height: 620 }),
    addDimensionsListener: mkListener('dimensions'),
    getMode: () => ({ mode: state.mode }),
    addModeListener: mkListener('mode'),
    getTokens: () => ({ tokens: state.tokens }),
    addTokensListener: mkListener('tokens'),
    getError: () => null,
    addErrorListener: () => () => {},
    // 実機の型定義どおり：単一オブジェクト引数
    addDrilldownListener: (args) => { listenerRegistrations.push(args); },
    triggerDrilldown: (args) => {
        drilldownCalls.push(args);
        // setToken はホスト側がトークンを更新する挙動を模す（action / type の両方を受ける）
        if (args && (args.action === 'setToken' || args.type === 'setToken') && args.payload && args.payload.name) {
            state.tokens = { ...state.tokens, [args.payload.name]: args.payload.value };
            listeners.tokens.forEach((cb) => cb({ tokens: state.tokens }));
        }
    },
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

console.log('\n[1] 初期描画');
{
    const body = doc.body.textContent;
    check('プローブが描画される', body.includes('Drilldown Table Probe'), body.slice(0, 120));
    check('ROUND11 版である', body.includes('ROUND11'));
    check('テーブルが描画される', !!doc.querySelector('[data-role="probe-table"]'));
    check('クリック可能なセルがある', doc.querySelectorAll('[data-role="probe-cell"]').length > 0,
        `cells=${doc.querySelectorAll('[data-role="probe-cell"]').length}`);
    check('スナップショットボタンがある', !!doc.querySelector('[data-role="btn-snapshot"]'));
}

console.log('\n[4] ホバーで point.mouseover / point.mouseout が飛ぶ');
{
    const rowsEl = [...doc.querySelectorAll('[data-role="probe-row"]')];
    const before = drilldownCalls.length;

    rowsEl[1].dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
    await sleep(300); // 150ms デバウンス待ち
    let c = drilldownCalls[drilldownCalls.length - 1] || {};
    check('mouseover が飛ぶ', drilldownCalls.length > before);
    check('type=point.mouseover', c.type === 'point.mouseover', c.type);
    check('payload に row.*.value がある',
        c.payload && Object.keys(c.payload).some((k) => /^row\..+\.value$/.test(k)),
        JSON.stringify(Object.keys(c.payload || {})));
    check('2行目の値である',
        c.payload?.[`row.${state.data.fields[0].name}.value`] === state.data.rows[1][0],
        JSON.stringify(c.payload));

    rowsEl[1].dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(150);
    c = drilldownCalls[drilldownCalls.length - 1] || {};
    check('type=point.mouseout', c.type === 'point.mouseout', c.type);
    check('発火ログに出る', doc.body.textContent.includes('point.mouse'));
}

console.log('\n[4a] ドラッグで range.select が飛ぶ');
{
    const rowsEl = [...doc.querySelectorAll('[data-role="probe-row"]')];
    const before = drilldownCalls.length;

    // 1行目で mousedown → 2行目へ move → mouseup
    rowsEl[0].dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await sleep(60);
    rowsEl[1].dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }));
    await sleep(60);
    rowsEl[1].dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    await sleep(150);

    const c = drilldownCalls[drilldownCalls.length - 1] || {};
    check('range.select が飛ぶ', drilldownCalls.length > before);
    check('type=range.select', c.type === 'range.select', c.type);
    check('範囲が payload に入る',
        c.payload?.['row.rangeFrom.value'] === 1 && c.payload?.['row.rangeTo.value'] === 2,
        JSON.stringify(c.payload));
    check('発火ログに出る', doc.body.textContent.includes('range.select'));
}

console.log('\n[4a2] 同じ行内の mousedown→mouseup は range 扱いしない');
{
    const rowsEl = [...doc.querySelectorAll('[data-role="probe-row"]')];
    const before = drilldownCalls.length;
    rowsEl[0].dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    await sleep(50);
    rowsEl[0].dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    await sleep(150);
    check('単一行の選択では range.select を送らない', drilldownCalls.length === before,
        `before=${before} after=${drilldownCalls.length}`);
}

console.log('\n[4b] 各セルが addDrilldownListener に登録される（click 用）');
{
    const nCells = doc.querySelectorAll('[data-role="probe-cell"]').length;
    check('セル数ぶん登録されている', listenerRegistrations.length === nCells,
        `listeners=${listenerRegistrations.length} cells=${nCells}`);
    check('すべて action=cell.click', listenerRegistrations.every((r) => r.action === 'cell.click'));
    check('すべて node を持つ', listenerRegistrations.every((r) => !!r.node));

    // セルごとに payloadCallback が「そのセルの値」を返す（1行目固定バグの回帰）
    const payloads = listenerRegistrations.map((r) => r.payloadCallback());
    const nCols = state.data.fields.length;
    check('1行目と2行目の payload が違う',
        JSON.stringify(payloads[0]) !== JSON.stringify(payloads[nCols]),
        JSON.stringify({ row1: payloads[0]?.value, row2: payloads[nCols]?.value }));
    check('2行目セルの row.*.value が2行目のもの',
        payloads[nCols]?.[`row.${state.data.fields[0].name}.value`] === state.data.rows[1][0],
        JSON.stringify(payloads[nCols]));
    check('UI に登録セル数が出る', /\d+ セルを登録/.test(doc.body.textContent),
        doc.querySelector('[data-role="listener-note"]')?.textContent);
}

console.log('\n[5] 外部からのトークン更新も購読できる');
{
    state.tokens = { ...state.tokens, external_tok: 'abc' };
    fire('tokens', { tokens: state.tokens });
    await sleep(200);
    check('外部トークンが表示される', doc.body.textContent.includes('external_tok'));
}

console.log('\n[5b] 実機どおりの入れ子トークンでも probe_token を見つけられる');
{
    // 実機は { env:{…}, default:{…}, submitted:{…} } の入れ子で届く（ROUND 7 で判明）
    state.tokens = {
        env: { app: 'sample_dashboard', user: 'admin' },
        default: { 'global_time.earliest': '-24h@h' },
        submitted: { 'global_time.earliest': '-24h@h', probe_token: 'nested_ok' },
    };
    fire('tokens', { tokens: state.tokens });
    await sleep(200);
    check('入れ子の probe_token を検出できる', doc.body.textContent.includes('nested_ok'),
        doc.body.textContent.slice(0, 200));
    check('値も表示される', doc.body.textContent.includes('nested_ok'));
}

console.log('\n[5c] columns 形式のデータも読める（ROUND 7 初回の不具合）');
{
    // rows だけ見ると「サーチは紐づいているのに 0 行」になる
    state.data = { fields: [{ name: '_time' }, { name: 'count' }], columns: [['t1', 't2', 't3'], ['5', '9', '12']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('columns 形式で 3 行と認識される', doc.body.textContent.includes('3 行'),
        doc.body.textContent.slice(0, 200));
    check('値も取れている（no-data ではない）', !doc.body.textContent.includes('no-data'));
}

console.log('\n[6] ガード（データ空・テーマ切替）');
{
    state.data = { fields: [], rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('データ空でも落ちない', doc.body.textContent.includes('Drilldown Table Probe'),
        doc.body.textContent.slice(0, 100));
    check('no-data 表示になる', doc.body.textContent.includes('no-data') || doc.body.textContent.includes('0 行'));

    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(200);
    check('light でも落ちない', doc.body.textContent.includes('Drilldown Table Probe'));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(200);
}

console.log('\n[7] config.json のフラグ');
{
    const cfgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'visualizations', 'custom_viz_editor_probe', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    check('showDrilldown が true', cfg.showDrilldown === true);
    check('hasEventHandlers が true', cfg.hasEventHandlers === true);
    check('canSetTokens が dynamic/static', Array.isArray(cfg.canSetTokens) && cfg.canSetTokens.includes('dynamic'),
        JSON.stringify(cfg.canSetTokens));
    // ROUND 9：標準 viz と同じ events / supports 宣言を入れてみる（未検証・推測）
    check('events に4種を宣言している',
        ['cell.click', 'point.mouseover', 'point.mouseout', 'range.select']
            .every((e) => !!(cfg.config.events && cfg.config.events[e])),
        JSON.stringify(Object.keys(cfg.config.events || {})));
    check('supports に events がある', Array.isArray(cfg.config.supports) && cfg.config.supports.includes('events'),
        JSON.stringify(cfg.config.supports));

    // 使用不可が確定した editor 型が紛れ込んでいないか
    const used = [];
    (function walk(n) {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
            if (typeof n.editor === 'string') used.push(n.editor);
            Object.values(n).forEach(walk);
        }
    })(cfg.config.editorConfig);
    const KNOWN_BAD = ['editor.marks', 'editor.seriesLineTypes', 'editor.seriesLineTypesByField',
        'editor.dynamicColor', 'editor.dynamicColorWithPrecedence', 'editor.networkGraphDynamicColor',
        'editor.tableDynamicColor', 'editor.tableColumnFormatter'];
    check('使用不可が確定した型が入っていない', !used.some((e) => KNOWN_BAD.includes(e)),
        JSON.stringify(used.filter((e) => KNOWN_BAD.includes(e))));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exitCode = 1;
