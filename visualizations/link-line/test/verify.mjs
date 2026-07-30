// Link Line viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'custom_viz_link_line', 'visualization.js');
// バージョン表記は package.json を正とする（ハードコードするとリリースのたびに壊れるため）
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const VERSION_MARK = `v${PKG_VERSION}`;
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

// Canvas 2D コンテキストのスタブ（光の帯 Canvas 用。呼ばれた操作名を記録する）
function makeCtx2d() {
    const ops = [];
    const rec = (name) => (...args) => { ops.push(name); };
    return {
        ops,
        setTransform: rec('setTransform'),
        clearRect: rec('clearRect'),
        beginPath: rec('beginPath'),
        moveTo: rec('moveTo'),
        lineTo: rec('lineTo'),
        closePath: rec('closePath'),
        fill: rec('fill'),
        stroke: rec('stroke'),
        arc: rec('arc'),
        save: rec('save'),
        restore: rec('restore'),
    };
}
win.HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!this.__ctx2d) this.__ctx2d = makeCtx2d();
    return this.__ctx2d;
};
globalThis.HTMLCanvasElement = win.HTMLCanvasElement;

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
    // ドリルダウン登録を記録して、正しい payload が登録されるか検査する
    addDrilldownListener: (args) => {
        drilldownRegs.push(args);
    },
};
const drilldownRegs = [];
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
const valueText = () => doc.querySelector('[data-role="value-label"] [data-role="value-text"]');
const flowCanvas = () => doc.querySelector('canvas[data-role="flow-canvas"]');
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
    check('value 95 in default band [90,100) → red #dc4e41', p && lineColor() === '#dc4e41', p && lineColor());
    check('gradient stroke by default (url(#llGrad))', p && p.getAttribute('stroke') === 'url(#llGrad)',
        p && p.getAttribute('stroke'));
    check('flat mode → no halo layers', !doc.querySelector('path[data-role="line-halo1"]'));
    check('no shadow filter in flat mode', p && !p.getAttribute('filter'));
    const caps = [...doc.querySelectorAll('[data-role="endcap"]')];
    check('2 endcaps', caps.length === 2, `got ${caps.length}`);
    check('no arrow by default', !doc.querySelector('[data-role="arrow"]'));
    const label = valueText();
    check('value label shows 95', label && label.textContent === '95', label && label.textContent);
    check('no flow canvas by default (flowSpeed 0)', !flowCanvas());
    check('edit toggle (✎) shown in view mode', !!doc.querySelector('[data-role="edit-toggle"]'));
    check('self-built color panel removed (no 🎨 toggle)', !doc.querySelector('[data-role="color-toggle"]'));
    check('no edit layer until unlocked', !doc.querySelector('[data-role="edit-layer"]'));
    check('no reset button until unlocked', !doc.querySelector('[data-role="reset-line"]'));
}

