// KPI Tile viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_kpi_tile', 'visualization.js'
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

const FIELDS = [{ name: '_time' }, { name: '重大アラート' }];
const VALS = [5, 9, 7, 12, 10, 14, 11, 16, 13, 18, 15, 20, 17, 22, 19, 24, 21, 26, 8, 23];
const ROWS = VALS.map((v, i) => [`2026-07-${String(i + 1).padStart(2, '0')}`, String(v)]);

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: { animate: false },
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
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 基本描画（dark, animate off） ----------------------------------------
console.log('\n[1] basic tile (dark)');
{
    const body = doc.body.textContent;
    check('title 重大アラート shown', body.includes('重大アラート'), body.slice(0, 120));
    check('big value 23 shown', body.includes('23'));
    check('delta ↑ 15 (前日比) shown', body.includes('↑ 15 (前日比)'), body.slice(0, 200));
    const spark = doc.querySelector('svg[data-role="spark"]');
    check('sparkline svg rendered', !!spark);
    const rects = [...doc.querySelectorAll('svg[data-role="spark"] rect')];
    check('20 spark bars', rects.length === 20, `got ${rects.length}`);
    check('bars use accent color', rects.every((r) => r.getAttribute('fill') === '#22d3ee'),
        rects[0] && rects[0].getAttribute('fill'));
    check('icon badge rendered', !!doc.querySelector('[data-role="icon-badge"]'));
    check('default icon is shield', !!doc.querySelector('[data-role="icon-badge"] svg path[d^="M12 3l7 3"]'));
    check('no picker in view mode', !doc.querySelector('[data-role="icon-picker"]'));
}

// ---- 2. 増減の％表示 ---------------------------------------------------------
console.log('\n[2] deltaAsPercent');
{
    await setOpts({ animate: false, deltaAsPercent: true });
    const body = doc.body.textContent;
    // 100%以上は整数に丸め、100%未満は小数1桁（画像の「18.7%」相当）
    check('delta as percent 188%', body.includes('↑ 188% (前日比)'), body.slice(0, 200));
}

