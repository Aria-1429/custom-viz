// Attack Globe viz のローカル検証（happy-dom、Splunk実機なし）
//
// WebGL は happy-dom に無いため getContext('webgl2') をスタブ化して
// 「シェーダに何が渡ったか」を検証する。陸地テクスチャのラスタライズに使う
// getContext('2d') もスタブ化する（描画そのものは実機検証に委ねる）。
//
// 【重点】シェーダ（uLambda/uPhi）と SVG オーバーレイ（アーク・着弾点の射影）は
// 同じ回転・正射影の式を使う必要がある。ここでは式を JS で再現し、
// SVG 要素の実際の座標と照合する（符号の取り違えは初回実装で実際に起きた）。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_attack_globe', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const W = 900;
const H = 500;
const win = new Window({ width: W, height: H });
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// ---- WebGL / 2D canvas スタブ ----------------------------------------------
const gpu = {
    contextAttrs: null,
    shaders: [],
    uniforms: {},
    draws: 0,
    blendFunc: null,
    clearColor: null,
    texImageCalls: 0,
    texSource: null,
};
const tex2d = { fills: 0, strokes: 0, compositeOps: [] };

function makeGLStub() {
    const names = new Map();
    let uid = 0;
    const rec = (n) => {
        if (!names.has(n)) names.set(n, { __u: n, id: uid++ });
        return names.get(n);
    };
    return {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
        ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8,
        COLOR_BUFFER_BIT: 9, BLEND: 10, ONE: 11, ONE_MINUS_SRC_ALPHA: 12,
        TEXTURE_2D: 13, TEXTURE0: 14, RGBA: 15, UNSIGNED_BYTE: 16,
        TEXTURE_MIN_FILTER: 17, TEXTURE_MAG_FILTER: 18,
        TEXTURE_WRAP_S: 19, TEXTURE_WRAP_T: 20, LINEAR: 21,
        LINEAR_MIPMAP_LINEAR: 22, REPEAT: 23, CLAMP_TO_EDGE: 24,
        createShader: () => ({}),
        shaderSource: (_s, src) => { gpu.shaders.push(src); },
        compileShader: () => {},
        getShaderParameter: () => true,
        getShaderInfoLog: () => '',
        deleteShader: () => {},
        createProgram: () => ({}),
        attachShader: () => {},
        linkProgram: () => {},
        getProgramParameter: () => true,
        getProgramInfoLog: () => '',
        useProgram: () => {},
        createBuffer: () => ({}),
        bindBuffer: () => {},
        bufferData: () => {},
        getAttribLocation: () => 0,
        enableVertexAttribArray: () => {},
        vertexAttribPointer: () => {},
        createTexture: () => ({}),
        activeTexture: () => {},
        bindTexture: () => {},
        texImage2D: (...args) => {
            gpu.texImageCalls += 1;
            gpu.texSource = args[args.length - 1];
        },
        texParameteri: () => {},
        generateMipmap: () => {},
        getUniformLocation: (_p, n) => rec(n),
        uniform1i: (l, v) => { gpu.uniforms[l.__u] = v; },
        uniform1f: (l, v) => { gpu.uniforms[l.__u] = v; },
        uniform2f: (l, a, b) => { gpu.uniforms[l.__u] = [a, b]; },
        uniform3f: (l, a, b, c) => { gpu.uniforms[l.__u] = [a, b, c]; },
        enable: () => {},
        blendFunc: (a, b) => { gpu.blendFunc = [a, b]; },
        viewport: () => {},
        clearColor: (r, g, b, a) => { gpu.clearColor = [r, g, b, a]; },
        clear: () => {},
        drawArrays: () => { gpu.draws += 1; },
        isContextLost: () => false,
    };
}
// 2D コンテキストはインスタンスごとに記録を持つ（陸地テクスチャ用と彗星用を
// 区別するため）。グローバルの tex2d には合算も残す
function make2DStub() {
    const stub = {
        fills: 0, strokes: 0,
        fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
        _composite: 'source-over',
        get globalCompositeOperation() { return this._composite; },
        set globalCompositeOperation(v) { this._composite = v; tex2d.compositeOps.push(v); },
        clearRect: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        closePath: () => {},
        arc: () => {},
        fill: () => { stub.fills += 1; tex2d.fills += 1; },
        stroke: () => { stub.strokes += 1; tex2d.strokes += 1; },
        setTransform: () => {},
        save: () => {},
        restore: () => {},
    };
    return stub;
}
win.HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2') {
        gpu.contextAttrs = attrs;
        return makeGLStub();
    }
    if (type === '2d') {
        if (!this.__ctx2d) this.__ctx2d = make2DStub();
        return this.__ctx2d;      // 同じ canvas には同じコンテキストを返す（実物と同じ）
    }
    return null;
};

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => W });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => H });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 };
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
const listeners = { dataSources: [], options: [], theme: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

const FIELDS = ['src_lat', 'src_lon', 'dst_lat', 'dst_lon', 'category', 'count', 'src_name', 'dst_name']
    .map((name) => ({ name }));
const ROWS = [
    ['35.7', '139.7', '37.8', '-122.4', 'attack', '120', 'Tokyo', 'SanFrancisco'],
    ['51.5', '-0.1', '35.7', '139.7', 'scan', '40', 'London', 'Tokyo'],
    ['-33.9', '151.2', '52.5', '13.4', 'attack', '8', 'Sydney', 'Berlin'],
];

let state = { data: { fields: FIELDS, rows: ROWS }, options: {}, theme: 'dark' };
const drilldownRegs = [];

globalThis.DashboardExtensionAPI = {
    getDataSources: () => ({ loading: false, dataSources: { primary: { data: state.data } } }),
    addDataSourcesListener: mkListener('dataSources'),
    getOptions: () => ({ options: state.options }),
    setOptions: (o) => { state.options = { ...state.options, ...o }; },
    addOptionsListener: mkListener('options'),
    getTheme: () => ({ theme: state.theme }),
    addThemeListener: mkListener('theme'),
    getDimensions: () => ({ width: W, height: H }),
    addDimensionsListener: () => () => {},
    getMode: () => ({ mode: 'view' }),
    addModeListener: () => () => {},
    getTokens: () => ({}),
    addTokensListener: () => () => {},
    getError: () => null,
    addErrorListener: () => () => {},
    addDrilldownListener: (args) => { drilldownRegs.push(args); },
    triggerDrilldown: () => {},
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));
const setOpts = async (o, ms = 300) => {
    state.options = o;
    fire('options', { options: state.options });
    await sleep(ms);
};
const setData = async (data, ms = 300) => {
    state.data = data;
    fire('dataSources', { loading: false, dataSources: { primary: { data } } });
    await sleep(ms);
};

