// World Map viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_worldmap', 'visualization.js'
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

// happy-dom は canvas.getContext を実装しないため 2D コンテキストをスタブ化。
// 彗星描画（fill 回数）を数えて「Canvas に描かれたか / 静止時は描かれないか」を検証する。
const canvasStub = { fills: 0, arcs: 0, clears: 0 };
const ctxStub = {
    setTransform() {},
    clearRect() { canvasStub.clears += 1; },
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    arc() { canvasStub.arcs += 1; },
    fill() { canvasStub.fills += 1; },
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set globalCompositeOperation(v) {}, get globalCompositeOperation() { return 'source-over'; },
};
win.HTMLCanvasElement.prototype.getContext = function () { return ctxStub; };

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

const FIELDS = ['src_lat', 'src_lon', 'dst_lat', 'dst_lon', 'severity', 'count', 'src_name', 'dst_name']
    .map((name) => ({ name }));
const ROWS = [
    ['51.5', '-0.12', '35.68', '139.69', 'low', '120', 'London', 'Tokyo'],
    ['31.2', '121.47', '35.68', '139.69', 'high', '300', 'Shanghai', 'Tokyo'],
    ['55.75', '37.61', '35.68', '139.69', 'HIGH', '50', 'Moscow', 'Tokyo'],   // 大文字違い → high に合流
    ['-23.5', '-46.6', '35.68', '139.69', 'medium', '80', 'Sao Paulo', 'Tokyo'],
    ['40.7', '-74.0', '35.68', '139.69', '', '10', 'New York', 'Tokyo'],      // 空severity → low
    ['48.85', '2.35', '35.68', '139.69', 'worm', '40', 'Paris', 'Tokyo'],     // 未知severity → パレット4番目
    ['99.9', '10', '35.68', '139.69', 'high', '5', 'BadLat', 'Tokyo'],        // 緯度>90 → 除去
    ['abc', '10', '35.68', '139.69', 'low', '5', 'NaN', 'Tokyo'],             // 非数値 → 除去
];
// 有効な脅威 = 6 行
const ROWS_VALID = ROWS.slice(0, 6);

let state = {
    data: { fields: FIELDS, rows: ROWS },
    options: {},
    theme: 'dark',
};

// addDrilldownListener の呼び出し記録
const drilldownRegs = [];

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
    // ドリルダウン登録を記録して、要素ごとに正しい payload が閉じ込められているか検査する
    addDrilldownListener: (args) => { drilldownRegs.push(args); },
    triggerDrilldown: () => {},
};
win.DashboardExtensionAPI = globalThis.DashboardExtensionAPI;

const fire = (key, payload) => listeners[key].forEach((cb) => cb(payload));
// 流れる彗星は Canvas に描くため DOM に出ない。弧の本数は SVG のベース軌道で数える。
// ベース軌道は 1 弧あたり2枚（発光ハロー=filter付き + 芯線）。
// ハロー層(filter="url(#gtm-arc-glow)")を 1 弧 = 1 とみなして数える。
const streaks = () =>
    [...doc.querySelectorAll('svg path[filter="url(#gtm-arc-glow)"]')];
const strokes = () => streaks().map((p) => p.getAttribute('stroke'));
// ツールチップ相当のテキスト。v1.8.0 で SVG <title>（ブラウザ標準ツールチップ）を
// 廃止し、当たり判定要素の aria-label ＋カスタムツールチップに置き換えたため、
// aria-label を読む（内容の書式は <title> 時代と同じ）。
const titles = () => [...doc.querySelectorAll('svg [aria-label]')].map((t) => t.getAttribute('aria-label'));

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(350);

// ---- 1. 初期表示（dark・自動フィールド判定） --------------------------------
console.log('\n[1] initial render (dark, auto field detection)');
{
    check('svg rendered', !!doc.querySelector('svg'));
    check('land path drawn', !!doc.querySelector('svg path[fill="#0d2b52"]'));
    check('6 streak paths (2 invalid rows dropped)', streaks().length === 6, `got ${streaks().length}`);
    // 色の指定が無い状態では「勝手にパレットを配らない」＝全て既定色（fallbackColor）
    check('no colors assigned without explicit mapping (all fallback)',
        strokes().every((c) => c === 'rgb(56, 166, 255)'), JSON.stringify(strokes()));
    const body = doc.body.textContent;
    check('title shown', body.includes('GLOBAL THREAT MAP'));
    check('legend/filter include arbitrary category (worm)', body.includes('worm'));
    check('arc tooltip src → dst', titles().some((t) => t.includes('Shanghai') && t.includes('Tokyo')), JSON.stringify(titles().slice(0, 4)));
    check('hotspot tooltip has target name', titles().some((t) => t.startsWith('Target: Tokyo')));
    check('pulse/streak animations present', doc.querySelectorAll('svg animate').length > 0);
    // 彗星は Canvas に描かれる：アニメーション中は fill が発生している
    canvasStub.fills = 0;
    await sleep(120);
    check('comets drawn on canvas (animated)', canvasStub.fills > 0, `got ${canvasStub.fills}`);
}

// ---- 2. 明示マッピング（editor.arrayOfStrings「カテゴリ名|色」）だけが色を決める ----
// 色の根拠は severity とは限らない（ログ種別・ステータス等）。viz は語彙を解釈せず、
// ユーザーが書いた「カテゴリ名|色」だけを使う。
console.log('\n[2] explicit "name|color" mapping is the only source of color');
{
    state.options = { categoryColors: ['high|#00ff00', 'medium|#0000ff', 'low|#ffff00'] };
    fire('options', { options: state.options });
    await sleep(250);
    const st = strokes();
    check('high → mapped color', st.includes('rgb(0, 255, 0)'), JSON.stringify(st));
    check('medium → mapped color', st.includes('rgb(0, 0, 255)'), JSON.stringify(st));
    check('low → mapped color', st.includes('rgb(255, 255, 0)'), JSON.stringify(st));
    // worm は未マッピング → fallbackColor（既定 #38a6ff）。勝手に色を配らない
    check('unmapped category uses fallback color', st.includes('rgb(56, 166, 255)'), JSON.stringify(st));
}

// ---- 2a. 大文字小文字・空白のゆれを吸収する -----------------------------------
console.log('\n[2a] mapping is case/space tolerant');
{
    // データ側は 'high'/'HIGH' の両方が登場する（HIGH 行は high に合流済み）
    state.options = { categoryColors: ['  HIGH | #ff0000  '] };
    fire('options', { options: state.options });
    await sleep(250);
    check('case-insensitive + trimmed mapping applies', strokes().includes('rgb(255, 0, 0)'), JSON.stringify(strokes()));
}

// ---- 2b. fallbackColor をユーザーが変えられる ---------------------------------
console.log('\n[2b] fallbackColor is user-controlled');
{
    state.options = { categoryColors: [], fallbackColor: '#123456' };
    fire('options', { options: state.options });
    await sleep(250);
    check('all arcs use custom fallback', strokes().every((c) => c === 'rgb(18, 52, 86)'), JSON.stringify(strokes()));
}

