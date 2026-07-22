// Link Line viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_link_line', 'visualization.js'
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

const FIELDS = [{ name: '_time' }, { name: 'latency_ms' }];
const ROWS = [['t1', '40'], ['t2', '95']]; // シングルバリュー = 最終行の 95

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
    theme: 'dark',
    mode: 'view',
};

let dropViewSetOptions = false; // true = 表示モード中の setOptions を定義に取り込まないホストを再現
const setOptionsLog = [];

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => {
        setOptionsLog.push({ mode: state.mode, o });
        if (dropViewSetOptions && state.mode === 'view') return;
        state.options = { ...o };
    },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: 900, height: 560 }),
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
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
};
const ev = (type, init = {}) => new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
const mainLine = () => doc.querySelector('path[data-role="main-line"]');
// 線の「色」を返す。lineGradient オン時は stroke が url(#llGrad) になるため、
// グラデーション中央ストップ（= ベース色そのもの）を読む
const lineColor = () => {
    const s = mainLine() && mainLine().getAttribute('stroke');
    if (s && s.startsWith('url(')) {
        const stops = [...doc.querySelectorAll('#llGrad stop')];
        return stops[1] ? stops[1].getAttribute('stop-color') : s;
    }
    return s;
};

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 基本描画（dark / view / フラット既定） --------------------------------
console.log('\n[1] basic render');
{
    const p = mainLine();
    check('main line rendered', !!p);
    check('default horizontal path (M 63 280 L 837 280)', p && p.getAttribute('d') === 'M 63 280 L 837 280',
        p && p.getAttribute('d'));
    check('value 95 >= threshold3(90) → red #dc4e41', p && lineColor() === '#dc4e41', p && lineColor());
    check('gradient stroke by default (url(#llGrad))', p && p.getAttribute('stroke') === 'url(#llGrad)',
        p && p.getAttribute('stroke'));
    check('flat mode → no halo layers', !doc.querySelector('path[data-role="line-halo1"]'));
    check('no shadow filter in flat mode', p && !p.getAttribute('filter'));
    const caps = [...doc.querySelectorAll('[data-role="endcap"]')];
    check('2 endcaps', caps.length === 2, `got ${caps.length}`);
    check('no arrow by default', !doc.querySelector('[data-role="arrow"]'));
    const label = doc.querySelector('[data-role="value-label"] text');
    check('value label shows 95', label && label.textContent === '95', label && label.textContent);
    check('no flow overlay by default', !doc.querySelector('[data-role="flow"]'));
    check('edit toggle (✎) shown in view mode', !!doc.querySelector('[data-role="edit-toggle"]'));
    check('color toggle (🎨) shown in view mode', !!doc.querySelector('[data-role="color-toggle"]'));
    check('no edit layer until unlocked', !doc.querySelector('[data-role="edit-layer"]'));
    check('no reset button until unlocked', !doc.querySelector('[data-role="reset-line"]'));
}

// ---- 2. しきい値の色分け -------------------------------------------------------
console.log('\n[2] threshold colors');
{
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '10']] });
    check('value 10 < t1(40) → base green', lineColor() === '#53a051',
        lineColor());

    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '50']] });
    check('value 50 in [40,70) → color1 yellow', lineColor() === '#f8be34',
        lineColor());

    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '75']] });
    check('value 75 in [70,90) → color2 orange', lineColor() === '#f1813f',
        lineColor());

    // しきい値カスタム（順不同でもソートされる）
    await setOpts({ threshold1: 100, color1: '#0000ff', threshold2: 60, color2: '#00ff00', threshold3: 200 });
    check('custom unsorted thresholds → 75 ≥ 60 → #00ff00', lineColor() === '#00ff00',
        lineColor());

    // しきい値オフ → 常に基本色
    await setOpts({ useThresholds: false, baseColor: '#22d3ee' });
    check('thresholds off → fixed baseColor', lineColor() === '#22d3ee',
        lineColor());

    await setOpts({});
    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 3. フィールド選択（columnSelector DOS 文字列） ---------------------------