// ---- 射影の式（visualization.jsx と同じもの。照合に使う） -------------------
const DEG = Math.PI / 180;
function lonLatToVec(lonDeg, latDeg) {
    const lon = lonDeg * DEG;
    const lat = latDeg * DEG;
    const cl = Math.cos(lat);
    return [cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon)];
}
function worldToView(w, lambdaRad, phiRad) {
    const cl = Math.cos(lambdaRad);
    const sl = Math.sin(lambdaRad);
    const x1 = w[0] * cl - w[2] * sl;
    const z1 = w[0] * sl + w[2] * cl;
    const y1 = w[1];
    const cp = Math.cos(phiRad);
    const sp = Math.sin(phiRad);
    return [x1, y1 * cp - z1 * sp, y1 * sp + z1 * cp];
}
function expectScreen(lonDeg, latDeg, centerLon, centerLat, zoom = 1) {
    const v = worldToView(lonLatToVec(lonDeg, latDeg), centerLon * DEG, centerLat * DEG);
    const R = 0.42 * Math.min(W, H) * zoom;
    return {
        x: W / 2 + v[0] * R,
        y: H / 2 - v[1] * R,
        visible: v[2] >= 0 || (v[0] * v[0] + v[1] * v[1]) >= 1,
    };
}

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 初期表示 ------------------------------------------------------------
console.log('\n[1] initial render');
{
    check('canvas rendered', !!doc.querySelector('canvas'));
    check('webgl2 context requested', gpu.contextAttrs !== null);
    check('shader compiled and drawn', gpu.draws > 0, `draws=${gpu.draws}`);
    check('svg overlay rendered', !!doc.querySelector('svg'));
    const paths = doc.querySelectorAll('svg path');
    // 1アーク = ハロー + 芯線 + 当たり判定 の3パス × 3行
    check('3 arcs x 3 paths rendered', paths.length === 9, `paths=${paths.length}`);
    // world-map と同じ質感：ぼかしフィルタ付きハロー＋細い芯線の2本構え
    check('halo paths use gaussian blur filter',
        [...doc.querySelectorAll('svg path[data-agl="halo"]')].every(
            (p) => (p.getAttribute('filter') || '').includes('agl-arc-glow')
        ) && doc.querySelectorAll('svg path[data-agl="halo"]').length === 3);
    check('glow filter defined in defs', !!doc.querySelector('svg filter#agl-arc-glow feGaussianBlur'));
    // 着弾点は放射グラデーションのグロー＋白寄りコアドット
    // （初期状態はカテゴリ色未指定＝全弧フォールバック色1色なので、グラデーションは1つ）
    check('hotspot radial gradients defined (1 per unique color)',
        doc.querySelectorAll('svg radialGradient').length === 1,
        `gradients=${doc.querySelectorAll('svg radialGradient').length}`);
    check('dst glow uses radial gradient fill',
        [...doc.querySelectorAll('svg circle[data-agl="dst-glow"]')].every(
            (c) => (c.getAttribute('fill') || '').startsWith('url(#agl-hot-')
        ));
    const coreFill = doc.querySelector('svg circle[data-agl="dst-core"]')?.getAttribute('fill') || '';
    check('dst core dot is tinted toward white', coreFill.startsWith('rgb('), coreFill);
    check('title rendered', doc.body.textContent.includes('GLOBAL ATTACK GLOBE'));
    check('legend shows categories', doc.body.textContent.includes('attack')
        && doc.body.textContent.includes('scan'));
    check('legend shows total count', doc.body.textContent.includes('168'),
        doc.body.textContent.slice(0, 200));
}

