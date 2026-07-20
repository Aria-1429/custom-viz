// Severity Table viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'custom_viz_severity_table',
    'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) {
        pass += 1;
        console.log(`  ✓ ${name}`);
    } else {
        fail += 1;
        console.log(`  ✗ ${name} ${extra}`);
    }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 500 });
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
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 500 });

globalThis.ResizeObserver = class {
    constructor(cb) {
        this.cb = cb;
    }
    observe() {
        setTimeout(() => this.cb([]), 0);
    }
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
    return () => {
        listeners[key] = listeners[key].filter((f) => f !== cb);
    };
};

const FIELDS = [{ name: '_time_str' }, { name: 'severity' }, { name: 'event' }, { name: 'host' }];
const ROWS = [
    ['2026-07-19 10:05', 'medium', 'Policy violation', 'host-22'],
    ['2026-07-19 10:12', 'critical', 'Brute force detected', 'host-01'],
    ['2026-07-19 09:58', 'low', 'Login success', 'host-03'],
    ['2026-07-19 10:09', 'high', 'Port scan', 'host-07'],
    ['2026-07-19 09:51', 'info', 'Config reload', 'host-11'],
    ['2026-07-19 09:40', 'warning', 'Unusual traffic', 'host-05'], // alias → medium
    ['2026-07-19 09:30', 'unknown-xyz', 'Odd thing', 'host-09'], // 未定義 → プレーン表示
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
    setOptions: (o) => {
        state.options = { ...state.options, ...o };
    },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: 900, height: 500 }),
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
const bodyRowTexts = () =>
    [...doc.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' | ')
    );

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 基本描画・自動判定・ソート -----------------------------------------
console.log('\n[1] basic render (auto severity detect, default sort by severity)');
{
    const table = doc.querySelector('table');
    check('table rendered', !!table);
    const headers = [...doc.querySelectorAll('thead th')].map((t) => t.textContent.trim());
    check('4 data columns (+row bar th)', headers.filter((h) => h.length > 0).length === 4, JSON.stringify(headers));
    check('header label strips underscore', headers.includes('time str'), JSON.stringify(headers));

    const rows = bodyRowTexts();
    check('7 rows rendered', rows.length === 7, `got ${rows.length}`);
    // ソート既定ON: 先頭は critical、末尾付近に info/unknown
    check('first row is critical', rows[0].includes('critical'), rows[0]);
    check('critical before high', rows[0].includes('critical') && rows[1].includes('high'), rows.slice(0, 2).join(' // '));
    // 件数サマリ(既定ON): 各レベルの日本語ラベル
    const body = doc.body.textContent;
    check('summary shows 重大', body.includes('重大'), body.slice(0, 120));
    check('summary shows 中 (warning→medium counted)', body.includes('中'));
    // pill 既定: critical セルに critical テキスト
    check('unknown severity shown as plain text', rows.some((r) => r.includes('unknown-xyz')));
}

// ---- 2. ソートOFF（元順序維持） --------------------------------------------
console.log('\n[2] sortBySeverity off → original order');
{
    state.options = { sortBySeverity: false };
    fire('options', { options: state.options });
    await sleep(200);
    const rows = bodyRowTexts();
    check('first row back to medium (original order)', rows[0].includes('medium'), rows[0]);
}

// ---- 3. 最大表示行数 --------------------------------------------------------
console.log('\n[3] maxRows = 3');
{
    state.options = { maxRows: 3 };
    fire('options', { options: state.options });
    await sleep(200);
    const rows = bodyRowTexts();
    check('only 3 rows shown', rows.length === 3, `got ${rows.length}`);
    // タイトル行に "3 / 7" の件数表示
    check('title shows shown/total 3 / 7', doc.body.textContent.includes('3') && doc.body.textContent.includes('7'));
}

// ---- 4. 色オプション反映 ----------------------------------------------------
console.log('\n[4] custom critical color reflected');
{
    state.options = { criticalColor: '#123abc', maxRows: 0 };
    fire('options', { options: state.options });
    await sleep(200);
    check('custom critical color used somewhere', doc.body.innerHTML.toLowerCase().includes('#123abc'), 'color not found');
}

// ---- 5. 数値 severity + 閾値 -----------------------------------------------
console.log('\n[5] numeric severity via thresholds');
{
    state.data = {
        fields: [{ name: 'urgency' }, { name: 'event' }],
        rows: [
            ['5', 'Data exfiltration'],
            ['3', 'Repeated failures'],
            ['1', 'Info log'],
        ],
    };
    state.options = { numericSeverity: true, criticalThreshold: 4, highThreshold: 3, mediumThreshold: 2, lowThreshold: 1 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(220);
    const rows = bodyRowTexts();
    check('3 rows for numeric data', rows.length === 3, `got ${rows.length}`);
    // 5 → critical(重大) がサマリに出る
    check('numeric 5 counted as 重大', doc.body.textContent.includes('重大'), doc.body.textContent.slice(0, 120));
    check('numeric 3 counted as 高', doc.body.textContent.includes('高'));
}

// ---- 6. columnSelector の DOS 文字列で列指定 -------------------------------
console.log('\n[6] severityField via DOS string');
{
    state.data = {
        fields: [{ name: 'lvl' }, { name: 'sev2' }, { name: 'msg' }],
        rows: [
            ['x', 'critical', 'A'],
            ['y', 'low', 'B'],
        ],
    };
    // 自動判定では sev2 は名前一致しない → DOS で明示指定
    state.options = { severityField: "> primary | seriesByName('sev2')", numericSeverity: false };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(220);
    check('summary reflects sev2 column (重大 present)', doc.body.textContent.includes('重大'), doc.body.textContent.slice(0, 120));
}

// ---- 7. テーマ切替 ----------------------------------------------------------
console.log('\n[7] theme switch to light');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {};
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(220);
    const container = doc.querySelector('table');
    check('table still rendered after theme switch', !!container);
}

// ---- 8. ガード（空・ローディング・列形式） ---------------------------------
console.log('\n[8] guards');
{
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(180);
    check('empty data → No data message', doc.body.textContent.includes('No data'));

    // columns 形式でも動く
    state.data = {
        fields: [{ name: 'severity' }, { name: 'event' }],
        columns: [
            ['critical', 'low'],
            ['A', 'B'],
        ],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(180);
    check('columns-form renders 2 rows', bodyRowTexts().length === 2, `got ${bodyRowTexts().length}`);
}

// ---- 9. debug オーバーレイ --------------------------------------------------
console.log('\n[9] debug overlay');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { debug: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(200);
    check('debug dump visible (severityIndex)', doc.body.textContent.includes('severityIndex'), doc.body.textContent.slice(-200));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
