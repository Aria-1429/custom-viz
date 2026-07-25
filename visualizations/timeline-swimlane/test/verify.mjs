// Timeline Swimlane viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_timeline_swimlane', 'visualization.js'
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
const VH = 500;
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
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => VW, configurable: true });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => VH, configurable: true });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
};
// SVG 要素にも getBoundingClientRect（ブラシの座標計算で使う）
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

// ---- テストデータ -----------------------------------------------------------
// 2026-07-25 09:00:00 ローカル を基準にした epoch 秒
const T0 = Math.floor(new Date(2026, 6, 25, 9, 0, 0).getTime() / 1000);

// 期間イベント（min/max(_time) by host, action 相当）: 3レーン × 分類3種、計6件
const SPANS = {
    fields: [{ name: 'host' }, { name: 'action' }, { name: 'start' }, { name: 'end' }],
    rows: [
        ['web-01', 'login', String(T0), String(T0 + 300)],
        ['web-01', 'query', String(T0 + 600), String(T0 + 1500)],
        ['web-02', 'login', String(T0 + 120), String(T0 + 200)],
        ['web-02', 'error', String(T0 + 900), String(T0 + 960)],
        ['db-01', 'query', String(T0 + 300), String(T0 + 3600)],
        ['db-01', 'query', String(T0 + 3700), String(T0 + 4000)],
    ],
};

// 点イベント（table _time host action 相当。終了列なし）
const POINTS = {
    fields: [{ name: '_time' }, { name: 'host' }, { name: 'action' }],
    rows: [
        [String(T0), 'web-01', 'login'],
        [String(T0 + 500), 'web-01', 'logout'],
        [String(T0 + 900), 'db-01', 'login'],
    ],
};

// ISO 文字列の時刻
const ISO = {
    fields: [{ name: 'host' }, { name: 'start' }, { name: 'end' }],
    rows: [
        ['h1', '2026-07-25 09:00:00', '2026-07-25 09:10:00'],
        ['h2', '2026-07-25 09:05:00', '2026-07-25 09:30:00'],
    ],
};

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

let state = {
    data: SPANS,
    options: { animate: false },
    theme: 'dark',
    mode: 'view',
};
let lastSetOptions = null;

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { lastSetOptions = o; state.options = { ...state.options, ...o }; },
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
    // 前セクションのホバー状態（クロスヘアによる減光）を持ち越さない
    const svg0 = doc.querySelector('svg');
    if (svg0) svg0.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    state.options = o;
    fire('options', { options: state.options });
    await sleep(250);
};
const setData = async (data) => {
    state.data = data;
    fire('dataSources', { loading: false, dataSources: { primary: { data } } });
    await sleep(250);
};

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
// eslint-disable-next-line no-eval
(0, eval)(code);
await sleep(400);

const q = (sel) => Array.from(doc.querySelectorAll(sel));
const bars = () => q('rect[data-role="tl-bar"]');
const laneLabels = () => q('text[data-role="tl-lane-label"]');
const ticks = () => q('text[data-role="tl-tick"]');
const legendItems = () => q('[data-role="tl-legend-item"]');

// ---- 1. 基本描画 -------------------------------------------------------------
console.log('\n[1] duration events render as bars');
{
    check('6 bars rendered', bars().length === 6, `got ${bars().length}`);
    check('3 lane labels', laneLabels().length === 3, `got ${laneLabels().length}`);
    const widths = bars().map((b) => Number(b.getAttribute('width')));
    check('all bars have positive width', widths.every((v) => v > 0), widths.join(','));
    // db-01 の 3600秒バーが最長になるはず
    check('longest bar is the 3600s span', Math.max(...widths) > 300, `max=${Math.max(...widths)}`);
}

// ---- 2. レーンの並び順（件数の多い順） ---------------------------------------
console.log('\n[2] lanes sorted by event count');
{
    const texts = laneLabels().map((t) => t.textContent);
    // web-01=2, web-02=2, db-01=2 → 同数なので名前順（db-01, web-01, web-02）
    check('lane labels include counts', texts.every((t) => /\(\d+\)/.test(t)), texts.join(' | '));
    check('first lane is db-01 (tie broken by name)', texts[0].startsWith('db-01'), texts.join(' | '));
}

// ---- 3. 分類の色分けと凡例 ---------------------------------------------------
console.log('\n[3] category colors and legend');
{
    check('3 legend items (login/query/error)', legendItems().length === 3, `got ${legendItems().length}`);
    const fills = new Set(bars().map((b) => b.getAttribute('fill')));
    check('3 distinct bar colors', fills.size === 3, Array.from(fills).join(','));
    check('uses palette color1 for first category', fills.has('#4c9be8'), Array.from(fills).join(','));
}

