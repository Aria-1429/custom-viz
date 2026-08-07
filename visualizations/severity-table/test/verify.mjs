// Severity Table viz のローカル検証（happy-dom、Splunk実機なし）
//
// v2.0.0 の検証方針：
//   「viz が独自に持つ暗黙のルール」が無いことを確かめる。
//   深刻度の順位・別名・色・並び順・一覧にない値の扱い・範囲外の数値の扱いは
//   すべてオプションで決まり、オプションを変えれば結果が変わること。
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
    ['2026-07-19 09:40', 'warning', 'Unusual traffic', 'host-05'], // 既定の順位一覧では medium 段
    ['2026-07-19 09:30', 'unknown-xyz', 'Odd thing', 'host-09'], // 一覧にない値
];

// 既定の色（順位一覧と同じ並び）
const C = {
    critical: '#ff5c3d',
    high: '#ffab2e',
    medium: '#f2c14b',
    low: '#4dcf6e',
    info: '#4fa8f0',
    unknown: '#8b9bb4',
};

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
    theme: 'dark',
};

// ドリルダウンの記録（登録・発火・triggerDrilldown 呼び出し）
const drilldown = { registrations: [], fired: [], triggered: [] };

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
    // ドリルダウン: ホストは「登録されたノードの click」を見て payloadCallback を呼ぶ。
    // 実機の挙動を真似て、ここで実際に DOM の click リスナーを張る。
    // registrations に積むことで「同じノードに二重登録していないか」も検査できる。
    addDrilldownListener: ({ node, action, payloadCallback }) => {
        drilldown.registrations.push({ node, action });
        node.addEventListener('click', () => {
            drilldown.fired.push({ action, payload: payloadCallback() });
        });
    },
    triggerDrilldown: (args) => {
        drilldown.triggered.push(args);
    },
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));

// 深刻度の色が出る領域だけの HTML（= テーブル本体）。
// タイトル行のアクセントバーはテーマ由来の固定色(#ff5c3d)で深刻度とは無関係なので、
// 「特定の色が使われていないこと」の検査からは除外する。
const severityHtml = () => {
    const tbody = doc.querySelector('tbody');
    return (tbody ? tbody.innerHTML : '').toLowerCase();
};
const allHtml = () => doc.body.innerHTML.toLowerCase();
const bodyRowTexts = () =>
    [...doc.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' | ')
    );

// options を丸ごと差し替えて再描画を待つ
async function setOptions(options, data) {
    state.options = options;
    if (data) {
        state.data = data;
        fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    }
    fire('options', { options: state.options });
    await sleep(220);
}

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 既定の描画（既定オプションだけで従来どおりの見た目） ---------------
console.log('\n[1] default render');
{
    const table = doc.querySelector('table');
    check('table rendered', !!table);
    const headers = [...doc.querySelectorAll('thead th')].map((t) => t.textContent.trim());
    check('4 data columns (+row bar th)', headers.filter((h) => h.length > 0).length === 4, JSON.stringify(headers));
    check('header label strips underscore', headers.includes('time str'), JSON.stringify(headers));

    const rows = bodyRowTexts();
    check('7 rows rendered', rows.length === 7, `got ${rows.length}`);
    check('default sort desc: critical first', rows[0].includes('critical'), rows[0]);
    check('high second', rows[1].includes('high'), rows[1]);
    check('unknown value sorts last', rows[6].includes('unknown-xyz'), rows[6]);

    const html = allHtml();
    check('critical uses palette[0]', html.includes(C.critical));
    check('high uses palette[1]', html.includes(C.high));
    check('medium uses palette[2]', html.includes(C.medium));
    check('low uses palette[3]', html.includes(C.low));
    check('info uses palette[4]', html.includes(C.info));
    check('unknown uses unknownColor', html.includes(C.unknown), 'missing unknown color');

    // 既定のサマリラベルは順位一覧の代表値（日本語への暗黙変換はしない）
    const text = doc.body.textContent;
    check('summary label is canonical "critical"', text.includes('critical'));
    check('no hidden Japanese level label 重大', !text.includes('重大'), text.slice(0, 200));
    // 既定ではタイトルは出ない（暗黙の英語タイトルを廃止）
    check('no hardcoded default title', !text.includes('Recent High Severity Alerts'));
}