// ---- 2. 線の色（editor.threshold の colorBands 配列） --------------------------
// editor.threshold は [{from,to,value}] を生の配列で渡してくる（DOS 文字列にならない）。
console.log('\n[2] colorBands (editor.threshold array)');
{
    // (a) 既定バンド：各バンド内の値がそのバンドの色になる
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '10']] });
    check('default bands: 10 in [0,40) → green #53a051', lineColor() === '#53a051', lineColor());
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '50']] });
    check('default bands: 50 in [40,70) → yellow #f8be34', lineColor() === '#f8be34', lineColor());
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '75']] });
    check('default bands: 75 in [70,90) → orange #f1813f', lineColor() === '#f1813f', lineColor());
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '95']] });
    check('default bands: 95 in [90,∞) → red #dc4e41', lineColor() === '#dc4e41', lineColor());
    // 最上位バンドは上限なし [90,∞)。100 超でも灰色に抜けず赤のままであること
    // （旧実装の threshold3 は「90 以上すべて赤」だったので、その挙動を既定で保つ）
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '250']] });
    check('default bands: 250 above top band → still red (open range)', lineColor() === '#dc4e41', lineColor());
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '99999']] });
    check('default bands: very large value → still red', lineColor() === '#dc4e41', lineColor());

    // 半開区間 [from, to)：境界値は下側のバンドではなく上側のバンドに入る
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '40']] });
    check('half-open [from,to): 40 → upper band #f8be34', lineColor() === '#f8be34', lineColor());

    // (a2) カスタムバンド（editor から届く形そのまま）
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '55']] });
    await setOpts({ colorBands: [{ from: 0, to: 50, value: '#111111' }, { from: 50, to: 100, value: '#222222' }] });
    check('custom bands: 55 in [50,100) → #222222', lineColor() === '#222222', lineColor());

    // 未ソートでも同じ結果
    await setOpts({ colorBands: [{ from: 50, to: 100, value: '#222222' }, { from: 0, to: 50, value: '#111111' }] });
    check('unsorted bands: 55 → #222222 (order-independent)', lineColor() === '#222222', lineColor());
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '20']] });
    check('unsorted bands: 20 → #111111', lineColor() === '#111111', lineColor());

    // 開区間（openRanges: true → from/to が null で届く）
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '999']] });
    await setOpts({ colorBands: [{ from: null, to: 10, value: '#aa0000' }, { from: 10, to: null, value: '#00aa00' }] });
    check('open upper range [10,∞) → 999 → #00aa00', lineColor() === '#00aa00', lineColor());
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '-500']] });
    check('open lower range (-∞,10) → -500 → #aa0000', lineColor() === '#aa0000', lineColor());
    await setData({ fields: FIELDS, rows: [['t1', '5'], ['t2', '95']] });

    // 重なり：狭い方（from が大きい方）が勝つ。並び順を変えても同じ色
    await setOpts({ colorBands: [{ from: 0, to: 200, value: '#aaaaaa' }, { from: 90, to: 200, value: '#bbbbbb' }] });
    check('overlap: narrower (higher from) wins → #bbbbbb', lineColor() === '#bbbbbb', lineColor());
    await setOpts({ colorBands: [{ from: 90, to: 200, value: '#bbbbbb' }, { from: 0, to: 200, value: '#aaaaaa' }] });
    check('overlap is order-independent → #bbbbbb', lineColor() === '#bbbbbb', lineColor());
    // 同じ from なら to が小さい方（より狭い方）が勝つ
    await setOpts({ colorBands: [{ from: 90, to: 200, value: '#aaaaaa' }, { from: 90, to: 100, value: '#cccccc' }] });
    check('same from → smaller to wins → #cccccc', lineColor() === '#cccccc', lineColor());

    // (b) 壊れた配列でも落ちない → ニュートラル or 生き残った行
    await setOpts({ colorBands: [] });
    check('empty array → neutral gray, no crash', lineColor() === '#8b93a1', lineColor());
    check('empty array → line still rendered', !!mainLine());

    await setOpts({ colorBands: 'garbage' });
    check('non-array (string) → falls back to DEFAULTS bands (red)', lineColor() === '#dc4e41', lineColor());
    await setOpts({ colorBands: 12345 });
    check('non-array (number) → falls back to DEFAULTS bands (red)', lineColor() === '#dc4e41', lineColor());
    await setOpts({ colorBands: null });
    check('null → falls back to DEFAULTS bands (red)', lineColor() === '#dc4e41', lineColor());

    await setOpts({ colorBands: [null, 'x', 42, { nope: 1 }] });
    check('garbage rows → neutral gray, no crash', lineColor() === '#8b93a1', lineColor());

    await setOpts({ colorBands: [{ from: 0, to: 200, value: 'not-a-color' }] });
    check('invalid hex → row skipped → neutral gray', lineColor() === '#8b93a1', lineColor());

    // 1 行だけ壊れていても、生きている行は活かす
    await setOpts({ colorBands: [{ from: 0, to: 200, value: 'nope' }, { from: 90, to: 200, value: '#0088ff' }] });
    check('partially broken array → valid row still applies', lineColor() === '#0088ff', lineColor());

    // 逆転した範囲（from > to）は無視
    await setOpts({ colorBands: [{ from: 200, to: 0, value: '#ff00ff' }] });
    check('reversed range (from > to) ignored → neutral', lineColor() === '#8b93a1', lineColor());

    // 値が数値でない → ニュートラル（バンドは見ない）
    await setData({ fields: FIELDS, rows: [['t1', 'abc'], ['t2', 'def']] });
    await setOpts({ colorBands: [{ from: 0, to: 200, value: '#0088ff' }] });
    check('non-numeric value → neutral gray regardless of bands', lineColor() === '#8b93a1', lineColor());

    await setOpts({});
    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 2b. 旧・色オプションは無視される（後方互換は意図的に実装しない） -----------
