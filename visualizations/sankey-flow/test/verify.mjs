// Sankey Flow viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_sankey_flow', 'visualization.js'
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
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
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

const FIELDS3 = [{ name: 'source' }, { name: 'target' }, { name: 'count' }];
const ROWS3 = [
    ['Internet', 'Firewall', '5,200'],   // カンマ付き数値の正規化を検証
    ['Internet', 'VPN', '1400'],
    ['Firewall', 'WebServer', '3600'],
    ['Firewall', 'AppServer', '1500'],
    ['VPN', 'AppServer', '900'],
    ['WebServer', 'Database', '2100'],
    ['AppServer', 'Database', '1700'],
    ['Database', 'Internet', '400'],     // 循環リンク → 除去されるはず
    ['AppServer', 'AppServer', '50'],    // 自己ループ → 除去
    ['Ghost', '', '10'],                 // 空カテゴリ → 除去
    ['Ghost', 'X', 'abc'],               // 非数値 → 除去
    ['Ghost', 'X', '-5'],                // 0以下 → 除去
];

const drilldownRegs = [];

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
    // ドリルダウン登録を記録する（登録された要素と payload を検証するため）
    addDrilldownListener: ({ node, action, payloadCallback }) => {
        drilldownRegs.push({ node, action, payloadCallback });
        return () => {};
    },
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 自由グラフモード（3列） ---------------------------------------------
console.log('\n[1] free-graph mode (3 cols, dark theme)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    const paths = [...doc.querySelectorAll('svg path')];
    // 有効リンク: 7本（循環1・自己ループ1・不正3行を除去）
    check('7 link paths', paths.length === 7, `got ${paths.length}`);
    const rects = [...doc.querySelectorAll('svg rect')];
    // ノード: Internet, Firewall, VPN, WebServer, AppServer, Database + Ghost系は全滅 → 6
    check('6 node rects', rects.length === 6, `got ${rects.length}`);
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('labels include Internet', texts.some((t) => t.includes('Internet')));
    check('labels include Database', texts.some((t) => t.includes('Database')));
    // 値併記（showValues 既定 ON）: Internet 総流量 6600 → "6.6k"
    check('label shows compact value 6.6k', texts.some((t) => t.includes('6.6k')), JSON.stringify(texts));
    const header = doc.body.textContent;
    check('header shows total 6,600', header.includes('6,600'), header.slice(0, 200));
    check('header notes dropped cyclic', header.includes('循環 1'), header.slice(0, 200));
    // グラデーションリンク既定 ON
    const grads = doc.querySelectorAll('svg defs linearGradient');
    check('gradient defs = links', grads.length === 7, `got ${grads.length}`);
    check('paths use gradient url', paths.every((p) => (p.getAttribute('stroke') || '').startsWith('url(#')));
    // 不透明度既定 40%
    check('stroke-opacity 0.4', paths.every((p) => Math.abs(parseFloat(p.getAttribute('stroke-opacity')) - 0.4) < 1e-6));
}

// ---- 2. 値ベースカラースケール ON --------------------------------------------
console.log('\n[2] colorMode=scale (low green → high red, no mid)');
{
    state.options = {
        colorMode: 'scale', useMidColor: false,
        lowColor: '#00ff00', highColor: '#ff0000', linkOpacity: 80,
    };
    fire('options', { options: state.options });
    await sleep(250);
    const paths = [...doc.querySelectorAll('svg path')];
    const strokes = paths.map((p) => p.getAttribute('stroke'));
    check('strokes are rgb() scale colors', strokes.every((s) => s.startsWith('rgb(')), JSON.stringify(strokes));
    // 最大値リンク(5200)は highColor=赤、最小値リンク(900)は lowColor=緑
    check('max link is pure red', strokes.includes('rgb(255,0,0)'), JSON.stringify(strokes));
    check('min link is pure green', strokes.includes('rgb(0,255,0)'));
    check('opacity updated to 0.8', paths.every((p) => Math.abs(parseFloat(p.getAttribute('stroke-opacity')) - 0.8) < 1e-6));
    check('legend gradient bar in header', doc.body.innerHTML.includes('linear-gradient'));
}

// ---- 3. reverse 反転 ---------------------------------------------------------
console.log('\n[3] reverse');
{
    state.options = { ...state.options, reverse: true };
    fire('options', { options: state.options });
    await sleep(250);
    const strokes = [...doc.querySelectorAll('svg path')].map((p) => p.getAttribute('stroke'));
    // 反転: 最大値リンクが緑側になる
    const maxIsGreen = strokes.includes('rgb(0,255,0)');
    check('reversed scale applies', maxIsGreen, JSON.stringify(strokes));
}