// ---- 2. 並び順オプション（3択） --------------------------------------------
console.log('\n[2] sortMode');
{
    await setOptions({ sortMode: 'none' });
    check('none → original order (medium first)', bodyRowTexts()[0].includes('medium'), bodyRowTexts()[0]);

    await setOptions({ sortMode: 'asc' });
    const rows = bodyRowTexts();
    // asc は「軽微→重大」。一覧にない値は既定で最下位＝軽微側なので先頭に来る。
    check('asc → unknown (最下位扱い) first', rows[0].includes('unknown-xyz'), rows[0]);
    check('asc → critical last', rows[rows.length - 1].includes('critical'), rows[rows.length - 1]);

    await setOptions({ sortMode: 'desc' });
    check('desc → critical first', bodyRowTexts()[0].includes('critical'));
}

// ---- 3. 最大表示行数 --------------------------------------------------------
console.log('\n[3] maxRows = 3');
{
    await setOptions({ maxRows: 3 });
    check('only 3 rows shown', bodyRowTexts().length === 3, `got ${bodyRowTexts().length}`);
    check('shown/total indicator visible', doc.body.textContent.includes('3 / 7'), doc.body.textContent.slice(0, 120));
}

// ---- 4. ★順位一覧（severityOrder）がすべてを決める ------------------------
console.log('\n[4] severityOrder drives rank / alias / grouping');
{
    // 既定と逆の順位を宣言する: info が最重大、critical が最軽微
    await setOptions({
        maxRows: 0,
        severityOrder: ['info', 'low', 'medium', 'high', 'critical'],
    });
    const rows = bodyRowTexts();
    check('reversed order → info first', rows[0].includes('info'), rows[0]);
    check('reversed order → critical last among known', rows[4].includes('critical'), rows.join(' // '));
    const html = allHtml();
    check('info now painted with palette[0]', html.includes(C.critical), 'palette[0] missing');

    // 別名は | で宣言する。宣言しなければ「一覧にない値」になる。
    await setOptions({
        maxRows: 0,
        severityOrder: ['critical', 'high', 'medium', 'low', 'info'], // warning を宣言しない
    });
    const summary = doc.body.textContent;
    check('undeclared alias "warning" is NOT folded into medium', summary.includes('warning'), summary.slice(0, 200));

    // 宣言すれば畳まれる
    await setOptions({
        maxRows: 0,
        severityOrder: ['critical', 'high', 'medium|warning', 'low', 'info'],
        summaryLabelMode: 'canonical',
    });
    const text2 = doc.body.textContent;
    check('declared alias folds into canonical "medium"', !/warning\s*1/.test(text2), text2.slice(0, 200));

    // 順位一覧に無い深刻度体系（P1/P2/P3）を宣言すればそのまま動く
    await setOptions(
        { maxRows: 0, severityOrder: ['P1', 'P2', 'P3'] },
        {
            fields: [{ name: 'severity' }, { name: 'event' }],
            rows: [
                ['P2', 'Disk pressure'],
                ['P1', 'Cluster down'],
                ['P3', 'Cert expiring'],
                ['P1', 'Second outage'],
            ],
        }
    );
    const p = bodyRowTexts();
    check('P1/P2/P3: 4 rows', p.length === 4, `got ${p.length}`);
    check('P1 sorts first', p[0].includes('P1') && p[1].includes('P1'), p.join(' // '));
    check('P3 sorts last', p[3].includes('P3'), p.join(' // '));
    const ph = allHtml();
    check('P1 → palette[0]', ph.includes(C.critical));
    check('P2 → palette[1]', ph.includes(C.high));
    check('P3 → palette[2]', ph.includes(C.medium));
    check('no error boundary', !doc.body.textContent.includes('Visualization error'));

    // 非ASCII でも同じ
    await setOptions(
        { maxRows: 0, severityOrder: ['緊急', '注意'] },
        {
            fields: [{ name: 'level' }, { name: 'event' }],
            rows: [
                ['注意', '軽微な逸脱'],
                ['緊急', '侵害の可能性'],
            ],
        }
    );
    check('non-ASCII order: 緊急 sorts first', bodyRowTexts()[0].includes('緊急'), bodyRowTexts().join(' // '));
    check('non-ASCII: no error boundary', !doc.body.textContent.includes('Visualization error'));
}

