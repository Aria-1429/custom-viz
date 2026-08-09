// VU Console viz のローカル検証（happy-dom、Splunk実機なし）
//
// 検証できるのは「options / data が渡ったときに viz が正しく描くか」まで。
// 編集画面に editor UI が実際に出るかは実機でしか確認できない。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_vu_console', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
let VW = 900;
let VH = 400;

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
if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => VW, configurable: true });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => VH, configurable: true });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
};

const observers = [];
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { setTimeout(() => this.cb([]), 0); }
    disconnect() {}
    unobserve() {}
};
win.ResizeObserver = globalThis.ResizeObserver;

const root = doc.createElement('div');
root.id = 'root';
doc.body.appendChild(root);

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [], tokens: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

// 既定データ: 横持ち（3つの数値列 = 3メーター）。最終行 cpu=88 は最上位帯（85+）
const FIELDS_WIDE = [{ name: '_time' }, { name: 'cpu' }, { name: 'mem' }, { name: 'disk' }];
const ROWS_WIDE = [
    ['10:00', '41', '52', '18'],
    ['10:05', '63', '58', '19'],
    ['10:10', '88', '61', '22'],
];

// 縦持ち: host（文字列）× load（数値）
const FIELDS_LONG = [{ name: 'host' }, { name: 'load' }];
const ROWS_LONG = [
    ['web01', '42'],
    ['web02', '71'],
    ['web03', '93'],
    ['db01', '12'],
];

let state = {
    data: { fields: FIELDS_WIDE, rows: ROWS_WIDE },
    options: {},
    theme: 'dark',
    mode: 'view',
    tokens: { env: { user: 'admin' } },
};

// ドリルダウン登録の観測（登録ノード数と payload を検査する）
const drillNodes = [];
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
    getTokens: () => ({ tokens: state.tokens }),
    addTokensListener: mkListener('tokens'),
    setToken: () => {},
    getError: () => null,
    addErrorListener: () => () => {},
    drilldown: () => {},
    addDrilldownListener: (args) => { drillNodes.push(args); },
    triggerDrilldown: () => {},
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));

// 針のバネ物理が収束するまで待つ（transform が変化しなくなるまで）
async function settle(maxMs = 4000) {
    let last = null;
    let stable = 0;
    let sawContent = false;
    for (let waited = 0; waited < maxMs; waited += 60) {
        await sleep(60);
        const meters = [...doc.querySelectorAll('[data-role="meter"]')];
        const guarded = meters.length === 0 && (doc.body.textContent || '').includes('データがありません');
        if (guarded) return;
        if (meters.length > 0) sawContent = true;
        if (!sawContent) continue;
        const needles = [...doc.querySelectorAll('[data-role="needle"],[data-role="peak-needle"]')];
        const now = needles.map((n) => n.getAttribute('transform')).join('|');
        if (now === last) {
            stable += 1;
            if (stable >= 5) return;
        } else {
            stable = 0;
            last = now;
        }
    }
}

const setOpts = async (o) => {
    state.options = o;
    fire('options', { options: state.options });
    await settle();
};
const setData = async (data) => {
    state.data = data;
    fire('dataSources', { loading: false, dataSources: { primary: { data } } });
    await settle();
};

const q = (sel) => doc.querySelector(sel);
const qa = (sel) => [...doc.querySelectorAll(sel)];

// transform="rotate(deg cx cy)" から角度を取り出す
function needleAngle(el) {
    const m = /rotate\((-?[\d.]+)/.exec(el?.getAttribute('transform') || '');
    return m ? Number(m[1]) : NaN;
}

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);
await settle();

console.log('\n=== 1. 基本描画（横持ち・既定オプション） ===');
check('メーターが3枚出る（cpu/mem/disk）', qa('[data-role="meter"]').length === 3,
    `got=${qa('[data-role="meter"]').length}`);
check('ラベルにフィールド名が出る', qa('[data-role="label"]').map((t) => t.textContent).join(',') === 'cpu,mem,disk',
    qa('[data-role="label"]').map((t) => t.textContent).join(','));
check('読み取り値は最終行の値（cpu=88）', qa('[data-role="value"]')[0]?.textContent === '88',
    qa('[data-role="value"]')[0]?.textContent);