// ---- 2. 陸地テクスチャ ------------------------------------------------------
console.log('\n[2] land texture rasterization');
{
    check('texture uploaded to GPU', gpu.texImageCalls > 0, `calls=${gpu.texImageCalls}`);
    check('land polygons filled (R channel)', tex2d.fills > 0, `fills=${tex2d.fills}`);
    check('borders stroked (G channel)', tex2d.strokes > 0, `strokes=${tex2d.strokes}`);
    check('borders drawn additively (lighter)', tex2d.compositeOps.includes('lighter'),
        JSON.stringify(tex2d.compositeOps));
}

// ---- 3. シェーダとオーバーレイの射影が一致すること --------------------------
console.log('\n[3] projection consistency (shader vs SVG overlay)');
{
    // 中心（経度135・緯度35）を指定 → uLambda/uPhi はその弧度法の値になる。
    // 自転していると座標がずれるので、この節は rotatePeriod: 0 で固定する
    await setOpts({ centerLon: 135, centerLat: 35, rotatePeriod: 0 });
    await sleep(150);
    check('uLambda = centerLon in radians', Math.abs(gpu.uniforms.uLambda - 135 * DEG) < 1e-6,
        `got ${gpu.uniforms.uLambda}`);
    check('uPhi = centerLat in radians', Math.abs(gpu.uniforms.uPhi - 35 * DEG) < 1e-6,
        `got ${gpu.uniforms.uPhi}`);

    // 【符号の回帰防止】中心に指定した地点は画面中央に来る。
    // 宛先＝中心と一致するデータを与え、着弾点の cx/cy を照合する
    await setData({
        fields: FIELDS,
        rows: [['0', '0', '35', '135', 'attack', '10', 'S', 'D']],
    });
    await setOpts({ centerLon: 135, centerLat: 35, rotatePeriod: 0 });
    await sleep(200);
    const dots = [...doc.querySelectorAll('svg circle[data-agl="dst-core"]')];
    check('destination dot exists', dots.length === 1, `dots=${dots.length}`);
    if (dots.length === 1) {
        const cx = Number(dots[0].getAttribute('cx'));
        const cy = Number(dots[0].getAttribute('cy'));
        check('center point projects to screen center',
            Math.abs(cx - W / 2) < 0.5 && Math.abs(cy - H / 2) < 0.5,
            `got (${cx}, ${cy}) want (${W / 2}, ${H / 2})`);
    }

    // 中心以外の点も式どおりの位置に出る（経度90東・赤道、中心0/0）
    await setData({
        fields: FIELDS,
        rows: [['0', '0', '0', '90', 'attack', '10', 'S', 'D']],
    });
    await setOpts({ centerLon: 0, centerLat: 0, rotatePeriod: 0 });
    await sleep(200);
    const dots2 = [...doc.querySelectorAll('svg circle[data-agl="dst-core"]')];
    if (dots2.length === 1) {
        const want = expectScreen(90, 0, 0, 0);
        const cx = Number(dots2[0].getAttribute('cx'));
        const cy = Number(dots2[0].getAttribute('cy'));
        check('east-90 point matches formula',
            Math.abs(cx - want.x) < 0.5 && Math.abs(cy - want.y) < 0.5,
            `got (${cx},${cy}) want (${want.x.toFixed(1)},${want.y.toFixed(1)})`);
    } else {
        check('east-90 point rendered', false, `dots=${dots2.length}`);
    }

    // 裏側の点は隠れる（経度180 は中心0から見て球の真裏）
    await setData({
        fields: FIELDS,
        rows: [['0', '0', '0', '180', 'attack', '10', 'S', 'D']],
    });
    await setOpts({ centerLon: 0, centerLat: 0, rotatePeriod: 0 });
    await sleep(250);
    const dots3 = [...doc.querySelectorAll('svg circle[data-agl="dst-core"]')];
    if (dots3.length === 1) {
        check('far-side point is hidden (opacity 0)',
            dots3[0].getAttribute('opacity') === '0',
            `opacity=${dots3[0].getAttribute('opacity')}`);
    } else {
        check('far-side point rendered', false, `dots=${dots3.length}`);
    }

    // アークの始端は src の射影位置から始まる
    await setData({
        fields: FIELDS,
        rows: [['0', '0', '0', '90', 'attack', '10', 'S', 'D']],
    });
    await setOpts({ centerLon: 0, centerLat: 0, rotatePeriod: 0 });
    await sleep(250);
    const mainPath = doc.querySelector('svg path[data-agl="core"]');
    const d = mainPath?.getAttribute('d') || '';
    const m = d.match(/^M([0-9.-]+),([0-9.-]+)/);
    check('arc starts at src projection', m
        && Math.abs(Number(m[1]) - W / 2) < 0.5 && Math.abs(Number(m[2]) - H / 2) < 0.5,
        d.slice(0, 40));
    check('arc path has segments', (d.match(/L/g) || []).length > 20, `L count=${(d.match(/L/g) || []).length}`);
}