// ---- 4b. 色はデータの中身に依存しない（v1 系の比例配分を撤廃） -------------
console.log('\n[4b] a value keeps its color regardless of what else is in the data');
{
    const opts = { maxRows: 0, severityOrder: ['critical', 'high', 'medium', 'low', 'info'] };
    // critical のみのデータ
    await setOptions(opts, {
        fields: [{ name: 'severity' }, { name: 'event' }],
        rows: [['critical', 'only one level']],
    });
    check('critical alone → palette[0]', severityHtml().includes(C.critical), severityHtml().slice(0, 200));

    // critical + info のデータ（v1 系ではここで色の割り当てが変わっていた）
    await setOptions(opts, {
        fields: [{ name: 'severity' }, { name: 'event' }],
        rows: [
            ['critical', 'a'],
            ['info', 'b'],
        ],
    });
    const h = severityHtml();
    check('critical still palette[0] with info present', h.includes(C.critical));
    check('info uses palette[4], not palette[3]', h.includes(C.info) && !h.includes(C.low), h.slice(0, 300));
}

// ---- 4c. 色パレット（severityColors）を差し替えられる ----------------------
console.log('\n[4c] severityColors palette');
{
    await setOptions(
        {
            maxRows: 0,
            severityOrder: ['a', 'b', 'c'],
            severityColors: ['#111aaa', '#222bbb', '#333ccc'],
        },
        {
            fields: [{ name: 'severity' }, { name: 'event' }],
            rows: [['a', '1'], ['b', '2'], ['c', '3']],
        }
    );
    const h = severityHtml();
    check('custom palette[0] used', h.includes('#111aaa'));
    check('custom palette[1] used', h.includes('#222bbb'));
    check('custom palette[2] used', h.includes('#333ccc'));
    check('default palette gone from table', !h.includes(C.critical) && !h.includes(C.info), h.slice(0, 200));

    // パレットが順位より短いときは先頭から繰り返す
    await setOptions({
        maxRows: 0,
        severityOrder: ['a', 'b', 'c'],
        severityColors: ['#111aaa', '#222bbb'],
    });
    const h2 = severityHtml();
    check('palette cycles when shorter than order', h2.includes('#111aaa') && h2.includes('#222bbb'));
    check('no error with short palette', !doc.body.textContent.includes('Visualization error'));
}

// ---- 4d. 一覧にない値の扱いがオプションで決まる ----------------------------
console.log('\n[4d] unknown value handling');
{
    const data = {
        fields: [{ name: 'severity' }, { name: 'event' }],
        rows: [
            ['low', 'known-low'],
            ['zzz', 'unknown-1'],
            ['critical', 'known-crit'],
        ],
    };
    await setOptions({ maxRows: 0, sortMode: 'desc' }, data);
    check('unknown default → last', bodyRowTexts()[2].includes('zzz'), bodyRowTexts().join(' // '));
    check('unknown colored by default', severityHtml().includes(C.unknown), severityHtml().slice(0, 200));

    await setOptions({ maxRows: 0, sortMode: 'desc', unknownOrder: 'first' });
    check('unknownOrder=first → unknown on top', bodyRowTexts()[0].includes('zzz'), bodyRowTexts().join(' // '));

    await setOptions({ maxRows: 0, sortMode: 'desc', colorUnknown: false });
    check('colorUnknown=false → no unknown color', !severityHtml().includes(C.unknown), severityHtml().slice(0, 200));
    check('known values still colored', severityHtml().includes(C.critical));

    await setOptions({ maxRows: 0, sortMode: 'desc', unknownColor: '#abcdef' });
    check('custom unknownColor applied', severityHtml().includes('#abcdef'), severityHtml().slice(0, 200));
}

// ---- 5. 数値モード ----------------------------------------------------------
const NUMERIC_DATA = {
    fields: [{ name: 'urgency' }, { name: 'event' }],
    rows: [
        ['5', 'Data exfiltration'],
        ['3', 'Repeated failures'],
        ['1', 'Info log'],
    ],
};

