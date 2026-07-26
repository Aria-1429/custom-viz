// Icon Status viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_icon_status', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 400, height: 340 });
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

// コンテナ実寸（オートフィットのため固定）。resize() で差し替えられるようにする
let VW = 400;
let VH = 340;
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => VW, configurable: true });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => VH, configurable: true });

const observers = [];
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { setTimeout(() => this.cb([]), 0); }
    disconnect() { }
    unobserve() { }
};
win.ResizeObserver = globalThis.ResizeObserver;
const resize = async (w, h) => {
    VW = w; VH = h;
    observers.forEach((o) => o.cb([]));
    await sleep(220);
};

const root = doc.createElement('div');
root.id = 'root';
doc.body.appendChild(root);

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

const FIELDS = [{ name: '_time' }, { name: 'CPU使用率' }];
const VALS = [22, 35, 41, 55, 63, 70, 88];
const ROWS = VALS.map((v, i) => [`2026-07-${String(i + 1).padStart(2, '0')}`, String(v)]);

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
    theme: 'dark',
    mode: 'view',
};

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
    getTokens: () => ({}),
    addTokensListener: () => () => { },
    setToken: () => { },
    getError: () => null,
    addErrorListener: () => () => { },
    drilldown: () => { },
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));
const setOpts = async (o) => {
    state.options = o;
    fire('options', { options: state.options });
    await sleep(250);
};
const setData = async (d) => {
    state.data = d;
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
};

const iconWrap = () => doc.querySelector('[data-role="icon-wrap"] svg');
const layers = () => [...doc.querySelectorAll('[data-role="icon-wrap"] svg path[data-role]')];
const container = () => doc.querySelector('.viz-container');