// ---- 4. 色分け --------------------------------------------------------------
console.log('\n[4] coloring');
{
    // カテゴリモード：「カテゴリ名|色」の明示指定＋フォールバック
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({
        colorMode: 'category',
        categoryColors: ['attack|#ff0000', 'scan|#00ff00'],
        fallbackColor: '#0000ff',
    });
    const strokes = [...doc.querySelectorAll('svg path[data-agl="core"]')]
        .map((p) => p.getAttribute('stroke'));
    check('category color applied (attack)', strokes.includes('#ff0000'), JSON.stringify(strokes));
    check('category color applied (scan)', strokes.includes('#00ff00'), JSON.stringify(strokes));
    // 色の数だけホットスポットのグラデーションが増える
    check('one radial gradient per unique color',
        doc.querySelectorAll('svg radialGradient').length === 2,
        `gradients=${doc.querySelectorAll('svg radialGradient').length}`);

    // 未登録カテゴリはフォールバック色
    await setData({
        fields: FIELDS,
        rows: [['0', '0', '10', '10', 'unknown-cat', '5', 'S', 'D']],
    });
    await sleep(200);
    const stroke2 = doc.querySelector('svg path[data-agl="core"]')?.getAttribute('stroke');
    check('unmapped category falls back', stroke2 === '#0000ff', String(stroke2));

    // 件数しきい値モード：下限以上・上限未満
    const bands = [
        { from: null, to: 10, value: '#00ff00' },
        { from: 10, to: 100, value: '#ffff00' },
        { from: 100, to: null, value: '#ff0000' },
    ];
    const strokeForCount = async (count) => {
        await setData({
            fields: FIELDS,
            rows: [['0', '0', '10', '10', 'x', String(count), 'S', 'D']],
        }, 200);
        await setOpts({ colorMode: 'count', countThresholds: bands }, 200);
        return doc.querySelector('svg path[data-agl="core"]')?.getAttribute('stroke');
    };
    check('count 5 -> green (<10)', await strokeForCount(5) === '#00ff00');
    check('count 10 -> yellow (boundary joins upper)', await strokeForCount(10) === '#ffff00');
    check('count 99 -> yellow', await strokeForCount(99) === '#ffff00');
    check('count 100 -> red (boundary joins upper)', await strokeForCount(100) === '#ff0000');
}

