// Treemap viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_treemap', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const VW = 800;
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

Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => VW, configurable: true });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => VH, configurable: true });
const rectFn = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
};
win.HTMLElement.prototype.getBoundingClientRect = rectFn;
win.SVGElement.prototype.getBoundingClientRect = rectFn;

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
// 2階層（index > sourcetype）。合計 1000。
//   web: 600 (access 400 / error 200)
//   db : 300 (query  250 / slow   50)
//   sec: 100 (auth   100)
const TWO_LEVEL = {
    fields: [{ name: 'index' }, { name: 'sourcetype' }, { name: 'count' }],
    rows: [
        ['web', 'access', '400'],
        ['web', 'error', '200'],
        ['db', 'query', '250'],
        ['db', 'slow', '50'],
        ['sec', 'auth', '100'],
    ],
};

// 1階層のみ。合計 100（a=50, b=30, c=20）
const ONE_LEVEL = {
    fields: [{ name: 'host' }, { name: 'bytes' }],
    rows: [
        ['a', '50'],
        ['b', '30'],
        ['c', '20'],
    ],
};

// 3階層
const THREE_LEVEL = {
    fields: [{ name: 'index' }, { name: 'sourcetype' }, { name: 'host' }, { name: 'count' }],
    rows: [
        ['web', 'access', 'h1', '300'],
        ['web', 'access', 'h2', '100'],
        ['web', 'error', 'h1', '200'],
        ['db', 'query', 'h3', '400'],
    ],
};

// 同じ組み合わせが重複（合算されるはず）
const DUPES = {
    fields: [{ name: 'k' }, { name: 'v' }],
    rows: [
        ['a', '30'],
        ['b', '40'],
        ['a', '20'], // a は 30+20=50 になる
    ],
};

// ---- DashboardExtensionAPI モック ------------------------------------------
const listeners = { dataSources: [], options: [], theme: [], dimensions: [], mode: [] };
const mkListener = (key) => (cb) => {
    listeners[key].push(cb);
    return () => { listeners[key] = listeners[key].filter((f) => f !== cb); };
};

let state = { data: TWO_LEVEL, options: { animate: false }, theme: 'dark', mode: 'view' };
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
// eslint-disable-next-line no-eval
(0, eval)(readFileSync(BUNDLE, 'utf8'));
await sleep(400);

const q = (sel) => Array.from(doc.querySelectorAll(sel));
const tiles = () => q('rect[data-role="tm-tile"]');
const leaves = () => tiles().filter((t) => t.getAttribute('data-leaf') === '1');
const groups = () => tiles().filter((t) => t.getAttribute('data-leaf') === '0');
const crumbs = () => q('button[data-role="tm-crumb"]');
const areaOf = (t) => Number(t.getAttribute('width')) * Number(t.getAttribute('height'));
const byName = (name) => tiles().find((t) => t.getAttribute('data-name') === name);

// ---- 1. 基本描画 -------------------------------------------------------------
console.log('\n[1] two-level treemap renders');
{
    check('group tiles for 3 indexes', groups().length === 3, `got ${groups().length}`);
    check('leaf tiles for 5 sourcetypes', leaves().length === 5, `got ${leaves().length}`);
    check('web/db/sec groups present',
        ['web', 'db', 'sec'].every((n) => byName(n)), tiles().map((t) => t.getAttribute('data-name')).join(','));
}