// 面はベタ塗りではなくグラデーション（fill="url(#g-<role>-<uid>)"）で塗るため、
// 実際の色は linearGradient の stop を見ないと分からない。
// role からその stop 色（[開始, 終了]）を取り出す。
function gradientStops(role) {
    const svg = iconWrap();
    if (!svg) return [];
    const g = [...svg.querySelectorAll('linearGradient')].find((el) =>
        (el.getAttribute('id') || '').startsWith(`g-${role}-`)
    );
    if (!g) return [];
    return [...g.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'));
}
// レイヤーの「実効的な塗り色」。グラデーション参照なら stop 色の配列を返す
function effectiveFill(pathEl) {
    const f = pathEl.getAttribute('fill') || '';
    const m = f.match(/^url\(#g-([a-zA-Z]+)-/);
    return m ? gradientStops(m[1]) : [f];
}

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 基本描画 --------------------------------------------------------------
console.log('\n[1] basic render (dark, default options)');
{
    check('icon svg rendered', !!iconWrap());
    check('default icon is server', container()?.getAttribute('data-icon') === 'server',
        container()?.getAttribute('data-icon'));
    check('layered (multiple filled paths)', layers().length >= 6, `got ${layers().length}`);
    const body = doc.body.textContent;
    check('value 88 shown (last row)', body.includes('88'), body.slice(0, 120));
    check('label CPU使用率 shown', body.includes('CPU使用率'), body.slice(0, 120));
}

// ---- 2. しきい値で色が変わる（方式Cの中核） --------------------------------------
console.log('\n[2] threshold recolors the whole icon');
{
    // 既定バンド: <50 緑 / 50-80 黄 / >=80 赤。最終行 88 → 赤
    const red = container()?.getAttribute('data-base-color');
    check('value 88 → red band (#f85149)', red === '#f85149', red);

    // accent はグラデーションで塗られるが、その stop 色は基準色から導出される。
    // 赤バンドなら stop も赤系（R が G/B より明確に大きい）になる。
    const isReddish = (c) => {
        const m = String(c).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
            || String(c).match(/rgb\((\d+),(\d+),(\d+)\)/);
        if (!m) return false;
        const [r, g2, b] = m[0].startsWith('#')
            ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
            : [Number(m[1]), Number(m[2]), Number(m[3])];
        return r > g2 + 40 && r > b + 40;
    };
    const accentStops = gradientStops('accent');
    check('accent gradient derives from red base', accentStops.length >= 2 && accentStops.every(isReddish),
        accentStops.join(','));

    // 面もグラデーションで、accent とは別の（暗い/明るい）色になっている
    const frontStops = gradientStops('faceFront');
    check('faceFront gradient differs from accent',
        frontStops.length >= 2 && frontStops.join(',') !== accentStops.join(','),
        frontStops.join(','));

    // 値を下げると緑バンドへ
    await setData({ fields: FIELDS, rows: [['2026-07-01', '12']] });
    check('value 12 → green band (#3fb950)', container()?.getAttribute('data-base-color') === '#3fb950',
        container()?.getAttribute('data-base-color'));
    const isGreenish = (c) => {
        const m = String(c).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
            || String(c).match(/rgb\((\d+),(\d+),(\d+)\)/);
        if (!m) return false;
        const [r, g2, b] = m[0].startsWith('#')
            ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
            : [Number(m[1]), Number(m[2]), Number(m[3])];
        return g2 > r + 20 && g2 > b + 20;
    };
    const greenStops = gradientStops('accent');
    check('accent gradient follows to green', greenStops.length >= 2 && greenStops.every(isGreenish),
        greenStops.join(','));

    // 中間バンド
    await setData({ fields: FIELDS, rows: [['2026-07-01', '65']] });
    check('value 65 → amber band (#d29922)', container()?.getAttribute('data-base-color') === '#d29922',
        container()?.getAttribute('data-base-color'));

    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 2b. openRanges（from/to が null）を正しく扱う ---------------------------------
console.log('\n[2b] open ranges (null from/to)');
{
    await setOpts({
        colorBands: [
            { from: null, to: 10, value: '#3fb950' },
            { from: 10, to: null, value: '#f85149' },
        ],
    });
    check('88 falls in open upper band', container()?.getAttribute('data-base-color') === '#f85149',
        container()?.getAttribute('data-base-color'));

    await setData({ fields: FIELDS, rows: [['a', '-500']] });
    check('-500 falls in open lower band', container()?.getAttribute('data-base-color') === '#3fb950',
        container()?.getAttribute('data-base-color'));

    // 上端が閉じたバンドしかない場合でも色が消えない（最近傍へ倒す）
    await setOpts({ colorBands: [{ from: 0, to: 10, value: '#3fb950' }] });
    await setData({ fields: FIELDS, rows: [['a', '9999']] });
    check('out-of-range value still gets a color (no colorless icon)',
        container()?.getAttribute('data-base-color') === '#3fb950',
        container()?.getAttribute('data-base-color'));

    await setOpts({});
    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 3. 単色モード -------------------------------------------------------------
console.log('\n[3] fixed color mode');
{
    await setOpts({ colorMode: 'fixed', baseColor: '#22d3ee' });
    check('fixed mode uses baseColor', container()?.getAttribute('data-base-color') === '#22d3ee',
        container()?.getAttribute('data-base-color'));
    const fixedStops = gradientStops('accent');
    // 基準色 #22d3ee（シアン）から導出されるので B > R になる
    const isCyan = (c) => {
        const m = String(c).match(/rgb\((\d+),(\d+),(\d+)\)/) || String(c).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (!m) return false;
        const [r, g2, b] = m[0].startsWith('#')
            ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
            : [Number(m[1]), Number(m[2]), Number(m[3])];
        return b > r + 40 && g2 > r + 40;
    };
    check('accent gradient uses fixed color', fixedStops.length >= 2 && fixedStops.every(isCyan),
        fixedStops.join(','));
    await setOpts({});
}

// ---- 4. 全12アイコンが描画できる ---------------------------------------------------
console.log('\n[4] all 12 icons render (solid + outline)');
{
    const names = ['server', 'database', 'shield', 'alert', 'lock', 'router',
        'user', 'eye', 'cloud', 'firewall', 'endpoint', 'bug'];
    let solidOk = 0;
    let outlineOk = 0;
    for (const n of names) {
        await setOpts({ iconName: n, iconStyle: 'solid' });
        const filled = layers().length;
        if (filled >= 4 && container()?.getAttribute('data-icon') === n) solidOk += 1;
        else console.log(`      solid ${n}: ${filled} layers`);

        await setOpts({ iconName: n, iconStyle: 'outline' });
        const strokes = [...doc.querySelectorAll('[data-role="icon-wrap"] svg path[stroke]')];
        if (strokes.length >= 1) outlineOk += 1;
        else console.log(`      outline ${n}: ${strokes.length} strokes`);
    }
    check('all 12 icons render in solid', solidOk === 12, `${solidOk}/12`);
    check('all 12 icons render in outline', outlineOk === 12, `${outlineOk}/12`);
    await setOpts({});
}

// ---- 5. 集計方法 ---------------------------------------------------------------
console.log('\n[5] aggregation modes');
{
    // VALS = [22,35,41,55,63,70,88] → sum=374 avg=53.43 max=88 min=22 count=7
    const cases = [
        ['last', '88'],
        ['sum', '374'],
        ['max', '88'],
        ['min', '22'],
        ['count', '7'],
    ];
    for (const [mode, expected] of cases) {
        await setOpts({ aggregation: mode });
        const valEl = doc.querySelector('[data-role="value"]');
        check(`aggregation=${mode} → ${expected}`, valEl && valEl.textContent === expected,
            valEl && valEl.textContent);
    }
    await setOpts({ aggregation: 'avg', valueDecimals: 1 });
    const avgEl = doc.querySelector('[data-role="value"]');
    check('aggregation=avg → 53.4', avgEl && avgEl.textContent === '53.4', avgEl && avgEl.textContent);
    await setOpts({});
}

// ---- 6. 表示オプション ------------------------------------------------------------
console.log('\n[6] display options');
{
    await setOpts({ unitText: '%' });
    check('unit appended', doc.querySelector('[data-role="value"]')?.textContent === '88%',
        doc.querySelector('[data-role="value"]')?.textContent);

    await setOpts({ labelText: '稼働率' });
    check('custom label used', doc.querySelector('[data-role="label"]')?.textContent === '稼働率',
        doc.querySelector('[data-role="label"]')?.textContent);

    await setOpts({ showValue: false });
    check('showValue=false hides value', !doc.querySelector('[data-role="value"]'));

    await setOpts({ showLabel: false });
    check('showLabel=false hides label', !doc.querySelector('[data-role="label"]'));

    await setOpts({ abbreviateValue: true });
    await setData({ fields: FIELDS, rows: [['a', '1500000']] });
    check('abbreviate 1500000 → 1.5M', doc.querySelector('[data-role="value"]')?.textContent === '1.5M',
        doc.querySelector('[data-role="value"]')?.textContent);
    await setData({ fields: FIELDS, rows: ROWS });

    // フィルタは glow / shadow / shade用blur の3種。shade用は常設（seam 対策）なので、
    // glow+shadow を切ると 1 個だけ残るのが正しい。
    await setOpts({ showGlow: false, showShadow: false });
    const noFx = [...doc.querySelectorAll('[data-role="icon-wrap"] svg filter')]
        .map((f) => f.getAttribute('id'));
    check('glow+shadow off → only the shade blur remains',
        noFx.length === 1 && noFx[0].startsWith('shadeblur-'), noFx.join(','));

    await setOpts({ showGlow: true, showShadow: true });
    const fx = doc.querySelectorAll('[data-role="icon-wrap"] svg filter').length;
    check('glow+shadow on → glow/shadow/shade filters defined', fx === 3, `got ${fx}`);

    await setOpts({ showCard: false });
    const card = doc.querySelector('[data-role="card"]');
    // 背景は backgroundColor で指定している（shorthand の background は使わない）
    check('showCard=false → transparent background', card && card.style.backgroundColor === 'transparent',
        card && card.style.backgroundColor);
    await setOpts({});
}

// ---- 7. アニメーション（フィルタを毎フレーム再計算しない設計の確認） -----------------
console.log('\n[7] animation');
{
    // LED 明滅は v1.1.0 で廃止した。旧値 'led' が残っていても既定(none)に倒れ、
    // 明滅用のマーカー属性が付かないこと（＝アニメーションしないこと）を確認する。
    await setOpts({ pulseMode: 'led' });
    const legacy = layers().filter((p) => p.getAttribute('data-base-opacity') !== null);
    check('legacy pulseMode=led no longer animates', legacy.length === 0, `got ${legacy.length}`);
    check('legacy led shows no ring either', !doc.querySelector('[data-role="icon-wrap"] svg circle'));

    await setOpts({ pulseMode: 'ring' });
    const ring = doc.querySelector('[data-role="icon-wrap"] svg circle');
    check('ring rendered', !!ring);
    const r1 = ring?.getAttribute('r');
    await sleep(300);
    const r2 = ring?.getAttribute('r');
    check('ring radius animates', r1 !== r2, `${r1} → ${r2}`);

    await setOpts({ pulseMode: 'none' });
    await sleep(150);
    check('none mode removes the ring', !doc.querySelector('[data-role="icon-wrap"] svg circle'));
    await setOpts({});
}

// ---- 8. テーマ切り替え ------------------------------------------------------------
console.log('\n[8] theme');
{
    const darkFront = gradientStops('faceFront').join(',');
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const lightFront = gradientStops('faceFront').join(',');
    check('faceFront differs between themes', darkFront !== lightFront, `${darkFront} vs ${lightFront}`);
    check('light theme still renders icon', !!iconWrap());
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
}

// ---- 9. リサイズ／小パネルの退避 -----------------------------------------------------
console.log('\n[9] autofit and small panels');
{
    await resize(700, 600);
    const big = Number(iconWrap()?.getAttribute('width'));
    await resize(260, 240);
    const small = Number(iconWrap()?.getAttribute('width'));
    check('icon scales with container', big > small, `${big} vs ${small}`);

    // 極小パネル：立体が潰れるので自動で線画へフォールバック（iconSize < 56px）。
    // v1.1.0 で余白を詰めた結果、同じパネル寸法でもアイコンが大きくなったため、
    // フォールバックが起きるのはさらに小さいサイズになった。
    await resize(60, 50);
    const strokes = doc.querySelectorAll('[data-role="icon-wrap"] svg path[stroke]').length;
    check('tiny panel falls back to outline', strokes > 0, `strokes=${strokes}`);
    check('icon still rendered at tiny size', !!iconWrap());

    await resize(90, 70);
    check('small panel hides label', !doc.querySelector('[data-role="label"]'));
    check('small panel still renders icon', !!iconWrap());

    await resize(400, 340);
    await setOpts({ iconScale: 1.5 });
    const scaled = Number(iconWrap()?.getAttribute('width'));
    await setOpts({ iconScale: 0.5 });
    const shrunk = Number(iconWrap()?.getAttribute('width'));
    check('iconScale option applies', scaled > shrunk, `${scaled} vs ${shrunk}`);
    await setOpts({});
}

// ---- 9b. 余白は最小限（v1.1.0 の主眼） ------------------------------------------------
//
// 「はみ出さない範囲でできるだけ小さく」が要件。padding を詰めすぎて中身が
// パネルからはみ出さないこと、逆に余白が余りすぎないことの両方を検査する。
console.log('\n[9b] tight padding without overflow');
{
    const sizes = [[300, 260], [200, 160], [480, 400], [600, 500]];
    const tooMuchPad = [];
    const overflow = [];
    for (const [w, h] of sizes) {
        await resize(w, h);
        const card = doc.querySelector('[data-role="card"]');
        const pad = parseInt(card?.style.padding || '0', 10);
        // 余白は片側 10px 以下（旧実装は最大 20px だった）
        if (pad > 10) tooMuchPad.push(`${w}x${h}:pad=${pad}`);

        // 中身の合計高さがパネル内に収まっているか
        const icon = Number(iconWrap()?.getAttribute('height') || 0);
        const valueEl = doc.querySelector('[data-role="value"]');
        const labelEl = doc.querySelector('[data-role="label"]');
        const vFont = valueEl ? parseInt(valueEl.style.fontSize, 10) : 0;
        const lFont = labelEl ? parseInt(labelEl.style.fontSize, 10) : 0;
        const gap = parseInt(card?.style.gap || '0', 10);
        const rows = (valueEl ? 1 : 0) + (labelEl ? 1 : 0);
        // 行の高さは line-height 込みでおよそ font*1.2〜1.35
        const used = icon + Math.round(vFont * 1.2) + Math.round(lFont * 1.4) + gap * rows;
        if (used > h - pad * 2 + 2) overflow.push(`${w}x${h}: used=${used} avail=${h - pad * 2}`);
    }
    check('padding stays small (<=10px)', tooMuchPad.length === 0, tooMuchPad.join(' | '));
    check('content never overflows the panel', overflow.length === 0, overflow.join(' | '));

    // 大きいパネルでもアイコンが固定上限で頭打ちにならない
    await resize(300, 260);
    const small = Number(iconWrap()?.getAttribute('height') || 0);
    await resize(700, 620);
    const big = Number(iconWrap()?.getAttribute('height') || 0);
    check('icon keeps growing on large panels (no fixed cap)', big > small + 100, `${small} → ${big}`);

    // iconScale を上げても領域を超えない（固定上限を外した際にはみ出した回帰）
    await setOpts({ iconScale: 1 });
    const full = Number(iconWrap()?.getAttribute('height') || 0);
    const card2 = doc.querySelector('[data-role="card"]');
    const pad2 = parseInt(card2?.style.padding || '0', 10);
    check('iconScale=1 fits inside the panel', full <= 620 - pad2 * 2, `icon=${full}`);
    await setOpts({});
    await resize(400, 340);
}

// ---- 9c. 背景は常に透過（画像エクスポートで背景がくり抜かれること） ----------------------
//
// v1.1.1 まで cardBase が不透明色（ダーク #0d1020 / ライト #ffffff）だったため、
// パネル背景を塗り潰し、画像エクスポート時に viz の地色が写り込んでいた。
// radial-bar 等は 'transparent' で、透過のままエクスポートできる。
// 「不透明な塗りを持たないこと」を全組み合わせで検査する。
console.log('\n[9c] background stays transparent (exportable with alpha)');
{
    // 不透明とみなす塗り: #rgb / #rrggbb / rgb(...) / 名前付き色（transparent 以外）
    const isOpaque = (v) => {
        const s = String(v || '').trim();
        if (!s || s === 'none' || s === 'transparent' || s === 'initial') return false;
        if (/#[0-9a-fA-F]{3,8}\b/.test(s)) return true;
        if (/\brgb\(/i.test(s)) return true;
        // rgba(...) は alpha が 0 より大きければ不透明扱い（グラデの途中停止は許容）
        return false;
    };
    const offenders = [];
    for (const theme of ['dark', 'light']) {
        for (const showCard of [true, false]) {
            state.theme = theme;
            fire('theme', { theme });
            await setOpts({ showCard });
            const c = container();
            const card = doc.querySelector('[data-role="card"]');
            for (const [name, el] of [['container', c], ['card', card]]) {
                if (!el) continue;
                for (const prop of ['background', 'backgroundColor']) {
                    const v = el.style[prop];
                    if (isOpaque(v)) offenders.push(`${theme}/showCard=${showCard} ${name}.${prop}=${v}`);
                }
            }
        }
    }
    check('no opaque background in any theme/card combination', offenders.length === 0,
        offenders.join(' | '));

    // ★ ルート（.viz-container）に background:'transparent' が**明示**されていること。
    // 指定を省くと iframe / ホスト側の既定背景が残り、画像エクスポートで
    // 背景がくり抜かれない（実機で発生。カード側だけ透過にしても直らなかった）。
    // 透過エクスポートできている radial-bar はここを明示している。
    {
        await setOpts({});
        const c = container();
        check('root .viz-container explicitly sets transparent background',
            c && (c.style.background === 'transparent' || c.style.backgroundColor === 'transparent'),
            `background=${c?.style.background} backgroundColor=${c?.style.backgroundColor}`);
    }

    // ガード表示（ローディング / データなし）でもルートは透過であること
    {
        await setData({ fields: FIELDS, rows: [] });
        const c = container();
        check('empty-state container is transparent too',
            c && (c.style.background === 'transparent' || c.style.backgroundColor === 'transparent'),
            `background=${c?.style.background}`);
        await setData({ fields: FIELDS, rows: ROWS });
    }

    // 実際に描かれたピクセルの土台を検査する。
    // 上の style 検査だけだと、背景を別のプロパティ（background shorthand など）で
    // 塗った場合に見逃す。カード配下に「不透明な塗りを持つ要素」が無いことを確かめる。
    {
        state.theme = 'dark';
        fire('theme', { theme: 'dark' });
        await setOpts({ showCard: true });
        const painted = [...doc.querySelectorAll('[data-role="card"], [data-role="card"] *')]
            .filter((el) => {
                const st = el.style || {};
                // SVG の中身（アイコン本体）は塗って当然なので除外する
                if (el.namespaceURI && el.namespaceURI.includes('svg')) return false;
                const vals = [st.background, st.backgroundColor].filter(Boolean);
                return vals.some((v) => /#[0-9a-fA-F]{3,8}\b/.test(v) || /\brgb\(/i.test(v));
            })
            .map((el) => `${el.getAttribute('data-role') || el.tagName}:${el.style.background || el.style.backgroundColor}`);
        check('no HTML element under the card paints an opaque fill', painted.length === 0,
            painted.join(' | '));
    }

    // カード表示時もベタ塗りではなくグラデーションだけで面を表現している
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await setOpts({ showCard: true });
    const card = doc.querySelector('[data-role="card"]');
    check('card uses a gradient (not a solid fill)',
        (card?.style.backgroundImage || '').includes('linear-gradient'),
        card?.style.backgroundImage);
    check('card backgroundColor is transparent',
        card?.style.backgroundColor === 'transparent', card?.style.backgroundColor);

    // showCard を切り替えても背景プロパティが残らない（shorthand 混在の回帰）
    await setOpts({ showCard: false });
    const off = doc.querySelector('[data-role="card"]');
    check('toggling showCard off clears the gradient',
        !(off?.style.backgroundImage || '').includes('linear-gradient'),
        off?.style.backgroundImage);
    // happy-dom は border:'none' を "none none" に正規化することがあるので、
    // 色や太さが残っていないことで判定する
    check('toggling showCard off clears the border',
        !/\d|rgb|#/.test(off?.style.border || ''), off?.style.border);

    await setOpts({});
}

// ---- 10. データのガード -------------------------------------------------------------
console.log('\n[10] data guards');
{
    await setData({ fields: FIELDS, rows: [] });
    check('empty rows → message', doc.body.textContent.includes('データがありません'));

    await setData({ fields: FIELDS, rows: [['a', 'not-a-number']] });
    check('non-numeric → message', doc.body.textContent.includes('データがありません'));

    // columns 形式（rows だけ見る実装だと 0 行になるケース）
    await setData({ fields: FIELDS, columns: [['2026-07-01', '2026-07-02'], ['10', '77']] });
    check('columns format handled', doc.querySelector('[data-role="value"]')?.textContent === '77',
        doc.querySelector('[data-role="value"]')?.textContent);

    // 1列だけ
    await setData({ fields: [{ name: 'count' }], rows: [['5'], ['42']] });
    check('single column handled', doc.querySelector('[data-role="value"]')?.textContent === '42',
        doc.querySelector('[data-role="value"]')?.textContent);

    // カンマ入り数値
    await setData({ fields: FIELDS, rows: [['a', '1,234']] });
    check('comma-separated number parsed', doc.querySelector('[data-role="value"]')?.textContent === '1,234',
        doc.querySelector('[data-role="value"]')?.textContent);

    // 未知のオプションキー（ホストが勝手に載せてくる）で壊れない
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ backgroundColor: 'transparent', someUnknownKey: 123 });
    check('unknown option keys ignored', !!iconWrap());

    // 不正なオプション値でも既定へ倒れる
    await setOpts({ iconName: 'no-such-icon', iconStyle: 'bogus', colorMode: 'bogus', iconScale: 'x' });
    check('invalid iconName → default server', container()?.getAttribute('data-icon') === 'server',
        container()?.getAttribute('data-icon'));
    check('invalid options still render', layers().length >= 6);

    // colorBands が壊れていても落ちない
    await setOpts({ colorBands: 'not-an-array' });
    check('broken colorBands falls back to defaults', !!container()?.getAttribute('data-base-color'),
        container()?.getAttribute('data-base-color'));
    await setOpts({ colorBands: [{ from: 'x', to: 'y', value: 'nope' }] });
    check('invalid band entries fall back', !!iconWrap());
    await setOpts({});
}

// ---- 11. columnSelector（DOS 文字列）の解決 ------------------------------------------
console.log('\n[11] columnSelector DOS string');
{
    const F3 = [{ name: 'host' }, { name: 'cpu' }, { name: 'mem' }];
    await setData({ fields: F3, rows: [['h1', '10', '90'], ['h2', '20', '80']] });

    await setOpts({ valueField: "> primary | seriesByName('cpu')" });
    check('seriesByName resolves cpu → 20', doc.querySelector('[data-role="value"]')?.textContent === '20',
        doc.querySelector('[data-role="value"]')?.textContent);

    await setOpts({ valueField: '> primary | seriesByIndex(2)' });
    check('seriesByIndex resolves mem → 80', doc.querySelector('[data-role="value"]')?.textContent === '80',
        doc.querySelector('[data-role="value"]')?.textContent);

    await setOpts({ valueField: 'cpu' });
    check('raw field name resolves → 20', doc.querySelector('[data-role="value"]')?.textContent === '20',
        doc.querySelector('[data-role="value"]')?.textContent);

    await setOpts({ valueField: "> primary | seriesByName('missing')" });
    check('unknown field falls back to last column → 80',
        doc.querySelector('[data-role="value"]')?.textContent === '80',
        doc.querySelector('[data-role="value"]')?.textContent);

    await setOpts({});
    await setData({ fields: FIELDS, rows: ROWS });
}

// ---- 11b. 立体アイコンの幾何（はみ出し・ズレの回帰テスト） ------------------------------
//
// v1.0.1 で「錠前のシャックルが左にズレる」「盾のチェックが縁からはみ出す」
// 「甲虫の縞が胴から溢れる」等を修正した。パスが有効でも見た目は壊れうるので、
// 座標そのものを検査して再発を防ぐ。
console.log('\n[11b] solid icon geometry (containment / centering)');
{
    const NAMES = ['server', 'database', 'shield', 'alert', 'lock', 'router',
        'user', 'eye', 'cloud', 'firewall', 'endpoint', 'bug'];

    // パスの d 属性から「実際の端点」だけを取り出す。
    // A（楕円弧）は 7 引数（rx ry rot large sweep x y）で、末尾の 2 つだけが座標。
    // 全数値を座標として読むと rx/ry/フラグを x に誤読し、偽の「はみ出し」を報告する
    // （最初にこれで作って false positive を出した）。コマンド別に引数を数えて解釈する。
    const ARGC = { M: 2, L: 2, T: 2, H: 1, V: 1, S: 4, Q: 4, C: 6, A: 7, Z: 0 };
    function endpoints(d) {
        const pts = [];
        const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) || [];
        let cmd = null;
        let i = 0;
        let cx = 0;
        let cy = 0;
        while (i < tokens.length) {
            if (/[A-Za-z]/.test(tokens[i])) { cmd = tokens[i]; i += 1; continue; }
            if (!cmd) { i += 1; continue; }
            const up = cmd.toUpperCase();
            const n = ARGC[up];
            if (n === undefined) { i += 1; continue; }
            const args = tokens.slice(i, i + n).map(Number);
            i += n;
            if (args.length < n) break;
            if (up === 'H') { cx = args[0]; } else if (up === 'V') { cy = args[0]; } else if (n >= 2) {
                cx = args[n - 2];
                cy = args[n - 1];
            }
            if (up !== 'Z') pts.push([cx, cy]);
            // 暗黙の繰り返し（M の後の連続座標は L 扱い）
            if (up === 'M') cmd = cmd === 'M' ? 'L' : 'l';
        }
        return pts;
    }

    let overflow = [];
    let offCenter = [];
    for (const n of NAMES) {
        await setOpts({ iconName: n, iconStyle: 'solid', showGlow: false, showShadow: false });
        const paths = layers();
        if (paths.length === 0) { overflow.push(`${n}: no layers`); continue; }

        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        for (const p of paths) {
            for (const [x, y] of endpoints(p.getAttribute('d') || '')) {
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
        }
        // viewBox 0 0 96 96 の外に出ていないか
        if (minX < 0 || minY < 0 || maxX > 96 || maxY > 96) {
            overflow.push(`${n}: [${minX},${minY}]-[${maxX},${maxY}]`);
        }
        // 左右のバランス（中心 x=48 から極端に偏っていないか）。
        // 目安として、左右の余白差が 10 を超えたら偏りとみなす。
        const leftGap = minX;
        const rightGap = 96 - maxX;
        if (Math.abs(leftGap - rightGap) > 10) {
            offCenter.push(`${n}: L=${leftGap} R=${rightGap}`);
        }
    }
    check('no icon overflows the 96x96 viewBox', overflow.length === 0, overflow.join(' | '));
    check('all icons are roughly centered on x=48', offCenter.length === 0, offCenter.join(' | '));

    // 錠前：シャックル・鍵穴が本体の中心 x=48 に対して対称であること
    await setOpts({ iconName: 'lock', iconStyle: 'solid', showGlow: false, showShadow: false });
    const lockPaths = layers().map((p) => p.getAttribute('d'));
    const shackle = lockPaths.find((d) => d.includes('A16 16'));
    check('lock shackle exists', !!shackle, lockPaths.join(' / '));
    if (shackle) {
        const xs = endpoints(shackle).map(([x]) => x);
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        check('lock shackle is centered on x=48', Math.abs((lo + hi) / 2 - 48) < 0.6, `${lo}..${hi}`);
    }

    await setOpts({});
}

// ---- 12. 複数インスタンスの filter id が衝突しない ------------------------------------
console.log('\n[12] unique filter ids');
{
    const ids = [...doc.querySelectorAll('[data-role="icon-wrap"] svg filter')].map((f) => f.getAttribute('id'));
    check('filter ids are namespaced per instance',
        ids.length > 0 && ids.every((id) => /^(glow|shadow|shadeblur)-is[a-z0-9]+$/.test(id)),
        ids.join(','));
    const gradIds = [...doc.querySelectorAll('[data-role="icon-wrap"] svg linearGradient')]
        .map((g) => g.getAttribute('id'));
    check('gradient ids are namespaced per instance',
        gradIds.length > 0 && gradIds.every((id) => /^g-[a-zA-Z]+-is[a-z0-9]+$/.test(id)),
        gradIds.join(','));
}

// ---- 結果 -------------------------------------------------------------------------
console.log(`\n${'='.repeat(46)}`);
console.log(`  passed: ${pass}   failed: ${fail}`);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);
