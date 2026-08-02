// Liquid Tube viz のローカル検証（happy-dom、Splunk実機なし）
//
// WebGL は happy-dom に無いため、**getContext('webgl2') をスタブ化**して
// 「シェーダに何が渡ったか」を記録し、uniform 値の正しさを検証する。
// 描画そのものは実機検証に委ねる
// （結果は .claude/skills/splunk-viz/references/webgl-in-custom-viz.md）。
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_liquid_tube', 'visualization.js'
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.performance = globalThis.performance || { now: () => 0 };

// ---- WebGL スタブ -----------------------------------------------------------
// uniform に渡された値を記録して検証する。
// shaderSource も控えて「シェーダ本体がバンドルされているか」を見る。
const gpu = {
    contextAttrs: null,
    shaders: [],
    uniforms: {},
    draws: 0,
    blendFunc: null,
    clearColor: null,
};
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
        getUniformLocation: (_p, n) => rec(n),
        uniform1i: (l, v) => { gpu.uniforms[l.__u] = v; },
        uniform1f: (l, v) => { gpu.uniforms[l.__u] = v; },
        uniform2f: (l, a, b) => { gpu.uniforms[l.__u] = [a, b]; },
        uniform3f: (l, a, b, c) => { gpu.uniforms[l.__u] = [a, b, c]; },
        uniform1fv: (l, v) => { gpu.uniforms[l.__u] = Array.from(v); },
        uniform3fv: (l, v) => { gpu.uniforms[l.__u] = Array.from(v); },
        enable: () => {},
        blendFunc: (a, b) => { gpu.blendFunc = [a, b]; },
        viewport: () => {},
        clearColor: (r, g, b, a) => { gpu.clearColor = [r, g, b, a]; },
        clear: () => {},
        drawArrays: () => { gpu.draws += 1; },
        isContextLost: () => false,
    };
}
win.HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2') {
        gpu.contextAttrs = attrs;
        return makeGLStub();
    }
    return null;
};

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 900 });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 500 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 500, width: 900, height: 500, x: 0, y: 0 };
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