// ---- 2. 面積が値に比例する（ツリーマップの核心） -----------------------------
console.log('\n[2] tile areas are proportional to values');
{
    // 葉タイル同士で面積比を検証する。access(400) : error(200) : query(250) : slow(50) : auth(100)
    const expect = { access: 400, error: 200, query: 250, slow: 50, auth: 100 };
    const got = {};
    for (const n of Object.keys(expect)) {
        const t = byName(n);
        got[n] = t ? areaOf(t) : 0;
    }
    // access は error のおよそ2倍の面積になるはず（余白・見出しぶんの誤差を許容）
    const ratio = got.access / got.error;
    check('access:error area ratio ≈ 2', Math.abs(ratio - 2) < 0.35, `ratio=${ratio.toFixed(2)}`);
    const ratio2 = got.query / got.slow;
    check('query:slow area ratio ≈ 5', Math.abs(ratio2 - 5) < 1.2, `ratio=${ratio2.toFixed(2)}`);
    check('all leaf areas positive', Object.values(got).every((a) => a > 0), JSON.stringify(got));

    // グループ面積: web(600) > db(300) > sec(100)
    const gw = areaOf(byName('web'));
    const gd = areaOf(byName('db'));
    const gs = areaOf(byName('sec'));
    check('group areas ordered web>db>sec', gw > gd && gd > gs, `${gw.toFixed(0)},${gd.toFixed(0)},${gs.toFixed(0)}`);
    const gratio = gw / gd;
    check('web:db group area ratio ≈ 2', Math.abs(gratio - 2) < 0.3, `ratio=${gratio.toFixed(2)}`);
}

// ---- 3. squarified: 極端に細長いタイルを作らない -----------------------------
console.log('\n[3] squarified layout avoids slivers');
{
    const ratios = leaves().map((t) => {
        const w = Number(t.getAttribute('width'));
        const h = Number(t.getAttribute('height'));
        return Math.max(w / h, h / w);
    });
    const worst = Math.max(...ratios);
    // slice-and-dice なら 10 を軽く超える。squarified は概ね 5 未満に収まる
    check('worst aspect ratio < 6', worst < 6, `worst=${worst.toFixed(2)}`);
    check('median aspect ratio < 3',
        ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] < 3, ratios.map((r) => r.toFixed(1)).join(','));
}

// ---- 4. タイルが領域内に収まる ------------------------------------------------
console.log('\n[4] tiles stay inside the panel');
{
    const bad = tiles().filter((t) => {
        const x = Number(t.getAttribute('x'));
        const y = Number(t.getAttribute('y'));
        const w = Number(t.getAttribute('width'));
        const h = Number(t.getAttribute('height'));
        return x < -0.5 || y < -0.5 || x + w > VW + 0.5 || y + h > VH + 0.5;
    });
    check('no tile overflows the panel', bad.length === 0, `${bad.length} overflow`);

    // 子タイルは親の矩形の内側に入る（web の子 = access, error）
    const parent = byName('web');
    const px = Number(parent.getAttribute('x'));
    const py = Number(parent.getAttribute('y'));
    const pw = Number(parent.getAttribute('width'));
    const ph = Number(parent.getAttribute('height'));
    const kids = ['access', 'error'].map(byName);
    const inside = kids.every((k) => {
        const x = Number(k.getAttribute('x'));
        const y = Number(k.getAttribute('y'));
        return x >= px - 0.5 && y >= py - 0.5
            && x + Number(k.getAttribute('width')) <= px + pw + 0.5
            && y + Number(k.getAttribute('height')) <= py + ph + 0.5;
    });
    check('children nested inside their parent', inside);
}

