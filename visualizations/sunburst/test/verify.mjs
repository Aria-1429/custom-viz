// Sunburst viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_sunburst', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const VW = 600;
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
// 2階層。合計 1000。web:600(access400/error200) db:300(query250/slow50) sec:100(auth100)
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

// 1階層（a=50, b=30, c=20 → 合計100）
const ONE_LEVEL = {
    fields: [{ name: 'host' }, { name: 'bytes' }],
    rows: [['a', '50'], ['b', '30'], ['c', '20']],
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

// 重複行（合算されるはず）
const DUPES = {
    fields: [{ name: 'k' }, { name: 'v' }],
    rows: [['a', '30'], ['b', '40'], ['a', '20']],
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
// eslint-disable-next-line no-eval
(0, eval)(readFileSync(BUNDLE, 'utf8'));
await sleep(400);

const q = (sel) => Array.from(doc.querySelectorAll(sel));
const slices = () => q('path[data-role="sb-slice"]');
const atDepth = (d) => slices().filter((s) => Number(s.getAttribute('data-depth')) === d);
const byName = (n) => slices().find((s) => s.getAttribute('data-name') === n);
const crumbs = () => q('button[data-role="sb-crumb"]');

// 扇形のパスから幾何を読む。
// 注意: "A rx ry rot large sweep x y" の rx/ry/フラグは座標ではないので、
// 数値を無差別に2つずつ組にすると座標として誤読する（最初これで測り違えた）。
// M/L は末尾2つ、A は末尾2つだけが実際の点。
const CX = 8 + (VW - 16) / 2;

function pointsOf(pathEl) {
    const d = pathEl.getAttribute('d') || '';
    const pts = [];
    // コマンド文字ごとに分割して、各セグメントの「終点」だけを拾う
    const segs = d.match(/[MLAQ][^MLAQZ]*/g) || [];
    for (const seg of segs) {
        const cmd = seg[0];
        const nums = (seg.slice(1).match(/-?\d+(\.\d+)?/g) || []).map(Number);
        if (nums.length < 2) continue;
        if (cmd === 'A' && nums.length >= 7) {
            pts.push([nums[5], nums[6]]);
        } else {
            pts.push([nums[nums.length - 2], nums[nums.length - 1]]);
        }
    }
    return pts;
}

// 扇形が覆う角度範囲。起点(-90度=真上)を 0 とした 0..2π で返す。
function anglesOf(pathEl, cy) {
    const pts = pointsOf(pathEl);
    if (pts.length === 0) return null;
    // 起点を -90 度に合わせて 0..2π へ正規化
    const norm = (a) => {
        let v = a + Math.PI / 2;
        while (v < -1e-9) v += Math.PI * 2;
        while (v >= Math.PI * 2 - 1e-9) v -= Math.PI * 2;
        return v;
    };
    const angs = pts.map(([x, y]) => norm(Math.atan2(y - cy, x - CX)));
    return { min: Math.min(...angs), max: Math.max(...angs) };
}

// 扇形の角度幅。large-arc フラグ（180度超か）と端点の差から求める。
function spanOfPath(pathEl, cy) {
    const a = anglesOf(pathEl, cy);
    if (!a) return 0;
    const d = pathEl.getAttribute('d') || '';
    const m = d.match(/A\s+[\d.]+\s+[\d.]+\s+\d+\s+(\d)\s+\d/);
    const large = m ? m[1] === '1' : false;
    let s = a.max - a.min;
    // 端点の差が π を超える＝起点をまたいでいる、または 180 度超の扇形
    if (large && s < Math.PI) s = Math.PI * 2 - s;
    else if (!large && s > Math.PI) s = Math.PI * 2 - s;
    return s;
}

// ---- 1. 基本描画 -------------------------------------------------------------
console.log('\n[1] two-level sunburst renders');
{
    check('3 slices in ring 1', atDepth(1).length === 3, `got ${atDepth(1).length}`);
    check('5 slices in ring 2', atDepth(2).length === 5, `got ${atDepth(2).length}`);
    check('web/db/sec present', ['web', 'db', 'sec'].every(byName),
        slices().map((s) => s.getAttribute('data-name')).join(','));
    check('all slices have a path', slices().every((s) => (s.getAttribute('d') || '').length > 10));
}

// ---- 2. 角度が値に比例する（サンバーストの核心） -------------------------------
console.log('\n[2] slice angles are proportional to values');
{
    const cy = 8 + (VH - 8 * 2 - 22) / 2; // パンくず22pxぶんを引いた描画領域の中心
    const spanOf = (name) => spanOfPath(byName(name), cy);
    const web = spanOf('web');
    const db = spanOf('db');
    const sec = spanOf('sec');
    check('ring1 spans ordered web>db>sec', web > db && db > sec,
        `web=${web.toFixed(3)} db=${db.toFixed(3)} sec=${sec.toFixed(3)}`);
    // web(600):db(300) = 2:1
    check('web:db angle ratio ≈ 2', Math.abs(web / db - 2) < 0.25, `ratio=${(web / db).toFixed(2)}`);
    // db(300):sec(100) = 3:1
    check('db:sec angle ratio ≈ 3', Math.abs(db / sec - 3) < 0.5, `ratio=${(db / sec).toFixed(2)}`);
    // 合計は全周（2π）に近い（隙間ぶんだけ小さい）
    const sum = web + db + sec;
    check('ring1 spans sum to a full circle', Math.abs(sum - Math.PI * 2) < 0.15,
        `sum=${sum.toFixed(3)} vs ${(Math.PI * 2).toFixed(3)}`);
}

// ---- 3. 輪の半径が階層ごとに外へ広がる ------------------------------------------
console.log('\n[3] rings expand outward by depth');
{
    const cy = 8 + (VH - 8 * 2 - 22) / 2;
    const radiiOf = (el) => pointsOf(el).map(([x, y]) => Math.hypot(x - CX, y - cy));
    const r1 = radiiOf(byName('web'));
    const r2 = radiiOf(byName('access'));
    check('ring1 has an inner hole', Math.min(...r1) > 20, `min=${Math.min(...r1).toFixed(1)}`);
    check('ring2 sits outside ring1', Math.min(...r2) >= Math.max(...r1) - 2,
        `ring2min=${Math.min(...r2).toFixed(1)} ring1max=${Math.max(...r1).toFixed(1)}`);
}

// ---- 4. 子が親の角度範囲に収まる（包含関係） -------------------------------------
console.log('\n[4] children nest inside their parent angular range');
{
    const cy = 8 + (VH - 8 * 2 - 22) / 2;
    // 角度は 0..2π で折り返すため範囲の直接比較は壊れやすい。
    // 「子の角度幅の合計が親の角度幅と一致する」ことで包含関係を確かめる
    // （子は親を必ず埋め尽くすので、はみ出していれば合計がずれる）。
    const parentSpan = spanOfPath(byName('db'), cy);
    const kidSpan = ['query', 'slow'].reduce((s, n) => s + spanOfPath(byName(n), cy), 0);
    check('db children fill exactly the db wedge', Math.abs(parentSpan - kidSpan) < 0.06,
        `parent=${parentSpan.toFixed(3)} kids=${kidSpan.toFixed(3)}`);

    // web(600) も同様。access(400)+error(200) = web
    const webSpan = spanOfPath(byName('web'), cy);
    const webKids = ['access', 'error'].reduce((s, n) => s + spanOfPath(byName(n), cy), 0);
    check('web children fill exactly the web wedge', Math.abs(webSpan - webKids) < 0.06,
        `parent=${webSpan.toFixed(3)} kids=${webKids.toFixed(3)}`);

    // 比率も確認: query(250):slow(50) = 5:1
    const qs = spanOfPath(byName('query'), cy) / spanOfPath(byName('slow'), cy);
    check('query:slow angle ratio ≈ 5', Math.abs(qs - 5) < 0.8, `ratio=${qs.toFixed(2)}`);
}

// ---- 4b. 角丸で扇形がえぐれない -------------------------------------------------------
console.log('\n[4b] rounded corners do not carve notches');
{
    await setData(TWO_LEVEL);
    await setOpts({ animate: false, cornerRadius: 4 });
    const cy = 8 + (VH - 8 * 2 - 22) / 2;

    // 同じ輪の扇形は厚み（外周半径 - 内周半径）がそろっているべき。
    // 角丸の作り方を誤って半径方向と角度方向のオフセットを混ぜると、
    // 内側の角がえぐれて厚みが狂う（v1.0.0 の不具合）。
    const thicknessOf = (el) => {
        const rs = pointsOf(el).map(([x, y]) => Math.hypot(x - CX, y - cy));
        return Math.max(...rs) - Math.min(...rs);
    };
    for (const d of [1, 2]) {
        const ts = atDepth(d).map(thicknessOf);
        const spread = Math.max(...ts) - Math.min(...ts);
        check(`ring ${d} slices share one thickness`, spread < 3,
            `spread=${spread.toFixed(2)} values=${ts.map((t) => t.toFixed(1)).join(',')}`);
    }

    // 角丸を大きくしても、角丸なしと厚みが変わらない
    const thickRounded = thicknessOf(byName('web'));
    await setOpts({ animate: false, cornerRadius: 0 });
    const thickSquare = thicknessOf(byName('web'));
    check('corner radius does not change ring thickness',
        Math.abs(thickRounded - thickSquare) < 2, `rounded=${thickRounded.toFixed(1)} square=${thickSquare.toFixed(1)}`);

    // 角丸が輪の厚みより大きくても壊れない
    await setOpts({ animate: false, cornerRadius: 12 });
    check('oversized corner radius still renders every slice', slices().length === 8, `got ${slices().length}`);
    const ts2 = atDepth(1).map(thicknessOf);
    check('oversized radius keeps thickness uniform',
        Math.max(...ts2) - Math.min(...ts2) < 3, ts2.map((t) => t.toFixed(1)).join(','));

    await setOpts({ animate: false });
}

// ---- 4c. 階層はデータの深さぶんだけ辿れる ----------------------------------------------
console.log('\n[4c] drilling is not capped by the visible ring count');
{
    // ラベル列6つ（＝6階層）のデータ。maxDepth=3 は「一度に見せる輪の数」であって
    // データの深さを制限しない。クリックし続ければ最深部まで到達できる。
    const DEEP = {
        fields: [
            { name: 'L1' }, { name: 'L2' }, { name: 'L3' },
            { name: 'L4' }, { name: 'L5' }, { name: 'L6' }, { name: 'v' },
        ],
        rows: [
            ['a', 'b', 'c', 'd', 'e', 'f', '100'],
            ['a', 'b', 'c', 'd', 'e', 'g', '50'],
            ['a', 'b', 'c', 'x', 'y', 'z', '30'],
            ['p', 'q', 'r', 's', 't', 'u', '80'],
        ],
    };
    await setData(DEEP);
    await setOpts({ animate: false, maxDepth: 3 });

    check('only 3 rings shown at once', [...new Set(slices().map((s) => Number(s.getAttribute('data-depth'))))].length === 3,
        slices().map((s) => s.getAttribute('data-depth')).join(','));
    // 輪の上限に当たっただけの枝は葉ではない（まだ子がいる）
    const ring3 = slices().filter((s) => Number(s.getAttribute('data-depth')) === 3);
    check('outermost ring is not marked as leaf', ring3.every((s) => s.getAttribute('data-leaf') === '0'),
        ring3.map((s) => `${s.getAttribute('data-name')}=${s.getAttribute('data-leaf')}`).join(' '));

    // 5段掘る（旧実装は4階層で頭打ちだった）
    for (const step of ['a', 'b', 'c', 'd', 'e']) {
        const el = byName(step);
        check(`can reach "${step}"`, Boolean(el), `slices=${slices().map((s) => s.getAttribute('data-name')).join(',')}`);
        if (!el) break;
        el.parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await sleep(250);
    }
    check('breadcrumb reflects 5 levels deep', crumbs().length === 6, `got ${crumbs().length}`);
    check('deepest level shows its leaves', slices().length > 0, `got ${slices().length}`);

    await setOpts({ animate: false });
    await setData(TWO_LEVEL);
}

// ---- 5. 重複行の合算 -------------------------------------------------------------
console.log('\n[5] duplicate rows are summed');
{
    await setData(DUPES);
    check('2 slices (a, b)', atDepth(1).length === 2, `got ${atDepth(1).length}`);
    const cy = 8 + (VH - 8 * 2 - 22) / 2;
    const spanOf = (name) => spanOfPath(byName(name), cy);
    // a = 30+20 = 50 > b = 40
    check('a (30+20=50) wider than b (40)', spanOf('a') > spanOf('b'),
        `a=${spanOf('a').toFixed(3)} b=${spanOf('b').toFixed(3)}`);
}

// ---- 6. 1階層のみ ----------------------------------------------------------------
console.log('\n[6] single-level data');
{
    await setData(ONE_LEVEL);
    check('3 slices in ring 1', atDepth(1).length === 3, `got ${atDepth(1).length}`);
    check('no ring 2', atDepth(2).length === 0, `got ${atDepth(2).length}`);
}

// ---- 7. 3階層と maxDepth ----------------------------------------------------------
console.log('\n[7] three-level data and maxDepth');
{
    await setData(THREE_LEVEL);
    await setOpts({ animate: false, maxDepth: 3 });
    check('ring 3 rendered', atDepth(3).length > 0, `got ${atDepth(3).length}`);
    check('h1/h2/h3 present', ['h1', 'h2', 'h3'].every(byName));

    await setOpts({ animate: false, maxDepth: 2 });
    check('maxDepth=2 drops ring 3', atDepth(3).length === 0, `got ${atDepth(3).length}`);

    await setOpts({ animate: false, maxDepth: 1 });
    check('maxDepth=1 shows only ring 1', slices().length === 2, `got ${slices().length}`);
    await setOpts({ animate: false });
}

// ---- 8. ドリルダウン ---------------------------------------------------------------
console.log('\n[8] click-to-drill navigation');
{
    await setData(TWO_LEVEL);
    await setOpts({ animate: false });
    lastSetOptions = null;

    byName('web').parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(300);
    check('setOptions called with drillPath', lastSetOptions && typeof lastSetOptions.drillPath === 'string',
        JSON.stringify(lastSetOptions));
    check('drillPath is "web"', lastSetOptions && lastSetOptions.drillPath === 'web', JSON.stringify(lastSetOptions));
    check('only web children shown', atDepth(1).length === 2, `got ${atDepth(1).length}`);
    check('db is gone after drill', !byName('db'));
    check('breadcrumb has 2 entries', crumbs().length === 2, `got ${crumbs().length}`);

    // 中央クリックで1つ戻る
    const center = doc.querySelector('g[data-role="sb-center"]');
    check('center KPI rendered', Boolean(center));
    center.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(300);
    check('center click goes back to root', lastSetOptions && lastSetOptions.drillPath === '',
        JSON.stringify(lastSetOptions));
    check('all ring1 slices back', atDepth(1).length === 3, `got ${atDepth(1).length}`);

    // パンくずでも戻れる
    byName('web').parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(250);
    crumbs()[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(250);
    check('breadcrumb root restores full chart', atDepth(1).length === 3, `got ${atDepth(1).length}`);
}

// ---- 9. ドリルダウン無効・葉は掘れない ---------------------------------------------
console.log('\n[9] drilldown disabled / leaves not drillable');
{
    await setOpts({ animate: false, enableDrilldown: false });
    lastSetOptions = null;
    byName('web').parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(250);
    check('no drill when disabled', lastSetOptions === null, JSON.stringify(lastSetOptions));

    await setOpts({ animate: false });
    lastSetOptions = null;
    byName('auth').parentNode.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(250);
    check('clicking a leaf does nothing', lastSetOptions === null, JSON.stringify(lastSetOptions));
}

// ---- 10. ホバーのツールチップ --------------------------------------------------------
console.log('\n[10] hover tooltip');
{
    await setOpts({ animate: false });
    const tip = () => doc.querySelector('[data-role="sb-tooltip"]');
    const svg = doc.querySelector('svg');
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(120);
    check('no tooltip before hover', !tip());

    byName('web').parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 150 }));
    await sleep(200);
    check('tooltip appears on hover', Boolean(tip()));
    check('tooltip names the branch', tip() && tip().textContent.includes('web'), tip() && tip().textContent.slice(0, 60));
    check('tooltip shows value', tip() && tip().textContent.includes('600'), tip() && tip().textContent.slice(0, 80));
    check('tooltip shows share', tip() && tip().textContent.includes('60%'), tip() && tip().textContent.slice(0, 80));
    check('drillable slice hints at click', tip() && tip().textContent.includes('掘り下げ'));

    // 端でも枠内に収まる
    byName('web').parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: VW - 3, clientY: VH - 3 }));
    await sleep(150);
    const el = tip();
    const left = parseFloat(el.style.left);
    const width = parseFloat(el.style.width);
    check('tooltip stays inside the panel', left >= 3 && left + width <= VW - 3, `left=${left} w=${width}`);

    byName('web').parentNode.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(150);
    check('tooltip cleared on leave', !tip());
}