console.log('\n[5] numeric mode via severityBands');
{
    await setOptions({ severityMode: 'number' }, NUMERIC_DATA);
    check('3 rows for numeric data', bodyRowTexts().length === 3, `got ${bodyRowTexts().length}`);
    const html = allHtml();
    check('5 → top band color', html.includes(C.critical));
    check('3 → high band color', html.includes(C.high));
    check('1 → low band color', html.includes(C.low));
    check('summary shows range labels', /\d+–\d+/.test(doc.body.textContent), doc.body.textContent.slice(0, 200));
    check('numeric sorted desc: 5 first', bodyRowTexts()[0].includes('5'), bodyRowTexts().join(' // '));

    // 文字列モードのままなら数値は「一覧にない値」になる（型は明示オプション）
    await setOptions({ severityMode: 'string' }, NUMERIC_DATA);
    check('string mode → numbers are unknown-colored', severityHtml().includes(C.unknown), severityHtml().slice(0, 200));
}

console.log('\n[5b] custom bands and out-of-range handling');
{
    await setOptions(
        {
            severityMode: 'number',
            severityBands: [
                { from: 0, to: 2, value: '#111aaa' },
                { from: 2, to: 4, value: '#222bbb' },
                { from: 4, to: 9, value: '#333ccc' },
            ],
        },
        NUMERIC_DATA
    );
    const h = severityHtml();
    check('custom band color for 5', h.includes('#333ccc'));
    check('custom band color for 3', h.includes('#222bbb'));
    check('custom band color for 1', h.includes('#111aaa'));
    check('default bands gone', !h.includes(C.critical) && !h.includes(C.info), h.slice(0, 200));

    // 範囲外の扱い: clamp(既定) と unknown
    const outData = {
        fields: [{ name: 'urgency' }, { name: 'event' }],
        rows: [
            ['50', 'way above'],
            ['1', 'inside'],
        ],
    };
    await setOptions(
        {
            severityMode: 'number',
            bandOutOfRange: 'clamp',
            severityBands: [
                { from: 0, to: 2, value: '#111aaa' },
                { from: 2, to: 4, value: '#222bbb' },
            ],
        },
        outData
    );
    check('clamp → out-of-range gets nearest band color', severityHtml().includes('#222bbb'), severityHtml().slice(0, 200));

    await setOptions({
        severityMode: 'number',
        bandOutOfRange: 'unknown',
        severityBands: [
            { from: 0, to: 2, value: '#111aaa' },
            { from: 2, to: 4, value: '#222bbb' },
        ],
    });
    const h2 = severityHtml();
    check('unknown → out-of-range gets unknownColor', h2.includes(C.unknown), h2.slice(0, 200));
    check('unknown → nearest band color NOT used', !h2.includes('#222bbb'), h2.slice(0, 200));
}

// ---- 5c. 壊れたバンド・壊れた順位一覧でも落ちない --------------------------
console.log('\n[5c] malformed options fall back sanely');
{
    const malformedBands = [
        ['unsorted', [
            { from: 4, to: 9, value: '#333ccc' },
            { from: 0, to: 2, value: '#111aaa' },
            { from: 2, to: 4, value: '#222bbb' },
        ]],
        ['overlapping', [
            { from: 0, to: 6, value: '#111aaa' },
            { from: 2, to: 9, value: '#222bbb' },
        ]],
        ['reversed from/to', [{ from: 9, to: 0, value: '#111aaa' }]],
        ['open ranges (null bounds)', [
            { from: null, to: 3, value: '#111aaa' },
            { from: 3, to: null, value: '#222bbb' },
        ]],
        ['empty array', []],
        ['not an array', 'nonsense'],
        ['garbage entries', [null, 42, { from: 'x', to: 'y' }, { value: 'not-a-color' }]],
    ];
    for (const [name, bands] of malformedBands) {
        await setOptions({ severityMode: 'number', severityBands: bands }, NUMERIC_DATA);
        check(`${name}: still renders 3 rows`, bodyRowTexts().length === 3, `got ${bodyRowTexts().length}`);
        check(`${name}: no error boundary`, !doc.body.textContent.includes('Visualization error'));
    }

    const malformedOrder = [
        ['empty array', []],
        ['not an array', 'nonsense'],
        ['blank strings', ['', '   ']],
        ['pipes only', ['|||']],
        ['non-strings', [1, null, {}]],
        ['duplicate token across stages', ['critical|dup', 'high|dup']],
    ];
    for (const [name, order] of malformedOrder) {
        await setOptions({ maxRows: 0, severityOrder: order }, { fields: FIELDS, rows: ROWS });
        check(`order ${name}: renders 7 rows`, bodyRowTexts().length === 7, `got ${bodyRowTexts().length}`);
        check(`order ${name}: no error boundary`, !doc.body.textContent.includes('Visualization error'));
    }

    const malformedPalette = [
        ['empty array', []],
        ['not an array', 'nonsense'],
        ['all invalid colors', ['red', 'nope', 123]],
        ['mixed valid/invalid', ['#123456', 'nope']],
    ];
    for (const [name, colors] of malformedPalette) {
        await setOptions({ maxRows: 0, severityColors: colors });
        check(`palette ${name}: renders 7 rows`, bodyRowTexts().length === 7, `got ${bodyRowTexts().length}`);
        check(`palette ${name}: no error boundary`, !doc.body.textContent.includes('Visualization error'));
    }
}