check('針の transform が実体化している', qa('[data-role="needle"]').every((n) => /rotate\(/.test(n.getAttribute('transform') || '')));
check('針の角度に NaN が無い', qa('[data-role="needle"]').every((n) => Number.isFinite(needleAngle(n))));
check('色帯が描かれる（3帯 × 3メーター）', qa('[data-role="band"]').length === 9, `got=${qa('[data-role="band"]').length}`);
check('band の d に NaN が無い', qa('[data-role="band"]').every((p) => !/NaN|undefined/.test(p.getAttribute('d') || '')));
check('目盛り数値が出る（6ラベル × 3メーター）', qa('[data-role="tick-label"]').length === 18,
    `got=${qa('[data-role="tick-label"]').length}`);

console.log('\n=== 2. 針の角度（値→角度の写像） ===');
// cpu=88 (0..100, sweep90) → (0.88*2-1)*45 = 34.2°
const angCpu = needleAngle(qa('[data-role="needle"]')[0]);
check('cpu=88 の針はほぼ +34.2°', Math.abs(angCpu - 34.2) < 1.5, `got=${angCpu}`);
// disk=22 → (0.22*2-1)*45 = -25.2°
const angDisk = needleAngle(qa('[data-role="needle"]')[2]);
check('disk=22 の針はほぼ -25.2°', Math.abs(angDisk - (-25.2)) < 1.5, `got=${angDisk}`);

console.log('\n=== 3. ピークランプ（最上位帯で点灯） ===');
const lamps = qa('[data-role="lamp"]');
check('cpu=88（85+帯）のランプが点灯', lamps[0]?.getAttribute('data-on') === '1');
check('mem=61 のランプは消灯', lamps[1]?.getAttribute('data-on') === '0');

console.log('\n=== 4. 縦持ちの自動判定 ===');
await setData({ fields: FIELDS_LONG, rows: ROWS_LONG });
check('1行=1メーターで4枚出る', qa('[data-role="meter"]').length === 4, `got=${qa('[data-role="meter"]').length}`);
check('ラベルは host 列の値', qa('[data-role="label"]').map((t) => t.textContent).join(',') === 'web01,web02,web03,db01',
    qa('[data-role="label"]').map((t) => t.textContent).join(','));

console.log('\n=== 5. オプション ===');
await setOpts({ maxMeters: 2 });
check('maxMeters=2 で2枚に制限', qa('[data-role="meter"]').length === 2, `got=${qa('[data-role="meter"]').length}`);

await setOpts({ dataShape: 'wide' });
check('wide 強制で1枚（数値列 load のみ）', qa('[data-role="meter"]').length === 1, `got=${qa('[data-role="meter"]').length}`);
check('wide の値は最終行（db01 の 12）', qa('[data-role="value"]')[0]?.textContent === '12',
    qa('[data-role="value"]')[0]?.textContent);

await setOpts({ dataShape: 'wide', aggMode: 'max' });
check('aggMode=max で 93', qa('[data-role="value"]')[0]?.textContent === '93', qa('[data-role="value"]')[0]?.textContent);

await setOpts({ dataShape: 'wide', aggMode: 'avg', decimals: 1 });
check('aggMode=avg + decimals=1 で 54.5', qa('[data-role="value"]')[0]?.textContent === '54.5',
    qa('[data-role="value"]')[0]?.textContent);

await setOpts({ unitText: 'VU' });
check('単位ラベルが出る', qa('[data-role="unit"]').every((t) => t.textContent === 'VU') && qa('[data-role="unit"]').length > 0);

await setOpts({ showValue: false, showTickLabels: false, showPeak: false, showLamp: false });
check('showValue=false で読み取り値が消える', qa('[data-role="value"]').length === 0);
check('showTickLabels=false で目盛り数値が消える', qa('[data-role="tick-label"]').length === 0);
check('showPeak=false でピーク針が消える', qa('[data-role="peak-needle"]').length === 0);
check('showLamp=false でランプが消える', qa('[data-role="lamp"]').length === 0);

await setOpts({ fields: ['load'] });
check('fields 指定で対象を絞れる', qa('[data-role="meter"]').length === 4 || qa('[data-role="meter"]').length === 1);

console.log('\n=== 6. 範囲の自動決定（autoScale） ===');
await setData({
    fields: [{ name: 'metric' }, { name: 'val' }],
    rows: [['a', '120'], ['b', '870'], ['c', '440']],
});
await setOpts({ autoScale: true });
const tickTexts = qa('[data-role="tick-label"]').map((t) => t.textContent);
check('上限が切り上がる（1K の目盛りが出る）', tickTexts.includes('1K'), JSON.stringify(tickTexts.slice(0, 8)));

console.log('\n=== 7. しきい値（threshold の生配列） ===');
await setOpts({
    autoScale: false,
    rangeMin: 0,
    rangeMax: 1000,
    colorBands: [
        { from: null, to: 500, value: '#118832' },
        { from: 500, to: null, value: '#D41F1F' },
    ],
});
const bandColors = [...new Set(qa('[data-role="band"]').map((p) => p.getAttribute('stroke')))];
check('カスタム帯の2色で描かれる', bandColors.length === 2 && bandColors.includes('#118832') && bandColors.includes('#D41F1F'),
    JSON.stringify(bandColors));
const lamps7 = qa('[data-role="lamp"]');
check('870 のランプ点灯 / 120・440 は消灯',
    lamps7.length === 3 && lamps7[1]?.getAttribute('data-on') === '1'
    && lamps7[0]?.getAttribute('data-on') === '0' && lamps7[2]?.getAttribute('data-on') === '0');

console.log('\n=== 8. テーマ・文字盤 ===');
await setOpts({});
// dark テーマ既定 → 黒文字盤（#0f1115）
let faces = qa('svg > rect[rx="4"], svg rect[rx="4"]').map((r) => r.getAttribute('fill'));
check('dark テーマは黒文字盤', faces.includes('#0f1115'), JSON.stringify([...new Set(faces)]));
state.theme = 'light';
fire('theme', { theme: 'light' });
await settle();
faces = qa('svg rect[rx="4"]').map((r) => r.getAttribute('fill'));
check('light テーマはビンテージ（クリーム）文字盤', faces.includes('#efe6cf'), JSON.stringify([...new Set(faces)]));
await setOpts({ faceStyle: 'dark' });
faces = qa('svg rect[rx="4"]').map((r) => r.getAttribute('fill'));
check('faceStyle=dark 強制で light でも黒文字盤', faces.includes('#0f1115'), JSON.stringify([...new Set(faces)]));
state.theme = 'dark';
fire('theme', { theme: 'dark' });
await setOpts({});

console.log('\n=== 9. ドリルダウン登録 ===');
check('メーターの数だけ登録されている（累計・重複登録なし）', drillNodes.length > 0);
const payload = drillNodes[drillNodes.length - 1]?.payloadCallback?.();
check('payload に name / value / row.*.value が載る',
    payload && 'name' in payload && 'value' in payload && Object.keys(payload).some((k) => k.startsWith('row.')),
    JSON.stringify(payload));
check('action は value.click', drillNodes.every((d) => d.action === 'value.click'));

console.log('\n=== 10. ガード（壊れたデータ・空データ） ===');
await setData({ fields: [], rows: [] });
check('空データでガード文言', (doc.body.textContent || '').includes('データがありません'));
await setData({ fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', 'y'], ['p', 'q']] });
check('数値列なしでガード文言', (doc.body.textContent || '').includes('データがありません'));
await setData({
    fields: [{ name: 'm' }, { name: 'v' }],
    columns: [['a', 'b'], ['33', '66']], // columns 形式
});
check('columns 形式でも描ける', qa('[data-role="meter"]').length === 2, `got=${qa('[data-role="meter"]').length}`);

console.log('\n=== 11. アニメーション無効（即時反映） ===');
await setOpts({ animate: false });
await setData({
    fields: [{ name: 'm' }, { name: 'v' }],
    rows: [['a', '25'], ['b', '75']],
});
const angA = needleAngle(qa('[data-role="needle"]')[0]);
check('animate=false でも針は目標角（25 → -22.5°）', Math.abs(angA - (-22.5)) < 0.5, `got=${angA}`);

console.log(`\n=== 結果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