console.log('\n[3] field selection');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'errors' }, { name: 'users' }],
        rows: [['t1', '5', '1000'], ['t2', '88', '2000']],
    });
    let label = doc.querySelector('[data-role="value-label"] text');
    check('fallback = last numeric column (users → 2,000)', label && label.textContent === '2,000',
        label && label.textContent);

    await setOpts({ valueField: "> primary | seriesByName('errors')" });
    label = doc.querySelector('[data-role="value-label"] text');
    check('DOS-selected errors → 88', label && label.textContent === '88', label && label.textContent);
    check('88 ≥ t2(70) → orange', lineColor() === '#f1813f', lineColor());

    await setOpts({});
    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 4. 線の点列オプション -----------------------------------------------------
console.log('\n[4] linePoints option');
{
    await setOpts({ linePoints: '[[0.1,0.2],[0.5,0.8],[0.9,0.2]]', cornerRadius: 0 });
    const p = mainLine();
    check('3-point polyline path', p.getAttribute('d') === 'M 90 112 L 450 448 L 810 112', p.getAttribute('d'));

    await setOpts({ linePoints: '[[0.1,0.2],[0.5,0.8],[0.9,0.2]]', cornerRadius: 20 });
    check('cornerRadius > 0 → quadratic corner (Q)', mainLine().getAttribute('d').includes('Q'),
        mainLine().getAttribute('d'));

    await setOpts({ linePoints: '{bad json' });
    check('invalid JSON → default line, no crash', mainLine().getAttribute('d') === 'M 63 280 L 837 280',
        mainLine().getAttribute('d'));

    await setOpts({ linePoints: '[[0.5,0.5]]' });
    check('single point → default line', mainLine().getAttribute('d') === 'M 63 280 L 837 280');

    await setOpts({});
}

// ---- 5. 質感（styleMode / 破線 / 流れ / 不透明度 / 端点・矢印・ラベル） --------
console.log('\n[5] texture & decorations');
{
    await setOpts({ styleMode: 3 });
    check('neon → halo layers', !!doc.querySelector('path[data-role="line-halo1"]')
        && !!doc.querySelector('path[data-role="line-halo2"]'));
    check('neon → bright core layer', !!doc.querySelector('path[data-role="line-core"]'));

    await setOpts({ styleMode: 4 });
    check('pipe → dark edge layer', !!doc.querySelector('path[data-role="line-edge"]'));
    check('pipe → highlight core layer', !!doc.querySelector('path[data-role="line-core"]'));

    await setOpts({ styleMode: 2 });
    check('soft shadow → filter on main line', mainLine().getAttribute('filter') === 'url(#llShadow)',
        mainLine().getAttribute('filter'));

    await setOpts({ dashLength: 12 });
    check('dashLength 12 → stroke-dasharray "12 9"', mainLine().getAttribute('stroke-dasharray') === '12 9',
        mainLine().getAttribute('stroke-dasharray'));

    await setOpts({ dashLength: 12, flowSpeed: 2 });
    await sleep(350);
    check('dashed + flow → main line animated (dashoffset set)',
        mainLine().getAttribute('data-anim') === 'dash' && !!mainLine().getAttribute('stroke-dashoffset'),
        String(mainLine().getAttribute('stroke-dashoffset')));

    await setOpts({ flowSpeed: 2 });
    await sleep(350);
    const flow = doc.querySelector('[data-role="flow"]');
    check('solid + flow → overlay dots exist', !!flow);
    check('flow overlay animated (negative dashoffset)', flow && parseFloat(flow.getAttribute('stroke-dashoffset')) < 0,
        flow && String(flow.getAttribute('stroke-dashoffset')));

    await setOpts({ lineOpacity: 50 });
    const g = mainLine().parentElement;
    check('lineOpacity 50 → group opacity 0.5', g && g.getAttribute('opacity') === '0.5',
        g && g.getAttribute('opacity'));

    await setOpts({ lineGradient: false });
    check('lineGradient off → solid hex stroke', mainLine().getAttribute('stroke') === '#dc4e41',
        mainLine().getAttribute('stroke'));

    await setOpts({ pulseCaps: true });
    await sleep(400);
    const pulse = doc.querySelector('[data-anim="pulse"]');
    check('pulseCaps → pulse rings exist', !!pulse);
    check('pulse animated by rAF (opacity updated)', pulse && pulse.getAttribute('opacity') !== '0',
        pulse && String(pulse.getAttribute('opacity')));

    await setOpts({ arrowHead: true });
    check('arrow head rendered', !!doc.querySelector('[data-role="arrow"]'));
    check('arrow replaces end cap (1 endcap left)',
        [...doc.querySelectorAll('[data-role="endcap"]')].length === 1);

    await setOpts({ showEndCaps: false, arrowHead: false });
    check('endcaps hidden', !doc.querySelector('[data-role="endcap"]'));

    await setOpts({ showValue: false });
    check('value label hidden', !doc.querySelector('[data-role="value-label"]'));

    await setOpts({ valueDecimals: 1 });
    const label = doc.querySelector('[data-role="value-label"] text');
    check('valueDecimals 1 → 95.0', label && label.textContent === '95.0', label && label.textContent);

    await setOpts({});
}