// ---- 5d. 旧オプションキーは一切読まれない ----------------------------------
console.log('\n[5d] legacy option keys are ignored');
{
    await setOptions(
        {
            maxRows: 0,
            // v1 系のキーだけを与える
            sortBySeverity: false,
            numericSeverity: true,
            showTitle: true,
            criticalColor: '#123abc',
            highColor: '#456def',
            infoColor: '#9abcde',
            criticalThreshold: 3,
        },
        { fields: FIELDS, rows: ROWS }
    );
    const h = allHtml();
    check('legacy criticalColor not used', !h.includes('#123abc'));
    check('legacy highColor not used', !h.includes('#456def'));
    check('legacy infoColor not used', !h.includes('#9abcde'));
    check('legacy sortBySeverity ignored → still sorted desc', bodyRowTexts()[0].includes('critical'), bodyRowTexts()[0]);
    check('legacy numericSeverity ignored → strings still colored', h.includes(C.critical));
    check('legacy showTitle ignored → no default title', !doc.body.textContent.includes('Recent High Severity Alerts'));
}

// ---- 6. 表示オプション ------------------------------------------------------
console.log('\n[6] display options');
{
    await setOptions({ maxRows: 0, title: 'セキュリティアラート' }, { fields: FIELDS, rows: ROWS });
    check('title shown when set', doc.body.textContent.includes('セキュリティアラート'));

    await setOptions({ maxRows: 0, title: '' });
    check('title hidden when empty', !doc.body.textContent.includes('セキュリティアラート'));

    await setOptions({ maxRows: 0, showSummary: false });
    check('summary hidden', !/critical\s*1/.test(doc.body.textContent), doc.body.textContent.slice(0, 160));

    await setOptions({ maxRows: 0, summaryLabelMode: 'raw', severityOrder: ['critical', 'high', 'medium|warning', 'low', 'info'] });
    check('summaryLabelMode=raw shows the data value "warning"', doc.body.textContent.includes('warning'), doc.body.textContent.slice(0, 200));

    await setOptions({ maxRows: 0, cellStyle: 'text' });
    check('cellStyle=text → no pill border-radius 999px', !severityHtml().includes('999px'), severityHtml().slice(0, 200));
    await setOptions({ maxRows: 0, cellStyle: 'bar' });
    // happy-dom は borderLeft ショートハンドを個別プロパティへ展開して直列化する
    check(
        'cellStyle=bar → left border',
        /border-left-width:\s*4px/.test(severityHtml()) && /border-left-style:\s*solid/.test(severityHtml()),
        severityHtml().slice(0, 300)
    );
    await setOptions({ maxRows: 0, cellStyle: 'pill' });
    check('cellStyle=pill → pill radius back', severityHtml().includes('999px'));

    await setOptions({ maxRows: 0, rowBar: false });
    const headers = [...doc.querySelectorAll('thead th')];
    check('rowBar=false → no extra bar column', headers.length === 4, `got ${headers.length}`);

    // アイコンモード
    await setOptions({ maxRows: 0, rowBar: true, topIcon: 'none' });
    check('topIcon=none → no svg icon in cells', doc.querySelectorAll('tbody svg').length === 0);
    await setOptions({ maxRows: 0, topIcon: 'highest' });
    check('topIcon=highest → icon present', doc.querySelectorAll('tbody svg').length > 0);
    // 最上位(critical)が居ないデータでは 'top' はアイコンを出さない
    await setOptions(
        { maxRows: 0, topIcon: 'top' },
        {
            fields: [{ name: 'severity' }, { name: 'event' }],
            rows: [['low', 'a'], ['info', 'b']],
        }
    );
    check('topIcon=top → no icon when stage 0 absent', doc.querySelectorAll('tbody svg').length === 0);
    await setOptions({ maxRows: 0, topIcon: 'highest' });
    check('topIcon=highest → icon on most severe present (low)', doc.querySelectorAll('tbody svg').length > 0);
}