// ---- 4. ステージモード（4列） ------------------------------------------------
console.log('\n[4] staged mode (4 cols)');
{
    state.options = {};
    state.data = {
        fields: [{ name: 'region' }, { name: 'product' }, { name: 'channel' }, { name: 'revenue' }],
        rows: [
            ['APAC', 'Widgets', 'Online', '100'],
            ['APAC', 'Gadgets', 'Retail', '80'],
            ['EMEA', 'Widgets', 'Online', '60'],
            ['EMEA', 'Widgets', 'Retail', '40'],
        ],
    };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    const rects = [...doc.querySelectorAll('svg rect')];
    // ノード: stage0 {APAC,EMEA} stage1 {Widgets,Gadgets} stage2 {Online,Retail} → 6
    check('6 staged nodes', rects.length === 6, `got ${rects.length}`);
    const paths = [...doc.querySelectorAll('svg path')];
    // リンク: APAC→Widgets, APAC→Gadgets, EMEA→Widgets, Widgets→Online, Widgets→Retail, Gadgets→Retail → 6
    check('6 staged links (aggregated)', paths.length === 6, `got ${paths.length}`);
    const header = doc.body.textContent;
    check('3 stages in header', header.includes('3 stages'), header.slice(0, 160));
    check('total = 280', header.includes('280'));
    // 同名ノード（Widgets）はステージ内で1つに合算されている
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('Widgets label appears once', texts.filter((t) => t.includes('Widgets')).length === 1);
}

// ---- 5. テーマ切替 -----------------------------------------------------------
console.log('\n[5] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const text = doc.querySelector('svg text');
    check('label color switches to light-mode text', text && text.getAttribute('fill') === '#31373e',
        text && text.getAttribute('fill'));
}

