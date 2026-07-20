// Network Graph viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_network_graph', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
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
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 4);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// コンテナ実寸を固定（オートフィット系のため）
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 500 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, x: 0, y: 0 };
};

// ResizeObserver 簡易モック（observe 時に即 callback）
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

const FIELDS3 = [{ name: 'src' }, { name: 'dest' }, { name: 'bytes' }];
const ROWS3 = [
    ['Internet', 'Firewall', '5,200'],   // カンマ付き数値の正規化を検証
    ['Internet', 'Firewall', '800'],     // 重複ペア → 合算で 6000
    ['Internet', 'VPN', '1400'],
    ['Firewall', 'Web-01', '3600'],
    ['Firewall', 'App-01', '1500'],
    ['VPN', 'App-01', '900'],
    ['Web-01', 'DB-01', '2100'],
    ['App-01', 'DB-01', '1700'],
    ['App-01', 'App-01', '50'],          // 自己ループ → 除去
    ['Ghost', '', '10'],                 // 空カテゴリ → 除去
    ['Ghost', 'X', 'abc'],               // 非数値 → 除去
    ['Ghost', 'X', '-5'],                // 0以下 → 除去
];
// 有効リンク7本 / ノード6 / 総流量 17,200

let state = {
    data: { fields: FIELDS3, rows: ROWS3 },
    options: {},
    theme: 'dark',
};

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({
        loading: false,
        dataSources: { primary: { data: state.data } },
    }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...state.options, ...o }; },
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

const finiteTranslate = (el) => {
    const m = /translate\(([-\d.eE]+),([-\d.eE]+)\)/.exec(el.getAttribute('transform') || '');
    return !!m && Number.isFinite(Number(m[1])) && Number.isFinite(Number(m[2]));
};

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(500);

// ---- 1. 基本描画（3列・darkテーマ・既定オプション） --------------------------
console.log('\n[1] basic render (3 cols, dark theme, defaults)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    const nodes = [...doc.querySelectorAll('circle.ng-node')];
    check('6 node circles', nodes.length === 6, `got ${nodes.length}`);
    const edges = [...doc.querySelectorAll('path.ng-edge')];
    check('7 edge paths (dup aggregated, junk dropped)', edges.length === 7, `got ${edges.length}`);
    const arrows = [...doc.querySelectorAll('polygon.ng-arrow')];
    check('7 direction arrows', arrows.length === 7, `got ${arrows.length}`);
    check('edges have finite d', edges.every((e) => /^M [-\d.eE]+ [-\d.eE]+ Q/.test(e.getAttribute('d') || '')),
        edges[0] && edges[0].getAttribute('d'));
    check('edge stroke-opacity 0.55 (default)', edges.every(
        (e) => Math.abs(parseFloat(e.getAttribute('stroke-opacity')) - 0.55) < 1e-6
    ));
    const nodeGs = nodes.map((c) => c.parentElement);
    check('node groups positioned (finite transform)', nodeGs.every(finiteTranslate));
    // 重なり回避：全ノードペアの最小間隔が半径合計を超える（円が重ならない）ことを確認
    const posOf = (g) => {
        const m = /translate\(([-\d.eE]+),([-\d.eE]+)\)/.exec(g.getAttribute('transform') || '');
        return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };
    const pts = nodes.map((c, i) => ({ p: posOf(nodeGs[i]), r: parseFloat(c.getAttribute('r')) }));
    let minGap = Infinity;
    for (let a = 0; a < pts.length; a += 1) {
        for (let b = a + 1; b < pts.length; b += 1) {
            const d = Math.hypot(pts[a].p.x - pts[b].p.x, pts[a].p.y - pts[b].p.y);
            minGap = Math.min(minGap, d - (pts[a].r + pts[b].r));
        }
    }
    check('nodes do not overlap (min gap > 0)', minGap > 0, `minGap=${minGap.toFixed(1)}`);
    const halos = [...doc.querySelectorAll('circle.ng-halo')];
    check('glow halos in dark theme', halos.length === 6, `got ${halos.length}`);
    const labels = [...doc.querySelectorAll('text.ng-label')].map((t) => t.textContent);
    check('labels include Internet', labels.some((t) => t.includes('Internet')));
    check('labels include DB-01', labels.some((t) => t.includes('DB-01')));
    const header = doc.body.textContent;
    check('header: 6 nodes · 7 links', header.includes('6 nodes') && header.includes('7 links'), header.slice(0, 200));
    check('header: total 17,200', header.includes('17,200'), header.slice(0, 200));
    check('header notes self-loop', header.includes('1 self-loop'));
    check('header notes invalid rows', header.includes('3 invalid rows'));
    const flows = [...doc.querySelectorAll('path.ng-flow')];
    check('7 flow overlay paths (one per edge)', flows.length === 7, `got ${flows.length}`);
    check('flow paths share edge d (finite Q curve)', flows.every(
        (f) => /^M [-\d.eE]+ [-\d.eE]+ Q/.test(f.getAttribute('d') || '')
    ), flows[0] && flows[0].getAttribute('d'));
    check('flow paths animate via dasharray/dashoffset', flows.every((f) => {
        const da = f.getAttribute('stroke-dasharray') || '';
        const off = f.getAttribute('stroke-dashoffset');
        return /\d/.test(da) && off !== null && Number.isFinite(parseFloat(off));
    }), flows[0] && `${flows[0].getAttribute('stroke-dasharray')} / ${flows[0].getAttribute('stroke-dashoffset')}`);
    // 矢印は太さ連動の実三角（頂点が原点=ノード縁、4点のチェブロン）
    const arr0 = doc.querySelector('polygon.ng-arrow');
    check('arrow points anchor tip at origin (0,0 first)', arr0 && /^0,0 /.test(arr0.getAttribute('points') || ''),
        arr0 && arr0.getAttribute('points'));
    check('arrow sits on node rim (finite transform)', [...doc.querySelectorAll('polygon.ng-arrow')].every(finiteTranslate));
}