// v1.9.0 で自作の色設定パネルを廃止し editor.threshold へ一本化した。旧ダッシュボードに
// 残った文字列 colorBands / threshold1 / color1 / useThresholds / baseColor / colorMethod /
// colorMatches は読み替えず、既定バンドへ倒す。
console.log('\n[2b] legacy color options ignored (no back-compat)');
{
    // 95 は既定バンド [90,100) → #dc4e41 になるはず（旧値の色にはならない）
    await setOpts({ colorBands: '[[96,"#111111"],[50,"#222222"],[null,"#333333"]]' });
    check('legacy STRING colorBands ignored → default bands (red)', lineColor() === '#dc4e41', lineColor());

    await setOpts({ threshold1: 10, color1: '#00ff00', threshold2: 20, color2: '#0000ff',
                    threshold3: 30, color3: '#ff00ff' });
    check('legacy threshold1-3 / color1-3 ignored → default bands (red)', lineColor() === '#dc4e41', lineColor());

    await setOpts({ useThresholds: false, baseColor: '#22d3ee' });
    check('legacy useThresholds/baseColor ignored → default bands (red)', lineColor() === '#dc4e41', lineColor());

    await setData({ fields: [{ name: 'status' }], rows: [['OK']] });
    await setOpts({ colorMethod: 'match', colorMatches: '[["OK","#11aa22"]]' });
    check('legacy colorMethod/colorMatches ignored → non-numeric → neutral',
        lineColor() === '#8b93a1', lineColor());

    // 旧キーが全部残っていても落ちない
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ colorBands: '[[96,"#111111"]]', colorMethod: 'match', colorMatches: '[["a","#b"]]',
                    useThresholds: true, baseColor: '#53a051', threshold1: 40, color1: '#f8be34',
                    threshold2: 70, color2: '#f1813f', threshold3: 90, color3: '#dc4e41' });
    check('all legacy keys present → no crash, default bands (red)', lineColor() === '#dc4e41', lineColor());
    check('all legacy keys present → line still rendered', !!mainLine());

    await setOpts({});
}