// ---- 4b. SVG の高さとタイルが整合する（見切れ防止） ---------------------------
console.log('\n[4b] tiles fit inside the SVG for every chrome combination');
{
    const svgH = () => Number(doc.querySelector('svg').getAttribute('height'));
    const bottomMost = () =>
        Math.max(...tiles().map((t) => Number(t.getAttribute('y')) + Number(t.getAttribute('height'))));
    const rightMost = () =>
        Math.max(...tiles().map((t) => Number(t.getAttribute('x')) + Number(t.getAttribute('width'))));

    // パンくず・凡例・注記は SVG の外の行なので、その分 SVG が縮み、
    // タイルはその中に収まらなければならない（過去に凡例ぶんの引き忘れで見切れた）
    await setData(TWO_LEVEL);
    await setOpts({ animate: false });
    check('breadcrumb on: tiles inside svg', bottomMost() <= svgH() + 0.5, `${bottomMost()} vs ${svgH()}`);
    check('breadcrumb on: tiles inside width', rightMost() <= VW + 0.5, `${rightMost()} vs ${VW}`);

    await setOpts({ animate: false, showLegend: true });
    check('legend on: svg shrinks for the legend row', svgH() <= VH - 22, `svgH=${svgH()}`);
    check('legend on: tiles inside svg', bottomMost() <= svgH() + 0.5, `${bottomMost()} vs ${svgH()}`);

    await setOpts({ animate: false, showBreadcrumb: false, showLegend: false });
    check('no chrome: svg uses full height', svgH() === VH, `svgH=${svgH()}`);
    check('no chrome: tiles inside svg', bottomMost() <= svgH() + 0.5, `${bottomMost()} vs ${svgH()}`);

    // 注記が出るデータ（負の値）でも収まる
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: [['a', '50'], ['b', '-10'], ['c', '30']],
    });
    await setOpts({ animate: false });
    check('with note row: tiles inside svg', bottomMost() <= svgH() + 0.5, `${bottomMost()} vs ${svgH()}`);

    await setData(TWO_LEVEL);
    await setOpts({ animate: false });
}

// ---- 4c. ラベルがタイルからはみ出さない ----------------------------------------
console.log('\n[4c] labels stay within their tiles');
{
    const LONG = {
        fields: [{ name: 'g' }, { name: 'name' }, { name: 'v' }],
        rows: [
            ['group-alpha', 'very-long-sourcetype-name-here', '400'],
            ['group-alpha', 'b', '200'],
            ['group-beta', 'another-extremely-long-label-x', '250'],
            ['group-beta', 'd', '50'],
        ],
    };
    await setData(LONG);
    await setOpts({ animate: false });

    const textW = (s, fs) => {
        let acc = 0;
        for (const ch of String(s)) acc += ch.codePointAt(0) > 0x2e7f ? fs : fs * 0.62;
        return acc;
    };
    const labels = q('text[data-role="tm-label"]');
    check('long labels still render', labels.length > 0, `got ${labels.length}`);
    const outside = labels.filter((tx) => {
        const cx = Number(tx.getAttribute('x'));
        const fs = Number(tx.getAttribute('font-size'));
        const half = textW(tx.textContent, fs) / 2;
        return cx - half < -0.5 || cx + half > VW + 0.5;
    });
    check('no label spills outside the panel', outside.length === 0,
        outside.map((t) => t.textContent).join(','));

    // 見出しは「名前＋値」が入らなければ値を捨てて名前を優先する
    const heads = q('text[data-role="tm-header"]');
    check('group headers rendered', heads.length === 2, `got ${heads.length}`);
    check('headers not truncated when they fit',
        heads.every((h) => !h.textContent.startsWith('…')), heads.map((h) => h.textContent).join(' | '));

    await setData(TWO_LEVEL);
    await setOpts({ animate: false });
}