// ---- 2. 値ベースカラースケール ON --------------------------------------------
console.log('\n[2] useValueColors on (low green → high red, no mid)');
{
    state.options = {
        useValueColors: true, useMidColor: false,
        lowColor: '#00ff00', highColor: '#ff0000', edgeOpacity: 80,
    };
    fire('options', { options: state.options });
    await sleep(300);
    const edges = [...doc.querySelectorAll('path.ng-edge')];
    const strokes = edges.map((e) => e.getAttribute('stroke'));
    check('edge strokes are rgb() scale colors', strokes.every((s) => s.startsWith('rgb(')), JSON.stringify(strokes));
    check('max link (6000) is pure red', strokes.includes('rgb(255,0,0)'), JSON.stringify(strokes));
    check('min link (900) is pure green', strokes.includes('rgb(0,255,0)'));
    check('edge opacity updated to 0.8', edges.every(
        (e) => Math.abs(parseFloat(e.getAttribute('stroke-opacity')) - 0.8) < 1e-6
    ));
    const nodeFills = [...doc.querySelectorAll('circle.ng-node')].map((c) => c.getAttribute('fill'));
    check('node fills use scale too', nodeFills.every((f) => f.startsWith('rgb(')), JSON.stringify(nodeFills));
    check('legend gradient bar in header', doc.body.innerHTML.includes('linear-gradient'));
}

// ---- 3. reverse 反転 ---------------------------------------------------------
console.log('\n[3] reverse');
{
    state.options = { ...state.options, reverse: true };
    fire('options', { options: state.options });
    await sleep(300);
    const strokes = [...doc.querySelectorAll('path.ng-edge')].map((e) => e.getAttribute('stroke'));
    const idx = strokes.indexOf('rgb(0,255,0)');
    check('reversed scale applies (a green edge exists)', idx >= 0, JSON.stringify(strokes));
    check('no pure-red-at-max anymore ordering flipped', strokes.filter((s) => s === 'rgb(255,0,0)').length >= 1);
}

// ---- 4. maxNodes キャップ（silent cap にしない） ------------------------------
console.log('\n[4] maxNodes cap');
{
    state.options = { maxNodes: 3 };
    fire('options', { options: state.options });
    await sleep(300);
    const nodes = [...doc.querySelectorAll('circle.ng-node')];
    check('3 nodes kept (top by flow)', nodes.length === 3, `got ${nodes.length}`);
    const edges = [...doc.querySelectorAll('path.ng-edge')];
    check('2 links among kept nodes', edges.length === 2, `got ${edges.length}`);
    const header = doc.body.textContent;
    check('header notes capped nodes', header.includes('3 nodes capped'), header.slice(0, 260));
    check('header notes dropped links', header.includes('links dropped'));
    const labels = [...doc.querySelectorAll('text.ng-label')].map((t) => t.textContent).join(' ');
    check('kept nodes are the biggest hubs', labels.includes('Firewall') && labels.includes('Internet'));
}

// ---- 5. フロー OFF / 矢印 OFF ------------------------------------------------
console.log('\n[5] flow off / arrows off');
{
    state.options = { showFlow: false, showArrows: false };
    fire('options', { options: state.options });
    await sleep(300);
    check('no flow overlay paths', doc.querySelectorAll('path.ng-flow').length === 0);
    check('no arrows', doc.querySelectorAll('polygon.ng-arrow').length === 0);
    check('edges back to 7', doc.querySelectorAll('path.ng-edge').length === 7);
}

// ---- 6. テーマ切替 -----------------------------------------------------------
console.log('\n[6] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(300);
    const text = doc.querySelector('text.ng-label');
    check('label color switches to light-mode text', text && text.getAttribute('fill') === '#31373e',
        text && text.getAttribute('fill'));
    check('no glow halos in light theme', doc.querySelectorAll('circle.ng-halo').length === 0);
}

