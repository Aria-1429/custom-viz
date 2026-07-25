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
// 深刻度の色が出る領域だけの HTML（= テーブル本体）。
// タイトル行のアクセントバーはテーマ由来の固定色(#ff5c3d)で深刻度とは無関係なので、
// 「固定パレットが残っていないこと」の検査からは除外する。
const severityHtml = () => {
    const tbody = doc.querySelector('tbody');
    return (tbody ? tbody.innerHTML : '').toLowerCase();
};
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

// ---- 4. 標準5レベルの文字列データが既定バンド色で描画される ----------------
// 既定バンド(低→高): info #4fa8f0 / low #4dcf6e / medium #f2c14b / high #ffab2e / critical #ff5c3d
// 文字列パスは「出現した深刻度をランク順に並べ、バンド色を高い順に割り当てる」。
// ROWS には critical/high/medium(warning含む)/low/info の 5 種が出るので、
// 割り当ては 5:5 でそのまま重大→#ff5c3d … 情報→#4fa8f0 になる。
console.log('\n[4] standard 5-level string data uses default band colors');
{
    state.options = { maxRows: 0 };
    fire('options', { options: state.options });
    await sleep(200);
    const html = doc.body.innerHTML.toLowerCase();
    check('critical → #ff5c3d', html.includes('#ff5c3d'), 'missing');
    check('high → #ffab2e', html.includes('#ffab2e'), 'missing');
    check('medium → #f2c14b', html.includes('#f2c14b'), 'missing');
    check('low → #4dcf6e', html.includes('#4dcf6e'), 'missing');
    check('info → #4fa8f0', html.includes('#4fa8f0'), 'missing');
    check('summary shows Japanese labels', doc.body.textContent.includes('重大') && doc.body.textContent.includes('情報'));
}

// ---- 4b. 文字列パスの色も severityBands が支配する ---------------------------
console.log('\n[4b] string severity colors are driven by severityBands');
{
    state.options = {
        maxRows: 0,
        severityBands: [
            { from: 0, to: 1, value: '#0000aa' },
            { from: 1, to: 2, value: '#00aa00' },
            { from: 2, to: 3, value: '#aa0000' },
        ],
    };
    fire('options', { options: state.options });
    await sleep(220);
    const html = doc.body.innerHTML.toLowerCase();
    check('custom band color #aa0000 used for most severe', html.includes('#aa0000'), 'missing #aa0000');
    check('custom band color #0000aa used for least severe', html.includes('#0000aa'), 'missing #0000aa');
    check('old fixed default #ff5c3d no longer in table', !severityHtml().includes('#ff5c3d'), 'fixed 5-color palette leaked');
}

// ---- 4c. ★カスタム/未知の深刻度文字列(P1/P2/P3)が動く ---------------------
// これが今回の柔軟性修正の核心。5 レベルに一致しない任意の文字列でも
// 異なる色が付き、クラッシュせず、サマリに生の値がそのまま出る。
console.log('\n[4c] custom/unknown severity strings (P1/P2/P3)');
{
    state.data = {
        fields: [{ name: 'severity' }, { name: 'event' }],
        rows: [
            ['P2', 'Disk pressure'],
            ['P1', 'Cluster down'],
            ['P3', 'Cert expiring'],
            ['P1', 'Second outage'],
        ],
    };
    state.options = { maxRows: 0 };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(240);
    check('no error boundary for unknown severities', !doc.body.textContent.includes('Visualization error'));
    const rows = bodyRowTexts();
    check('4 rows rendered for P1/P2/P3 data', rows.length === 4, `got ${rows.length}`);
    // サマリには生の値がそのまま出る(日本語ラベルに化けない)
    const text = doc.body.textContent;
    check('summary shows raw P1', text.includes('P1'), text.slice(0, 200));
    check('summary shows raw P2', text.includes('P2'));
    check('summary shows raw P3', text.includes('P3'));
    // 3 種の深刻度に 3 つの異なる色が付く
    const html = doc.body.innerHTML.toLowerCase();
    const bandColors = ['#4fa8f0', '#4dcf6e', '#f2c14b', '#ffab2e', '#ff5c3d'];
    const used = bandColors.filter((c) => html.includes(c));
    check('at least 3 distinct band colors used for P1/P2/P3', used.length >= 3, `used=${JSON.stringify(used)}`);
    // 最重大(P1)には既定バンドの最上位色が当たる
    check('P1 gets the top band color #ff5c3d', html.includes('#ff5c3d'), 'top color missing');
}