// ---- 2c. 任意の語彙（ログ種別など）でも指定どおりに色が付く ---------------------
// severity ではない語彙が主役のケース。並び順も色も推測されないことを確認する。
console.log('\n[2c] arbitrary vocabulary (log types) colored exactly as specified');
{
    const CUSTOM = ROWS_VALID.map((r, i) => {
        const row = [...r];
        row[4] = ['auth', 'firewall', 'dns', 'proxy', '監査', 'アラート'][i];
        return row;
    });
    state.data = { fields: FIELDS, rows: CUSTOM };
    state.options = {
        categoryColors: ['auth|#111111', 'firewall|#222222', 'dns|#333333', 'proxy|#444444', '監査|#555555', 'アラート|#666666'],
    };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    const st = strokes();
    check('6 arcs rendered with log-type vocabulary', st.length === 6, `got ${st.length}`);
    check('6 distinct colors exactly as mapped', new Set(st).size === 6, JSON.stringify(st));
    check('non-ascii category mapped (監査 → #555555)', st.includes('rgb(85, 85, 85)'), JSON.stringify(st));
    const body = doc.body.textContent;
    check('legend lists log-type values', body.includes('auth') && body.includes('監査'), body.slice(0, 300));
    check('did not crash on non-ascii category', !!doc.querySelector('svg'));
}

// ---- 2d. 並び順もユーザー指定に従う（意味で並べ替えない） ----------------------
// 旧実装は critical→high→medium→low の既知順で勝手に並べ替えていた。
console.log('\n[2d] categoryOrder controls legend order (no semantic sorting)');
{
    state.data = { fields: FIELDS, rows: ROWS };
    // 登場順は low, high, medium, worm。指定で dns 的な任意順に並べ替える
    state.options = {
        categoryColors: ['low|#aa0000', 'high|#00aa00'],
        categoryOrder: ['medium', 'worm', 'high'],
    };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    // 凡例（左下パネル）の並びで確認する。
    // body 全体のテキストだと右上のフィルタ（Select）も混ざるため、
    // 「色スウォッチ(boxShadow)を持つ行」を含む最小の div を凡例とみなす。
    // v1.9.0 で各行の末尾に件数の span が付いたため、行全体の textContent では
    // "medium80" のように連結されてしまう。カテゴリ名は「スウォッチの次の span」
    // に入っているので、そこだけを読む。
    const legendNames = [...doc.querySelectorAll('span')]
        .filter((s) => (s.getAttribute('style') || '').includes('box-shadow'))
        .map((s) => (s.nextElementSibling ? s.nextElementSibling.textContent.trim() : ''))
        .filter((t) => t !== '');
    check('legend rendered with swatches', legendNames.length >= 4, JSON.stringify(legendNames));
    // 指定した medium, worm, high が先頭3件、未指定の low がその後（登場順）
    check('categoryOrder respected: medium, worm, high, low',
        legendNames.slice(0, 4).join(',') === 'medium,worm,high,low', JSON.stringify(legendNames));
    // 値が空の行は「(未分類)」として独立したカテゴリになる（low 等に混ぜない）
    check('empty category value becomes its own "(未分類)" entry',
        legendNames.includes('(未分類)'), JSON.stringify(legendNames));
}

// ---- 2e. 壊れた入力でも描画を壊さない ------------------------------------------
console.log('\n[2e] malformed mapping input degrades safely');
{
    for (const bad of [
        [], ['nope'], ['no-separator'], ['name|not-a-color'], ['|#ff0000'], ['x|'],
        [42, null, {}], 'not-an-array', { a: 1 }, null,
    ]) {
        state.options = { categoryColors: bad };
        fire('options', { options: state.options });
        await sleep(150);
        check(`malformed ${JSON.stringify(bad)} → fallback, still renders`,
            streaks().length === 6 && strokes().every((c) => c === 'rgb(56, 166, 255)'),
            JSON.stringify(strokes()));
    }
    state.options = {};
    fire('options', { options: state.options });
    await sleep(200);
}

// ---- 2f. 色名（red 等）も使える ------------------------------------------------
console.log('\n[2f] CSS color names accepted in mapping');
{
    state.options = { categoryColors: ['high|red', 'low|lime'] };
    fire('options', { options: state.options });
    await sleep(250);
    const st = strokes();
    check('named color red applied', st.includes('rgb(255, 0, 0)'), JSON.stringify(st));
    check('named color lime applied', st.includes('rgb(0, 255, 0)'), JSON.stringify(st));
}

// ---- 2g. 旧オプション（severityColors 等）は一切効かない ------------------------
// 既定値は options に載らないため、旧キーへのフォールバックは実装しない方針。
console.log('\n[2g] legacy severity options must not leak');
{
    state.options = {
        severityColors: ['#ff00ff', '#00ffff'],
        highColor: '#ff00ff', mediumColor: '#00ffff', lowColor: '#ffff00',
    };
    fire('options', { options: state.options });
    await sleep(250);
    const st = strokes();
    check('legacy severityColors ignored', !st.includes('rgb(255, 0, 255)'), JSON.stringify(st));
    check('legacy highColor ignored', !st.includes('rgb(0, 255, 255)'), JSON.stringify(st));
    check('falls back to default color', st.every((c) => c === 'rgb(56, 166, 255)'), JSON.stringify(st));
    state.options = {};
    fire('options', { options: state.options });
    await sleep(200);
}

// ---- 3. 表示トグルとアニメーション停止 ---------------------------------------
console.log('\n[3] display toggles + animation off');
{
    state.options = { showTitle: false, showLegend: false, showFilter: false, animDuration: 0 };
    fire('options', { options: state.options });
    await sleep(250);
    const body = doc.body.textContent;
    check('title hidden', !body.includes('GLOBAL THREAT MAP'));
    check('filter hidden', !body.includes('All Threats'));
    check('legend hidden', !doc.body.innerHTML.includes('0 0 8px'));
    check('no animate elements when animDuration=0', doc.querySelectorAll('svg animate').length === 0,
        `got ${doc.querySelectorAll('svg animate').length}`);
    // 静的モードでは彗星を描かない → Canvas への fill が止まる（rAF で clear のみ継続）
    canvasStub.fills = 0;
    await sleep(120);
    check('no comet fills on canvas (static mode)', canvasStub.fills === 0, `got ${canvasStub.fills}`);
    // ベース軌道は静的でも残る（弧の存在を示す）
    check('base tracks remain in static mode', streaks().length === 6, `got ${streaks().length}`);
    // 静的モードでは芯線が濃くなる（animOn 時 0.3 → 静的 0.75）
    const staticArcs = [...doc.querySelectorAll('svg path[opacity="0.75"]')];
    check('static arcs drawn brighter', staticArcs.length === 6, `got ${staticArcs.length}`);
}

// ---- 4. タイトル文字列の変更 -------------------------------------------------
console.log('\n[4] custom title text');
{
    state.options = { titleText: 'MY SOC MAP' };
    fire('options', { options: state.options });
    await sleep(250);
    check('custom title shown', doc.body.textContent.includes('MY SOC MAP'));
}

// ---- 5. editor.columnSelector（DOS文字列）でのフィールド指定 ------------------
console.log('\n[5] columnSelector DOS strings on renamed fields');
{
    const renamed = ['la1', 'lo1', 'la2', 'lo2', 'sev', 'cnt', 'n1', 'n2'].map((name) => ({ name }));
    state.data = { fields: renamed, rows: ROWS };
    state.options = {};
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    // 自動判定は候補名に一致しない → 必須フィールド欠損メッセージ
    check('auto-detect fails on renamed fields', doc.body.textContent.includes('必須フィールドが見つかりません'));

    state.options = {
        srcLatField: "> primary | seriesByName('la1')",
        srcLonField: "> primary | seriesByName('lo1')",
        dstLatField: "> primary | seriesByName('la2')",
        dstLonField: '> primary | seriesByIndex(3)',
        categoryField: "> primary | seriesByName('sev')",
        srcNameField: "> primary | seriesByName('n1')",
        dstNameField: "> primary | seriesByName('n2')",
    };
    fire('options', { options: state.options });
    await sleep(250);
    check('renders via columnSelector fields', streaks().length === 6, `got ${streaks().length}`);
    check('category column resolved via selector', doc.body.textContent.includes('worm'));
    check('names resolved via selector', titles().some((t) => t.includes('Shanghai')));
}