// ---- 6. 列不足 / 空データ ----------------------------------------------------
console.log('\n[6] guards');
{
    state.data = { fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', '1']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('2-col message', doc.body.textContent.includes('at least 3 columns'));

    state.data = { fields: FIELDS3, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty data message', doc.body.textContent.includes('データがありません'));

    // 全行不正 → nolinks メッセージ
    state.data = { fields: FIELDS3, rows: [['a', 'b', 'xyz'], ['', 'b', '5']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('no valid links message', doc.body.textContent.includes('No valid flow links'));

    // columns 形式でも動く
    state.data = {
        fields: FIELDS3,
        columns: [['A', 'B'], ['B', 'C'], ['10', '20']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    const paths = [...doc.querySelectorAll('svg path')];
    check('columns-form data renders 2 links', paths.length === 2, `got ${paths.length}`);
}

// ---- 7. debug オプションは廃止済み ---------------------------------------------
console.log('\n[7] debug option removed');
{
    state.options = { debug: true };
    fire('options', { options: state.options });
    await sleep(200);
    check('no debug overlay even with debug:true', !doc.body.textContent.includes('"normalized"'));
    check('chart still renders', doc.querySelectorAll('svg path').length > 0);
}

// ---- 8. しきい値カラー（editor.threshold の配列が生で届く） --------------------
console.log('\n[8] colorMode=threshold');
{
    state.data = { fields: FIELDS3, rows: ROWS3 };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    state.options = {
        colorMode: 'threshold',
        colorBands: [
            { from: 0, to: 2000, value: '#00ff00' },
            { from: 2000, to: null, value: '#ff0000' },   // 上端は開放
        ],
    };
    fire('options', { options: state.options });
    await sleep(250);
    const strokes = [...doc.querySelectorAll('svg path')].map((p) => p.getAttribute('stroke'));
    check('threshold colors applied', strokes.every((s) => s === '#00ff00' || s === '#ff0000'),
        JSON.stringify(strokes));
    check('large link (5200) uses upper open band', strokes.includes('#ff0000'));
    check('small link (900) uses lower band', strokes.includes('#00ff00'));
    check('threshold legend in header', doc.body.textContent.includes('–'));

    // 壊れた帯は既定に倒す（色が付かない状態を作らない）
    state.options = { colorMode: 'threshold', colorBands: 'not-an-array' };
    fire('options', { options: state.options });
    await sleep(200);
    const s2 = [...doc.querySelectorAll('svg path')].map((p) => p.getAttribute('stroke'));
    check('broken bands fall back to defaults', s2.length > 0 && s2.every((s) => !!s));
}

// ---- 9. 単位表示 --------------------------------------------------------------
console.log('\n[9] value unit');
{
    state.options = { valueUnit: 'bytes', unitPosition: 'after' };
    fire('options', { options: state.options });
    await sleep(250);
    check('unit appended in header', doc.body.textContent.includes('6,600 bytes'),
        doc.body.textContent.slice(0, 160));

    state.options = { valueUnit: '$', unitPosition: 'before' };
    fire('options', { options: state.options });
    await sleep(250);
    check('unit prefixed in header', doc.body.textContent.includes('$6,600'),
        doc.body.textContent.slice(0, 160));
}

// ---- 10. 段内の並び順 ---------------------------------------------------------
console.log('\n[10] nodeSort');
{
    state.options = { nodeSort: 'name', showValues: false };
    fire('options', { options: state.options });
    await sleep(300);
    check('renders with name sort', doc.querySelectorAll('svg rect').length === 6);

    state.options = { nodeSort: 'value', showValues: false };
    fire('options', { options: state.options });
    await sleep(300);
    check('renders with value sort', doc.querySelectorAll('svg rect').length === 6);

    // 不正値は既定(auto)へ倒す
    state.options = { nodeSort: 'bogus' };
    fire('options', { options: state.options });
    await sleep(300);
    check('invalid sort falls back', doc.querySelectorAll('svg rect').length === 6);
}

// ---- 11. 上位N件への集約 ------------------------------------------------------
console.log('\n[11] topN rollup');
{
    state.options = { topN: 2, otherLabel: 'OTHER' };
    fire('options', { options: state.options });
    await sleep(300);
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent).join('|');
    check('rollup node appears', texts.includes('OTHER'), texts.slice(0, 240));
    check('header reports rollup count', doc.body.textContent.includes('集約'));

    // topN=0 は集約しない
    state.options = { topN: 0 };
    fire('options', { options: state.options });
    await sleep(300);
    const t0 = [...doc.querySelectorAll('svg text')].map((t) => t.textContent).join('|');
    check('topN=0 keeps all nodes', !t0.includes('OTHER'));
}

// ---- 12. 循環リンクの展開 -----------------------------------------------------
console.log('\n[12] cycleMode=unroll');
{
    state.options = { cycleMode: 'unroll' };
    fire('options', { options: state.options });
    await sleep(300);
    // 循環1本を捨てずに残すので、drop 時(7本)より1本多い
    const paths = [...doc.querySelectorAll('svg path')];
    check('cyclic link is kept as unrolled', paths.length === 8, `got ${paths.length}`);
    check('header reports unrolled', doc.body.textContent.includes('循環展開'));

    state.options = { cycleMode: 'drop' };
    fire('options', { options: state.options });
    await sleep(300);
    check('drop mode removes it again', doc.querySelectorAll('svg path').length === 7);
}

// ---- 13. 損失表示（段ごとの減少量） -------------------------------------------
console.log('\n[13] loss analysis');
{
    // Firewall に 5200 入って 5100 出る → 100 の損失
    state.data = {
        fields: FIELDS3,
        rows: [
            ['Internet', 'Firewall', '5200'],
            ['Firewall', 'WebServer', '3600'],
            ['Firewall', 'AppServer', '1500'],
        ],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    state.options = { showLoss: true, lossColor: '#8a6d3b' };
    fire('options', { options: state.options });
    await sleep(300);
    const rects = [...doc.querySelectorAll('svg rect')];
    check('loss bar rendered', rects.some((r) => r.getAttribute('fill') === '#8a6d3b'));
    check('header reports loss', doc.body.textContent.includes('損失'),
        doc.body.textContent.slice(0, 200));

    state.options = { showLoss: false };
    fire('options', { options: state.options });
    await sleep(300);
    check('loss hidden when off', ![...doc.querySelectorAll('svg rect')]
        .some((r) => r.getAttribute('fill') === '#8a6d3b'));
}

// ---- 14. リンク値ラベル -------------------------------------------------------
console.log('\n[14] link labels');
{
    state.options = { showLinkLabels: true, showLabels: false };
    fire('options', { options: state.options });
    await sleep(300);
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('link value labels rendered', texts.some((t) => t.includes('3.6k') || t.includes('5.2k')),
        JSON.stringify(texts));

    // ⭐ 重なっても値を「消さない」こと。
    // 以前は近接ラベルを間引いていたが、消えたのか欠損なのか区別できないため
    // ずらして両方出す方式に変更した（ユーザー指摘。2026-08-09）。
    // 段の中で複数リンクが近接する4列データで、太い帯のラベルが全部出ることを見る。
    state.data = {
        fields: [{ name: 'region' }, { name: 'product' }, { name: 'channel' }, { name: 'revenue' }],
        rows: [
            ['APAC', 'Widgets', 'Online', '180'],
            ['APAC', 'Gadgets', 'Online', '80'],
            ['APAC', 'Gadgets', 'Retail', '90'],
            ['EMEA', 'Widgets', 'Online', '140'],
            ['EMEA', 'Gadgets', 'Retail', '70'],
        ],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    state.options = { showLinkLabels: true, showLabels: false, showValues: false };
    fire('options', { options: state.options });
    await sleep(350);

    const svg = doc.querySelector('svg');
    const paths = [...svg.querySelectorAll('path')];
    const labelTexts = [...svg.querySelectorAll('text')].map((t) => t.textContent.trim());
    // 帯が細すぎるものを除いた「出すべきラベル」の本数を、実際の描画数と突き合わせる
    check('no link label is silently dropped',
        labelTexts.length > 0 && labelTexts.length >= Math.min(paths.length, 5),
        `labels=${labelTexts.length} paths=${paths.length} ${JSON.stringify(labelTexts)}`);

    // 近接する複数のラベルが両方残ること。
    // （ステージモードでは同じ (source,target) が合算されるので、
    //   APAC→Gadgets は 80+90=170 になる。合算は仕様どおり）
    // 2段目の Gadgets から出る 80 と 70 は別リンクなので両方出るはず。
    check('close-valued labels both present',
        labelTexts.includes('80') && labelTexts.includes('70'),
        JSON.stringify(labelTexts));

    // ずらした結果、ラベル同士が完全に同じ座標に重なっていないこと
    const pos = [...svg.querySelectorAll('text')].map(
        (t) => `${Math.round(parseFloat(t.getAttribute('x')))},${Math.round(parseFloat(t.getAttribute('y')))}`
    );
    check('labels are not stacked at identical positions',
        new Set(pos).size === pos.length, JSON.stringify(pos));
}

// ---- 15. ドリルダウン登録 -----------------------------------------------------
console.log('\n[15] drilldown registration');
{
    state.data = { fields: FIELDS3, rows: ROWS3 };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    state.options = {};
    fire('options', { options: state.options });
    await sleep(350);

    check('drilldown listeners registered', drilldownRegs.length > 0, `got ${drilldownRegs.length}`);
    const actions = new Set(drilldownRegs.map((r) => r.action));
    check('node.click registered', actions.has('node.click'), [...actions].join(','));
    check('link.click registered', actions.has('link.click'), [...actions].join(','));

    // payload はフィールド名つきで row.<field>.value 形式
    const nodeReg = drilldownRegs.find((r) => r.action === 'node.click');
    const p = nodeReg ? nodeReg.payloadCallback() : {};
    check('node payload has row.<field>.value', typeof p['row.source.value'] === 'string', JSON.stringify(p));
    check('node payload has name/value', p.name === 'node' && typeof p.value === 'string');

    const linkReg = drilldownRegs.find((r) => r.action === 'link.click');
    const lp = linkReg ? linkReg.payloadCallback() : {};
    check('link payload has source and target', typeof lp['row.source.value'] === 'string'
        && typeof lp['row.target.value'] === 'string', JSON.stringify(lp));

    // 同じノードへの二重登録をしない（解除APIが無いため積み上がると多重発火する）
    const nodes = drilldownRegs.map((r) => r.node);
    check('no duplicate node registration', new Set(nodes).size === nodes.length,
        `${nodes.length} regs / ${new Set(nodes).size} unique`);
}

// ---- 16. 経路追跡（traceMode） ------------------------------------------------
console.log('\n[16] traceMode option accepted');
{
    for (const m of ['path', 'adjacent', 'off']) {
        state.options = { traceMode: m };
        fire('options', { options: state.options });
        await sleep(250);
        check(`traceMode=${m} renders`, doc.querySelectorAll('svg path').length === 7);
    }
    state.options = { traceMode: 'bogus' };
    fire('options', { options: state.options });
    await sleep(250);
    check('invalid traceMode falls back', doc.querySelectorAll('svg path').length === 7);
}

// ---- 17. 旧オプション（useValueColors）は復活しない ----------------------------
console.log('\n[17] no fallback to removed option');
{
    // 旧キーだけを渡しても、新キー(colorMode)の既定 categorical のままであること。
    // （既定値は options に載らないため、旧キーへのフォールバックは不具合になる）
    state.options = { useValueColors: true, lowColor: '#00ff00', highColor: '#ff0000' };
    fire('options', { options: state.options });
    await sleep(300);
    const strokes = [...doc.querySelectorAll('svg path')].map((p) => p.getAttribute('stroke'));
    check('legacy useValueColors is ignored', strokes.every((s) => s.startsWith('url(#')),
        JSON.stringify(strokes));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