// ---- 4d. 親の角丸が子に潰されない -------------------------------------------------
console.log('\n[4d] parent corners stay visible behind children');
{
    await setData(TWO_LEVEL);
    await setOpts({ animate: false, tileRadius: 3 });

    const bottomOf = (t) => Number(t.getAttribute('y')) + Number(t.getAttribute('height'));
    const rightOf = (t) => Number(t.getAttribute('x')) + Number(t.getAttribute('width'));

    // 親（グループ）の下辺・右辺と、その子の下辺・右辺の間には、
    // 角丸の半径ぶん以上の余白が必要。ここが 1px しかないと、子の直線的な縁が
    // 親の丸みを覆って「角が立っている＝見切れている」ように見える。
    const parents = groups();
    check('group tiles exist', parents.length === 3, `got ${parents.length}`);

    let worstBottom = Infinity;
    let worstRight = Infinity;
    for (const p of parents) {
        const px = Number(p.getAttribute('x'));
        const py = Number(p.getAttribute('y'));
        const pw = Number(p.getAttribute('width'));
        const ph = Number(p.getAttribute('height'));
        // この親の内側にある葉タイルを集める
        const kids = leaves().filter((k) => {
            const kx = Number(k.getAttribute('x'));
            const ky = Number(k.getAttribute('y'));
            return kx >= px - 0.5 && ky >= py - 0.5
                && rightOf(k) <= px + pw + 0.5 && bottomOf(k) <= py + ph + 0.5;
        });
        if (kids.length === 0) continue;
        worstBottom = Math.min(worstBottom, py + ph - Math.max(...kids.map(bottomOf)));
        worstRight = Math.min(worstRight, px + pw - Math.max(...kids.map(rightOf)));
    }
    check('bottom clearance >= tileRadius', worstBottom >= 3, `worst=${worstBottom}`);
    check('right clearance >= tileRadius', worstRight >= 3, `worst=${worstRight}`);

    // 角丸を大きくしても内側余白が追従する
    await setOpts({ animate: false, tileRadius: 8 });
    let worst8 = Infinity;
    for (const p of groups()) {
        const py = Number(p.getAttribute('y'));
        const ph = Number(p.getAttribute('height'));
        const px = Number(p.getAttribute('x'));
        const pw = Number(p.getAttribute('width'));
        const kids = leaves().filter((k) => {
            const kx = Number(k.getAttribute('x'));
            const ky = Number(k.getAttribute('y'));
            return kx >= px - 0.5 && ky >= py - 0.5
                && rightOf(k) <= px + pw + 0.5 && bottomOf(k) <= py + ph + 0.5;
        });
        if (kids.length === 0) continue;
        worst8 = Math.min(worst8, py + ph - Math.max(...kids.map(bottomOf)));
    }
    check('larger radius widens the inner padding too', worst8 >= 8, `worst=${worst8}`);

    // 葉の角丸は親より小さい（同心円状の入れ子に見せる）
    await setOpts({ animate: false, tileRadius: 4 });
    const parentRx = Number(groups()[0].getAttribute('rx'));
    const leafRx = Number(leaves()[0].getAttribute('rx'));
    check('leaf radius is smaller than parent radius', leafRx < parentRx, `leaf=${leafRx} parent=${parentRx}`);
    check('leaf radius stays >= 1', leafRx >= 1, `leaf=${leafRx}`);

    // 角丸ゼロでも壊れない
    await setOpts({ animate: false, tileRadius: 0 });
    check('radius 0 renders square tiles', Number(tiles()[0].getAttribute('rx')) === 0,
        tiles()[0].getAttribute('rx'));
    check('radius 0 still renders every tile', tiles().length === 8, `got ${tiles().length}`);

    await setOpts({ animate: false });
}

// ---- 5. 重複行の合算 ---------------------------------------------------------
console.log('\n[5] duplicate rows are summed');
{
    await setData(DUPES);
    check('2 tiles (a, b)', leaves().length === 2, `got ${leaves().length}`);
    const a = areaOf(byName('a'));
    const b = areaOf(byName('b'));
    // a = 30+20 = 50, b = 40 → a > b
    check('a (30+20=50) larger than b (40)', a > b, `a=${a.toFixed(0)} b=${b.toFixed(0)}`);
}

// ---- 6. 1階層のみ -------------------------------------------------------------
console.log('\n[6] single-level data');
{
    await setData(ONE_LEVEL);
    check('3 leaf tiles', leaves().length === 3, `got ${leaves().length}`);
    check('no group tiles', groups().length === 0, `got ${groups().length}`);
    const a = areaOf(byName('a'));
    const c = areaOf(byName('c'));
    const r = a / c;
    check('a:c area ratio ≈ 2.5', Math.abs(r - 2.5) < 0.5, `ratio=${r.toFixed(2)}`);
}