// ---- 5. maxArcs と凡例の件数 ------------------------------------------------
console.log('\n[5] maxArcs cap and legend totals');
{
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ maxArcs: 2 });
    const mains = [...doc.querySelectorAll('svg path[data-agl="core"]')];
    check('only top-2 arcs drawn', mains.length === 2, `mains=${mains.length}`);
    check('legend shows shown/total', doc.body.textContent.includes('表示 160 / 全 168 件'),
        doc.body.textContent.slice(0, 260));

    await setOpts({ maxArcs: 0 });
    const mains2 = [...doc.querySelectorAll('svg path[data-agl="core"]')];
    check('maxArcs=0 draws all', mains2.length === 3, `mains=${mains2.length}`);
    check('legend shows plain total', doc.body.textContent.includes('全 168 件'));
}

// ---- 6. オプションがシェーダへ届くこと --------------------------------------
console.log('\n[6] options reach the shader');
{
    await setOpts({ showGraticule: false, showBorders: false, atmosphere: 1.5, shadeMode: 'daynight' });
    check('graticule off -> uGraticule 0', gpu.uniforms.uGraticule === 0, `got ${gpu.uniforms.uGraticule}`);
    check('borders off -> uBorders 0', gpu.uniforms.uBorders === 0, `got ${gpu.uniforms.uBorders}`);
    check('atmosphere -> uAtmosphere', Math.abs(gpu.uniforms.uAtmosphere - 1.5) < 1e-6,
        `got ${gpu.uniforms.uAtmosphere}`);
    check('daynight -> uShadeMode 2', gpu.uniforms.uShadeMode === 2, `got ${gpu.uniforms.uShadeMode}`);

    await setOpts({ shadeMode: 'flat', landColor: '#ff0000', oceanColor: '#0000ff' });
    check('flat -> uShadeMode 0', gpu.uniforms.uShadeMode === 0, `got ${gpu.uniforms.uShadeMode}`);
    const lc = gpu.uniforms.uLandColor?.map((v) => Math.round(v * 255)).join(',');
    const oc = gpu.uniforms.uOceanColor?.map((v) => Math.round(v * 255)).join(',');
    check('custom land color', lc === '255,0,0', lc);
    check('custom ocean color', oc === '0,0,255', oc);

    // ズーム初期値は uRadius に効く（dpr=1 なので radius = 0.42*min(W,H)*zoom）
    await setOpts({ initialZoom: 2 });
    check('initialZoom scales uRadius', Math.abs(gpu.uniforms.uRadius - 0.42 * H * 2) < 0.5,
        `got ${gpu.uniforms.uRadius} want ${0.42 * H * 2}`);
    await setOpts({});
}