// ---- 7. 深刻度フィールドの選択 ---------------------------------------------
console.log('\n[7] severity field selection');
{
    const data = {
        fields: [{ name: 'lvl' }, { name: 'sev2' }, { name: 'msg' }],
        rows: [
            ['x', 'critical', 'A'],
            ['y', 'low', 'B'],
        ],
    };
    // 既定の候補列名には lvl / sev2 のどちらも無い → 色が付かない
    await setOptions({ maxRows: 0 }, data);
    check('no candidate match → no severity coloring', !severityHtml().includes(C.critical), severityHtml().slice(0, 200));

    // 候補列名をオプションで足せば自動判定できる
    await setOptions({ maxRows: 0, severityFieldCandidates: ['sev2'] });
    check('custom candidate list detects sev2', severityHtml().includes(C.critical), severityHtml().slice(0, 200));

    // DOS 文字列での明示指定
    await setOptions({ maxRows: 0, severityField: "> primary | seriesByName('sev2')" });
    check('DOS columnSelector selects sev2', severityHtml().includes(C.critical));

    // 明示指定は候補リストより優先される
    await setOptions({
        maxRows: 0,
        severityField: "> primary | seriesByName('lvl')",
        severityFieldCandidates: ['sev2'],
    });
    check('explicit field wins over candidates', !severityHtml().includes(C.critical), severityHtml().slice(0, 200));
}

// ---- 8. テーマ切替 ----------------------------------------------------------
console.log('\n[8] theme switch to light');
{
    await setOptions({}, { fields: FIELDS, rows: ROWS });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(220);
    check('table still rendered after theme switch', !!doc.querySelector('table'));
}

// ---- 9. ガード（空・列形式・未知オプション） -------------------------------
console.log('\n[9] guards');
{
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(180);
    check('empty data → データなしメッセージ', doc.body.textContent.includes('データがありません'));

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

    // 空の深刻度値は並べ替え対象外で常に末尾
    await setOptions(
        { maxRows: 0, sortMode: 'asc' },
        {
            fields: [{ name: 'severity' }, { name: 'event' }],
            rows: [['', 'blank'], ['critical', 'c'], ['info', 'i']],
        }
    );
    check('blank severity always last (asc)', bodyRowTexts()[2].includes('blank'), bodyRowTexts().join(' // '));
    await setOptions({ maxRows: 0, sortMode: 'desc' });
    check('blank severity always last (desc)', bodyRowTexts()[2].includes('blank'), bodyRowTexts().join(' // '));

    // ホストが勝手に載せる未知キー・旧 debug オプションは無視される
    await setOptions(
        { maxRows: 0, debug: true, backgroundColor: 'transparent' },
        { fields: FIELDS, rows: ROWS }
    );
    check('no debug dump', !doc.body.textContent.includes('severityIndex'));
    check('no debug overlay <pre>', !doc.querySelector('pre'));
    check('table still renders with unknown options', !!doc.querySelector('table'));
}