// ---- 6. 表示モードでの線編集：トグル・ドラッグ・追加・削除・リセット ------------
console.log('\n[6] view-mode line editing');
{
    // トグル ON でハンドルが出る（表示モードのまま）
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);

    check('edit layer appears after unlock', !!doc.querySelector('[data-role="edit-layer"]'));
    check('toggle label switches to 編集を終了', doc.body.textContent.includes('編集を終了'));
    check('2 vertex handles for default line', [...doc.querySelectorAll('[data-role="vertex"]')].length === 2);
    check('1 midpoint (+) handle', [...doc.querySelectorAll('[data-role="midpoint"]')].length === 1);
    check('reset button shown', !!doc.querySelector('[data-role="reset-line"]'));
    check('edit hint shown (with save note)', doc.body.textContent.includes('点をドラッグ')
        && doc.body.textContent.includes('確定はダッシュボード'));

    // --- 端点ドラッグ → setOptions に正規化座標で保存 ---
    const v0 = doc.querySelectorAll('[data-role="vertex"]')[0];
    v0.dispatchEvent(ev('pointerdown', { clientX: 63, clientY: 280 }));
    await sleep(50);
    win.dispatchEvent(ev('pointermove', { clientX: 450, clientY: 56 })); // → (0.5, 0.1)
    await sleep(50);
    win.dispatchEvent(ev('pointerup'));
    await sleep(250);
    let saved = JSON.parse(state.options.linePoints || 'null');
    check('drag saved via setOptions', Array.isArray(saved) && saved.length === 2, state.options.linePoints);
    check('dragged endpoint ≈ (0.5, 0.1)',
        saved && Math.abs(saved[0][0] - 0.5) < 0.01 && Math.abs(saved[0][1] - 0.1) < 0.01,
        JSON.stringify(saved && saved[0]));
    fire('options', { options: state.options });
    await sleep(250);

    // --- 中点「＋」で折れ点追加（ドラッグ開始→そのまま離す） ---
    const midH = doc.querySelector('[data-role="midpoint"]');
    midH.dispatchEvent(ev('pointerdown', { clientX: 450, clientY: 168 }));
    await sleep(50);
    win.dispatchEvent(ev('pointermove', { clientX: 450, clientY: 448 })); // → (0.5, 0.8)
    await sleep(50);
    win.dispatchEvent(ev('pointerup'));
    await sleep(250);
    saved = JSON.parse(state.options.linePoints || 'null');
    check('midpoint insert → 3 points saved', Array.isArray(saved) && saved.length === 3, state.options.linePoints);
    check('inserted point dragged to (0.5, 0.8)',
        saved && Math.abs(saved[1][0] - 0.5) < 0.01 && Math.abs(saved[1][1] - 0.8) < 0.01,
        JSON.stringify(saved && saved[1]));
    fire('options', { options: state.options });
    await sleep(250);
    check('3 vertex handles now', [...doc.querySelectorAll('[data-role="vertex"]')].length === 3);
    check('2 midpoint handles now', [...doc.querySelectorAll('[data-role="midpoint"]')].length === 2);

    // --- 中間点のダブルクリック削除 ---
    const vMid = doc.querySelectorAll('[data-role="vertex"]')[1];
    vMid.dispatchEvent(ev('dblclick'));
    await sleep(250);
    saved = JSON.parse(state.options.linePoints || 'null');
    check('dblclick removed interior point (2 left)', Array.isArray(saved) && saved.length === 2,
        state.options.linePoints);
    fire('options', { options: state.options });
    await sleep(250);

    // --- リセット ---
    doc.querySelector('[data-role="reset-line"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('reset → linePoints cleared', state.options.linePoints === '', JSON.stringify(state.options.linePoints));
    fire('options', { options: state.options });
    await sleep(250);
    check('reset → default path restored', mainLine().getAttribute('d') === 'M 63 280 L 837 280',
        mainLine().getAttribute('d'));

    // --- トグル OFF でハンドルが消える ---
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('handles gone after lock', !doc.querySelector('[data-role="edit-layer"]'));
    check('reset button gone after lock', !doc.querySelector('[data-role="reset-line"]'));

    // --- allowViewEdit オフ → トグル自体が消える ---
    await setOpts({ allowViewEdit: false });
    check('allowViewEdit off → no toggle', !doc.querySelector('[data-role="edit-toggle"]'));
    await setOpts({});
}