// ---- 7. 透過3点セット --------------------------------------------------------
console.log('\n[7] transparent background');
{
    check('canvas requests alpha:true', gpu.contextAttrs?.alpha === true,
        JSON.stringify(gpu.contextAttrs));
    check('premultipliedAlpha enabled', gpu.contextAttrs?.premultipliedAlpha === true);
    check('clearColor fully transparent', JSON.stringify(gpu.clearColor) === '[0,0,0,0]',
        JSON.stringify(gpu.clearColor));
    check('premultiplied blend func', JSON.stringify(gpu.blendFunc) === '[11,12]',
        JSON.stringify(gpu.blendFunc));

    // 既定は不透過（テーマ背景色で塗る）
    check('default is opaque (uBgAlpha=1)', gpu.uniforms.uBgAlpha === 1, `got ${gpu.uniforms.uBgAlpha}`);
    const darkBg = gpu.uniforms.uBgColor;
    check('dark theme background is dark', darkBg && darkBg[0] < 0.2, JSON.stringify(darkBg));

    await setOpts({ transparentBg: true });
    check('transparent -> uBgAlpha 0', gpu.uniforms.uBgAlpha === 0, `got ${gpu.uniforms.uBgAlpha}`);
    const host = doc.querySelector('canvas')?.parentElement;
    const bg = host?.getAttribute('style') || '';
    check('container background is transparent', /background:\s*transparent/.test(bg), bg.slice(0, 120));

    // ライトテーマの背景は明るい
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await setOpts({ transparentBg: false });
    const lightBg = gpu.uniforms.uBgColor;
    check('light theme background is bright', lightBg && lightBg[0] > 0.5, JSON.stringify(lightBg));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await setOpts({});
}

// ---- 8. 自転とアニメーション ------------------------------------------------
console.log('\n[8] rotation and flow animation');
{
    // rotatePeriod を短くして uLambda が進むこと（起動から2.5秒は待機するので待つ）
    await setOpts({ rotatePeriod: 2 });
    await sleep(2700);
    const l1 = gpu.uniforms.uLambda;
    await sleep(400);
    const l2 = gpu.uniforms.uLambda;
    check('auto-rotation advances uLambda', l2 > l1, `${l1} -> ${l2}`);

    // rotatePeriod=0 で自転停止
    await setOpts({ rotatePeriod: 0 });
    await sleep(200);
    const l3 = gpu.uniforms.uLambda;
    await sleep(300);
    const l4 = gpu.uniforms.uLambda;
    check('rotatePeriod=0 stops rotation', Math.abs(l4 - l3) < 1e-9, `${l3} -> ${l4}`);

    // 光の帯（彗星）は 2D canvas に描かれる（world-map の ArcFlowCanvas と同方式）。
    // DOM 上の canvas は WebGL（球）と 2D（彗星）の2枚
    const canvases = [...doc.querySelectorAll('canvas')];
    check('two canvases (globe + comet)', canvases.length === 2, `canvases=${canvases.length}`);
    const flowCanvas = canvases.find((c) => c.__ctx2d);
    check('comet canvas has a 2d context', !!flowCanvas);
    const flowCtx = flowCanvas?.__ctx2d;

    // flowPeriod>0 なら毎フレーム塗りが進む（グロー＋芯の2回塗り/弧）
    await setOpts({ flowPeriod: 3 });
    await sleep(250);
    const f1 = flowCtx ? flowCtx.fills : 0;
    await sleep(300);
    const f2 = flowCtx ? flowCtx.fills : 0;
    check('comet keeps painting while flowPeriod>0', f2 > f1, `${f1} -> ${f2}`);

    // flowPeriod=0 で彗星の塗りが止まる（rAF は回るが drawFlow を呼ばない）
    await setOpts({ flowPeriod: 0 });
    await sleep(300);
    const f3 = flowCtx ? flowCtx.fills : 0;
    await sleep(300);
    const f4 = flowCtx ? flowCtx.fills : 0;
    check('flowPeriod=0 stops comet painting', f4 === f3, `${f3} -> ${f4}`);
    await setOpts({});
}