// ---- 3. フィールド選択（columnSelector DOS 文字列） ---------------------------
console.log('\n[3] field selection');
{
    await setData({
        fields: [{ name: '_time' }, { name: 'errors' }, { name: 'users' }],
        rows: [['t1', '5', '1000'], ['t2', '88', '2000']],
    });
    let label = valueText();
    check('fallback = last numeric column (users → 2,000)', label && label.textContent === '2,000',
        label && label.textContent);

    await setOpts({ valueField: "> primary | seriesByName('errors')" });
    label = valueText();
    check('DOS-selected errors → 88', label && label.textContent === '88', label && label.textContent);
    check('88 in default band [70,90) → orange', lineColor() === '#f1813f', lineColor());

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
    await setOpts({ styleMode: 'neon' });
    check('neon → halo layers', !!doc.querySelector('path[data-role="line-halo1"]')
        && !!doc.querySelector('path[data-role="line-halo2"]'));
    check('neon → bright core layer', !!doc.querySelector('path[data-role="line-core"]'));

    await setOpts({ styleMode: 'pipe' });
    check('pipe → dark edge layer', !!doc.querySelector('path[data-role="line-edge"]'));
    check('pipe → highlight core layer', !!doc.querySelector('path[data-role="line-core"]'));

    await setOpts({ styleMode: 'shadow' });
    check('soft shadow → filter on main line', mainLine().getAttribute('filter') === 'url(#llShadow)',
        mainLine().getAttribute('filter'));

    await setOpts({ dashLength: 12 });
    check('dashLength 12 → stroke-dasharray "12 9"', mainLine().getAttribute('stroke-dasharray') === '12 9',
        mainLine().getAttribute('stroke-dasharray'));

    await setOpts({ dashLength: 12, flowSpeed: 2 });
    await sleep(400);
    check('dashed + flow → flow canvas mounted', !!flowCanvas());
    check('dashes stay static (no dashoffset animation)', !mainLine().getAttribute('stroke-dashoffset')
        && !mainLine().getAttribute('data-anim'));

    await setOpts({ flowSpeed: 2 });
    await sleep(400);
    const cv = flowCanvas();
    check('solid + flow → flow canvas mounted', !!cv);
    const ctx = cv && cv.getContext('2d');
    check('flow canvas rAF running (clearRect called)', ctx && ctx.ops.includes('clearRect'));
    check('light band drawn (tapered polygon filled)', ctx && ctx.ops.includes('fill'),
        ctx && `ops=${[...new Set(ctx.ops)].join(',')}`);
    check('no SVG flow overlay anymore', !doc.querySelector('[data-role="flow"]'));

    await setOpts({ lineOpacity: 50 });
    const g = mainLine().parentElement;
    check('lineOpacity 50 → group opacity 0.5', g && g.getAttribute('opacity') === '0.5',
        g && g.getAttribute('opacity'));

    await setOpts({ lineGradient: false });
    check('lineGradient off → solid hex stroke', mainLine().getAttribute('stroke') === '#dc4e41',
        mainLine().getAttribute('stroke'));

    await setOpts({ pulseCaps: true });
    await sleep(400);
    const pulseCv = flowCanvas();
    check('pulseCaps → flow canvas mounted (flowSpeed 0 でも)', !!pulseCv);
    const pulseCtx = pulseCv && pulseCv.getContext('2d');
    check('pulse rings drawn on canvas (arc + stroke)',
        pulseCtx && pulseCtx.ops.includes('arc') && pulseCtx.ops.includes('stroke'),
        pulseCtx && `ops=${[...new Set(pulseCtx.ops)].join(',')}`);

    await setOpts({ arrowHead: true });
    check('arrow head rendered', !!doc.querySelector('[data-role="arrow"]'));
    check('arrow replaces end cap (1 endcap left)',
        [...doc.querySelectorAll('[data-role="endcap"]')].length === 1);

    await setOpts({ showEndCaps: false, arrowHead: false });
    check('endcaps hidden', !doc.querySelector('[data-role="endcap"]'));

    await setOpts({ showValue: false });
    check('value label hidden', !doc.querySelector('[data-role="value-label"]'));

    await setOpts({ valueDecimals: 1 });
    const label = valueText();
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
    let label = valueText();
    check('empty data → N/A label', label && label.textContent === 'N/A', label && label.textContent);

    await setData({ fields: FIELDS, rows: [['a', 'xyz'], ['b', 'www']] });
    p = mainLine();
    check('non-numeric → neutral gray, no crash', lineColor() === '#8b93a1', lineColor());

    await setData({ fields: FIELDS, columns: [['t1', 't2'], ['10', '95']] });
    label = valueText();
    check('columns-form → value 95', label && label.textContent === '95', label && label.textContent);

    await setData({ fields: [{ name: 'count' }], rows: [['4'], ['9']] });
    label = valueText();
    check('single-column → value 9', label && label.textContent === '9', label && label.textContent);

    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 8. テーマ切替 -------------------------------------------------------------
console.log('\n[8] theme switch');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const chip = doc.querySelector('[data-role="value-label"]');
    check('light theme → white label chip', chip && chip.style.background === 'rgba(255, 255, 255, 0.92)',
        chip && chip.style.background);
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const chip2 = doc.querySelector('[data-role="value-label"]');
    check('dark theme → dark label chip', chip2 && chip2.style.background === 'rgba(10, 14, 26, 0.88)',
        chip2 && chip2.style.background);
}

// ---- 9. debug オプション廃止（オーバーレイが出ないこと） ------------------------
console.log('\n[9] debug option removed');
{
    await setOpts({ debug: true });
    check('debug overlay no longer renders', !doc.body.textContent.includes('"normalized"'),
        doc.body.textContent.slice(0, 160));
    check('no [data-role="debug"] element', !doc.querySelector('[data-role="debug"]'));
    check('line still renders with stale debug option', !!mainLine());
    await setOpts({});
}