// ---- 7. 3階層と maxDepth --------------------------------------------------------
console.log('\n[7] three-level data and maxDepth');
{
    await setData(THREE_LEVEL);
    await setOpts({ animate: false, maxDepth: 2 });
    const d2 = tiles().length;
    check('depth=2 shows index+sourcetype', d2 > 0, `got ${d2}`);
    check('no depth-3 tiles at maxDepth=2',
        tiles().every((t) => Number(t.getAttribute('data-depth')) <= 2));

    await setOpts({ animate: false, maxDepth: 3 });
    check('depth=3 adds host tiles',
        tiles().some((t) => Number(t.getAttribute('data-depth')) === 3),
        tiles().map((t) => t.getAttribute('data-depth')).join(','));
    check('h1/h2/h3 hosts rendered', ['h1', 'h2', 'h3'].every((n) => byName(n)));

    await setOpts({ animate: false, maxDepth: 1 });
    check('depth=1 shows only top level', tiles().length === 2, `got ${tiles().length}`);
    await setOpts({ animate: false });
}

// ---- 8. ドリルダウン ----------------------------------------------------------
console.log('\n[8] click-to-drill navigation');
{
    await setData(TWO_LEVEL);
    await setOpts({ animate: false });
    lastSetOptions = null;

    const web = byName('web');
    web.parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(300);

    check('setOptions called with drillPath', lastSetOptions && typeof lastSetOptions.drillPath === 'string',
        JSON.stringify(lastSetOptions));
    check('drillPath is "web"', lastSetOptions && lastSetOptions.drillPath === 'web',
        JSON.stringify(lastSetOptions));
    // web の中身（access, error）だけになる
    check('only web children shown', leaves().length === 2, `got ${leaves().length}`);
    check('db is gone after drill', !byName('db'), 'db still present');
    check('breadcrumb has 2 entries', crumbs().length === 2, `got ${crumbs().length}`);
    check('breadcrumb shows web', crumbs()[1] && crumbs()[1].textContent === 'web',
        crumbs().map((c) => c.textContent).join(' / '));

    // パンくずの「全体」で戻る
    crumbs()[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(300);
    check('back to root via breadcrumb', lastSetOptions && lastSetOptions.drillPath === '',
        JSON.stringify(lastSetOptions));
    check('all groups back', groups().length === 3, `got ${groups().length}`);
}

// ---- 9. ドリルダウン無効時 -----------------------------------------------------
console.log('\n[9] drilldown disabled');
{
    await setOpts({ animate: false, enableDrilldown: false });
    lastSetOptions = null;
    const web = byName('web');
    web.parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(250);
    check('no drill when disabled', lastSetOptions === null, JSON.stringify(lastSetOptions));
    await setOpts({ animate: false });
}

// ---- 10. 葉タイルは掘り下げられない --------------------------------------------
console.log('\n[10] leaf tiles are not drillable');
{
    await setOpts({ animate: false });
    lastSetOptions = null;
    const leaf = byName('auth'); // sec の唯一の子（葉）
    leaf.parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(250);
    check('clicking a leaf does nothing', lastSetOptions === null, JSON.stringify(lastSetOptions));
}

// ---- 10b. ホバーのツールチップと強調 ---------------------------------------------
console.log('\n[10b] hover tooltip and highlight');
{
    await setData(TWO_LEVEL);
    await setOpts({ animate: false });
    const tip = () => doc.querySelector('[data-role="tm-tooltip"]');
    const hoverRing = () => q('rect[data-role="tm-tile-hover"]');

    check('no tooltip before hover', !tip());

    const web = byName('web');
    web.parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 90 }));
    await sleep(200);

    check('tooltip appears on hover', Boolean(tip()));
    check('tooltip names the hovered branch',
        tip() && tip().textContent.includes('web'), tip() && tip().textContent.slice(0, 60));
    check('tooltip shows the value', tip() && tip().textContent.includes('600'),
        tip() && tip().textContent.slice(0, 80));
    check('tooltip shows share of total', tip() && tip().textContent.includes('60%'),
        tip() && tip().textContent.slice(0, 80));
    check('drillable tile hints at click',
        tip() && tip().textContent.includes('掘り下げ'), tip() && tip().textContent.slice(0, 120));
    check('hover ring drawn on drillable tile', hoverRing().length === 1, `got ${hoverRing().length}`);

    // 離れたら消える
    web.parentNode.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(200);
    check('tooltip cleared on leave', !tip());
    check('hover ring cleared on leave', hoverRing().length === 0);

    // 葉タイルでは「掘り下げ」ヒントを出さない
    const auth = byName('auth');
    auth.parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 200 }));
    await sleep(200);
    check('leaf tooltip has no drill hint',
        tip() && !tip().textContent.includes('掘り下げ'), tip() && tip().textContent.slice(0, 120));
    check('leaf tooltip shows its path',
        tip() && tip().textContent.includes('auth'), tip() && tip().textContent.slice(0, 60));
    auth.parentNode.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(150);
}