// ---- 9. フィールド選択（columnSelector / DOS 文字列） -----------------------
console.log('\n[9] field selection via columnSelector');
{
    await setData({
        fields: ['a', 'b', 'c', 'd', 'kind', 'n'].map((name) => ({ name })),
        rows: [['10', '20', '30', '40', 'X', '7']],
    });
    // 候補名に一致しない列名 → 明示指定が必要
    check('unknown columns show guidance', doc.body.textContent.includes('必須フィールドが見つかりません'),
        doc.body.textContent.slice(0, 160));

    await setOpts({
        srcLatField: "> primary | seriesByName('a')",
        srcLonField: "> primary | seriesByName('b')",
        dstLatField: "> primary | seriesByName('c')",
        dstLonField: "> primary | seriesByName('d')",
        categoryField: "> primary | seriesByName('kind')",
        countField: "> primary | seriesByName('n')",
    });
    const mains = [...doc.querySelectorAll('svg path[data-agl="core"]')];
    check('DOS strings resolve all columns', mains.length === 1, `mains=${mains.length}`);
    check('category from selected column', doc.body.textContent.includes('X'),
        doc.body.textContent.slice(0, 160));
    check('count from selected column', doc.body.textContent.includes('全 7 件'),
        doc.body.textContent.slice(0, 200));
    await setOpts({});
}