// ---- 4d. 非ASCII のカスタム深刻度(緊急/注意)でも動く -----------------------
console.log('\n[4d] non-ASCII custom severities (緊急/注意)');
{
    state.data = {
        fields: [{ name: 'level' }, { name: 'event' }],
        rows: [
            ['注意', '軽微な逸脱'],
            ['緊急', '侵害の可能性'],
        ],
    };
    state.options = { maxRows: 0 };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(240);
    check('no error boundary', !doc.body.textContent.includes('Visualization error'));
    check('2 rows rendered', bodyRowTexts().length === 2, `got ${bodyRowTexts().length}`);
    check('summary shows 緊急 as-is', doc.body.textContent.includes('緊急'));
    check('summary shows 注意 as-is', doc.body.textContent.includes('注意'));
}

// ---- 4e. 旧 criticalColor 等の固定色キーは完全に無視される -----------------
console.log('\n[4e] legacy fixed color keys are ignored');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {
        maxRows: 0,
        criticalColor: '#123abc',
        highColor: '#456def',
        mediumColor: '#789012',
        lowColor: '#345678',
        infoColor: '#9abcde',
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(240);
    const html = doc.body.innerHTML.toLowerCase();
    check('legacy criticalColor not used', !html.includes('#123abc'), 'legacy color leaked');
    check('legacy highColor not used', !html.includes('#456def'), 'legacy color leaked');
    check('legacy infoColor not used', !html.includes('#9abcde'), 'legacy color leaked');
    check('default band colors used instead', html.includes('#ff5c3d'), 'default band color missing');
}