// ---- 10b. ホバー時に系統以外を暗くする -------------------------------------------------
console.log('\n[10b] hover dims everything outside the lineage');
{
    // 3階層データで「祖先＋自分＋子孫」だけが明るく残ることを確かめる
    const TRI = {
        fields: [{ name: 'index' }, { name: 'sourcetype' }, { name: 'host' }, { name: 'v' }],
        rows: [
            ['web', 'access', 'web-01', '400'],
            ['web', 'error', 'web-02', '200'],
            ['db', 'query', 'db-01', '250'],
            ['security', 'auth', 'auth-01', '100'],
            ['security', 'firewall', 'fw-01', '150'],
        ],
    };
    await setData(TRI);
    await setOpts({ animate: false });
    const svg = doc.querySelector('svg');
    const opacityOf = (n) => Number(byName(n).getAttribute('opacity'));
    const isDim = (n) => opacityOf(n) < 0.5;

    check('nothing dimmed before hover', slices().every((s) => Number(s.getAttribute('opacity')) >= 0.9),
        slices().map((s) => s.getAttribute('opacity')).join(','));

    // 中間階層 firewall をホバー: 祖先 security と子孫 fw-01 は明るいまま
    byName('firewall').parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 200 }));
    await sleep(200);
    check('hovered slice stays bright', !isDim('firewall'), `opacity=${opacityOf('firewall')}`);
    check('ancestor stays bright', !isDim('security'), `opacity=${opacityOf('security')}`);
    check('descendant stays bright', !isDim('fw-01'), `opacity=${opacityOf('fw-01')}`);
    check('sibling is dimmed', isDim('auth'), `opacity=${opacityOf('auth')}`);
    check('sibling subtree is dimmed', isDim('auth-01'), `opacity=${opacityOf('auth-01')}`);
    check('unrelated branch is dimmed', isDim('web') && isDim('access') && isDim('db'),
        `web=${opacityOf('web')} access=${opacityOf('access')} db=${opacityOf('db')}`);

    // 最内周をホバー: その配下すべてが明るい
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(150);
    byName('web').parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 }));
    await sleep(200);
    check('whole subtree of a root branch stays bright',
        !isDim('web') && !isDim('access') && !isDim('error') && !isDim('web-01') && !isDim('web-02'),
        `web=${opacityOf('web')} access=${opacityOf('access')} web-01=${opacityOf('web-01')}`);
    check('other root branches are dimmed', isDim('db') && isDim('security'),
        `db=${opacityOf('db')} security=${opacityOf('security')}`);

    // 円の外へ抜けたら必ず戻る（扇形の onMouseLeave だけでは取りこぼしていた）
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(200);
    check('leaving the chart restores every slice',
        slices().every((s) => Number(s.getAttribute('opacity')) >= 0.9),
        slices().map((s) => s.getAttribute('opacity')).join(','));

    // ラベルも扇形と一緒に暗くなる
    byName('web').parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 }));
    await sleep(200);
    const labels = q('text[data-role="sb-label"]');
    const dimLabels = labels.filter((t) => Number(t.getAttribute('opacity')) < 0.5);
    check('labels dim along with their slices', dimLabels.length > 0,
        labels.map((t) => `${t.textContent}=${t.getAttribute('opacity')}`).join(' '));
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    await sleep(150);

    // オプションで無効化できる
    await setOpts({ animate: false, dimOthers: false });
    byName('web').parentNode.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300 }));
    await sleep(200);
    check('dimming can be turned off', slices().every((s) => Number(s.getAttribute('opacity')) >= 0.9),
        slices().map((s) => s.getAttribute('opacity')).join(','));
    svg.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));

    await setOpts({ animate: false });
    await setData(TWO_LEVEL);
}