// ---- 10c. ツールチップがパネル外へ出ない -----------------------------------------
console.log('\n[10c] tooltip flips at the panel edges');
{
    const tip = () => doc.querySelector('[data-role="tm-tooltip"]');
    const boxOf = () => {
        const el = tip();
        if (!el) return null;
        return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width) };
    };
    const web = byName('web');

    // 右下の隅にカーソルを置く → 左上側へ折り返すはず
    web.parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: VW - 5, clientY: VH - 5 }));
    await sleep(200);
    const b = boxOf();
    check('tooltip rendered at bottom-right corner', Boolean(b), JSON.stringify(b));
    check('tooltip does not overflow right edge', b && b.left + b.width <= VW - 3,
        b && `${b.left}+${b.width} vs ${VW}`);
    check('tooltip stays within top bound', b && b.top >= 3, b && `top=${b.top}`);

    // 左上の隅 → 通常どおり右下側に出る
    web.parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 2, clientY: 2 }));
    await sleep(200);
    const b2 = boxOf();
    check('tooltip stays within left bound', b2 && b2.left >= 3, b2 && `left=${b2.left}`);
    web.parentNode.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(150);
}

// ---- 11. 表示オプション --------------------------------------------------------
console.log('\n[11] display options');
{
    await setOpts({ animate: false, showLabels: false });
    check('labels hidden', q('text[data-role="tm-label"]').length === 0);
    check('headers hidden too', q('text[data-role="tm-header"]').length === 0);

    await setOpts({ animate: false, showBreadcrumb: false });
    check('breadcrumb hidden', crumbs().length === 0);

    await setOpts({ animate: false, showGroupHeaders: false });
    check('group headers hidden', q('text[data-role="tm-header"]').length === 0);

    await setOpts({ animate: false, showLegend: true });
    check('legend shown', q('[data-role="tm-legend-item"]').length === 3,
        `got ${q('[data-role="tm-legend-item"]').length}`);

    await setOpts({ animate: false, showPercent: true });
    check('labels still render with percent on', q('text[data-role="tm-label"]').length > 0);

    await setOpts({ animate: false });
    check('labels back by default', q('text[data-role="tm-label"]').length > 0);
}

// ---- 12. タイル数の上限（「その他」への集約） ------------------------------------
console.log('\n[12] tile cap folds into "その他"');
{
    const many = {
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: Array.from({ length: 50 }, (_, i) => [`k${i}`, String(50 - i)]),
    };
    await setData(many);
    await setOpts({ animate: false, maxTiles: 10 });
    check('at most 10 tiles', tiles().length <= 10, `got ${tiles().length}`);
    check('"その他" tile present',
        tiles().some((t) => (t.getAttribute('data-name') || '').startsWith('その他')),
        tiles().map((t) => t.getAttribute('data-name')).join(','));
    await setOpts({ animate: false });
    await setData(TWO_LEVEL);
}