const FIELDS = ['name', 'value'].map((name) => ({ name }));
const ROWS = [
    ['CPU', '78'],
    ['Memory', '56'],
    ['Storage', '82'],
    ['License', '64'],
    ['Risk', '92'],
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
    getDimensions: () => ({ width: 900, height: 500 }),
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
const setOpts = async (o, ms = 260) => {
    state.options = o;
    fire('options', { options: state.options });
    await sleep(ms);
};

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 初期表示 ------------------------------------------------------------
console.log('\n[1] initial render');
{
    check('canvas rendered', !!doc.querySelector('canvas'));
    check('webgl2 context requested', gpu.contextAttrs !== null);
    check('shader compiled and drawn', gpu.draws > 0, `draws=${gpu.draws}`);
    // 1 viz = 試験管1本。複数行は集計（既定は最終行）で1値に畳む
    const labels = doc.body.textContent;
    check('single tube: last row wins by default', labels.includes('Risk'), labels.slice(0, 80));
    check('value rendered with unit', labels.includes('92%'), labels.slice(0, 80));
    check('other rows are not rendered', !labels.includes('CPU'), labels.slice(0, 80));
}

// ---- 2. 透過（本命の要件） ---------------------------------------------------
console.log('\n[2] transparent background');
{
    // 既定は透過 ON
    check('canvas requests alpha:true', gpu.contextAttrs?.alpha === true,
        JSON.stringify(gpu.contextAttrs));
    check('premultipliedAlpha enabled', gpu.contextAttrs?.premultipliedAlpha === true,
        JSON.stringify(gpu.contextAttrs));
    check('uBgAlpha = 0 when transparent', gpu.uniforms.uBgAlpha === 0,
        `got ${gpu.uniforms.uBgAlpha}`);
    check('clearColor fully transparent', JSON.stringify(gpu.clearColor) === '[0,0,0,0]',
        JSON.stringify(gpu.clearColor));
    check('premultiplied blend func', JSON.stringify(gpu.blendFunc) === '[11,12]',
        JSON.stringify(gpu.blendFunc));
    // コンテナ背景も透明でなければ canvas の透過が無意味になる
    const host = doc.querySelector('canvas')?.parentElement;
    const bg = host?.getAttribute('style') || '';
    check('container background is transparent', /background:\s*transparent/.test(bg),
        bg.slice(0, 120));

    // 透過を OFF にすると背景色が使われる
    await setOpts({ transparentBg: false, bgColor: '#102030' });
    check('uBgAlpha = 1 when opaque', gpu.uniforms.uBgAlpha === 1, `got ${gpu.uniforms.uBgAlpha}`);
    const bg2 = doc.querySelector('canvas')?.parentElement?.getAttribute('style') || '';
    check('container uses bgColor when opaque', bg2.includes('#102030') || /rgb\(16,\s*32,\s*48\)/.test(bg2),
        bg2.slice(0, 120));
    // 背景色を未設定のままにすると、テーマに合わせた色になる。
    // 旧実装は '#03070d'（ほぼ黒）を決め打ちしていたため、ライトテーマでも
    // 背景が黒くなっていた。
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await setOpts({ transparentBg: false });
    const lightBg = doc.querySelector('canvas')?.parentElement?.getAttribute('style') || '';
    check('light theme does not force a black background',
        !/#03070d/.test(lightBg) && !/rgb\(3,\s*7,\s*13\)/.test(lightBg),
        lightBg.slice(0, 140));
    const lightUniform = gpu.uniforms.uBgColor;
    check('light theme background is bright', lightUniform && lightUniform[0] > 0.5,
        JSON.stringify(lightUniform));

    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await setOpts({ transparentBg: false });
    const darkUniform = gpu.uniforms.uBgColor;
    check('dark theme background is dark', darkUniform && darkUniform[0] < 0.2,
        JSON.stringify(darkUniform));

    await setOpts({});
}

// ---- 3. 値 → 液面の高さ -----------------------------------------------------
console.log('\n[3] value maps to liquid level');
{
    state.data = { fields: FIELDS, rows: [['CPU', '78']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({ minValue: 0, maxValue: 100 });
    check('78 -> level 0.78', Math.abs(gpu.uniforms.uLevel - 0.78) < 0.001,
        `got ${gpu.uniforms.uLevel}`);

    // 範囲を変えると液面も変わる
    await setOpts({ minValue: 50, maxValue: 100 });
    check('range 50-100: 78 -> 0.56', Math.abs(gpu.uniforms.uLevel - 0.56) < 0.001,
        `got ${gpu.uniforms.uLevel}`);

    // 範囲外はクランプされる
    await setOpts({ minValue: 80, maxValue: 90 });
    check('below min clamps to 0', gpu.uniforms.uLevel === 0, `got ${gpu.uniforms.uLevel}`);
    await setOpts({ minValue: 0, maxValue: 50 });
    check('above max clamps to 1', gpu.uniforms.uLevel === 1, `got ${gpu.uniforms.uLevel}`);

    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({});
}

// ---- 4. しきい値による色分け ------------------------------------------------
console.log('\n[4] threshold coloring');
{
    const rgb = () => {
        const c = gpu.uniforms.uColor;
        return c.map((v) => Math.round(v * 255)).join(',');
    };
    const bands = [
        { from: null, to: 60, value: '#00ff00' },
        { from: 60, to: 85, value: '#ffff00' },
        { from: 85, to: null, value: '#ff0000' },
    ];
    const withValue = async (v) => {
        state.data = { fields: FIELDS, rows: [['x', String(v)]] };
        fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
        await setOpts({ colorMode: 'threshold', colorBands: bands });
    };
    await withValue(78);
    check('78 -> yellow (60..85)', rgb() === '255,255,0', rgb());
    await withValue(56);
    check('56 -> green (<60)', rgb() === '0,255,0', rgb());
    await withValue(92);
    check('92 -> red (>=85)', rgb() === '255,0,0', rgb());
    // 境界値は「下限以上・上限未満」
    await withValue(60);
    check('exactly 60 -> upper band (yellow)', rgb() === '255,255,0', rgb());
    await withValue(85);
    check('exactly 85 -> upper band (red)', rgb() === '255,0,0', rgb());

    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({});
}

// ---- 4b. 管が画面に収まること（座標系の回帰防止） ---------------------------
// 【回帰防止】uTop/uBottom をクリップ座標(-1..1)で渡すと、シェーダの
// uv 空間（縦 -0.5..0.5 = 幅 1.0）に対して管が 1.87 倍の高さになり、
// 「試験管の途中しか見えない」状態になっていた。
console.log('\n[4b] tube fits inside the viewport');
{
    await setOpts({ showLabel: true, showValue: true, labelSize: 14 });
    const top = gpu.uniforms.uTop;
    const bottom = gpu.uniforms.uBottom;
    // シェーダの uv.y は -0.5 .. +0.5。ここを外れると画面外になる
    check('uTop within uv space (<= 0.5)', top <= 0.5 + 1e-6, `uTop=${top}`);
    check('uBottom within uv space (>= -0.5)', bottom >= -0.5 - 1e-6, `uBottom=${bottom}`);
    check('uTop is above uBottom', top > bottom, `${top} > ${bottom}`);

    // 管の全高（2H + R）が可視範囲 1.0 に収まること。
    // H は shader 側で (span - R)/2 として求まるので、全高 = span になる。
    const span = top - bottom;
    check('tube height fits in the visible 1.0', span <= 1.0 + 1e-6, `span=${span}`);
    // ラベル/値のぶんだけ余白が空いていること（＝管が端まで届いていない）
    check('leaves room for label and value', span < 0.98, `span=${span}`);

    // ラベルを消すと管が縦に伸びるが、それでも収まること
    await setOpts({ showLabel: false, showValue: false });
    const span2 = gpu.uniforms.uTop - gpu.uniforms.uBottom;
    check('still fits with labels hidden', span2 <= 1.0 + 1e-6, `span=${span2}`);
    check('grows when labels are hidden', span2 > span, `${span} -> ${span2}`);

    // 値は管の「下」に置く。DOM 上の位置で重なりを検証する。
    // パネル高 500px 固定（テスト環境の clientHeight）。
    await setOpts({ showLabel: true, showValue: true, labelSize: 14, glow: 1 });
    const H = 500;
    // 管の下端(px) を uv から逆算: uv = 0.5 - py/H  →  py = (0.5 - uv) * H
    const tubeBottomPx = (0.5 - gpu.uniforms.uBottom) * H;
    const valueEl = [...doc.querySelectorAll('div')].find(
        (d) => d.textContent.trim() === '92%' && (d.getAttribute('style') || '').includes('font-weight: 700')
    );
    check('value element rendered', !!valueEl);
    if (valueEl) {
        const st = valueEl.getAttribute('style') || '';
        const topMatch = st.match(/top:\s*([0-9.]+)px/);
        const valueTopPx = topMatch ? Number(topMatch[1]) : -1;
        check('value is placed below the tube [数値は試験管の下]',
            valueTopPx >= tubeBottomPx, `tubeBottom=${tubeBottomPx.toFixed(1)} valueTop=${valueTopPx}`);
        check('value stays inside the panel', valueTopPx < H, `valueTop=${valueTopPx}`);
    }
    // 管の下端はパネル下端から十分に離れている（丸底とグローが切れない）
    check('tube bottom leaves clearance for glow [下が見切れない]',
        H - tubeBottomPx >= 20, `clearance=${(H - tubeBottomPx).toFixed(1)}px`);

    // タイトルと管の隙間が詰まっていること
    const tubeTopPx = (0.5 - gpu.uniforms.uTop) * H;
    const labelBottomPx = 2 + Math.round(14 * 1.35);
    check('small gap between title and tube [タイトルとの余白を詰める]',
        tubeTopPx - labelBottomPx <= 4, `gap=${(tubeTopPx - labelBottomPx).toFixed(1)}px`);
    await setOpts({});
}

// ---- 4c. シェーダが実際に描く管の外形が uTop/uBottom に一致すること ----------
// 【重要】JS が渡す uTop/uBottom だけを見るテストでは不十分。それだけでは
// 「シェーダがその範囲どおりに描いているか」を検証できない。
// 試験管は **上下非対称**（上は平ら / 下は丸底 R が出る）で、さらに外壁の
// 肉厚 WALL が加わるため、対称と仮定して逆算すると span の 1.21 倍に膨らみ、
// 下へはみ出す（800px パネルで 73px。**パネルが大きいほど悪化**）。
//
// シェーダの寸法計算を JS で再現し、外形の上端・下端が指定範囲に収まるか見る。
console.log('\n[4c] shader geometry matches the requested bounds (all panel sizes)');
{
    // シェーダと同じ式（visualization.jsx の main() を参照）
    const shaderBounds = (uTop, uBottom, resW, resH, tubeW) => {
        const halfW = (resW / resH) * 0.5;
        const R = Math.min(tubeW, halfW * 0.82);
        const span = Math.max(uTop - uBottom, 0.05);
        const WALL = Math.max(R * 0.09, 0.004);
        const Hh = Math.max((span - R - 2 * WALL) * 0.5, 0.02);
        const cy = uTop - Hh - WALL;
        return { top: cy + Hh + WALL, bottom: cy - (Hh + R + WALL) };
    };

    // 実際に viz が渡している uTop/uBottom を使い、複数のパネル寸法で確かめる
    await setOpts({ showLabel: true, showValue: true, labelSize: 14, tubeWidth: 0.155 });
    const uTop = gpu.uniforms.uTop;
    const uBottom = gpu.uniforms.uBottom;
    const tubeW = gpu.uniforms.uTubeW;

    let worst = 0;
    const sizes = [[400, 300], [400, 500], [400, 800], [400, 1200], [800, 800], [300, 900], [1000, 400]];
    sizes.forEach(([w, h]) => {
        const b = shaderBounds(uTop, uBottom, w, h, tubeW);
        worst = Math.max(worst, Math.abs(b.bottom - uBottom), Math.abs(b.top - uTop));
    });
    check('outer shape matches uTop/uBottom exactly [下が見切れない]',
        worst < 1e-6, `worst error=${worst.toExponential(2)} (uv)`);

    // 管が画面外（uv.y < -0.5）へ出ないこと。パネルが大きいほど悪化する不具合の再現。
    let overflow = 0;
    sizes.forEach(([w, h]) => {
        const b = shaderBounds(uTop, uBottom, w, h, tubeW);
        overflow = Math.max(overflow, -0.5 - b.bottom);   // 正なら画面外
    });
    check('tube never extends past the bottom edge', overflow <= 0,
        `overflow=${overflow.toFixed(4)} uv`);

    // 太さを変えても外形が範囲内に収まること（R が大きいほど丸底が伸びる）
    let worstW = 0;
    [0.05, 0.155, 0.25, 0.35].forEach((tw) => {
        const b = shaderBounds(uTop, uBottom, 400, 800, tw);
        worstW = Math.max(worstW, Math.abs(b.bottom - uBottom));
    });
    check('holds for any tube width', worstW < 1e-6, `worst=${worstW.toExponential(2)}`);
}

// ---- 5. 固定色モード --------------------------------------------------------
console.log('\n[5] fixed color mode');
{
    await setOpts({ colorMode: 'series', seriesColors: ['#ff0000', '#00ff00'] });
    const rgb = gpu.uniforms.uColor.map((v) => Math.round(v * 255)).join(',');
    check('uses first palette color', rgb === '255,0,0', rgb);
    await setOpts({});
}

// ---- 6. オプションの反映 ----------------------------------------------------
console.log('\n[6] options reach the shader');
{
    await setOpts({ liquidOpacity: 0.8, bubbleCount: 5, tubeWidth: 0.2, glow: 0 });
    check('liquidOpacity -> uOpacity', Math.abs(gpu.uniforms.uOpacity - 0.8) < 1e-6,
        `got ${gpu.uniforms.uOpacity}`);
    check('bubbleCount -> uBubbles', gpu.uniforms.uBubbles === 5, `got ${gpu.uniforms.uBubbles}`);
    check('tubeWidth -> uTubeW', Math.abs(gpu.uniforms.uTubeW - 0.2) < 1e-6,
        `got ${gpu.uniforms.uTubeW}`);
    check('glow=0 -> uGlow 0 [外側グローを消せる]', gpu.uniforms.uGlow === 0,
        `got ${gpu.uniforms.uGlow}`);
    await setOpts({ glow: 1.5 });
    check('glow slider reaches shader', Math.abs(gpu.uniforms.uGlow - 1.5) < 1e-6,
        `got ${gpu.uniforms.uGlow}`);

    // animSpeed=0 で時間が進まない（静止する）
    await setOpts({ animSpeed: 0 });
    const t1 = gpu.uniforms.uTime;
    await sleep(200);
    check('animSpeed=0 freezes time', gpu.uniforms.uTime === t1, `${t1} -> ${gpu.uniforms.uTime}`);
    await setOpts({});
}

// ---- 7. ラベル・値の表示切替 ------------------------------------------------
console.log('\n[7] label and value display');
{
    await setOpts({ showLabel: false, showValue: true });
    check('label hidden', !doc.body.textContent.includes('Risk'), doc.body.textContent.slice(0, 60));
    check('value still shown', doc.body.textContent.includes('92'), doc.body.textContent.slice(0, 60));

    await setOpts({ showLabel: true, showValue: false });
    check('value hidden', !doc.body.textContent.includes('92%'), doc.body.textContent.slice(0, 60));
    check('label still shown', doc.body.textContent.includes('Risk'), doc.body.textContent.slice(0, 60));

    await setOpts({ valueUnit: ' GB', valueDecimals: 1 });
    check('unit and decimals applied', doc.body.textContent.includes('92.0 GB'),
        doc.body.textContent.slice(0, 80));

    // ラベル/値の表示状態で管の縦範囲が変わる（タイトルを管に近づける）
    await setOpts({ showLabel: true, showValue: true });
    const withBoth = gpu.uniforms.uTop;
    await setOpts({ showLabel: false, showValue: true });
    const noLabel = gpu.uniforms.uTop;
    check('tube extends upward when label is hidden', noLabel > withBoth,
        `withLabel=${withBoth} noLabel=${noLabel}`);
    await setOpts({});
}

// ---- 8. フィールド選択（columnSelector / DOS 文字列） -----------------------
console.log('\n[8] field selection via columnSelector');
{
    state.data = {
        fields: ['host', 'pct', 'label'].map((name) => ({ name })),
        rows: [['h1', '30', 'Alpha'], ['h2', '70', 'Beta']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({
        labelField: "> primary | seriesByName('label')",
        valueField: "> primary | seriesByName('pct')",
        minValue: 0,
        maxValue: 100,
    });
    // 既定の集計は最終行なので Beta / 70 になる
    check('DOS string resolves label column', doc.body.textContent.includes('Beta'),
        doc.body.textContent.slice(0, 80));
    check('DOS string resolves value column', doc.body.textContent.includes('70'),
        doc.body.textContent.slice(0, 80));
    check('level uses selected value column', Math.abs(gpu.uniforms.uLevel - 0.70) < 0.001,
        `got ${gpu.uniforms.uLevel}`);

    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({});
}

// ---- 9. 堅牢性 --------------------------------------------------------------
console.log('\n[9] robustness');
{
    // 空データ
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(260);
    check('empty data message', doc.body.textContent.includes('データがありません'),
        doc.body.textContent.slice(0, 80));

    // 数値列が無い
    state.data = { fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', 'y']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(260);
    check('no numeric column message', doc.body.textContent.includes('数値の列が見つかりません'),
        doc.body.textContent.slice(0, 80));

    // columns 形式（rows が空でも壊れない）
    state.data = { fields: FIELDS, columns: [['A', 'B'], ['10', '20']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(280);
    // columns 形式でも集計されて1本になる（既定=最終行なので B / 20）
    check('columns format renders', Number.isFinite(gpu.uniforms.uLevel),
        `uLevel=${gpu.uniforms.uLevel}`);
    check('columns format labels', doc.body.textContent.includes('B'),
        doc.body.textContent.slice(0, 60));

    // 数値に紛れ込んだ不正値は捨てる
    state.data = { fields: FIELDS, rows: [['ok', '50'], ['bad', 'abc'], ['ok2', '1,234']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(280);
    // 'abc' は捨て、'1,234' はカンマを外して数値化 → 合計 = 50 + 1234
    await setOpts({ aggregation: 'sum', minValue: 0, maxValue: 1284 });
    check('non-numeric row dropped, comma parsed', Math.abs(gpu.uniforms.uLevel - 1) < 0.001,
        `uLevel=${gpu.uniforms.uLevel}`);

    // 壊れたオプションでも落ちない
    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({ colorBands: 'garbage', seriesColors: 'garbage', minValue: 'x', maxValue: null });
    check('survives malformed options', !!doc.querySelector('canvas'));
    check('falls back to default bands', Array.isArray(gpu.uniforms.uColor)
        && gpu.uniforms.uColor.every((v) => Number.isFinite(v)),
        JSON.stringify(gpu.uniforms.uColor));
    await setOpts({});
}

// ---- 10. 複数行の集計（1 viz = 1本） ----------------------------------------
console.log('\n[10] aggregation of multiple rows');
{
    // 10, 20, 30, 40 の4行。集計方法ごとに液面が変わる
    state.data = { fields: FIELDS, rows: [['a', '10'], ['b', '20'], ['c', '30'], ['d', '40']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });

    const levelFor = async (how, min, max) => {
        await setOpts({ aggregation: how, minValue: min, maxValue: max });
        return gpu.uniforms.uLevel;
    };
    check('last -> 40', Math.abs(await levelFor('last', 0, 40) - 1) < 0.001);
    check('first -> 10', Math.abs(await levelFor('first', 0, 10) - 1) < 0.001);
    check('sum -> 100', Math.abs(await levelFor('sum', 0, 100) - 1) < 0.001);
    check('avg -> 25', Math.abs(await levelFor('avg', 0, 25) - 1) < 0.001);
    check('max -> 40', Math.abs(await levelFor('max', 0, 40) - 1) < 0.001);
    check('min -> 10', Math.abs(await levelFor('min', 0, 10) - 1) < 0.001);
    check('count -> 4', Math.abs(await levelFor('count', 0, 4) - 1) < 0.001);

    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({});
}

// ---- 11. ドリルダウン登録 ---------------------------------------------------
console.log('\n[11] drilldown registration');
{
    check('drilldown listeners registered', drilldownRegs.length > 0, `got ${drilldownRegs.length}`);
    const reg = drilldownRegs[drilldownRegs.length - 1];
    check('uses point.click action', reg?.action === 'point.click', String(reg?.action));
    const payload = reg?.payloadCallback ? reg.payloadCallback() : null;
    check('payload carries label and value',
        payload && 'row.label.value' in payload && 'row.value.value' in payload,
        JSON.stringify(payload));
}

// ---- 12. シェーダ本体の健全性 -----------------------------------------------
console.log('\n[12] shader source sanity');
{
    const frag = gpu.shaders.find((s) => s.includes('outColor'));
    check('fragment shader bundled', !!frag);
    check('uses GLSL ES 3.00', frag.includes('#version 300 es'));
    check('outputs premultiplied alpha', frag.includes('col * alpha, alpha'), '');
    check('has Beer-Lambert transmission', frag.includes('exp(-sigma'), '');
    check('has bubble wobble (vnoise)', frag.includes('vnoise'), '');
    check('no leftover checker backdrop', !frag.includes('checker'),
        'テスト用の市松模様が本番に残っている');

    // 【回帰防止】散乱項が liquidCol * (1.0 - T) だと色相が反転する。
    // 吸収係数 sigma は指定色の主要チャンネルほど小さい → T が大きい →
    // (1-T) を掛けると主要チャンネルが最も弱くなる（赤がオリーブになった実例）。
    // 散乱はスカラー density に比例させ、色相を歪めないこと。
    // コメント行（// で始まる部分）を除いた「実際に動くコード」だけを見る。
    // 修正の経緯をコメントに書いてあるため、素の grep では誤検出する。
    const fragCode = frag.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    check('scattering does not use (1.0 - T) [色相反転の回帰防止]',
        !/liquidCol\s*\*\s*\(1\.0\s*-\s*T\)/.test(fragCode),
        '散乱項が (1-T) 比例に戻っている＝色相が反転する');
    check('scattering uses scalar density', /liquidCol\s*\*\s*density/.test(frag), '');

    // 散乱項の色相が保たれることを数値で確認する（シェーダの式を JS で再現）
    const hueOf = (r, g, b) => {
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const d = mx - mn;
        if (d < 1e-9) return -1;
        let h;
        if (mx === r) h = ((g - b) / d + 6) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        return h * 60;
    };
    const scatterHue = (r, g, b, opacity, depth) => {
        const thickness = 1.0;
        const pathLen = (depth * 1.6 + thickness * 0.9) * (0.35 + (3.2 - 0.35) * opacity);
        const density = (1 - Math.exp(-pathLen * 0.85)) * (0.25 + 0.75 * opacity);
        const shade = 1.15 + (0.78 - 1.15) * depth;
        const k = density * shade * (0.60 + 0.40 * thickness);
        return hueOf(r * k, g * k, b * k);
    };
    // #ff5a2e（赤・色相 ~13°）が深さ・濃さによらず赤のままか
    const want = hueOf(1.0, 0.353, 0.180);
    let maxDrift = 0;
    for (const op of [0.1, 0.45, 1.0]) {
        for (const d of [0.05, 0.5, 0.95]) {
            maxDrift = Math.max(maxDrift, Math.abs(scatterHue(1.0, 0.353, 0.180, op, d) - want));
        }
    }
    check('red stays red across depth/opacity (hue drift < 1°)', maxDrift < 1,
        `max drift ${maxDrift.toFixed(2)}°`);

    // 【回帰防止】ガラス／液体は透明体なので、透過モードで alpha を
    // 1.0 に決め打ちしてはいけない（管が「黒い不透明な板」になる）。
    // 旧実装は `alpha = 1.0;` と暗色 behind の組み合わせで背景を潰していた。
    check('interior does not hard-code alpha = 1.0 [背景が潰れる回帰防止]',
        !/^\s*alpha\s*=\s*1\.0\s*;/m.test(fragCode),
        '管の内側が完全不透明に固定されている');
    check('behind is not a hard-coded dark color',
        !/vec3\(0\.02,\s*0\.03,\s*0\.045\)/.test(fragCode),
        '透かす先が暗色でハードコードされている');
    // 透過モードでは uBgAlpha=0 なので behind の寄与が 0 になること
    check('behind derives from uBgColor * uBgAlpha',
        /vec3\s+behind\s*=\s*uBgColor\s*\*\s*uBgAlpha/.test(fragCode), '');
    // alpha は uBgAlpha で不透過モードへ倒す形になっていること
    check('alpha blends toward opaque via uBgAlpha',
        (fragCode.match(/alpha\s*=\s*mix\([^;]*uBgAlpha\)/g) || []).length >= 3,
        'alpha の合成が uBgAlpha を経由していない');
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