// ---- 11. 細い扇形の集約 ---------------------------------------------------------------
console.log('\n[11] tiny slices fold into "その他"');
{
    // 1件だけ大きく、残り30件が極小 → 極小は集約される
    const many = {
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: [['big', '10000'], ...Array.from({ length: 30 }, (_, i) => [`t${i}`, '1'])],
    };
    await setData(many);
    await setOpts({ animate: false, minAnglePercent: 1 });
    check('slice count reduced by folding', atDepth(1).length < 31, `got ${atDepth(1).length}`);
    check('"その他" slice present',
        slices().some((s) => (s.getAttribute('data-name') || '').startsWith('その他')),
        slices().map((s) => s.getAttribute('data-name')).join(','));

    // 集約なしにすると全部出る
    await setOpts({ animate: false, minAnglePercent: 0 });
    check('no folding when threshold is 0', atDepth(1).length === 31, `got ${atDepth(1).length}`);
    await setOpts({ animate: false });
    await setData(TWO_LEVEL);
}

// ---- 12. 表示オプション -----------------------------------------------------------------
console.log('\n[12] display options');
{
    await setOpts({ animate: false, showLabels: false });
    check('labels hidden', q('text[data-role="sb-label"]').length === 0);

    await setOpts({ animate: false, showCenter: false });
    check('center hidden', !doc.querySelector('g[data-role="sb-center"]'));

    await setOpts({ animate: false, showBreadcrumb: false });
    check('breadcrumb hidden', crumbs().length === 0);

    await setOpts({ animate: false, showLegend: true });
    check('legend shown', q('[data-role="sb-legend-item"]').length === 3,
        `got ${q('[data-role="sb-legend-item"]').length}`);

    await setOpts({ animate: false, innerRadiusPercent: 0 });
    check('inner radius 0 still renders', slices().length === 8, `got ${slices().length}`);

    await setOpts({ animate: false, cornerRadius: 0 });
    check('corner radius 0 still renders', slices().every((s) => (s.getAttribute('d') || '').length > 10));

    await setOpts({ animate: false });
    check('labels back by default', q('text[data-role="sb-label"]').length > 0);
}