// ---- 13. 負の値・非数値の除外 ---------------------------------------------------
console.log('\n[13] negative and non-numeric rows excluded');
{
    const mixed = {
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: [
            ['a', '50'],
            ['b', '-20'],   // 面積で表せない
            ['c', 'abc'],   // 数値でない
            ['d', '30'],
        ],
    };
    await setData(mixed);
    check('2 tiles (a, d)', leaves().length === 2, `got ${leaves().length}`);
    check('negative notice shown', doc.body.textContent.includes('負の値'), doc.body.textContent.slice(-120));
    check('non-numeric notice shown', doc.body.textContent.includes('数値でない'), doc.body.textContent.slice(-120));
    await setData(TWO_LEVEL);
}

// ---- 14. テーマ切替 -------------------------------------------------------------
console.log('\n[14] theme switch');
{
    await setOpts({ animate: false });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const strokeLight = tiles()[0] && tiles()[0].getAttribute('stroke');
    check('light-mode tile stroke', strokeLight === 'rgba(255,255,255,0.75)', strokeLight);

    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const strokeDark = tiles()[0] && tiles()[0].getAttribute('stroke');
    check('dark-mode tile stroke', strokeDark === 'rgba(13,16,20,0.55)', strokeDark);
}

// ---- 15. 配色オプション ----------------------------------------------------------
console.log('\n[15] palette options');
{
    await setOpts({ animate: false, shadeChildren: false });
    const fills = new Set(leaves().map((t) => t.getAttribute('fill')));
    check('3 distinct colors without shading', fills.size === 3, Array.from(fills).join(','));
    check('uses color1 for first group', fills.has('#4c9be8'), Array.from(fills).join(','));

    await setOpts({ animate: false, shadeChildren: false, color1: '#ff0000' });
    check('color1 override applied',
        new Set(leaves().map((t) => t.getAttribute('fill'))).has('#ff0000'),
        leaves().map((t) => t.getAttribute('fill')).join(','));

    await setOpts({ animate: false });
    check('shading on gives parent/leaf different fills',
        new Set(tiles().map((t) => t.getAttribute('fill'))).size > 3,
        tiles().map((t) => t.getAttribute('fill')).join(','));
}

// ---- 16. アニメーション ----------------------------------------------------------
console.log('\n[16] fade-in animation completes');
{
    await setOpts({});
    await setData(TWO_LEVEL);
    await sleep(1200);
    check('tiles fully opaque after animation',
        tiles().every((t) => Number(t.getAttribute('opacity')) === 1),
        tiles().map((t) => t.getAttribute('opacity')).join(','));
    await setOpts({ animate: false });
}

// ---- 17. ガード -------------------------------------------------------------------
console.log('\n[17] guards');
{
    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', 'y'], ['p', 'q']] });
    check('no-value message', doc.body.textContent.includes('正の数値データ'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [['a', '0'], ['b', '0']] });
    check('all-zero treated as no value', doc.body.textContent.includes('正の数値データ'), doc.body.textContent.slice(0, 120));

    await setData(TWO_LEVEL);
    check('recovers after guard', groups().length === 3, `got ${groups().length}`);
}

// ---- 18. 存在しない drillPath へのフォールバック -----------------------------------
console.log('\n[18] stale drillPath falls back to root');
{
    await setOpts({ animate: false, drillPath: 'nonexistent-branch' });
    check('renders root when drillPath is unknown', groups().length === 3, `got ${groups().length}`);
    check('breadcrumb shows only root', crumbs().length === 1, `got ${crumbs().length}`);
    await setOpts({ animate: false });
}

// ---- 19. debug オーバーレイ ---------------------------------------------------------
console.log('\n[19] debug overlay');
{
    await setOpts({ animate: false, debug: true });
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
    check('version shown', doc.body.textContent.includes('1.1.0'));
    await setOpts({ animate: false });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