// ---- 6b. 編集モード：ドラッグUIは出さず案内のみ --------------------------------
console.log('\n[6b] edit mode shows guidance only');
{
    // 表示モードでアンロックした状態から編集モードへ → トグルは閉じ、ハンドルも消える
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('unlocked before switching', !!doc.querySelector('[data-role="edit-layer"]'));
    state.mode = 'edit';
    fire('mode', { mode: 'edit' });
    await sleep(250);
    check('edit mode → no toggle', !doc.querySelector('[data-role="edit-toggle"]'));
    check('edit mode → no handles', !doc.querySelector('[data-role="edit-layer"]'));
    check('edit mode → guidance note shown', doc.body.textContent.includes('編集モード中はドラッグ不可'));

    // 表示モードへ戻る → 案内が消え、トグルは閉じた状態（再アンロックが必要）
    state.mode = 'view';
    fire('mode', { mode: 'view' });
    await sleep(250);
    check('back to view → note gone', !doc.body.textContent.includes('編集モード中はドラッグ不可'));
    check('back to view → toggle shown, still locked', !!doc.querySelector('[data-role="edit-toggle"]')
        && !doc.querySelector('[data-role="edit-layer"]'));
}

// ---- 7. ガード（データ無し・数値無し・columns 形式・1列） ----------------------
console.log('\n[7] guards');
{
    await setData({ fields: FIELDS, rows: [] });
    let p = mainLine();
    check('empty data → line still rendered', !!p);
    check('empty data → neutral gray', lineColor() === '#8b93a1', lineColor());
    let label = doc.querySelector('[data-role="value-label"] text');
    check('empty data → N/A label', label && label.textContent === 'N/A', label && label.textContent);

    await setData({ fields: FIELDS, rows: [['a', 'xyz'], ['b', 'www']] });
    p = mainLine();
    check('non-numeric → neutral gray, no crash', lineColor() === '#8b93a1', lineColor());

    await setData({ fields: FIELDS, columns: [['t1', 't2'], ['10', '95']] });
    label = doc.querySelector('[data-role="value-label"] text');
    check('columns-form → value 95', label && label.textContent === '95', label && label.textContent);

    await setData({ fields: [{ name: 'count' }], rows: [['4'], ['9']] });
    label = doc.querySelector('[data-role="value-label"] text');
    check('single-column → value 9', label && label.textContent === '9', label && label.textContent);

    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 8. テーマ切替 -------------------------------------------------------------
console.log('\n[8] theme switch');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const rect = doc.querySelector('[data-role="value-label"] rect');
    check('light theme → white label chip', rect && rect.getAttribute('fill') === 'rgba(255,255,255,0.92)',
        rect && rect.getAttribute('fill'));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const rect2 = doc.querySelector('[data-role="value-label"] rect');
    check('dark theme → dark label chip', rect2 && rect2.getAttribute('fill') === 'rgba(10,14,26,0.88)',
        rect2 && rect2.getAttribute('fill'));
}