// ---- 13. 配色オプション -----------------------------------------------------------------
console.log('\n[13] palette options');
{
    await setOpts({ animate: false, fadeChildren: false });
    const fills = new Set(atDepth(1).map((s) => s.getAttribute('fill')));
    check('3 distinct ring-1 colors', fills.size === 3, Array.from(fills).join(','));
    check('uses 1st default palette entry for the first branch', fills.has('#4c9be8'), Array.from(fills).join(','));

    // editor.seriesColors は hex 文字列の配列を生で渡してくる
    await setOpts({ animate: false, fadeChildren: false, seriesColors: ['#ff0000', '#00ff00'] });
    check('seriesColors override applied',
        new Set(atDepth(1).map((s) => s.getAttribute('fill'))).has('#ff0000'),
        atDepth(1).map((s) => s.getAttribute('fill')).join(','));
    // パレットが扇形数より短くても循環して埋まる（既定色に落ちない）
    check('short palette cycles instead of falling back',
        atDepth(1).every((s) => ['#ff0000', '#00ff00'].includes(s.getAttribute('fill'))),
        atDepth(1).map((s) => s.getAttribute('fill')).join(','));

    // 旧 color1..colorN は読まない（既定値はoptionsに載らない罠の回帰）
    await setOpts({ animate: false, fadeChildren: false, color1: '#ff0000', color2: '#00ff00' });
    const legacyFills = atDepth(1).map((s) => s.getAttribute('fill'));
    check('legacy color1 ignored', !legacyFills.includes('#ff0000'), legacyFills.join(','));
    check('falls back to default palette', legacyFills.includes('#4c9be8'), legacyFills.join(','));

    await setOpts({ animate: false });
    check('fade makes ring2 differ from ring1',
        new Set(slices().map((s) => s.getAttribute('fill'))).size > 3,
        slices().map((s) => s.getAttribute('fill')).join(','));
}