// ---- 4. 色オプションの反映 ---------------------------------------------------
console.log('\n[4] palette options apply');
{
    await setOpts({ animate: false, color1: '#ff0000' });
    const fills = new Set(bars().map((b) => b.getAttribute('fill')));
    check('color1 override applied', fills.has('#ff0000'), Array.from(fills).join(','));
    await setOpts({ animate: false });
}

// ---- 5. 点イベント（終了列なし） ---------------------------------------------
console.log('\n[5] point events (no end field)');
{
    await setData(POINTS);
    check('3 bars for 3 point events', bars().length === 3, `got ${bars().length}`);
    const widths = bars().map((b) => Number(b.getAttribute('width')));
    check('point events use minBarWidth (3px)', widths.every((v) => v === 3), widths.join(','));
    check('2 lanes', laneLabels().length === 2, `got ${laneLabels().length}`);
}

// ---- 6. ISO 文字列の時刻 -----------------------------------------------------
console.log('\n[6] ISO datetime strings parsed');
{
    await setData(ISO);
    check('2 bars from ISO times', bars().length === 2, `got ${bars().length}`);
    const widths = bars().map((b) => Number(b.getAttribute('width')));
    check('ISO spans have real width', widths.every((v) => v > 5), widths.join(','));
    // h2 は 25分、h1 は 10分 → h2 が広い
    check('longer ISO span is wider', widths[1] > widths[0], widths.join(','));
}

// ---- 7. 時間軸の目盛り -------------------------------------------------------
console.log('\n[7] time axis ticks');
{
    await setData(SPANS);
    check('ticks rendered', ticks().length >= 2, `got ${ticks().length}`);
    check('tick labels look like HH:MM', ticks().every((t) => /^\d{2}:\d{2}$/.test(t.textContent)),
        ticks().map((t) => t.textContent).join(','));

    await setOpts({ animate: false, showAxis: false });
    check('axis hidden when disabled', ticks().length === 0, `got ${ticks().length}`);
    await setOpts({ animate: false });
}

// ---- 8. ブラシ（時間範囲の絞り込み） -----------------------------------------
console.log('\n[8] brush time-range selection');
{
    await setData(SPANS);
    const before = bars().length;
    const svg = doc.querySelector('svg');
    // React の state 反映を挟まないと mousemove 時点で drag が null のままになる
    svg.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 300, button: 0 }));
    await sleep(60);
    svg.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 500, button: 0 }));
    await sleep(60);
    check('brush rect visible while dragging', q('rect[data-role="tl-brush"]').length === 1);
    svg.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, clientX: 500, button: 0 }));
    await sleep(300);

    check('setOptions called with brush range', lastSetOptions
        && Number.isFinite(lastSetOptions.brushStart) && Number.isFinite(lastSetOptions.brushEnd),
        JSON.stringify(lastSetOptions));
    check('brushStart < brushEnd', lastSetOptions && lastSetOptions.brushStart < lastSetOptions.brushEnd);
    check('zoom notice shown', doc.body.textContent.includes('絞り込み中'), doc.body.textContent.slice(0, 100));
    check('fewer or equal bars after zoom', bars().length <= before, `${bars().length} vs ${before}`);

    // ダブルクリックで解除
    svg.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    await sleep(300);
    check('brush cleared on double click', lastSetOptions && lastSetOptions.brushStart === null,
        JSON.stringify(lastSetOptions));
    check('all bars back', bars().length === 6, `got ${bars().length}`);
}

// ---- 9. ブラシ無効時はドラッグしても選択されない -----------------------------
console.log('\n[9] brush disabled');
{
    await setOpts({ animate: false, enableBrush: false });
    lastSetOptions = null;
    const svg = doc.querySelector('svg');
    svg.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 300, button: 0 }));
    await sleep(60);
    check('no brush rect when disabled', q('rect[data-role="tl-brush"]').length === 0);
    svg.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 500, button: 0 }));
    await sleep(60);
    svg.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, clientX: 500, button: 0 }));
    await sleep(250);
    check('no setOptions when brush disabled', lastSetOptions === null, JSON.stringify(lastSetOptions));
    await setOpts({ animate: false });
}