// ---- 6. ガードと columns 形式 ------------------------------------------------
console.log('\n[6] guards + columns format');
{
    state.options = {};
    state.data = { fields: FIELDS, rows: [] };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('empty data message', doc.body.textContent.includes('データがありません'));

    state.data = { fields: [{ name: 'a' }, { name: 'b' }], rows: [['1', '2']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(200);
    check('missing fields message', doc.body.textContent.includes('必須フィールドが見つかりません'));

    // columns 形式でも動く
    state.data = {
        fields: FIELDS,
        columns: FIELDS.map((_, ci) => ROWS.map((r) => r[ci])),
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('columns format renders', streaks().length === 6, `got ${streaks().length}`);
}

// ---- 7. テーマ切替 -----------------------------------------------------------
console.log('\n[7] theme switch to light');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    check('light land color applied', !!doc.querySelector('svg path[fill="#c3d4e6"]'));
    check('still 6 streaks', streaks().length === 6, `got ${streaks().length}`);
}

// ---- 8. 地名ラベル（ズーム段階で国名→都市名） --------------------------------
// v1.4.0 で追加。国名は world-atlas、都市名は Natural Earth（ともにパブリックドメイン）。
console.log('\n[8] place labels appear and scale with zoom');
const labelTexts = () => [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
{
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {};
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);

    const base = labelTexts();
    check('country labels rendered at zoom 1', base.some((t) => t === 'Russia' || t === 'Brazil' || t === 'China'),
        JSON.stringify(base.slice(0, 12)));
    check('no city labels at zoom 1 (countries only)', !base.includes('Osaka'), JSON.stringify(base.slice(0, 15)));

    // 始点/終点の地点名はデータ由来なので zoom 1 でも出る
    check('endpoint labels shown (src/dst names)',
        base.includes('Tokyo') && base.includes('London'), JSON.stringify(base.slice(0, 15)));

    // ズームすると都市名が現れる
    state.options = { initialZoom: 12, centerLon: 135, centerLat: 35 };
    fire('options', { options: state.options });
    await sleep(320);
    const zoomed = labelTexts();
    // 拡大すると画面外の国が消えるため総数は減りうる。判定は「都市名が出たか」で行う。
    const cityAppeared = zoomed.some((t) => ['Osaka', 'Nagoya', 'Kyoto', 'Sapporo', 'Seoul', 'Busan'].includes(t));
    check('city labels appear when zoomed in', cityAppeared, JSON.stringify(zoomed.slice(0, 20)));
    check('zoomed view is centered on Japan', zoomed.includes('Tokyo'), JSON.stringify(zoomed.slice(0, 20)));
}

// ---- 9. 中心経度・緯度で表示位置が変わる -------------------------------------
console.log('\n[9] centerLon / centerLat recenter the map');
{
    // 中心経度を変えると同じ地点の投影 x 座標が動く（＝地図が回っている）
    const tokyoX = () => {
        const t = [...doc.querySelectorAll('svg text')].find((n) => n.textContent === 'Tokyo');
        return t ? Number(t.getAttribute('x')) : null;
    };
    state.options = { centerLon: 139, centerLat: 35, initialZoom: 3 };
    fire('options', { options: state.options });
    await sleep(320);
    const centered = tokyoX();
    check('Tokyo near horizontal center when centered on lon139', centered !== null && Math.abs(centered - 450) < 90,
        `x=${centered}`);

    state.options = { centerLon: -74, centerLat: 40, initialZoom: 3 };
    fire('options', { options: state.options });
    await sleep(320);
    const shifted = tokyoX();
    check('changing centerLon moves the map', shifted === null || Math.abs(shifted - (centered ?? 0)) > 60,
        `before=${centered} after=${shifted}`);
}

// ---- 10. ホイールズーム ------------------------------------------------------
console.log('\n[10] wheel zoom changes scale');
{
    state.options = { centerLon: 0, centerLat: 0, initialZoom: 1 };
    fire('options', { options: state.options });
    await sleep(320);

    // 陸地パスの長さはズームで変わる（拡大すると座標値が大きくなる）
    const landLen = () => {
        const p = doc.querySelector('svg path[fill="#0d2b52"]');
        return p ? (p.getAttribute('d') || '').length : 0;
    };
    const before = landLen();
    const container = doc.querySelector('#root div');
    check('container present for wheel events', !!container);

    // ホイールを手前→奥（deltaY 負）に回して拡大
    const evt = new win.WheelEvent('wheel', { deltaY: -600, clientX: 450, clientY: 250, bubbles: true, cancelable: true });
    container.dispatchEvent(evt);
    await sleep(320);

    const zoomLabel = doc.body.textContent;
    check('zoom indicator appears after wheel', /×\d/.test(zoomLabel), zoomLabel.slice(0, 120));
    check('wheel zoom altered the projection', landLen() !== before, `before=${before} after=${landLen()}`);
}

// ---- 11. ズーム/ラベルの無効化オプション --------------------------------------
console.log('\n[11] labels and zoom can be turned off');
{
    state.options = { showPlaceLabels: false, showEndpointLabels: false };
    fire('options', { options: state.options });
    await sleep(320);
    const t = labelTexts();
    check('no place labels when disabled', !t.includes('Russia') && !t.includes('Tokyo'), JSON.stringify(t.slice(0, 12)));
    check('arcs still rendered with labels off', streaks().length === 6, `got ${streaks().length}`);

    state.options = { enableZoom: false, initialZoom: 1 };
    fire('options', { options: state.options });
    await sleep(320);
    const before = (doc.querySelector('svg path[fill="#0d2b52"]').getAttribute('d') || '').length;
    doc.querySelector('#root div').dispatchEvent(
        new win.WheelEvent('wheel', { deltaY: -600, clientX: 450, clientY: 250, bubbles: true, cancelable: true })
    );
    await sleep(300);
    const after = (doc.querySelector('svg path[fill="#0d2b52"]').getAttribute('d') || '').length;
    check('wheel ignored when zoom disabled', before === after, `before=${before} after=${after}`);
}

// ---- 12. severity という語彙が一切無いデータでも成立する ----------------------
// 「色の根拠は severity とは限らない」ことの本丸。列名も値も severity と無関係な
// データを与え、ユーザー指定どおりに色が付くことを確認する。
console.log('\n[12] works with a dataset that has nothing to do with severity');
{
    const F2 = ['from_lat', 'from_lon', 'to_lat', 'to_lon', 'log_type', 'bytes', 'from_site', 'to_site']
        .map((name) => ({ name }));
    const R2 = [
        ['51.5', '-0.12', '35.68', '139.69', 'auth', '120', 'London', 'Tokyo'],
        ['31.2', '121.47', '35.68', '139.69', 'firewall', '300', 'Shanghai', 'Tokyo'],
        ['48.85', '2.35', '35.68', '139.69', 'dns', '40', 'Paris', 'Tokyo'],
    ];
    state.data = { fields: F2, rows: R2 };
    state.options = {
        // 緯度経度は自動判定できない列名 → columnSelector で明示
        srcLatField: "> primary | seriesByName('from_lat')",
        srcLonField: "> primary | seriesByName('from_lon')",
        dstLatField: "> primary | seriesByName('to_lat')",
        dstLonField: "> primary | seriesByName('to_lon')",
        categoryField: "> primary | seriesByName('log_type')",
        srcNameField: "> primary | seriesByName('from_site')",
        dstNameField: "> primary | seriesByName('to_site')",
        categoryColors: ['auth|#ff0000', 'firewall|#00ff00'],
        categoryOrder: ['firewall', 'auth'],
        categoryLabel: 'ログ種別',
    };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(320);

    const st = strokes();
    check('3 arcs rendered from non-severity dataset', st.length === 3, `got ${st.length}`);
    check('auth → mapped red', st.includes('rgb(255, 0, 0)'), JSON.stringify(st));
    check('firewall → mapped green', st.includes('rgb(0, 255, 0)'), JSON.stringify(st));
    check('dns (unmapped) → fallback', st.includes('rgb(56, 166, 255)'), JSON.stringify(st));

    const legendNames = [...doc.querySelectorAll('span')]
        .filter((s) => (s.getAttribute('style') || '').includes('box-shadow'))
        .map((s) => (s.nextElementSibling ? s.nextElementSibling.textContent.trim() : ''));
    check('legend order follows categoryOrder (firewall, auth, dns)',
        legendNames.slice(0, 3).join(',') === 'firewall,auth,dns', JSON.stringify(legendNames));

    const body = doc.body.textContent;
    check('categoryLabel shown as legend heading', body.includes('ログ種別'), body.slice(0, 200));
    check('filter says すべての<label>', body.includes('すべてのログ種別'), body.slice(0, 200));
    // ツールチップにカテゴリが出る（深刻度前提の文言になっていない）
    check('tooltip carries the log type', titles().some((t) => t.includes('firewall')), JSON.stringify(titles().slice(0, 4)));
}

// ---- 13. オーバーレイUI上の操作が地図のパンに奪われない -------------------------
// v1.4.1 の不具合: コンテナの pointerdown で即 setPointerCapture していたため、
// 右上フィルタ（Select）を押しても以降のイベントが地図に横取りされ、
// ドロップダウンが開かなかった（ズーム無効時だけ開く、という症状）。
console.log('\n[13] overlay UI clicks are not stolen by map panning');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { enableZoom: true, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(320);

    const container = doc.querySelector('#root div');
    // data-viz-ui でマークされたオーバーレイ（フィルタ・凡例・ズームリセット）
    const uiPanels = [...doc.querySelectorAll('[data-viz-ui="1"]')];
    check('overlay panels are marked with data-viz-ui', uiPanels.length >= 2, `got ${uiPanels.length}`);

    // フィルタ内の要素を押しても地図は動かない（＝パンが始まらない）
    const landBefore = (doc.querySelector('svg path[fill="#0d2b52"]').getAttribute('d') || '').length;
    const filterPanel = uiPanels.find((p) => (p.getAttribute('style') || '').includes('top: 12px'));
    check('filter panel found', !!filterPanel);
    const inner = filterPanel ? (filterPanel.querySelector('button') || filterPanel.firstElementChild || filterPanel) : null;
    if (inner) {
        inner.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 800, clientY: 20 }));
        inner.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: 700, clientY: 200 }));
        inner.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 700, clientY: 200 }));
    }
    await sleep(280);
    const landAfterUi = (doc.querySelector('svg path[fill="#0d2b52"]').getAttribute('d') || '').length;
    check('dragging from the filter panel does NOT pan the map',
        landAfterUi === landBefore, `before=${landBefore} after=${landAfterUi}`);

    // 一方、地図本体（SVG）からのドラッグはちゃんとパンする
    const svg = doc.querySelector('svg');
    svg.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, clientX: 450, clientY: 250 }));
    svg.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 250 }));
    svg.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 250 }));
    await sleep(300);
    const landAfterMap = (doc.querySelector('svg path[fill="#0d2b52"]').getAttribute('d') || '').length;
    check('dragging from the map body DOES pan', landAfterMap !== landBefore,
        `before=${landBefore} after=${landAfterMap}`);
}