// ---- 9b. 旧 styleMode 数値コードの回帰（後方互換は意図的に実装しない） -----------
// v1.8.0 で styleMode を editor.select の文字列へ移行した。旧ダッシュボードに残った
// 数値コードは「読み替えず」既定 'flat' へ倒す（既定値と同じ値は options に載らないため、
// 読み替えを実装すると「既定値を選び直したときだけ直らない」不具合になる）。
console.log('\n[9b] legacy numeric styleMode falls back to flat (no back-compat)');
{
    await setOpts({ styleMode: 3 }); // 旧「ネオン発光」
    check('legacy styleMode:3 does NOT select neon (no halo layers)',
        !doc.querySelector('path[data-role="line-halo1"]') && !doc.querySelector('path[data-role="line-halo2"]'));
    check('legacy styleMode:3 → flat (no core layer)', !doc.querySelector('path[data-role="line-core"]'));

    await setOpts({ styleMode: 4 }); // 旧「立体パイプ」
    check('legacy styleMode:4 does NOT select pipe (no dark edge layer)',
        !doc.querySelector('path[data-role="line-edge"]'));

    await setOpts({ styleMode: 2 }); // 旧「ソフトシャドウ」
    check('legacy styleMode:2 does NOT apply shadow filter', !mainLine().getAttribute('filter'),
        mainLine().getAttribute('filter'));

    check('legacy value still renders a line (flat fallback)', !!mainLine());
    await setOpts({});
}