// ---- 10. ドリルダウン（インタラクション） ----------------------------------
console.log('\n[10] drilldown / interactions');
{
    const clickCell = (rowIndex, colIndex) => {
        drilldown.fired.length = 0;
        const tr = doc.querySelectorAll('tbody tr')[rowIndex];
        const td = tr.querySelectorAll('td')[colIndex];
        td.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        return drilldown.fired;
    };

    await setOptions(
        { maxRows: 0, rowBar: false, sortMode: 'none' },
        { fields: FIELDS, rows: ROWS }
    );
    check('cells registered as drilldown nodes', drilldown.registrations.length > 0, `got ${drilldown.registrations.length}`);
    check(
        'action is cell.click',
        drilldown.registrations.every((r) => r.action === 'cell.click'),
        JSON.stringify([...new Set(drilldown.registrations.map((r) => r.action))])
    );
    // 1ノード1登録（解除手段が無いので二重登録は1クリック多重発火になる）
    const nodes = drilldown.registrations.map((r) => r.node);
    check('no node registered twice', new Set(nodes).size === nodes.length, `${nodes.length} 登録 / ${new Set(nodes).size} ノード`);

    // 先頭行（サーチ結果のまま = medium の行）の event 列をクリック
    const fired = clickCell(0, 2);
    check('click fires exactly once', fired.length === 1, `got ${fired.length}`);
    const p = fired[0] ? fired[0].payload : {};
    check('payload has row.<field>.value for every field', ['_time_str', 'severity', 'event', 'host'].every((f) => `row.${f}.value` in p), JSON.stringify(Object.keys(p)));
    check('row tokens are from the clicked row', p['row.severity.value'] === 'medium' && p['row.host.value'] === 'host-22', JSON.stringify(p));
    check('name is the clicked column', p.name === 'event', String(p.name));
    check('value is the clicked cell', p.value === 'Policy violation', String(p.value));

    // 別の行・別の列を押したら、その行・その列の値が飛ぶ
    // （payloadCallback を使い回して行を固定すると、ここで1行目の値が返ってしまう）
    const fired2 = clickCell(2, 1);
    const p2 = fired2[0] ? fired2[0].payload : {};
    check('another row sends its own values', p2['row.host.value'] === 'host-03' && p2.value === 'low', JSON.stringify(p2));
    check('name follows the clicked column', p2.name === 'severity', String(p2.name));

    // 並べ替えても「表示されている行」の値が飛ぶ（位置固定になっていないこと）
    await setOptions({ maxRows: 0, rowBar: false, sortMode: 'desc' });
    const fired3 = clickCell(0, 1);
    const p3 = fired3[0] ? fired3[0].payload : {};
    check('after re-sort the top row sends critical', p3.value === 'critical' && p3['row.host.value'] === 'host-01', JSON.stringify(p3));

    // 再レンダリングを何度か挟んでも二重登録・多重発火しない
    await setOptions({ maxRows: 0, rowBar: false, sortMode: 'desc', zebra: false });
    await setOptions({ maxRows: 0, rowBar: false, sortMode: 'desc', zebra: true });
    const fired4 = clickCell(0, 1);
    check('still fires exactly once after re-renders', fired4.length === 1, `got ${fired4.length}`);

    // 行頭カラーバーのセルも押せる（name/value は深刻度列）
    await setOptions({ maxRows: 0, rowBar: true, sortMode: 'desc' });
    const fired5 = clickCell(0, 0);
    const p5 = fired5[0] ? fired5[0].payload : {};
    check('row bar cell is clickable', fired5.length === 1, `got ${fired5.length}`);
    check('row bar sends the severity column', p5.name === 'severity' && p5.value === 'critical', JSON.stringify(p5));

    // OFF にしたら発火しない
    await setOptions({ maxRows: 0, rowBar: false, sortMode: 'desc', enableDrilldown: false });
    const fired6 = clickCell(0, 1);
    check('enableDrilldown=false → no fire', fired6.length === 0, `got ${fired6.length}`);
    const style = doc.querySelector('tbody td').getAttribute('style') || '';
    check('enableDrilldown=false → no pointer cursor', !/cursor:\s*pointer/.test(style), style.slice(0, 120));

    // 戻したらまた発火する
    await setOptions({ maxRows: 0, rowBar: false, sortMode: 'desc', enableDrilldown: true });
    const fired7 = clickCell(0, 1);
    check('enableDrilldown=true → fires again', fired7.length === 1, `got ${fired7.length}`);
    check('pointer cursor on cells', /cursor:\s*pointer/.test(doc.querySelector('tbody td').getAttribute('style') || ''));

    // triggerDrilldown は使わない（実機で効かないことが分かっている）
    check('triggerDrilldown is never called', drilldown.triggered.length === 0, `got ${drilldown.triggered.length}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