// ---- 4f. エイリアス吸収がソートに効き続ける --------------------------------
console.log('\n[4f] alias absorption still drives sorting');
{
    state.data = {
        fields: [{ name: 'severity' }, { name: 'event' }],
        rows: [
            ['info', 'Z last'],
            ['crit', 'A should be first'], // crit → critical
            ['warn', 'M middle'], // warn → medium
        ],
    };
    state.options = { maxRows: 0, sortBySeverity: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(240);
    const rows = bodyRowTexts();
    check('crit sorts first (alias → critical rank)', rows[0].includes('crit'), rows.join(' // '));
    check('warn sorts before info (alias → medium rank)', rows[1].includes('warn'), rows.join(' // '));
    check('info sorts last', rows[2].includes('info'), rows.join(' // '));
    // crit と critical が同じ正規キーに畳まれることを確認(サマリは 1 チップにまとまる)
    check('crit labelled 重大 in summary (canonicalized)', doc.body.textContent.includes('重大'));
}

// ---- 4g. 未知の深刻度は既知より後ろ・初出順で安定する ----------------------
console.log('\n[4g] unknown severities rank after known ones, stable by first-seen');
{
    state.data = {
        fields: [{ name: 'severity' }, { name: 'event' }],
        rows: [
            ['zeta-unknown', 'U1'],
            ['low', 'K-low'],
            ['critical', 'K-crit'],
            ['alpha-unknown', 'U2'],
        ],
    };
    state.options = { maxRows: 0, sortBySeverity: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(240);
    const rows = bodyRowTexts();
    check('known critical first', rows[0].includes('critical'), rows.join(' // '));
    check('known low second', rows[1].includes('low') && !rows[1].includes('unknown'), rows.join(' // '));
    check('unknowns after knowns, first-seen order', rows[2].includes('zeta-unknown') && rows[3].includes('alpha-unknown'), rows.join(' // '));
}

// ---- 5. 数値 severity + バンド(editor.threshold) ---------------------------
// 既定バンド: [0,1)=info #4fa8f0 / [1,2)=low #4dcf6e / [2,3)=medium #f2c14b /
//             [3,4)=high #ffab2e / [4,5]=critical #ff5c3d
const NUMERIC_DATA = {
    fields: [{ name: 'urgency' }, { name: 'event' }],
    rows: [
        ['5', 'Data exfiltration'],
        ['3', 'Repeated failures'],
        ['1', 'Info log'],
    ],
};

console.log('\n[5] numeric severity via default severityBands');
{
    state.data = NUMERIC_DATA;
    state.options = { numericSeverity: true };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(220);
    const rows = bodyRowTexts();
    check('3 rows for numeric data', rows.length === 3, `got ${rows.length}`);
    // 数値パスはバンドの色を「そのまま」使う(固定レベル名を経由しない)
    const html = doc.body.innerHTML.toLowerCase();
    check('band color #ff5c3d used for 5 (top band)', html.includes('#ff5c3d'));
    check('band color #ffab2e used for 3', html.includes('#ffab2e'));
    check('band color #4dcf6e used for 1', html.includes('#4dcf6e'));
    // サマリは範囲ラベルで出る(5 レベル固定名ではない)
    check('summary shows numeric range labels', /\d+–\d+/.test(doc.body.textContent), doc.body.textContent.slice(0, 200));
}

// ---- 5b. カスタムバンドの色が数値へ直接適用される --------------------------
console.log('\n[5b] custom severityBands colors applied directly to numeric values');
{
    state.options = {
        numericSeverity: true,
        severityBands: [
            { from: 0, to: 2, value: '#111aaa' },
            { from: 2, to: 4, value: '#222bbb' },
            { from: 4, to: 9, value: '#333ccc' },
        ],
    };
    fire('options', { options: state.options });
    await sleep(220);
    const html = doc.body.innerHTML.toLowerCase();
    check('custom band color for 5 present', html.includes('#333ccc'), 'missing #333ccc');
    check('custom band color for 3 present', html.includes('#222bbb'), 'missing #222bbb');
    check('custom band color for 1 present', html.includes('#111aaa'), 'missing #111aaa');
    // 固定 5 色は撤廃済み。テーブル本体に既定色が残っていてはいけない。
    const rowHtml = severityHtml();
    check('no fixed default palette in table', !rowHtml.includes('#ff5c3d') && !rowHtml.includes('#4fa8f0'), rowHtml.slice(0, 200));
    check('rows use band colors', rowHtml.includes('#333ccc'), rowHtml.slice(0, 200));
}

// ---- 5c. 未ソート / 重なり / 空 / 不正なバンドでも壊れない -----------------
console.log('\n[5c] malformed severityBands fall back sanely');
{
    const malformed = [
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
    for (const [name, bands] of malformed) {
        state.options = { numericSeverity: true, severityBands: bands };
        fire('options', { options: state.options });
        await sleep(160);
        const rows = bodyRowTexts();
        check(`${name}: still renders 3 rows`, rows.length === 3, `got ${rows.length}`);
        check(`${name}: no error boundary`, !doc.body.textContent.includes('Visualization error'));
    }

    // 文字列パスでも同じ壊れたバンドで落ちないこと(色マップの生成経路を通す)
    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    for (const [name, bands] of malformed) {
        state.options = { numericSeverity: false, severityBands: bands };
        fire('options', { options: state.options });
        await sleep(140);
        check(`${name} (string path): renders 7 rows`, bodyRowTexts().length === 7, `got ${bodyRowTexts().length}`);
        check(`${name} (string path): no error boundary`, !doc.body.textContent.includes('Visualization error'));
    }
    // 復帰
    state.data = NUMERIC_DATA;
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(140);
}

// ---- 5d. 旧 criticalThreshold 系キーは無視される ---------------------------
console.log('\n[5d] legacy threshold keys are ignored');
{
    // 旧キーだけを与える。読み替えを実装していないので既定バンドで判定されるはず。
    // 旧キーが効いてしまうと 3 が「重大」になる（criticalThreshold:3）。
    state.options = {
        numericSeverity: true,
        criticalThreshold: 3,
        highThreshold: 2,
        mediumThreshold: 1,
        lowThreshold: 0,
    };
    fire('options', { options: state.options });
    await sleep(220);
    const html = doc.body.innerHTML.toLowerCase();
    // 既定バンドなら 3 は high(#ffab2e)、1 は low(#4dcf6e)。
    check('legacy keys ignored → 3 stays high (#ffab2e)', html.includes('#ffab2e'));
    check('legacy keys ignored → 1 stays low (#4dcf6e)', html.includes('#4dcf6e'));
    // 旧キーが効いていれば 1 が medium(#f2c14b) になる。そうなっていないこと。
    check('legacy keys ignored → no medium color leaked', !html.includes('#f2c14b'), 'legacy threshold leaked');
}

// ---- 5e. 文字列 severity もバンド色に従う（単一の色設定） ------------------
console.log('\n[5e] string severity path is governed by the same bands');
{
    state.data = { fields: FIELDS, rows: ROWS };
    // バンドが 1 本しかない場合、すべての深刻度がその色になる(破綻しない)
    state.options = {
        numericSeverity: false,
        severityBands: [{ from: 0, to: 100, value: '#000fff' }],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(220);
    const html = doc.body.innerHTML.toLowerCase();
    check('band color applied to string path', html.includes('#000fff'), 'band color not used for strings');
    check('removed fixed palette absent from table', !severityHtml().includes('#ff5c3d'), 'fixed palette leaked');
    check('summary still shows 重大', doc.body.textContent.includes('重大'));
    check('no error boundary with single band', !doc.body.textContent.includes('Visualization error'));
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
}

// ---- 9. debug オーバーレイは削除済み ---------------------------------------
console.log('\n[9] debug overlay removed');
{
    state.data = { fields: FIELDS, rows: ROWS };
    // 旧 debug オプションを渡しても何も出ない（オプションごと削除済み）
    state.options = { debug: true };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(220);
    check('no debug dump (severityIndex absent)', !doc.body.textContent.includes('severityIndex'), doc.body.textContent.slice(-200));
    check('no debug overlay <pre> element', !doc.querySelector('pre'));
    check('table still renders with unknown debug option', !!doc.querySelector('table'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