// ---- 14. 凡例クリックで絞り込み ------------------------------------------------
console.log('\n[14] clicking a legend entry filters the map');
{
    state.options = { enableZoom: true, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(320);
    check('all arcs visible before filtering', streaks().length === 6, `got ${streaks().length}`);

    // 凡例の 'high' 行をクリック → high の弧だけになる（ROWS では high が2本）
    const legendRow = [...doc.querySelectorAll('span')]
        .filter((s) => (s.getAttribute('style') || '').includes('box-shadow'))
        // カテゴリ名はスウォッチの次の span（行末には件数の span が付く）
        .filter((s) => s.nextElementSibling && s.nextElementSibling.textContent.trim() === 'high')
        .map((s) => s.parentElement)
        .find(Boolean);
    check('legend row for "high" found', !!legendRow);
    if (legendRow) {
        legendRow.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await sleep(300);
        check('legend click filters to that category', streaks().length === 2, `got ${streaks().length}`);
        // もう一度押すと解除
        const again = [...doc.querySelectorAll('span')]
            .filter((s) => (s.getAttribute('style') || '').includes('box-shadow'))
            .filter((s) => s.nextElementSibling && s.nextElementSibling.textContent.trim() === 'high')
            .map((s) => s.parentElement)
            .find(Boolean);
        again.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await sleep(300);
        check('clicking again clears the filter', streaks().length === 6, `got ${streaks().length}`);
    }
}

// ---- 15. 件数による線の太さ / 上位N件 ------------------------------------------
console.log('\n[15] arc width scales with count, maxArcs limits rendering');
{
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { widthScale: 2, maxArcs: 0 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(320);

    // 芯線（filter 無し・stroke 付き）の太さを count と突き合わせる。
    // ROWS の count は Shanghai=300 が最大、New York=10 が最小。
    const widths = streaks().map((p) => Number(p.getAttribute('stroke-width')));
    check('arc widths vary with count', new Set(widths).size > 1, JSON.stringify(widths));
    check('widest arc is clearly thicker than thinnest',
        Math.max(...widths) > Math.min(...widths) * 1.5,
        `min=${Math.min(...widths)} max=${Math.max(...widths)}`);

    // widthScale=0 なら一律
    state.options = { widthScale: 0 };
    fire('options', { options: state.options });
    await sleep(280);
    const flat = streaks().map((p) => Number(p.getAttribute('stroke-width')));
    check('widthScale=0 → uniform width', new Set(flat).size === 1, JSON.stringify(flat));

    // maxArcs で上位N件だけ描く
    state.options = { maxArcs: 3 };
    fire('options', { options: state.options });
    await sleep(280);
    check('maxArcs=3 renders only 3 arcs', streaks().length === 3, `got ${streaks().length}`);
    // 残るのは count 上位3件（300, 120, 80）→ Shanghai/London/Sao Paulo
    const tips = titles().join(' | ');
    check('top-3 by count are kept (Shanghai/London/Sao Paulo)',
        tips.includes('Shanghai') && tips.includes('London') && tips.includes('Sao Paulo'),
        tips.slice(0, 250));
    check('lowest-count arc (New York, 10) dropped', !tips.includes('New York'), tips.slice(0, 250));

    state.options = {};
    fire('options', { options: state.options });
    await sleep(250);
}

// ---- 16. ドリルダウン登録（要素ごとに固有の payload） ---------------------------
// 実機の挙動（トークンが実際に入るか）は happy-dom では再現できない。
// ここで検証するのは「要素ごとに登録され、payload が取り違えられていないか」まで。
console.log('\n[16] drilldown listeners are registered per element');
{
    drilldownRegs.length = 0;
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {};
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(350);

    check('drilldown listeners registered', drilldownRegs.length > 0, `got ${drilldownRegs.length}`);
    const arcRegs = drilldownRegs.filter((r) => r.action === 'link.click');
    const spotRegs = drilldownRegs.filter((r) => r.action === 'point.click');
    check('arcs registered as link.click', arcRegs.length >= 6, `got ${arcRegs.length}`);
    check('hotspots registered as point.click', spotRegs.length > 0, `got ${spotRegs.length}`);
    check('every registration has a DOM node', drilldownRegs.every((r) => !!r.node));

    // ⚠ 過去の失敗パターン: payloadCallback を使い回して行番号を固定すると
    //    「どこを押しても1行目」になる。各登録が別々の値を返すことを確認する。
    const payloads = arcRegs.map((r) => r.payloadCallback());
    const srcNames = payloads.map((p) => p['row.src_name.value']);
    check('each arc carries its own src (no shared/fixed payload)',
        new Set(srcNames).size === srcNames.length, JSON.stringify(srcNames));
    check('payload uses row.<field>.value convention',
        payloads[0] && 'row.dst_name.value' in payloads[0] && 'row.category.value' in payloads[0],
        JSON.stringify(payloads[0]));
    check('payload has name/value for interaction UI',
        payloads.every((p) => typeof p.name === 'string' && p.value !== undefined),
        JSON.stringify(payloads[0]));
}

// ---- 17. ホバーで関連する弧を強調 ----------------------------------------------
console.log('\n[17] hovering a hotspot highlights only related arcs');
{
    state.options = { highlightOnHover: true, animDuration: 0 };
    fire('options', { options: state.options });
    await sleep(300);
    const opacityOf = () => streaks().map((p) => Number(p.getAttribute('opacity')));
    const before = opacityOf();
    check('all arcs equally visible before hover', new Set(before).size === 1, JSON.stringify(before));

    // 透明な当たり判定の circle（r=12）にホバーする
    const hit = [...doc.querySelectorAll('svg circle')].find(
        (c) => c.getAttribute('r') === '12' && c.getAttribute('fill') === 'transparent'
    );
    check('hover hit-area exists on hotspots', !!hit);
    if (hit) {
        hit.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
        // React の onMouseEnter は mouseover から合成される
        await sleep(300);
        const after = opacityOf();
        check('hover dims unrelated arcs', new Set(after).size > 1, JSON.stringify(after));

        hit.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
        await sleep(300);
        check('leaving restores all arcs', new Set(opacityOf()).size === 1, JSON.stringify(opacityOf()));
    }

    // 無効化すると強調しない
    state.options = { highlightOnHover: false, animDuration: 0 };
    fire('options', { options: state.options });
    await sleep(300);
    if (hit) {
        const h2 = [...doc.querySelectorAll('svg circle')].find(
            (c) => c.getAttribute('r') === '12' && c.getAttribute('fill') === 'transparent'
        );
        h2.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
        await sleep(300);
        check('highlightOnHover=false keeps arcs uniform',
            new Set(opacityOf()).size === 1, JSON.stringify(opacityOf()));
        h2.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
    }
}

// ---- 18. ズームしても地名が減らない（画面内で絞ってから件数を採る） --------------
// v1.5.1 の不具合: CITY_LABELS.slice(0, N) で「世界の上位N件」を先に取ってから
// 画面内かを判定していたため、拡大すると上位N件がほぼ全部画面外になり、
// **ズームするほど地名が減る**症状になっていた（zoom40 で実測3件）。
console.log('\n[18] zooming in does not reduce place labels');
{
    const labelCount = () => [...doc.querySelectorAll('svg text')].length;
    const labelNames = () => [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {};
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(340);

    const counts = {};
    for (const z of [6, 16, 40]) {
        state.options = { initialZoom: z, centerLon: 137, centerLat: 36 };
        fire('options', { options: state.options });
        await sleep(340);
        counts[z] = labelCount();
    }
    // 深いズームでも「ひとにぎり」にならないこと（旧実装では zoom40 で 3 件だった）
    check('deep zoom still shows a useful number of labels', counts[40] >= 15,
        `zoom6=${counts[6]} zoom16=${counts[16]} zoom40=${counts[40]}`);
    check('zoom 16 shows more than the old broken behaviour', counts[16] >= 20,
        `got ${counts[16]}`);

    // 拡大したら「その地域の」都市が出る（世界の主要都市だけではない）
    state.options = { initialZoom: 25, centerLon: 137, centerLat: 36 };
    fire('options', { options: state.options });
    await sleep(340);
    const jp = labelNames();
    check('regional Japanese cities appear when zoomed into Japan',
        ['Kyoto', 'Nagoya', 'Kanazawa', 'Kobe', 'Hiroshima', 'Fukuoka', 'Nagano'].filter((c) => jp.includes(c)).length >= 3,
        JSON.stringify(jp.slice(0, 20)));

    // 別地域でも同様に機能する（日本だけの特殊対応ではない）
    state.options = { initialZoom: 8, centerLon: 10, centerLat: 50 };
    fire('options', { options: state.options });
    await sleep(340);
    const eu = labelNames();
    check('European cities appear when centered on Europe',
        ['Berlin', 'Vienna', 'Prague', 'Munich', 'Milan', 'Zurich'].filter((c) => eu.includes(c)).length >= 3,
        JSON.stringify(eu.slice(0, 20)));
    check('no Japanese cities leak into the European view', !eu.includes('Osaka'), JSON.stringify(eu.slice(0, 20)));
}

// ---- 19. 地名の表示量（labelDensity）が実際に効く --------------------------------
// 件数の上限だけ変えても重なり判定が固定だと表示数が変わらないため、
// 候補数と「ラベル間隔」の両方を density に連動させている。
console.log('\n[19] labelDensity actually changes how many labels appear');
{
    const labelCount = () => [...doc.querySelectorAll('svg text')].length;
    const got = {};
    for (const d of [0.2, 1, 3]) {
        state.options = { initialZoom: 16, centerLon: 137, centerLat: 36, labelDensity: d };
        fire('options', { options: state.options });
        await sleep(340);
        got[d] = labelCount();
    }
    check('higher density → more labels', got[3] > got[1], `d1=${got[1]} d3=${got[3]}`);
    check('lower density → fewer labels', got[0.2] < got[1], `d0.2=${got[0.2]} d1=${got[1]}`);
    check('density spans a meaningful range', got[3] >= got[0.2] * 2,
        `d0.2=${got[0.2]} d3=${got[3]}`);

    state.options = {};
    fire('options', { options: state.options });
    await sleep(250);
}

// ---- 20. タイトル文字列を編集画面から変更できる ----------------------------------
console.log('\n[20] title text is editable (and empty means no title)');
{
    state.options = { titleText: '通信フロー' };
    fire('options', { options: state.options });
    await sleep(300);
    check('custom title rendered', doc.body.textContent.includes('通信フロー'));
    check('default title replaced', !doc.body.textContent.includes('GLOBAL THREAT MAP'));

    // 空文字は「タイトル無し」として尊重する（既定値に戻さない）
    state.options = { titleText: '' };
    fire('options', { options: state.options });
    await sleep(300);
    check('empty title hides the title (does not fall back to default)',
        !doc.body.textContent.includes('GLOBAL THREAT MAP'), doc.body.textContent.slice(0, 120));

    // キー自体が無い（未設定）ときだけ既定値
    state.options = {};
    fire('options', { options: state.options });
    await sleep(300);
    check('unset title falls back to the default', doc.body.textContent.includes('GLOBAL THREAT MAP'));
}

// ---- 21. 地名の言語（labelLang）: 日本語の国名・都市名 ---------------------------
// 地図由来のラベルだけが対象。データ由来の src_name/dst_name は翻訳しない。
console.log('\n[21] labelLang=ja shows Japanese place names');
{
    const labelNames = () => [...doc.querySelectorAll('svg text')].map((t) => t.textContent);

    // 日本にズーム＋日本語 → 日本の都市が日本語で出る
    state.options = { initialZoom: 25, centerLon: 137, centerLat: 36, labelLang: 'ja' };
    fire('options', { options: state.options });
    await sleep(400);
    const ja = labelNames();
    check('Japanese city names appear (ja)',
        ['京都', '名古屋', '神戸', '金沢', '広島', '福岡', '長野'].filter((c) => ja.some((n) => n.includes(c))).length >= 3,
        JSON.stringify(ja.slice(0, 20)));
    check('English names for those cities are replaced', !ja.includes('Kyoto') && !ja.includes('Nagoya'),
        JSON.stringify(ja.slice(0, 20)));

    // 同じ画角で英語（既定）に戻すと英語名
    state.options = { initialZoom: 25, centerLon: 137, centerLat: 36 };
    fire('options', { options: state.options });
    await sleep(400);
    const en = labelNames();
    check('default stays English', en.includes('Kyoto') || en.includes('Nagoya') || en.includes('Kobe'),
        JSON.stringify(en.slice(0, 20)));

    // 低ズームでは国名も日本語になる
    state.options = { initialZoom: 4, centerLon: 137, centerLat: 36, labelLang: 'ja' };
    fire('options', { options: state.options });
    await sleep(400);
    const jaCountries = labelNames();
    // Natural Earth の NAME_JA は正式名称（例: 中華人民共和国）。
    // 「日本」ラベルは端点ラベル Tokyo が優先で場所を取るため出ないことがある。
    check('Japanese country names appear (ja)',
        ['中華人民共和国', 'モンゴル', 'ミャンマー'].filter((c) => jaCountries.some((n) => n.includes(c))).length >= 2,
        JSON.stringify(jaCountries.slice(0, 20)));

    // データ由来の地点名（src_name/dst_name）は言語設定の影響を受けない
    state.options = { labelLang: 'ja', showEndpointLabels: true };
    fire('options', { options: state.options });
    await sleep(400);
    const world = labelNames();
    check('data-driven endpoint labels keep their own text (Tokyo from search results)',
        world.includes('Tokyo'), JSON.stringify(world.slice(0, 20)));
}

// ---- 22. count しきい値の色分け（colorMode='count' + editor.threshold） ---------
// バンドは from 以上・to 未満。null は開いた範囲（±∞）。
console.log('\n[22] colorMode=count colors arcs by count thresholds');
{
    // counts: London120 Shanghai300 Moscow50 SaoPaulo80 NewYork10 Paris40
    state.options = {
        colorMode: 'count',
        countThresholds: [
            { from: 0, to: 100, value: '#00ff00' },
            { from: 100, to: null, value: '#ff0000' },
        ],
    };
    fire('options', { options: state.options });
    await sleep(340);
    const byColor = () => strokes().reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {});
    let m = byColor();
    check('arcs >=100 are red (London, Shanghai)', m['rgb(255, 0, 0)'] === 2, JSON.stringify(m));
    check('arcs <100 are green (other 4)', m['rgb(0, 255, 0)'] === 4, JSON.stringify(m));
    const body = doc.body.textContent;
    check('legend shows band labels', body.includes('0〜100') && body.includes('100以上'),
        body.slice(0, 200));

    // countThresholds 未設定（既定値はホストから届かない）でも既定バンドで動く
    state.options = { colorMode: 'count' };
    fire('options', { options: state.options });
    await sleep(340);
    m = byColor();
    check('default bands apply when thresholds are unset (>=100 → orange)',
        m['rgb(255, 90, 46)'] === 2, JSON.stringify(m));

    // どのバンドにも入らない count は (未分類) → fallbackColor
    state.options = {
        colorMode: 'count',
        countThresholds: [{ from: 0, to: 100, value: '#00ff00' }],
    };
    fire('options', { options: state.options });
    await sleep(340);
    m = byColor();
    check('counts outside all bands fall back to the default color',
        m['rgb(56, 166, 255)'] === 2, JSON.stringify(m));
    check('legend shows (未分類) for out-of-band counts', doc.body.textContent.includes('(未分類)'));

    // カテゴリ用の色設定（categoryColors）は count モードでは使われない
    state.options = {
        colorMode: 'count',
        categoryColors: ['high|#123456'],
        countThresholds: [
            { from: 0, to: 100, value: '#00ff00' },
            { from: 100, to: null, value: '#ff0000' },
        ],
    };
    fire('options', { options: state.options });
    await sleep(340);
    check('categoryColors is ignored in count mode', !strokes().includes('rgb(18, 52, 86)'),
        JSON.stringify(strokes()));

    state.options = {};
    fire('options', { options: state.options });
    await sleep(300);
}

// ---- 23. 国境の詳細度（mapDetail: 110m ↔ 50m） ---------------------------------
// 50m は 110m よりパスの座標点が桁違いに多い。パス文字列長で判別する。
console.log('\n[23] mapDetail switches border resolution');
{
    const landLen = () => {
        const p = doc.querySelector('svg path[fill="#0d2b52"]');
        return p ? (p.getAttribute('d') || '').length : 0;
    };
    state.options = { initialZoom: 6, centerLon: 137, centerLat: 36, mapDetail: 'low' };
    fire('options', { options: state.options });
    await sleep(400);
    const low = landLen();

    state.options = { initialZoom: 6, centerLon: 137, centerLat: 36, mapDetail: 'high' };
    fire('options', { options: state.options });
    await sleep(400);
    const high = landLen();
    check('high detail draws far more border points than low', high > low * 1.5,
        `low=${low} high=${high}`);

    // auto はズームで切り替わる: zoom1 → 110m 相当 / zoom6 → 50m 相当
    state.options = { initialZoom: 1, mapDetail: 'auto' };
    fire('options', { options: state.options });
    await sleep(400);
    const autoWorld = landLen();
    state.options = { initialZoom: 6, centerLon: 137, centerLat: 36, mapDetail: 'auto' };
    fire('options', { options: state.options });
    await sleep(400);
    const autoZoomed = landLen();
    check('auto uses high detail once zoomed in', autoZoomed === high, `auto=${autoZoomed} high=${high}`);
    check('auto stays lightweight at world view', autoWorld < high, `world=${autoWorld} high=${high}`);

    // 【v1.8.1 回帰】操作中（カメラ静止150msを待たず）でも詳細度は落ちない。
    // v1.8.0 は「操作中は110m・静止後に50m」で、操作のたびに国境が粗くなっていた。
    state.options = { initialZoom: 6, centerLon: 137, centerLat: 36, mapDetail: 'high' };
    fire('options', { options: state.options });
    await sleep(30); // 静止判定(150ms)より前
    const during = landLen();
    await sleep(400); // 静止後
    const settledLen = landLen();
    check('detail is not reduced while the camera is settling', during === settledLen && during > low,
        `during=${during} settled=${settledLen} low110m=${low}`);

    // ヒステリシス: auto の切替は「上げ=4倍・下げ=3倍」。しきい値付近で往復しても
    // パカパカ切り替わらない（直前の詳細度を保持する）。
    const lenAt = async (o) => {
        state.options = o;
        fire('options', { options: state.options });
        await sleep(250);
        return landLen();
    };
    const high35 = await lenAt({ initialZoom: 3.5, centerLon: 137, centerLat: 36, mapDetail: 'high' });
    const low35 = await lenAt({ initialZoom: 3.5, centerLon: 137, centerLat: 36, mapDetail: 'low' });
    await lenAt({ initialZoom: 6, centerLon: 137, centerLat: 36, mapDetail: 'auto' }); // 高詳細に入る
    const downTo35 = await lenAt({ initialZoom: 3.5, centerLon: 137, centerLat: 36, mapDetail: 'auto' });
    check('hysteresis keeps high detail when zooming out to 3.5', downTo35 === high35,
        `got=${downTo35} want=${high35}`);
    await lenAt({ initialZoom: 2, centerLon: 137, centerLat: 36, mapDetail: 'auto' }); // 低詳細へ落ちる
    const upTo35 = await lenAt({ initialZoom: 3.5, centerLon: 137, centerLat: 36, mapDetail: 'auto' });
    check('hysteresis stays low until zoom reaches 4', upTo35 === low35,
        `got=${upTo35} want=${low35}`);

    state.options = {};
    fire('options', { options: state.options });
    await sleep(300);
}

// ---- 24. カスタムツールチップ（<title> ではなく自前パネル） ----------------------
console.log('\n[24] custom tooltip appears on hover and follows the cursor');
{
    state.options = { animDuration: 0 };
    fire('options', { options: state.options });
    await sleep(300);

    // ホバー前はツールチップの中身が DOM に無い（aria-label は属性なので textContent に出ない）
    check('no tooltip text before hover', !doc.body.textContent.includes('count 300'),
        doc.body.textContent.slice(0, 120));

    // Shanghai の弧（count 300）の当たり判定にホバー
    const hit = [...doc.querySelectorAll('svg path[stroke="transparent"]')].find(
        (p) => (p.getAttribute('aria-label') || '').includes('Shanghai')
    );
    check('arc hit-area with aria-label exists', !!hit);
    if (hit) {
        hit.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, clientX: 300, clientY: 200 }));
        await sleep(250);
        const body = doc.body.textContent;
        check('tooltip shows the route', body.includes('Shanghai → Tokyo'), body.slice(0, 200));
        check('tooltip shows category and count', body.includes('count 300'), body.slice(0, 200));

        hit.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
        await sleep(250);
        check('tooltip disappears on leave', !doc.body.textContent.includes('Shanghai → Tokyo'),
            doc.body.textContent.slice(0, 120));
    }

    // ホットスポット側にも同じツールチップ機構が付いている
    const spot = [...doc.querySelectorAll('svg circle')].find(
        (c) => (c.getAttribute('aria-label') || '').startsWith('Target: Tokyo')
    );
    check('hotspot hit-area with aria-label exists', !!spot);
    if (spot) {
        spot.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, clientX: 300, clientY: 200 }));
        await sleep(250);
        check('hotspot tooltip rendered', doc.body.textContent.includes('Target: Tokyo'),
            doc.body.textContent.slice(0, 200));
        spot.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true }));
        await sleep(200);
    }
}