// ---- 10. 色設定は編集パネル（editor.threshold）に一本化・viz 内 UI は無い ------
console.log('\n[10] in-viz color panel fully removed');
{
    check('no 🎨 color toggle in view mode', !doc.querySelector('[data-role="color-toggle"]'));
    check('no color editor panel', !doc.querySelector('[data-role="color-editor"]'));
    check('no method tabs (範囲/一致)', !doc.querySelector('[data-role="method-range"]')
        && !doc.querySelector('[data-role="method-match"]'));
    check('no palette bar / tabs', !doc.querySelector('[data-role="palette-bar"]')
        && !doc.querySelector('[data-role="palette-dark"]'));
    check('no band rows / add / remove / invert / revert',
        !doc.querySelector('[data-role="color-band-row"]') && !doc.querySelector('[data-role="band-add"]')
        && !doc.querySelector('[data-role="band-remove"]') && !doc.querySelector('[data-role="band-invert"]')
        && !doc.querySelector('[data-role="band-revert"]'));
    check('no match rows UI', !doc.querySelector('[data-role="color-match-row"]')
        && !doc.querySelector('[data-role="match-add"]'));
    check('panel wording gone from DOM', !doc.body.textContent.includes('動的色設定：メジャー値')
        && !doc.body.textContent.includes('色を設定'));

    // ✎ 線編集トグルは残っている（色パネルだけを消した）
    check('✎ line edit toggle still present', !!doc.querySelector('[data-role="edit-toggle"]'));

    // 編集モードの案内は「色は右パネル」と伝える
    state.mode = 'edit';
    fire('mode', { mode: 'edit' });
    await sleep(250);
    check('edit mode note points to right panel for color',
        doc.body.textContent.includes('線の色'), doc.body.textContent.slice(-200));
    check('edit mode note includes version', doc.body.textContent.includes(VERSION_MARK), VERSION_MARK);
    check('edit mode → no color toggle', !doc.querySelector('[data-role="color-toggle"]'));
    state.mode = 'view';
    fire('mode', { mode: 'view' });
    await sleep(250);

    // 編集パネル（右パネル）から colorBands が変われば線の色は即追従する
    await setOpts({ colorBands: [{ from: 0, to: 1000, value: '#7b56db' }] });
    check('editor-panel colorBands drives line color', lineColor() === '#7b56db', lineColor());
    await setOpts({});
    check('back to default bands (red)', lineColor() === '#dc4e41', lineColor());
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

    // 編集モードに入る → pending（linePoints のみ）が flush され、定義に載る
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
    check('flush patch contains ONLY linePoints (no color keys)',
        flushCalls.length === 1 && !('colorMethod' in flushCalls[0].o) && !('colorMatches' in flushCalls[0].o)
        && !Object.prototype.hasOwnProperty.call(state.options, 'colorMethod'),
        JSON.stringify(Object.keys(state.options)));
    fire('options', { options: state.options });
    await sleep(250);
    check('shape kept in edit mode', mainLine().getAttribute('d') !== 'M 63 280 L 837 280',
        mainLine().getAttribute('d'));
    check('color unaffected by flush (default bands, red)', lineColor() === '#dc4e41', lineColor());

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

// ---- 12. ✎ 線編集の回帰（色パネル削除の巻き添えが無いこと） ---------------------
// 色パネルの pendingRef / flush を剥がしたときに linePoints の経路まで壊していないか、
// 「色を editor.threshold で設定した状態」で線編集フローを丸ごと再走行して確認する。
console.log('\n[12] ✎ line editor regression (with editor-panel colorBands set)');
{
    await setOpts({ colorBands: [{ from: 0, to: 1000, value: '#7b56db' }] });
    check('editor-panel color applied', lineColor() === '#7b56db', lineColor());

    // トグル ON → ハンドルが出る
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('edit layer appears', !!doc.querySelector('[data-role="edit-layer"]'));
    check('2 vertex handles', [...doc.querySelectorAll('[data-role="vertex"]')].length === 2);
    check('1 midpoint (+) handle', [...doc.querySelectorAll('[data-role="midpoint"]')].length === 1);
    check('reset button shown', !!doc.querySelector('[data-role="reset-line"]'));

    // ドラッグ → linePoints が setOptions で保存される
    const v0 = doc.querySelectorAll('[data-role="vertex"]')[0];
    v0.dispatchEvent(ev('pointerdown', { clientX: 63, clientY: 280 }));
    await sleep(50);
    win.dispatchEvent(ev('pointermove', { clientX: 180, clientY: 448 })); // → (0.2, 0.8)
    await sleep(50);
    win.dispatchEvent(ev('pointerup'));
    await sleep(250);
    let saved = JSON.parse(state.options.linePoints || 'null');
    check('drag persisted to linePoints', Array.isArray(saved) && saved.length === 2, state.options.linePoints);
    check('dragged endpoint ≈ (0.2, 0.8)',
        saved && Math.abs(saved[0][0] - 0.2) < 0.01 && Math.abs(saved[0][1] - 0.8) < 0.01,
        JSON.stringify(saved && saved[0]));
    check('colorBands untouched by line save',
        Array.isArray(state.options.colorBands) && state.options.colorBands[0].value === '#7b56db',
        JSON.stringify(state.options.colorBands));
    fire('options', { options: state.options });
    await sleep(250);
    check('color still applied after line save', lineColor() === '#7b56db', lineColor());

    // ＋で折れ点を追加
    doc.querySelector('[data-role="midpoint"]').dispatchEvent(ev('pointerdown', { clientX: 450, clientY: 300 }));
    await sleep(50);
    win.dispatchEvent(ev('pointermove', { clientX: 450, clientY: 112 })); // → (0.5, 0.2)
    await sleep(50);
    win.dispatchEvent(ev('pointerup'));
    await sleep(250);
    saved = JSON.parse(state.options.linePoints || 'null');
    check('midpoint insert → 3 points persisted', Array.isArray(saved) && saved.length === 3,
        state.options.linePoints);
    fire('options', { options: state.options });
    await sleep(250);
    check('3 vertex handles now', [...doc.querySelectorAll('[data-role="vertex"]')].length === 3);
    check('path reflects 3 points', (mainLine().getAttribute('d').match(/[LQ]/g) || []).length >= 2,
        mainLine().getAttribute('d'));

    // ダブルクリックで削除
    doc.querySelectorAll('[data-role="vertex"]')[1].dispatchEvent(ev('dblclick'));
    await sleep(250);
    saved = JSON.parse(state.options.linePoints || 'null');
    check('dblclick removed interior point (2 left)', Array.isArray(saved) && saved.length === 2,
        state.options.linePoints);
    fire('options', { options: state.options });
    await sleep(250);

    // リセット
    doc.querySelector('[data-role="reset-line"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('reset → linePoints cleared', state.options.linePoints === '', JSON.stringify(state.options.linePoints));
    fire('options', { options: state.options });
    await sleep(250);
    check('reset → default path restored', mainLine().getAttribute('d') === 'M 63 280 L 837 280',
        mainLine().getAttribute('d'));

    // トグル OFF
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('handles gone after lock', !doc.querySelector('[data-role="edit-layer"]'));

    // allowViewEdit は今も ✎ 線編集を制御している（色パネル専用ではない）
    await setOpts({ allowViewEdit: false });
    check('allowViewEdit off → ✎ toggle hidden', !doc.querySelector('[data-role="edit-toggle"]'));
    await setOpts({ allowViewEdit: true, colorBands: [{ from: 0, to: 1000, value: '#7b56db' }] });
    check('allowViewEdit on → ✎ toggle back', !!doc.querySelector('[data-role="edit-toggle"]'));
    await setOpts({});
}

// ---- 12. 色分けモード「文字列の一致」（colorMode='match' + matchColors） --------
console.log('\n[17] match mode colors the line by raw string value');
{
    await setData({ fields: FIELDS, rows: [['t1', 'OK']] });
    await setOpts({ colorMode: 'match', matchColors: ['OK|#00ff00', 'NG|#dc4e41'], lineGradient: false });
    check('OK → green', mainLine().getAttribute('stroke') === '#00ff00', mainLine().getAttribute('stroke'));
    check('label shows the raw string', valueText().textContent === 'OK', valueText().textContent);

    // 大文字小文字は同一視する
    await setData({ fields: FIELDS, rows: [['t1', 'ng']] });
    check('case-insensitive match (ng → red)', mainLine().getAttribute('stroke') === '#dc4e41',
        mainLine().getAttribute('stroke'));

    // どれにも一致しない値・CSS 色名・数値文字列
    await setData({ fields: FIELDS, rows: [['t1', 'WARN']] });
    check('unmatched value → neutral gray', mainLine().getAttribute('stroke') === '#8b93a1',
        mainLine().getAttribute('stroke'));
    await setOpts({ colorMode: 'match', matchColors: ['warn|orange'], lineGradient: false });
    check('CSS color names accepted (orange)', mainLine().getAttribute('stroke') === '#ffa500',
        mainLine().getAttribute('stroke'));

    // match モードでは数値も整形しない（生の文字列のまま）
    await setData({ fields: FIELDS, rows: [['t1', '1234.5']] });
    await setOpts({ colorMode: 'match', matchColors: ['1234.5|#0000ff'], lineGradient: false });
    check('numeric string matches literally and is not formatted',
        mainLine().getAttribute('stroke') === '#0000ff' && valueText().textContent === '1234.5',
        `${mainLine().getAttribute('stroke')} / ${valueText().textContent}`);

    // range モード（既定）では matchColors は使われない
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ matchColors: ['95|#0000ff'], lineGradient: false });
    check('range mode ignores matchColors (95 → red band)', mainLine().getAttribute('stroke') === '#dc4e41',
        mainLine().getAttribute('stroke'));
    await setOpts({});
}