// ---- 14. 負の値・非数値の除外 -------------------------------------------------------------
console.log('\n[14] negative and non-numeric rows excluded');
{
    await setData({
        fields: [{ name: 'k' }, { name: 'v' }],
        rows: [['a', '50'], ['b', '-20'], ['c', 'abc'], ['d', '30']],
    });
    check('2 slices (a, d)', atDepth(1).length === 2, `got ${atDepth(1).length}`);
    check('negative notice shown', doc.body.textContent.includes('負の値'), doc.body.textContent.slice(-120));
    check('non-numeric notice shown', doc.body.textContent.includes('数値でない'), doc.body.textContent.slice(-120));
    await setData(TWO_LEVEL);
}

// ---- 15. テーマ切替 -----------------------------------------------------------------------
console.log('\n[15] theme switch');
{
    await setOpts({ animate: false });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    check('light-mode slice stroke', slices()[0].getAttribute('stroke') === 'rgba(255,255,255,0.8)',
        slices()[0].getAttribute('stroke'));

    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    check('dark-mode slice stroke', slices()[0].getAttribute('stroke') === 'rgba(13,16,20,0.55)',
        slices()[0].getAttribute('stroke'));
}

// ---- 16. アニメーション -------------------------------------------------------------------
console.log('\n[16] animation completes');
{
    await setOpts({});
    await setData(TWO_LEVEL);
    await sleep(1200);
    check('all slices drawn after animation', slices().length === 8, `got ${slices().length}`);
    check('labels appear once animation settles', q('text[data-role="sb-label"]').length > 0);
    await setOpts({ animate: false });
}

// ---- 17. ガード ---------------------------------------------------------------------------
console.log('\n[17] guards');
{
    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', 'y'], ['p', 'q']] });
    check('no-value message', doc.body.textContent.includes('正の数値データ'), doc.body.textContent.slice(0, 120));

    await setData({ fields: [{ name: 'k' }, { name: 'v' }], rows: [['a', '0'], ['b', '0']] });
    check('all-zero treated as no value', doc.body.textContent.includes('正の数値データ'));

    await setData(TWO_LEVEL);
    check('recovers after guard', atDepth(1).length === 3, `got ${atDepth(1).length}`);
}

// ---- 18. 存在しない drillPath へのフォールバック -----------------------------------------------
console.log('\n[18] stale drillPath falls back to root');
{
    await setOpts({ animate: false, drillPath: 'nonexistent' });
    check('renders root when drillPath is unknown', atDepth(1).length === 3, `got ${atDepth(1).length}`);
    check('breadcrumb shows only root', crumbs().length === 1, `got ${crumbs().length}`);
    await setOpts({ animate: false });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