// ---- 25. 地名ラベルの選定はカメラ静止後に確定する（操作中の間引き） ----------------
// 選定（重い）は settledCamera（150ms 静止）基準、投影（軽い）は毎フレーム。
// カメラ変更直後でも描画は壊れず、静止後にその地域のラベルへ確定することを確認する。
console.log('\n[25] label selection settles after the camera stops moving');
{
    const labelNames = () => [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    state.options = { initialZoom: 8, centerLon: 10, centerLat: 50 };
    fire('options', { options: state.options });
    await sleep(400);

    // 日本へジャンプ。直後（静止前）でも例外なく描画され続ける
    state.options = { initialZoom: 8, centerLon: 137, centerLat: 36 };
    fire('options', { options: state.options });
    await sleep(30);
    check('render survives immediately after a camera jump', !!doc.querySelector('svg'));

    // 静止（150ms）後には移動先のラベルが確定する
    await sleep(400);
    const jp = labelNames();
    check('labels settle to the new region', jp.includes('Tokyo') || jp.includes('Osaka') || jp.includes('Nagoya'),
        JSON.stringify(jp.slice(0, 20)));
    check('old-region labels are gone after settling', !jp.includes('Berlin'),
        JSON.stringify(jp.slice(0, 20)));

    state.options = {};
    fire('options', { options: state.options });
    await sleep(300);
}

// ---- 26. 地点クラスタリング（A-1） --------------------------------------------
// v1.8.2 までは「投影後 0.1px 完全一致」でしか集約されず、同一都市でも緯度経度が
// わずかにばらける実データ（IP ジオロケーション）ではほぼ集約されなかった。
// v1.9.0 は画面距離ベースで集約する。ズームすると自然に分離することも確認する。
console.log('\n[26] nearby points cluster by screen distance');
{
    // 関東一円に散らばった 5 つの起点（すべて別座標）。
    // zoom1（世界表示）では画面上 数px 以内に集まるので 1 クラスタに畳まれ、
    // 拡大すると 18px を超えて離れるため分離する、という関係になる距離に取る。
    // ※点を近づけすぎると拡大しても分離せず、テストが集約の解除を検証できない
    //   （実測: 0.01°差では zoom30 でも最大 4.5px しか離れない）。
    const SCATTER = [
        ['35.68', '139.69', '51.5', '-0.12', 'high', '10', 'Tokyo-A', 'London'],
        ['35.44', '139.64', '51.5', '-0.12', 'high', '20', 'Yokohama', 'London'],
        ['35.86', '139.65', '51.5', '-0.12', 'high', '30', 'Saitama', 'London'],
        ['35.60', '140.12', '51.5', '-0.12', 'high', '40', 'Chiba', 'London'],
        ['35.658', '139.745', '51.5', '-0.12', 'high', '50', 'Minato', 'London'],
    ];
    // 起点ホットスポットの数を数える（当たり判定 r=12 の circle が 1 地点 1 個）
    const spotCount = () =>
        [...doc.querySelectorAll('svg circle[r="12"]')].filter((c) =>
            (c.getAttribute('aria-label') || '').startsWith('Source:')
        ).length;

    state.data = { fields: FIELDS, rows: SCATTER };
    // まず集約を無効にすると、5 地点が別々に描かれる（従来の挙動）
    state.options = { clusterRadius: 0, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(350);
    const noCluster = spotCount();
    // clusterRadius=0 は従来（v1.8.2）の 0.1px 完全一致に退避する。
    // zoom1 では 5 地点が画面上 1px 未満に潰れるため 1 つにはまとまらず、
    // 「丸め位置が偶然一致した分だけ」が畳まれる（＝集約として機能していない）。
    // この中途半端さこそ A-1 が解決した問題なので、複数個に割れることを記録しておく。
    check('clusterRadius=0 falls back to legacy exact-match (barely merges)',
        noCluster > 1, `got ${noCluster}`);

    // 既定（18px）では、世界表示で近接した 5 地点が 1 つに畳まれる
    state.options = { clusterRadius: 18, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    await sleep(350);
    const clustered = spotCount();
    check('nearby points collapse into one cluster at zoom 1', clustered === 1, `got ${clustered}`);

    // 集約された地点のツールチップは「ほか N 地点」と内訳を示す
    const clusterLabel = [...doc.querySelectorAll('svg circle[r="12"]')]
        .map((c) => c.getAttribute('aria-label') || '')
        .find((l) => l.startsWith('Source:'));
    check('cluster tooltip shows how many points were merged',
        /ほか 4 地点/.test(clusterLabel || ''), clusterLabel);
    // count は合算される（10+20+30+40+50 = 150）
    check('cluster sums the counts of its members',
        /count 150/.test(clusterLabel || ''), clusterLabel);

    // 十分にズームすると同じ radius でもクラスタが分離する（地図アプリと同じ挙動）
    state.options = { clusterRadius: 18, initialZoom: 30, centerLon: 139.69, centerLat: 35.68 };
    fire('options', { options: state.options });
    await sleep(400);
    const zoomed = spotCount();
    check('zooming in separates the cluster again', zoomed > 1, `got ${zoomed}`);

    // 弧の本数はクラスタリングでは変わらない（描画位置が吸着するだけ）
    check('clustering does not drop arcs', streaks().length === 5, `got ${streaks().length}`);

    // 負の count（`| eval count=a-b` のような差分）でも代表点がクラスタの外へ飛ばない。
    // 重みを非負に丸めていないと加重平均が破綻し、マーカーが無関係な場所に描かれる。
    state.data = {
        fields: FIELDS,
        rows: [
            ['35.68', '139.69', '51.5', '-0.12', 'high', '10', 'Tokyo-A', 'London'],
            ['35.69', '139.70', '51.5', '-0.12', 'high', '-9', 'Tokyo-B', 'London'],
            ['35.67', '139.68', '51.5', '-0.12', 'high', '-3', 'Tokyo-C', 'London'],
        ],
    };
    state.options = { clusterRadius: 18, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(350);
    // 東京は zoom1・900x500 では概ね x=780 付近。代表点が壊れると 0 付近へ飛ぶ。
    const negSpot = [...doc.querySelectorAll('svg circle[r="12"]')]
        .filter((c) => (c.getAttribute('aria-label') || '').startsWith('Source:'))
        .map((c) => Number(c.getAttribute('cx')));
    check('negative counts do not throw the cluster centroid off the map',
        negSpot.length > 0 && negSpot.every((x) => Number.isFinite(x) && x > 600),
        JSON.stringify(negSpot));
}

// ---- 27. 件数サマリー（A-2） ---------------------------------------------------
// maxArcs は「上位 N 本だけ描いて残りを捨てる」動作なので、捨てられた分の存在を
// 凡例に出す。count 列の有無で単位が「件」/「本」に切り替わることも確認する。
console.log('\n[27] legend shows totals and per-category counts');
{
    const legendText = () => {
        const sw = [...doc.querySelectorAll('span')]
            .find((s) => (s.getAttribute('style') || '').includes('box-shadow'));
        // 凡例パネル = スウォッチを含む最小の div の、さらに親（パネル本体）
        const panel = sw && sw.parentElement ? sw.parentElement.parentElement : null;
        return panel ? panel.textContent : '';
    };

    state.data = { fields: FIELDS, rows: ROWS };
    state.options = { maxArcs: 0, clusterRadius: 0, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(350);
    // count 列があるので単位は「件」。全件描いているので「全 N 件」だけが出る
    // ROWS_VALID の count 合計 = 120+300+50+80+10+40 = 600
    check('shows grand total with 件 unit when a count column exists',
        /全 600 件/.test(legendText()), legendText().slice(0, 160));
    check('does not show a 表示/全 split when nothing is truncated',
        !legendText().includes('表示'), legendText().slice(0, 160));

    // maxArcs で絞ると「表示 N / 全 M」になる。上位2本 = 300 + 120 = 420
    state.options = { maxArcs: 2, clusterRadius: 0, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    await sleep(350);
    check('shows 表示/全 split when maxArcs truncates',
        /表示 420 \/ 全 600 件/.test(legendText()), legendText().slice(0, 160));

    // カテゴリごとの件数が各行に出る（high = 300 + 50 = 350）
    state.options = { maxArcs: 0, clusterRadius: 0, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    await sleep(350);
    const highRow = [...doc.querySelectorAll('span')]
        .filter((s) => (s.getAttribute('style') || '').includes('box-shadow'))
        .filter((s) => s.nextElementSibling && s.nextElementSibling.textContent.trim() === 'high')
        .map((s) => s.parentElement)
        .find(Boolean);
    check('per-category count rendered on the legend row',
        !!highRow && highRow.textContent.includes('350'),
        highRow ? highRow.textContent : 'no high row');

    // 【重要】カテゴリ別件数は絞り込みに影響されない。
    // 描画中の分で数えると、凡例クリックで他カテゴリが全て 0 になり
    // 「そのカテゴリのデータが無い」と誤読させる（実際は隠れているだけ）。
    const beforeFilter = legendText();
    check('category counts present before filtering',
        /medium\s*80/.test(beforeFilter), beforeFilter.slice(0, 160));
    const highRow2 = [...doc.querySelectorAll('span')]
        .filter((s) => (s.getAttribute('style') || '').includes('box-shadow'))
        .filter((s) => s.nextElementSibling && s.nextElementSibling.textContent.trim() === 'high')
        .map((s) => s.parentElement)
        .find(Boolean);
    if (highRow2) {
        highRow2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await sleep(320);
        check('filtering does not zero out other categories in the legend',
            /medium\s*80/.test(legendText()), legendText().slice(0, 160));
        check('totals switch to 表示/全 while filtered',
            /表示 350 \/ 全 600 件/.test(legendText()), legendText().slice(0, 160));
        // 解除
        const again2 = [...doc.querySelectorAll('span')]
            .filter((s) => (s.getAttribute('style') || '').includes('box-shadow'))
            .filter((s) => s.nextElementSibling && s.nextElementSibling.textContent.trim() === 'high')
            .map((s) => s.parentElement)
            .find(Boolean);
        if (again2) again2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await sleep(320);
    }

    // オプションで両方とも消せる
    state.options = { showTotals: false, showCategoryCounts: false, maxArcs: 2, clusterRadius: 0 };
    fire('options', { options: state.options });
    await sleep(350);
    check('showTotals=false hides the totals line', !legendText().includes('表示 '),
        legendText().slice(0, 160));
    check('showCategoryCounts=false hides per-category counts', !/high\s*350/.test(legendText()),
        legendText().slice(0, 160));

    // count 列が無いデータでは単位が「本」になり、弧の本数を数える
    const NO_COUNT_FIELDS = ['src_lat', 'src_lon', 'dst_lat', 'dst_lon', 'severity']
        .map((name) => ({ name }));
    state.data = {
        fields: NO_COUNT_FIELDS,
        rows: ROWS_VALID.map((r) => r.slice(0, 5)),
    };
    state.options = { maxArcs: 0, clusterRadius: 0, initialZoom: 1, centerLon: 0, centerLat: 0 };
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(350);
    check('unit falls back to 本 when there is no count column',
        /全 6 本/.test(legendText()), legendText().slice(0, 160));

    // 後片付け（以降のテストに影響させない）
    state.data = { fields: FIELDS, rows: ROWS };
    state.options = {};
    fire('options', { options: state.options });
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