// ---- 9b. スクラブ用クロスヘア -------------------------------------------------
console.log('\n[9b] scrub crosshair');
{
    await setData(SPANS);
    await setOpts({ animate: false });
    const svg = doc.querySelector('svg');
    const crosshair = () => q('line[data-role="tl-crosshair"]');
    const chip = () => q('[data-role="tl-crosshair-chip"]');

    // 前セクションのマウス操作が残っている可能性があるので一度退出させる
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(120);
    check('no crosshair before hover', crosshair().length === 0, `got ${crosshair().length}`);

    svg.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 400 }));
    await sleep(120);
    check('crosshair appears on hover', crosshair().length === 1, `got ${crosshair().length}`);
    check('crosshair sits at cursor x', crosshair()[0] && Math.abs(Number(crosshair()[0].getAttribute('x1')) - 400) < 1,
        crosshair()[0] && crosshair()[0].getAttribute('x1'));
    check('time chip rendered', chip().length === 1, `got ${chip().length}`);

    // 交差したバーだけ data-hit=1 になり、他は薄くなる
    const hits = bars().filter((b) => b.getAttribute('data-hit') === '1');
    const misses = bars().filter((b) => b.getAttribute('data-hit') === '0');
    check('some bars marked as hit', hits.length > 0, `hits=${hits.length}`);
    check('non-hit bars are dimmed', misses.every((b) => Number(b.getAttribute('opacity')) < 0.5),
        misses.map((b) => b.getAttribute('opacity')).join(','));
    check('hit bars stay at full opacity', hits.every((b) => Math.abs(Number(b.getAttribute('opacity')) - 0.9) < 1e-6),
        hits.map((b) => b.getAttribute('opacity')).join(','));
    check('scrub count readout shown', doc.body.textContent.includes('件'), doc.body.textContent.slice(-60));

    // 離れたら元に戻る
    // React はルートで委譲するため、バブルする mouseout で退出を再現する
    // （mouseleave はバブルせずルートリスナーに届かない）
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(150);
    check('crosshair cleared on leave', crosshair().length === 0);
    check('all bars back to full opacity', bars().every((b) => Math.abs(Number(b.getAttribute('opacity')) - 0.9) < 1e-6),
        bars().map((b) => b.getAttribute('opacity')).join(','));

    // オプションで無効化できる
    await setOpts({ animate: false, showCrosshair: false });
    svg.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 400 }));
    await sleep(120);
    check('crosshair suppressed when disabled', crosshair().length === 0, `got ${crosshair().length}`);
    // React はルートで委譲するため、バブルする mouseout で退出を再現する
    // （mouseleave はバブルせずルートリスナーに届かない）
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await setOpts({ animate: false });
}

// ---- 10. 表示オプション -------------------------------------------------------
console.log('\n[10] display options');
{
    await setOpts({ animate: false, showLaneLabels: false });
    check('lane labels hidden', laneLabels().length === 0, `got ${laneLabels().length}`);

    await setOpts({ animate: false, showLegend: false });
    check('legend hidden', legendItems().length === 0, `got ${legendItems().length}`);

    check('stripes off by default', q('rect[data-role="tl-lane-stripe"]').length === 0);
    await setOpts({ animate: false, stripeLanes: true });
    check('stripes shown when enabled', q('rect[data-role="tl-lane-stripe"]').length > 0);
    await setOpts({ animate: false });
    check('lane hairline separators drawn', q('line[data-role="tl-lane-sep"]').length === 2,
        `got ${q('line[data-role="tl-lane-sep"]').length}`);

    await setOpts({ animate: false, showGrid: false });
    check('grid hidden', q('line[data-role="tl-grid"]').length === 0);

    await setOpts({ animate: false, barOpacity: 0.5 });
    check('bar opacity applied', bars().every((b) => Number(b.getAttribute('opacity')) === 0.5),
        bars().map((b) => b.getAttribute('opacity')).join(','));

    await setOpts({ animate: false });
}

// ---- 11. バーのラベル ---------------------------------------------------------
console.log('\n[11] bar labels');
{
    await setOpts({ animate: false, showBarLabels: true, autoLaneHeight: false, laneHeight: 40 });
    const labels = q('text[data-role="tl-bar-label"]');
    check('some bar labels rendered', labels.length > 0, `got ${labels.length}`);
    check('labels show the category', labels.some((t) => t.textContent === 'query'),
        labels.map((t) => t.textContent).join(','));
    await setOpts({ animate: false });
}