// ---- 3. 増減の色分け ---------------------------------------------------------
console.log('\n[3] semanticDeltaColor');
{
    await setOpts({ animate: false, semanticDeltaColor: true });
    let deltaEl = [...doc.querySelectorAll('div')].find((d) => d.textContent.startsWith('↑ 15'));
    check('up delta is green', deltaEl && deltaEl.style.color === '#3fb950', deltaEl && deltaEl.style.color);

    await setOpts({ animate: false, semanticDeltaColor: true, invertDeltaColor: true });
    deltaEl = [...doc.querySelectorAll('div')].find((d) => d.textContent.startsWith('↑ 15'));
    check('inverted up delta is red', deltaEl && deltaEl.style.color === '#f85149', deltaEl && deltaEl.style.color);

    // 減少ケース（最後を 3 に）
    state.data = { fields: FIELDS, rows: [...ROWS.slice(0, 19), ['2026-07-20', '3']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({ animate: false, semanticDeltaColor: true });
    deltaEl = [...doc.querySelectorAll('div')].find((d) => d.textContent.startsWith('↓ 5'));
    check('down delta is red', deltaEl && deltaEl.style.color === '#f85149', deltaEl && deltaEl.style.color);
    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
}

// ---- 4. フィールド選択（columnSelector DOS 文字列） --------------------------
console.log('\n[4] field selection via DOS string');
{
    state.data = {
        fields: [{ name: '_time' }, { name: 'blocked' }, { name: 'users' }],
        rows: [
            ['t1', '100', '7'],
            ['t2', '150', '8'],
            ['t3', '130', '9'],
        ],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({ animate: false, valueField: "> primary | seriesByName('blocked')" });
    const body = doc.body.textContent;
    check('title = selected field name (blocked)', body.includes('blocked'), body.slice(0, 120));
    check('value from blocked (130)', body.includes('130'));
    check('delta ↓ 20', body.includes('↓ 20'), body.slice(0, 200));
}

// ---- 5. 省略表記・小数桁 ------------------------------------------------------
console.log('\n[5] abbreviate / decimals');
{
    state.data = {
        fields: [{ name: '_time' }, { name: 'ブロック数' }],
        rows: [['t1', '1,224,510'], ['t2', '1,452,389']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({ animate: false });
    check('comma formatting 1,452,389', doc.body.textContent.includes('1,452,389'), doc.body.textContent.slice(0, 160));

    await setOpts({ animate: false, abbreviateValue: true });
    check('abbreviated 1.5M', doc.body.textContent.includes('1.5M'), doc.body.textContent.slice(0, 160));

    state.data = { fields: [{ name: '_time' }, { name: 'v' }], rows: [['t1', '2.5'], ['t2', '3.14159']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await setOpts({ animate: false, valueDecimals: 2 });
    check('decimals=2 → 3.14', doc.body.textContent.includes('3.14'), doc.body.textContent.slice(0, 160));

    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
}

// ---- 6. スパークライン本数・表示トグル ----------------------------------------
console.log('\n[6] sparkBars / visibility toggles');
{
    await setOpts({ animate: false, sparkBars: 5 });
    const rects = [...doc.querySelectorAll('svg[data-role="spark"] rect')];
    check('sparkBars=5 → 5 bars', rects.length === 5, `got ${rects.length}`);

    await setOpts({ animate: false, showSparkline: false });
    check('sparkline hidden', !doc.querySelector('svg[data-role="spark"]'));

    await setOpts({ animate: false, showTitle: false });
    check('title hidden', !doc.body.textContent.includes('重大アラート'));

    await setOpts({ animate: false, showIcon: false });
    check('icon hidden', !doc.querySelector('[data-role="icon-badge"]'));

    await setOpts({ animate: false, showDelta: false });
    check('delta hidden', !doc.body.textContent.includes('前日比'));
}

// ---- 7. アイコン番号での選択 --------------------------------------------------
console.log('\n[7] iconIndex option');
{
    await setOpts({ animate: false, iconIndex: 4 });
    check('iconIndex=4 → bolt path', !!doc.querySelector('[data-role="icon-badge"] svg path[d^="M13 3L5.5"]'));
    await setOpts({ animate: false, iconIndex: 999 });
    check('out-of-range clamped to last (pulse)', !!doc.querySelector('[data-role="icon-badge"] svg path[d^="M3 12h4"]'));
}

// ---- 8. 編集モードのアイコンピッカー -------------------------------------------
console.log('\n[8] edit-mode icon picker');
{
    await setOpts({ animate: false });
    state.mode = 'edit';
    fire('mode', { mode: 'edit' });
    await sleep(250);
    const badge = doc.querySelector('[data-role="icon-badge"]');
    check('badge exists in edit mode', !!badge);
    click(badge);
    await sleep(250);
    const picker = doc.querySelector('[data-role="icon-picker"]');
    check('picker opens on badge click', !!picker);
    const choices = [...doc.querySelectorAll('[data-role="icon-choice"]')];
    check('12 icon choices', choices.length === 12, `got ${choices.length}`);
    // 7番目（globe）を選択 → setOptions で iconIndex=7 が保存される
    click(choices[6]);
    await sleep(150);
    check('setOptions saved iconIndex=7', state.options.iconIndex === 7, JSON.stringify(state.options));
    fire('options', { options: state.options });
    await sleep(250);
    check('picker closed after choice', !doc.querySelector('[data-role="icon-picker"]'));
    check('badge shows globe', !!doc.querySelector('[data-role="icon-badge"] svg path[d^="M3.5 12h17"]'));
    // 表示モードへ戻すとピッカーは開かない
    state.mode = 'view';
    fire('mode', { mode: 'view' });
    await sleep(200);
    click(doc.querySelector('[data-role="icon-badge"]'));
    await sleep(200);
    check('no picker in view mode', !doc.querySelector('[data-role="icon-picker"]'));
}

// ---- 9. カウントアップアニメーション ------------------------------------------
console.log('\n[9] count-up animation reaches target');
{
    await setOpts({});
    await sleep(1100);
    check('animated value reaches 23', doc.body.textContent.includes('23'), doc.body.textContent.slice(0, 160));
}

// ---- 10. テーマ切替 -----------------------------------------------------------
console.log('\n[10] theme switch to light');
{
    await setOpts({ animate: false });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const titleEl = [...doc.querySelectorAll('div')].find((d) => d.textContent === '重大アラート' && d.style.color);
    check('light-mode title color is rgb (darkened accent)',
        titleEl && titleEl.style.color.startsWith('rgb'), titleEl && titleEl.style.color);
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
    const titleDark = [...doc.querySelectorAll('div')].find((d) => d.textContent === '重大アラート' && d.style.color);
    check('dark-mode title color is accent hex', titleDark && titleDark.style.color === '#22d3ee',
        titleDark && titleDark.style.color);
}

// ---- 11. ガード ---------------------------------------------------------------
console.log('\n[11] guards');
{
    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    state.data = { fields: FIELDS, rows: [['a', 'xyz'], ['b', 'www']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('non-numeric message', doc.body.textContent.includes('数値データ'));

    // columns 形式
    state.data = { fields: FIELDS, columns: [['t1', 't2', 't3'], ['10', '20', '15']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('columns-form renders value 15', doc.body.textContent.includes('15'));
    check('columns-form delta ↓ 5', doc.body.textContent.includes('↓ 5'), doc.body.textContent.slice(0, 200));

    // 1列のみ（値の系列として扱う）
    state.data = { fields: [{ name: 'count' }], rows: [['4'], ['9'], ['6']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('single-column value 6', doc.body.textContent.includes('6'));
    check('single-column delta ↓ 3', doc.body.textContent.includes('↓ 3'), doc.body.textContent.slice(0, 200));

    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
}

// ---- 12. debug オーバーレイ ----------------------------------------------------
console.log('\n[12] debug overlay');
{
    await setOpts({ animate: false, debug: true });
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
}

// ---- 13. 背景の不透明度（bgOpacity） -------------------------------------------
console.log('\n[13] bgOpacity');
{
    // happy-dom は rgba をスペース入り（rgba(13, 16, 32, 0.4)）に正規化するので正規表現で比較
    const cardBg = () => {
        const el = [...doc.querySelectorAll('div')].find(
            (d) => d.style && d.style.background && d.style.background.includes('linear-gradient')
        );
        return el ? el.style.background : '';
    };
    const baseAlpha = (bg) => {
        const m = bg.match(/rgba\(13,\s*16,\s*32,\s*([\d.]+)\)\s*$/);
        return m ? Number(m[1]) : null;
    };

    await setOpts({ animate: false, debug: false });
    check('default bgOpacity=100 → base alpha 1', baseAlpha(cardBg()) === 1, cardBg().slice(-60));

    await setOpts({ animate: false, bgOpacity: 40 });
    check('bgOpacity=40 → base alpha 0.4', baseAlpha(cardBg()) === 0.4, cardBg().slice(-60));
    check('bgOpacity=40 → gradient alpha scaled (0.2*0.4=0.08)', /rgba\(34,\s*211,\s*238,\s*0\.08\)/.test(cardBg()), cardBg().slice(0, 80));

    await setOpts({ animate: false, bgOpacity: 0 });
    check('bgOpacity=0 → base alpha 0', baseAlpha(cardBg()) === 0, cardBg().slice(-60));
    {
        const spark = [...doc.querySelectorAll('svg[data-role="spark"] rect')];
        check('bgOpacity=0 でもスパークは不透過のまま', spark.length > 0 && spark.every((r) => r.getAttribute('fill') === '#22d3ee'));
        const titleEl = [...doc.querySelectorAll('div')].find((d) => d.textContent === '重大アラート' && d.style.color);
        check('bgOpacity=0 でもタイトル色は不変', titleEl && titleEl.style.color === '#22d3ee', titleEl && titleEl.style.color);
    }

    await setOpts({ animate: false, bgOpacity: 250 });
    check('範囲外(250)は100へclamp → base alpha 1', baseAlpha(cardBg()) === 1, cardBg().slice(-60));

    await setOpts({ animate: false, bgOpacity: 'abc' });
    check('不正値はデフォルト100 → base alpha 1', baseAlpha(cardBg()) === 1, cardBg().slice(-60));

    // ライトテーマでも同様に効く
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await setOpts({ animate: false, bgOpacity: 40 });
    check('light: bgOpacity=40 → white base alpha 0.4', /rgba\(255,\s*255,\s*255,\s*0\.4\)\s*$/.test(cardBg()), cardBg().slice(-60));
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(250);
}

// ---- 14. スパークラインの線グラフ切替（sparkAsLine） ----------------------------
console.log('\n[14] sparkAsLine');
{
    await setOpts({ animate: false });
    let svg = doc.querySelector('svg[data-role="spark"]');
    check('default is bars style', svg && svg.getAttribute('data-spark-style') === 'bars',
        svg && svg.getAttribute('data-spark-style'));

    await setOpts({ animate: false, sparkAsLine: true });
    svg = doc.querySelector('svg[data-role="spark"]');
    check('sparkAsLine=true → line style', svg && svg.getAttribute('data-spark-style') === 'line',
        svg && svg.getAttribute('data-spark-style'));

    const paths = [...doc.querySelectorAll('svg[data-role="spark"] path')];
    const line = paths.find((p) => p.getAttribute('stroke') === '#22d3ee' && p.getAttribute('fill') === 'none');
    check('accent-colored line path rendered', !!line);
    const area = paths.find((p) => (p.getAttribute('fill') || '').includes('url(#spark-line-grad)'));
    check('area path filled with gradient', !!area, paths.map((p) => p.getAttribute('fill')).join(' | '));
    check('area path closes to bottom (Z)', area && /Z\s*$/.test(area.getAttribute('d') || ''));

    const grad = doc.querySelector('svg[data-role="spark"] linearGradient#spark-line-grad');
    check('linearGradient defined', !!grad);
    check('gradient is vertical (y1=0→y2=1)', grad && grad.getAttribute('y1') === '0' && grad.getAttribute('y2') === '1',
        grad && `y1=${grad.getAttribute('y1')} y2=${grad.getAttribute('y2')}`);
    const stops = grad ? [...grad.querySelectorAll('stop')] : [];
    check('top stop is translucent accent (0.45)', stops[0] && /rgba\(34,\s*211,\s*238,\s*0\.45\)/.test(stops[0].getAttribute('stop-color') || ''),
        stops[0] && stops[0].getAttribute('stop-color'));
    check('bottom stop fades to alpha 0', stops[1] && /rgba\(34,\s*211,\s*238,\s*0\)/.test(stops[1].getAttribute('stop-color') || ''),
        stops[1] && stops[1].getAttribute('stop-color'));

    const dot = doc.querySelector('svg[data-role="spark"] circle');
    check('latest point dot rendered (accent)', dot && dot.getAttribute('fill') === '#22d3ee');

    const hits = [...doc.querySelectorAll('svg[data-role="spark"] rect[data-role="spark-hit"]')];
    check('20 tooltip hit rects', hits.length === 20, `got ${hits.length}`);
    check('hit rect has tooltip title', hits[0] && !!hits[0].querySelector('title'));

    await setOpts({ animate: false, sparkAsLine: true, sparkBars: 5 });
    const hits5 = [...doc.querySelectorAll('svg[data-role="spark"] rect[data-role="spark-hit"]')];
    check('sparkBars=5 → 5 points in line mode', hits5.length === 5, `got ${hits5.length}`);

    await setOpts({ animate: false, sparkAsLine: false });
    svg = doc.querySelector('svg[data-role="spark"]');
    check('back to bars style', svg && svg.getAttribute('data-spark-style') === 'bars');
    check('bars restored (20 rects)', [...doc.querySelectorAll('svg[data-role="spark"] rect')].length === 20);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