// ---- 10. 堅牢性 -------------------------------------------------------------
console.log('\n[10] robustness');
{
    // 空データ
    await setData({ fields: FIELDS, rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'),
        doc.body.textContent.slice(0, 80));

    // 座標として不正な行は捨てる（緯度 > 90）
    await setData({
        fields: FIELDS,
        rows: [
            ['95', '0', '0', '0', 'x', '1', 'S', 'D'],
            ['10', '10', '20', '20', 'x', '1', 'S', 'D'],
        ],
    });
    const mains = [...doc.querySelectorAll('svg path[data-agl="core"]')];
    check('invalid latitude row dropped', mains.length === 1, `mains=${mains.length}`);

    // 全行不正なら空メッセージ
    await setData({
        fields: FIELDS,
        rows: [['abc', 'def', 'x', 'y', 'x', '1', 'S', 'D']],
    });
    check('all-invalid rows -> message', doc.body.textContent.includes('データがありません'),
        doc.body.textContent.slice(0, 100));

    // columns 形式
    await setData({
        fields: FIELDS,
        columns: [
            ['10', '20'], ['10', '20'], ['30', '40'], ['30', '40'],
            ['x', 'y'], ['1', '2'], ['S', 'S2'], ['D', 'D2'],
        ],
    });
    const mains2 = [...doc.querySelectorAll('svg path[data-agl="core"]')];
    check('columns format renders', mains2.length === 2, `mains=${mains2.length}`);

    // 経度の正規化（185 → -175 相当。範囲内に収まって描画される）
    await setData({
        fields: FIELDS,
        rows: [['0', '185', '10', '10', 'x', '1', 'S', 'D']],
    });
    const mains3 = [...doc.querySelectorAll('svg path[data-agl="core"]')];
    check('longitude wraps to -180..180', mains3.length === 1, `mains=${mains3.length}`);

    // 壊れたオプションでも落ちない
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({
        countThresholds: 'garbage', categoryColors: 'garbage',
        centerLon: 'x', initialZoom: null, maxArcs: -5, textureSize: '9999',
    });
    check('survives malformed options', !!doc.querySelector('canvas'));
    check('draws continue', gpu.draws > 0);
    await setOpts({});
}

// ---- 11. ドリルダウン登録 ---------------------------------------------------
// 登録は「ノードごとに1回」（WeakSet ガード）なので、累積の drilldownRegs を見る。
console.log('\n[11] drilldown registration');
{
    await setData({ fields: FIELDS, rows: ROWS });
    await sleep(250);
    const linkRegs = drilldownRegs.filter((r) => r.action === 'link.click');
    const pointRegs = drilldownRegs.filter((r) => r.action === 'point.click');
    check('arc hit paths registered (link.click)', linkRegs.length >= 3, `got ${linkRegs.length}`);
    check('destination dots registered (point.click)', pointRegs.length >= 3, `got ${pointRegs.length}`);
    // 現在 DOM に居るノードの登録を探す（古い登録が混ざっていても正しく引ける）
    const liveHit = [...doc.querySelectorAll('svg path')].find(
        (p) => p.getAttribute('stroke') === 'transparent'
    );
    const liveReg = linkRegs.filter((r) => r.node === liveHit).pop();
    const payload = liveReg?.payloadCallback ? liveReg.payloadCallback() : null;
    check('payload carries row fields',
        payload && 'row.src_lat.value' in payload && 'row.dst_lon.value' in payload
        && 'row.category.value' in payload && 'row.count.value' in payload,
        JSON.stringify(payload));
    check('payload name/value set', payload && payload.name === 'category'
        && typeof payload.value === 'string', JSON.stringify(payload));

    // 【古い値の回帰防止】同じ形のデータで中身だけ変えると React は DOM ノードを
    // 再利用する。登録済みノードの payload が「最新のデータ」を返すこと
    const changed = ROWS.map((r) => r.slice());
    changed[0][4] = 'freshly-changed';
    await setData({ fields: FIELDS, rows: changed });
    await sleep(250);
    const payloads = drilldownRegs
        .filter((r) => r.action === 'link.click' && doc.contains(r.node))
        .map((r) => r.payloadCallback());
    check('payload reflects updated data (not the closure at registration)',
        payloads.some((p) => p['row.category.value'] === 'freshly-changed'),
        JSON.stringify(payloads.map((p) => p['row.category.value'])));

    // オプション変更で同じノードを二重登録しない
    const before = drilldownRegs.length;
    await setOpts({ atmosphere: 0.5 });
    await sleep(200);
    check('no duplicate registration on option change', drilldownRegs.length === before,
        `${before} -> ${drilldownRegs.length}`);
    await setOpts({});
}

// ---- 12. シェーダ本体の健全性 -----------------------------------------------
console.log('\n[12] shader source sanity');
{
    const frag = gpu.shaders.find((s) => s.includes('outColor'));
    check('fragment shader bundled', !!frag);
    check('uses GLSL ES 3.00', frag.includes('#version 300 es'));
    check('samples land texture', frag.includes('texture(uTex'), '');
    check('has fresnel atmosphere rim', frag.includes('pow(1.0 - z'), '');
    check('has day/night terminator', frag.includes('uSunLon'), '');
    check('outputs premultiplied alpha', frag.includes('* alpha, alpha'), '');
    // 日付変更線対策：経緯線の fwidth を clamp していること
    const fragCode = frag.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    check('graticule fwidth is clamped [日付変更線の帯の回帰防止]',
        /min\(fwidth\(lonDeg\)/.test(fragCode), '');
    // シェーダの逆回転（w = Ry(λ)·Rx(-φ)·v）が JS の順回転と互いに逆であること
    // （式の存在確認。数値の一致は [3] で SVG 座標により検証済み）
    check('shader applies Rx then Ry inverse rotation',
        /v\.y \* cp \+ v\.z \* sp/.test(fragCode) && /t\.x \* cl \+ t\.z \* sl/.test(fragCode), '');
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