// ---- 9. debug オーバーレイ -----------------------------------------------------
console.log('\n[9] debug overlay');
{
    await setOpts({ debug: true });
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
    await setOpts({});
}

// ---- 10. 動的色設定（範囲/一致・パネル操作） -----------------------------------
console.log('\n[10] dynamic color (range / match)');
{
    // --- オプション直指定（範囲） ---
    await setOpts({ colorBands: '[[96,"#111111"],[50,"#222222"],[null,"#333333"]]' });
    check('bands: 95 in [50,96) → #222222', lineColor() === '#222222', lineColor());
    await setOpts({ colorBands: '[[96,"#111111"],[null,"#333333"]]' });
    check('bands: 95 below all → else color', lineColor() === '#333333', lineColor());
    await setOpts({ colorBands: '{broken' });
    check('invalid bands → fallback to fixed thresholds (red)', lineColor() === '#dc4e41', lineColor());

    // --- オプション直指定（一致・非数値の文字列値） ---
    await setData({ fields: [{ name: 'status' }], rows: [['OK']] });
    await setOpts({ colorMethod: 'match', colorMatches: '[["OK","#11aa22"],["NG","#aa1122"]]' });
    check('match: value OK → #11aa22', lineColor() === '#11aa22', lineColor());
    let label = doc.querySelector('[data-role="value-label"] text');
    check('match: label shows raw string OK', label && label.textContent === 'OK', label && label.textContent);
    await setData({ fields: [{ name: 'status' }], rows: [['WARN']] });
    check('match: unmatched → neutral gray', lineColor() === '#8b93a1', lineColor());
    await setOpts({});
    await setData({ fields: FIELDS, rows: ROWS });

    // --- パネル操作（表示モード・範囲タブ） ---
    doc.querySelector('[data-role="color-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('color editor opens', !!doc.querySelector('[data-role="color-editor"]'));
    check('method tabs (範囲/一致) exist', !!doc.querySelector('[data-role="method-range"]')
        && !!doc.querySelector('[data-role="method-match"]'));
    check('palette tabs (ダーク/ライト) exist', !!doc.querySelector('[data-role="palette-dark"]')
        && !!doc.querySelector('[data-role="palette-light"]'));
    const bar = doc.querySelector('[data-role="palette-bar"]');
    check('palette bar with 7 swatches', bar && bar.children.length === 7,
        bar && `got ${bar.children.length}`);
    check('initial 4 rows derived from fixed thresholds',
        [...doc.querySelectorAll('[data-role="color-band-row"]')].length === 4,
        `got ${[...doc.querySelectorAll('[data-role="color-band-row"]')].length}`);
    check('row labels 以上 / 〜 90 / より小さい 40',
        doc.body.textContent.includes('以上') && doc.body.textContent.includes('〜 90')
        && doc.body.textContent.includes('より小さい 40'));
    check('version marker shown in panel', doc.body.textContent.includes('v1.5.0'));

    // ＋範囲の追加 → 5 行・colorBands/colorMethod が保存される
    doc.querySelector('[data-role="band-add"]').dispatchEvent(ev('click'));
    await sleep(250);
    let saved = JSON.parse(state.options.colorBands || 'null');
    check('add range → 5 bands saved', Array.isArray(saved) && saved.length === 5, state.options.colorBands);
    check('added range from = 110 (max+20)', saved && saved[0][0] === 110, JSON.stringify(saved && saved[0]));
    check('colorMethod saved as range', state.options.colorMethod === 'range', state.options.colorMethod);

    // パレットバー適用 → ランプ両端の色が上下の行に入る（上=↑緑端, 最下=↓赤端）
    doc.querySelector('[data-role="palette-bar"]').dispatchEvent(ev('click'));
    await sleep(250);
    saved = JSON.parse(state.options.colorBands || 'null');
    check('palette applied: top = ramp high end', saved && saved[0][1] === '#4f9c45', JSON.stringify(saved && saved[0]));
    check('palette applied: else = ramp low end', saved && saved[saved.length - 1][1] === '#d13b2e',
        JSON.stringify(saved && saved[saved.length - 1]));
    fire('options', { options: state.options });
    await sleep(250);
    {
        const expect = saved.find((b) => b[0] !== null && 95 >= b[0]);
        check('line follows applied palette', lineColor() === expect[1], `${lineColor()} vs ${expect[1]}`);
    }

    // ▾ メニューからパレット選択（青ランプ）→ 適用される
    doc.querySelector('[data-role="palette-menu-toggle"]').dispatchEvent(ev('click'));
    await sleep(200);
    const items = [...doc.querySelectorAll('[data-role="palette-item"]')];
    check('palette menu lists 3 ramps', items.length === 3, `got ${items.length}`);
    items[2].dispatchEvent(ev('click'));
    await sleep(250);
    saved = JSON.parse(state.options.colorBands || 'null');
    check('blue ramp applied via menu', saved && saved[0][1] === '#93cbe0', JSON.stringify(saved && saved[0]));

    // ⇄ 反転
    doc.querySelector('[data-role="band-invert"]').dispatchEvent(ev('click'));
    await sleep(250);
    saved = JSON.parse(state.options.colorBands || 'null');
    check('invert → top gets former bottom color', saved && saved[0][1] === '#0e4d64',
        JSON.stringify(saved && saved[0]));

    // × 削除 → 1 行減る
    doc.querySelector('[data-role="band-remove"]').dispatchEvent(ev('click'));
    await sleep(250);
    saved = JSON.parse(state.options.colorBands || 'null');
    check('remove → 4 bands saved', Array.isArray(saved) && saved.length === 4, state.options.colorBands);

    // --- 一致タブへ切替 ---
    doc.querySelector('[data-role="method-match"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('method switch saved (match)', state.options.colorMethod === 'match', state.options.colorMethod);
    check('match rows UI shown (1 default row)',
        [...doc.querySelectorAll('[data-role="color-match-row"]')].length === 1);
    check('range-only UI hidden in match mode', !doc.querySelector('[data-role="palette-bar"]'));
    doc.querySelector('[data-role="match-add"]').dispatchEvent(ev('click'));
    await sleep(250);
    const savedMatches = JSON.parse(state.options.colorMatches || 'null');
    check('add match → 2 matches saved', Array.isArray(savedMatches) && savedMatches.length === 2,
        state.options.colorMatches);

    // --- 既定に戻す → 3 オプションともクリア・パネルが閉じる ---
    doc.querySelector('[data-role="band-revert"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('revert → colorBands/colorMatches cleared, method range',
        state.options.colorBands === '' && state.options.colorMatches === ''
        && state.options.colorMethod === 'range',
        JSON.stringify([state.options.colorBands, state.options.colorMatches, state.options.colorMethod]));
    check('revert closes panel', !doc.querySelector('[data-role="color-editor"]'));
    fire('options', { options: state.options });
    await sleep(250);
    check('back to fixed thresholds (red)', lineColor() === '#dc4e41', lineColor());

    // 編集モードでは色設定ボタンも出ない
    state.mode = 'edit';
    fire('mode', { mode: 'edit' });
    await sleep(250);
    check('edit mode → no color toggle', !doc.querySelector('[data-role="color-toggle"]'));
    check('edit mode note includes version', doc.body.textContent.includes('v1.5.0'));
    state.mode = 'view';
    fire('mode', { mode: 'view' });
    await sleep(250);
}

// ---- 11. 表示モードの setOptions を取り込まないホスト → 編集モード入りで flush ----
console.log('\n[11] pending flush on entering edit mode');
{
    await setOpts({});
    dropViewSetOptions = true;

    // 表示モードで線をドラッグ（ホストは無視するが、ドラフトで表示は追従する）
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    const v0 = doc.querySelectorAll('[data-role="vertex"]')[0];
    v0.dispatchEvent(ev('pointerdown', { clientX: 63, clientY: 280 }));
    await sleep(50);
    win.dispatchEvent(ev('pointermove', { clientX: 270, clientY: 112 })); // → (0.3, 0.2)
    await sleep(50);
    win.dispatchEvent(ev('pointerup'));
    await sleep(250);
    check('host ignored view-mode save (options unchanged)', !state.options.linePoints,
        JSON.stringify(state.options.linePoints));
    check('draft still shown (path not default)', mainLine().getAttribute('d') !== 'M 63 280 L 837 280',
        mainLine().getAttribute('d'));

    // 表示モードで色を反転（⇄）→ ホスト無視でもライブプレビューで緑になる
    doc.querySelector('[data-role="color-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    doc.querySelector('[data-role="band-invert"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('host ignored view-mode color save', !state.options.colorBands, JSON.stringify(state.options.colorBands));
    check('live preview color (95 ≥ 90 → inverted green)', lineColor() === '#53a051', lineColor());

    // 編集モードに入る → pending が一括 flush され、定義に載る
    const callsBefore = setOptionsLog.length;
    state.mode = 'edit';
    fire('mode', { mode: 'edit' });
    await sleep(300);
    const flushCalls = setOptionsLog.slice(callsBefore).filter((c) => c.mode === 'edit');
    check('flush issued in edit mode', flushCalls.length === 1, `got ${flushCalls.length}`);
    let savedPts = JSON.parse(state.options.linePoints || 'null');
    check('flushed linePoints ≈ (0.3, 0.2)',
        savedPts && Math.abs(savedPts[0][0] - 0.3) < 0.01 && Math.abs(savedPts[0][1] - 0.2) < 0.01,
        JSON.stringify(savedPts && savedPts[0]));
    let savedBands = JSON.parse(state.options.colorBands || 'null');
    check('flushed colorBands (top 90 → inverted green)',
        savedBands && savedBands[0][0] === 90 && savedBands[0][1] === '#53a051',
        JSON.stringify(savedBands && savedBands[0]));
    check('flushed colorMethod', state.options.colorMethod === 'range', state.options.colorMethod);
    fire('options', { options: state.options });
    await sleep(250);
    check('shape kept in edit mode', mainLine().getAttribute('d') !== 'M 63 280 L 837 280',
        mainLine().getAttribute('d'));
    check('color kept in edit mode', lineColor() === '#53a051', lineColor());

    // 一度 echo を受けたら、モードを往復しても再送しない（pending 消し込み確認）
    state.mode = 'view';
    fire('mode', { mode: 'view' });
    await sleep(250);
    const callsBeforeSecond = setOptionsLog.length;
    state.mode = 'edit';
    fire('mode', { mode: 'edit' });
    await sleep(250);
    check('no re-flush after echo', setOptionsLog.length === callsBeforeSecond,
        `got ${setOptionsLog.length - callsBeforeSecond} extra calls`);

    // 後片付け
    dropViewSetOptions = false;
    state.mode = 'view';
    fire('mode', { mode: 'view' });
    await setOpts({});
    check('cleanup → default path', mainLine().getAttribute('d') === 'M 63 280 L 837 280',
        mainLine().getAttribute('d'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