// ---- 11b. レーン高さの自動フィット --------------------------------------------
console.log('\n[11b] auto lane height fills the panel');
{
    // 縞（レーン背景）の height でレーン高さを測る。stripe は奇数番レーンに出る
    const laneHeightOf = () => {
        const st = doc.querySelector('rect[data-role="tl-lane-stripe"]');
        return st ? Number(st.getAttribute('height')) : NaN;
    };

    // 3レーン(SPANS) / パネル高さ500px → 上限60px に張り付くはず（26px 固定ではない）
    await setData(SPANS);
    await setOpts({ animate: false, stripeLanes: true });
    check('auto height reaches the cap (60px)', Math.abs(laneHeightOf() - 60) < 0.5, `got ${laneHeightOf()}`);

    // 上限を上げると、より広がる（500px を 3 で割った ≒160px 付近）
    await setOpts({ animate: false, stripeLanes: true, laneMaxHeight: 200 });
    const tall = laneHeightOf();
    check('raising the cap widens lanes', tall > 100, `got ${tall}`);
    check('auto height does not exceed available space', tall * 3 <= VH, `${tall}*3 vs ${VH}`);

    // 上限を下げると素直に従う
    await setOpts({ animate: false, stripeLanes: true, laneMaxHeight: 20 });
    check('lowering the cap shrinks lanes', Math.abs(laneHeightOf() - 20) < 0.5, `got ${laneHeightOf()}`);

    // 自動オフなら従来どおり laneHeight 固定
    await setOpts({ animate: false, stripeLanes: true, autoLaneHeight: false, laneHeight: 26 });
    check('manual mode keeps the fixed height', Math.abs(laneHeightOf() - 26) < 0.5, `got ${laneHeightOf()}`);

    // レーンが多いときは自動でも 10px 下限まで詰めてスクロールへ退避する
    const many = {
        fields: [{ name: 'host' }, { name: 'start' }],
        rows: Array.from({ length: 80 }, (_, i) => [`host-${i}`, String(T0 + i * 60)]),
    };
    await setData(many);
    await setOpts({ animate: false, stripeLanes: true, maxLanes: 80 });
    const dense = laneHeightOf();
    check('dense data clamps to the 10px floor', Math.abs(dense - 10) < 0.5, `got ${dense}`);

    await setOpts({ animate: false });
    await setData(SPANS);
}

// ---- 12. レーン上限 -----------------------------------------------------------
console.log('\n[12] lane cap');
{
    const many = {
        fields: [{ name: 'host' }, { name: 'start' }],
        rows: Array.from({ length: 60 }, (_, i) => [`host-${i}`, String(T0 + i * 60)]),
    };
    await setData(many);
    await setOpts({ animate: false, maxLanes: 10 });
    check('lanes capped at 10', laneLabels().length === 10, `got ${laneLabels().length}`);
    check('truncation notice shown', doc.body.textContent.includes('レーン上限'), doc.body.textContent.slice(0, 120));
    await setOpts({ animate: false });
    await setData(SPANS);
}

// ---- 13. 固定表示範囲 ---------------------------------------------------------
console.log('\n[13] fixed range options');
{
    // 09:00 〜 09:20 に固定 → 3600秒バー（09:05開始）は範囲内、09:61〜のバーは範囲外
    await setOpts({ animate: false, rangeStart: '2026-07-25 09:00:00', rangeEnd: '2026-07-25 09:20:00' });
    const n = bars().length;
    check('fewer bars within fixed range', n < 6 && n > 0, `got ${n}`);
    await setOpts({ animate: false });
    check('all bars back after clearing range', bars().length === 6, `got ${bars().length}`);
}

// ---- 14. 時刻を解釈できない行の除外 -------------------------------------------
console.log('\n[14] unparseable time rows skipped');
{
    const mixed = {
        fields: [{ name: 'host' }, { name: 'start' }],
        rows: [
            ['a', String(T0)],
            ['b', String(T0 + 600)],
            ['c', 'not-a-time'],
        ],
    };
    await setData(mixed);
    check('2 bars (bad row dropped)', bars().length === 2, `got ${bars().length}`);
    check('skip notice shown', doc.body.textContent.includes('除外'), doc.body.textContent.slice(0, 120));
}

// ---- 15. テーマ切替 -----------------------------------------------------------
console.log('\n[15] theme switch');
{
    await setData(SPANS);
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const lab = doc.querySelector('text[data-role="tl-lane-label"]');
    check('light-mode lane label color', lab && lab.getAttribute('fill') === '#1e2429', lab && lab.getAttribute('fill'));

    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const labD = doc.querySelector('text[data-role="tl-lane-label"]');
    check('dark-mode lane label color', labD && labD.getAttribute('fill') === '#e3e8ee', labD && labD.getAttribute('fill'));
}

// ---- 16. アニメーション -------------------------------------------------------
console.log('\n[16] fade-in animation completes');
{
    await setOpts({});
    await setData(SPANS);
    await sleep(1200);
    check('bars reach full opacity', bars().every((b) => Math.abs(Number(b.getAttribute('opacity')) - 0.9) < 1e-6),
        bars().map((b) => b.getAttribute('opacity')).join(','));
    await setOpts({ animate: false });
}

// ---- 17. ガード ---------------------------------------------------------------
console.log('\n[17] guards');
{
    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', 'y'], ['p', 'q']] });
    check('no-time message', doc.body.textContent.includes('時刻フィールド'), doc.body.textContent.slice(0, 120));

    await setData(SPANS);
    check('recovers after guard', bars().length === 6, `got ${bars().length}`);
}

// ---- 18. debug オーバーレイ ---------------------------------------------------
console.log('\n[18] debug overlay');
{
    await setOpts({ animate: false, debug: true });
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
    check('version shown', doc.body.textContent.includes('1.2.0'));
    await setOpts({ animate: false });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