// ---- 13. 単位表示（unitLabel）と接続名（linkLabel） -----------------------------
console.log('\n[18] unit label and link label');
{
    await setData({ fields: FIELDS, rows: ROWS }); // 95
    await setOpts({ unitLabel: 'ms' });
    const unit = () => doc.querySelector('[data-role="value-unit"]');
    check('unit appears after the value', unit() && unit().textContent === 'ms',
        unit() && unit().textContent);
    check('value itself stays formatted (95)', valueText().textContent === '95', valueText().textContent);

    // 値が無い（N/A）ときは単位を付けない
    await setData({ fields: FIELDS, rows: [] });
    check('no unit on N/A', valueText().textContent === 'N/A' && !unit(),
        `${valueText() && valueText().textContent} / unit=${!!unit()}`);
    await setData({ fields: FIELDS, rows: ROWS });

    // 接続名（値の前に一段弱く表示）
    await setOpts({ linkLabel: 'DB → App', unitLabel: 'ms' });
    const linkLabel = () => doc.querySelector('[data-role="link-label"]');
    check('link label shown before the value', linkLabel() && linkLabel().textContent === 'DB → App',
        linkLabel() && linkLabel().textContent);

    // showValue オフでも接続名だけのチップを出せる
    await setOpts({ linkLabel: 'DB → App', showValue: false });
    check('label-only chip when showValue is off',
        !!linkLabel() && !valueText() && !!doc.querySelector('[data-role="value-label"]'),
        `label=${!!linkLabel()} value=${!!valueText()}`);

    // 両方無ければチップ自体が出ない（従来どおり）
    await setOpts({ showValue: false });
    check('no chip when both are off', !doc.querySelector('[data-role="value-label"]'));
    await setOpts({});
}