// ---- 7. ガード ---------------------------------------------------------------
console.log('\n[7] guards');
{
    state.options = {};
    fire('options', { options: state.options });

    state.data = { fields: [{ name: 'a' }], rows: [['x']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('1-col message', doc.body.textContent.includes('at least 2 columns'));

    state.data = { fields: FIELDS3, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('empty data message', doc.body.textContent.includes('No data'));

    state.data = { fields: FIELDS3, rows: [['a', 'a', '5'], ['', 'b', '5'], ['a', 'b', 'xyz']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('no valid links message', doc.body.textContent.includes('No valid network links'));

    // columns 形式でも動く
    state.data = { fields: FIELDS3, columns: [['A', 'B'], ['B', 'C'], ['10', '20']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(350);
    check('columns-form renders 2 edges', doc.querySelectorAll('path.ng-edge').length === 2,
        `got ${doc.querySelectorAll('path.ng-edge').length}`);

    // 2列（値なし）→ 各行 value=1、重複は合算
    state.data = {
        fields: [{ name: 'src' }, { name: 'dest' }],
        rows: [['A', 'B'], ['B', 'C'], ['A', 'B']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(350);
    check('2-col data renders 2 edges (value=1, dup merged)',
        doc.querySelectorAll('path.ng-edge').length === 2,
        `got ${doc.querySelectorAll('path.ng-edge').length}`);
    check('2-col total = 3', doc.body.textContent.includes('total 3'));
}

// ---- 8. debug オーバーレイ ----------------------------------------------------
console.log('\n[8] debug overlay');
{
    state.options = { debug: true };
    fire('options', { options: state.options });
    await sleep(250);
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
}

// ---- 9. 自動フィットカメラ ----------------------------------------------------
console.log('\n[9] auto-fit camera');
{
    await sleep(400); // easing がターゲットに寄るのを待つ
    const world = doc.querySelector('svg > g');
    check('world group exists', !!world);
    const m = /translate\(([-\d.eE]+),([-\d.eE]+)\) scale\(([-\d.eE]+)\)/
        .exec(world ? world.getAttribute('transform') || '' : '');
    check('world transform finite', !!m && [1, 2, 3].every((i) => Number.isFinite(Number(m[i]))),
        world && world.getAttribute('transform'));
    const k = m ? Number(m[3]) : NaN;
    check('fit scale within clamp [0.15, 1.3]', k >= 0.15 - 1e-9 && k <= 1.3 + 1e-9, `k=${k}`);
    check('camera moved from identity (auto-fit engaged)',
        !!m && !(Math.abs(k - 1) < 1e-6 && Math.abs(Number(m[1])) < 1e-6),
        world && world.getAttribute('transform'));
}

// ---- 10. 双方向エッジの分離 & 間隔スケール -----------------------------------
console.log('\n[10] bidirectional edge separation & spacing option');
{
    // A→B と B→A を同時に持たせ、2 本の曲線が反対側へ膨らむ（制御点が離れる）ことを検証
    state.data = { fields: [{ name: 'src' }, { name: 'dest' }, { name: 'v' }],
        rows: [['A', 'B', '10'], ['B', 'A', '10'], ['C', 'D', '5']] };
    state.options = {};
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(500);
    const edges = [...doc.querySelectorAll('path.ng-edge')];
    check('3 edges (A↔B pair + C→D)', edges.length === 3, `got ${edges.length}`);
    const ctrl = edges.slice(0, 2).map((e) => {
        const m = /Q ([-\d.eE]+) ([-\d.eE]+)/.exec(e.getAttribute('d') || '');
        return m ? { cx: Number(m[1]), cy: Number(m[2]) } : null;
    });
    const sep = ctrl[0] && ctrl[1]
        ? Math.hypot(ctrl[0].cx - ctrl[1].cx, ctrl[0].cy - ctrl[1].cy) : 0;
    check('bidirectional arcs bow to opposite sides (control points separated)', sep > 5,
        `sep=${sep.toFixed(1)}`);

    // spacing を上げると bbox が広がり fit scale が小さくなる（＝より縮小して収める）
    const scaleOf = () => {
        const m = /scale\(([-\d.eE]+)\)/.exec(doc.querySelector('svg > g').getAttribute('transform') || '');
        return m ? Number(m[1]) : NaN;
    };
    state.data = {
        fields: [{ name: 'src' }, { name: 'dest' }],
        rows: [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'A'], ['A', 'C']],
    };
    state.options = { spacing: 60 };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    fire('options', { options: state.options });
    await sleep(700);
    const kTight = scaleOf();
    state.options = { spacing: 260 };
    fire('options', { options: state.options });
    await sleep(900);
    const kWide = scaleOf();
    check('wider spacing zooms camera out (kWide < kTight)', kWide < kTight,
        `kTight=${kTight?.toFixed(3)} kWide=${kWide?.toFixed(3)}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