// ---- 14. 光の帯の向き（flowDirection: forward / reverse / both） -----------------
console.log('\n[19] flow direction');
{
    const fillsIn = async (o) => {
        await setOpts({ flowSpeed: 2, ...o });
        const cv = flowCanvas();
        const ctx = cv && cv.getContext('2d');
        if (!ctx) return -1;
        ctx.ops.length = 0;
        await sleep(150);
        return ctx.ops.filter((op) => op === 'fill').length;
    };
    const fwd = await fillsIn({ flowDirection: 'forward' });
    check('forward: band drawn on canvas', fwd > 0, `fills=${fwd}`);
    const rev = await fillsIn({ flowDirection: 'reverse' });
    check('reverse: band drawn on canvas', rev > 0, `fills=${rev}`);
    const both = await fillsIn({ flowDirection: 'both' });
    check('both: two bands per frame (≈2x fills)', both > Math.max(fwd, rev) * 1.5,
        `fwd=${fwd} rev=${rev} both=${both}`);
    // 未知値は forward へ丸めて落ちない
    const junk = await fillsIn({ flowDirection: 'zigzag' });
    check('unknown direction falls back safely', junk > 0, `fills=${junk}`);
    await setOpts({});
}

// ---- 15. ドリルダウン（line.click の登録と payload） -----------------------------
console.log('\n[20] drilldown registration');
{
    await setData({ fields: FIELDS, rows: ROWS }); // 95
    await setOpts({ linkLabel: 'DB → App' });
    check('transparent hit path exists', !!doc.querySelector('path[data-role="drill-hit"]'));
    check('drilldown listeners registered', drilldownRegs.length > 0, `got ${drilldownRegs.length}`);
    const reg = drilldownRegs[drilldownRegs.length - 1];
    check('action is line.click', reg && reg.action === 'line.click', reg && reg.action);
    check('registration has a DOM node', !!(reg && reg.node));
    const payload = reg && typeof reg.payloadCallback === 'function' ? reg.payloadCallback() : null;
    check('payload uses row.<field>.value convention (latency_ms=95)',
        payload && payload['row.latency_ms.value'] === 95 && payload['row.value.value'] === 95,
        JSON.stringify(payload));
    check('payload carries the link label', payload && payload['row.label.value'] === 'DB → App',
        JSON.stringify(payload));
    check('payload has name/value for interaction UI',
        payload && payload.name === 'latency_ms' && payload.value === 95, JSON.stringify(payload));

    // 線編集トグル中は当たり判定を外す（編集ドラッグを妨げない）
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('hit path removed while line editing', !doc.querySelector('path[data-role="drill-hit"]'));
    doc.querySelector('[data-role="edit-toggle"]').dispatchEvent(ev('click'));
    await sleep(250);
    check('hit path restored after editing', !!doc.querySelector('path[data-role="drill-hit"]'));
    await setOpts({});
}

// ---- 16. slider 化したオプションが従来どおり効く --------------------------------
console.log('\n[21] slider-backed options still apply');
{
    await setOpts({ lineOpacity: 40 });
    const g = doc.querySelector('svg > g[opacity]');
    check('lineOpacity 40 → group opacity 0.4', g && g.getAttribute('opacity') === '0.4',
        g && g.getAttribute('opacity'));
    await setOpts({ flowSpeed: 0.5 });
    check('fractional flowSpeed accepted (canvas mounted)', !!flowCanvas());
    await setOpts({});
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
