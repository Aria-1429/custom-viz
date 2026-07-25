// Chord Flow viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'dist', 'custom_viz_chord_flow', 'visualization.js');
const CONFIG = join(HERE, '..', 'visualizations', 'custom_viz_chord_flow', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- 0. config.json の editor 型を機械チェック（無効型はセクションごと消える事故対策） --
console.log('[0] config.json sanity');
{
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    // 確実な3種 + columnSelector（標準vizの「データ設定」と同形状で採用。実機確認対象）
    const SAFE = new Set(['editor.color', 'editor.checkbox', 'editor.number', 'editor.columnSelector']);
    const editors = [];
    (cfg.config.editorConfig || []).forEach((sec) =>
        (sec.layout || []).forEach((row) => row.forEach((item) => editors.push(item)))
    );
    check('all editors are safe types', editors.every((e) => SAFE.has(e.editor)),
        JSON.stringify(editors.filter((e) => !SAFE.has(e.editor))));
    const schema = cfg.config.optionsSchema;
    check('every editor option exists in optionsSchema',
        editors.every((e) => schema[e.option] !== undefined),
        JSON.stringify(editors.filter((e) => schema[e.option] === undefined)));
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 600 });
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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(), 5);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// コンテナ実寸（可変。resize() でリサイズをシミュレートできる）
let VW = 900;
let VH = 600;
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VW });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VH });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: VW, bottom: VH, width: VW, height: VH, x: 0, y: 0 };
};

// ResizeObserver 簡易モック（observe 時に即 callback。resize() で手動 flush）
const ROS = [];
globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; ROS.push(this); }
    observe() { setTimeout(() => this.cb([]), 0); }
    disconnect() {}
    unobserve() {}
};
win.ResizeObserver = globalThis.ResizeObserver;

const resize = async (w, h) => {
    VW = w;
    VH = h;
    ROS.forEach((ro) => setTimeout(() => ro.cb([]), 0));
    await sleep(300);
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

const FIELDS = [{ name: 'src' }, { name: 'dst' }, { name: 'count' }];
const ROWS = [
    ['Tokyo', 'Osaka', '5,200'],   // カンマ付き数値の正規化を検証
    ['Osaka', 'Tokyo', '3100'],    // 双方向 → 独立したリボン（Sankeyでは不可能な循環）
    ['Tokyo', 'Nagoya', '1400'],
    ['Nagoya', 'Fukuoka', '900'],
    ['Fukuoka', 'Tokyo', '700'],   // 循環フロー → そのまま表現
    ['Osaka', 'Fukuoka', '600'],
    ['Tokyo', 'Tokyo', '50'],      // 自己ループ → 除去
    ['', 'X', '10'],               // 空カテゴリ → 除去
    ['A', 'B', 'abc'],             // 非数値 → 除去
    ['A', 'B', '-5'],              // 0以下 → 除去
];

let state = {
    data: { fields: FIELDS, rows: ROWS },
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
    getDimensions: () => ({ width: 900, height: 600 }),
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

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 既定オプション（ダーク） --------------------------------------------
console.log('\n[1] defaults (dark theme)');
{
    const svg = doc.querySelector('svg');
    check('svg rendered', !!svg);
    const ribbons = [...doc.querySelectorAll('.cf-ribbon')];
    // 有効リンク: 6本（自己ループ1・不正3行を除去、双方向は別リボン）
    check('6 ribbons (bidirectional kept separate)', ribbons.length === 6, `got ${ribbons.length}`);
    const arcs = [...doc.querySelectorAll('.cf-arc')];
    check('4 entity arcs', arcs.length === 4, `got ${arcs.length}`);
    const texts = [...doc.querySelectorAll('svg text')].map((t) => t.textContent);
    check('labels include Tokyo', texts.some((t) => t.includes('Tokyo')));
    // Tokyo total = out(5200+1400) + in(3100+700) = 10400 → "10k"
    check('Tokyo label shows compact total 10k', texts.some((t) => t.includes('Tokyo') && t.includes('10k')),
        JSON.stringify(texts));
    const header = doc.body.textContent;
    check('header shows total 11,900', header.includes('11,900'), header.slice(0, 200));
    check('header shows 4 entities / 6 flows', header.includes('4 エンティティ') && header.includes('6 フロー'));
    // グラデーションリボン既定 ON
    const grads = doc.querySelectorAll('svg defs linearGradient');
    check('gradient defs = ribbons', grads.length === 6, `got ${grads.length}`);
    check('ribbons use gradient url', ribbons.every((p) => (p.getAttribute('fill') || '').startsWith('url(#')));
    check('fill-opacity 0.55', ribbons.every((p) => Math.abs(parseFloat(p.getAttribute('fill-opacity')) - 0.55) < 1e-6));
    // グロー既定 ON
    check('glow filter defined', !!doc.querySelector('svg defs filter'));
    // パーティクル（プレウォーム + 発生）が回っている
    const particles = [...doc.querySelectorAll('.cf-particle')];
    check('particles spawned', particles.length > 0, `got ${particles.length}`);
    const visible = particles.filter((p) => parseFloat(p.getAttribute('opacity') || '0') > 0);
    check('some particles visible', visible.length > 0, `got ${visible.length}`);
    check('particles positioned (cx set)', visible.every((p) => p.getAttribute('cx') !== null));
}

// ---- 2. 値ベースカラースケール ---------------------------------------------
console.log('\n[2] useValueColors on (low green → high red, no mid)');
{
    state.options = {
        useValueColors: true, useMidColor: false,
        lowColor: '#00ff00', highColor: '#ff0000', ribbonOpacity: 80,
    };
    fire('options', { options: state.options });
    await sleep(300);
    const ribbons = [...doc.querySelectorAll('.cf-ribbon')];
    const fills = ribbons.map((p) => p.getAttribute('fill'));
    check('fills are rgb() scale colors', fills.every((s) => s.startsWith('rgb(')), JSON.stringify(fills));
    check('max flow (5200) is pure red', fills.includes('rgb(255,0,0)'), JSON.stringify(fills));
    check('min flow (600) is pure green', fills.includes('rgb(0,255,0)'));
    check('opacity updated to 0.8', ribbons.every((p) => Math.abs(parseFloat(p.getAttribute('fill-opacity')) - 0.8) < 1e-6));
    check('legend gradient bar in header', doc.body.innerHTML.includes('linear-gradient'));
    // パーティクルもスケール色に追従する
    const pcolors = [...doc.querySelectorAll('.cf-particle')]
        .filter((p) => parseFloat(p.getAttribute('opacity') || '0') > 0)
        .map((p) => p.getAttribute('fill'));
    check('particles follow scale colors', pcolors.every((c) => c && c.startsWith('rgb(')), JSON.stringify(pcolors));
}

// ---- 3. reverse 反転 ---------------------------------------------------------
console.log('\n[3] reverse');
{
    state.options = { ...state.options, reverse: true };
    fire('options', { options: state.options });
    await sleep(250);
    const fills = [...doc.querySelectorAll('.cf-ribbon')].map((p) => p.getAttribute('fill'));
    check('reversed scale applies (max flow now green)', fills.includes('rgb(0,255,0)'), JSON.stringify(fills));
}

// ---- 4. パーティクル OFF -----------------------------------------------------
console.log('\n[4] showParticles off');
{
    state.options = { showParticles: false };
    fire('options', { options: state.options });
    await sleep(300);
    const particles = [...doc.querySelectorAll('.cf-particle')];
    const visible = particles.filter((p) => parseFloat(p.getAttribute('opacity') || '0') > 0);
    check('all particles hidden', visible.length === 0, `got ${visible.length} visible`);
}

// ---- 5. リング回転 -----------------------------------------------------------
console.log('\n[5] ring rotation');
{
    state.options = { rotateSpeed: 45 };
    fire('options', { options: state.options });
    await sleep(400);
    const translated = doc.querySelector('svg > g');
    const rotG = translated && translated.querySelector('g');
    const tf = rotG && rotG.getAttribute('transform');
    check('rotation transform applied', !!tf && /rotate\(/.test(tf), String(tf));
    const angle = tf ? parseFloat(tf.replace(/rotate\(/, '')) : 0;
    check('rotation angle is non-zero', Number.isFinite(angle) && Math.abs(angle) > 0.01, String(angle));
}

// ---- 6. テーマ切替 -----------------------------------------------------------
console.log('\n[6] theme switch to light');
{
    state.options = {};
    fire('options', { options: state.options });
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(250);
    const text = doc.querySelector('svg text');
    check('label color switches to light-mode text', text && text.getAttribute('fill') === '#31373e',
        text && text.getAttribute('fill'));
}

// ---- 7. ガード ---------------------------------------------------------------
console.log('\n[7] guards');
{
    state.data = { fields: [{ name: 'a' }, { name: 'b' }], rows: [['x', '1']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('2-col message', doc.body.textContent.includes('最低3列が必要'));

    state.data = { fields: FIELDS, rows: [] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('empty data message', doc.body.textContent.includes('データがありません'));

    // 全行不正（自己ループ・非数値・空）→ nolinks メッセージ
    state.data = { fields: FIELDS, rows: [['a', 'a', '5'], ['a', 'b', 'xyz'], ['', 'b', '5']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(250);
    check('no valid flows message', doc.body.textContent.includes('有効なフローがありません'));

    // columns 形式でも動く
    state.data = {
        fields: FIELDS,
        columns: [['A', 'B'], ['B', 'C'], ['10', '20']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    const ribbons = [...doc.querySelectorAll('.cf-ribbon')];
    check('columns-form data renders 2 ribbons', ribbons.length === 2, `got ${ribbons.length}`);
}

// ---- 8. マルチバリュー行の自動展開（mvexpand し忘れの救済） -------------------
console.log('\n[8] multivalue row auto-expand');
{
    state.options = {};
    fire('options', { options: state.options });
    // 配列セル（Splunk の mv フィールドが1行に潰れて届いたケース）
    state.data = {
        fields: FIELDS,
        rows: [[
            ['Tokyo', 'Osaka', 'Tokyo'],
            ['Osaka', 'Tokyo', 'Nagoya'],
            ['5200', '3100', '1400'],
        ]],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    let ribbons = [...doc.querySelectorAll('.cf-ribbon')];
    check('array cells expand to 3 ribbons', ribbons.length === 3, `got ${ribbons.length}`);
    let arcs = [...doc.querySelectorAll('.cf-arc')];
    check('3 arcs after expansion', arcs.length === 3, `got ${arcs.length}`);
    check('header total 9,700 (not digit-concatenated)', doc.body.textContent.includes('9,700'),
        doc.body.textContent.slice(0, 160));

    // 改行区切り文字列セルでも展開できる
    state.data = { fields: FIELDS, rows: [['A\nB', 'B\nC', '10\n20']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    ribbons = [...doc.querySelectorAll('.cf-ribbon')];
    check('newline-joined cells expand to 2 ribbons', ribbons.length === 2, `got ${ribbons.length}`);

    // トークン数不一致は展開しない（不正行として除去 → nolinks）
    state.data = { fields: FIELDS, rows: [[['A', 'B'], ['C'], ['10', '20']]] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    check('mismatched token counts fall back to guard', doc.body.textContent.includes('有効なフローがありません'));
}

// ---- 9. 巨大数の表示（ヘッダー崩壊防止） -------------------------------------
console.log('\n[9] huge numbers use exponential notation');
{
    state.data = {
        fields: FIELDS,
        rows: [['A', 'B', '5200310014008009000000000000000'], ['B', 'A', '1e28']],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    const header = doc.body.textContent;
    check('total shown as exponential', /e\+30/.test(header), header.slice(0, 120));
    check('no 30-digit comma monster', !/(\d{1,3},){8,}/.test(header), header.slice(0, 120));
}

// ---- 10. debug オーバーレイ ----------------------------------------------------
console.log('\n[10] debug overlay');
{
    state.options = { debug: true };
    fire('options', { options: state.options });
    await sleep(250);
    check('debug dump visible', doc.body.textContent.includes('"normalized"'));
}

// ---- 11. ラベルフィット（見切れ防止の段階退避） -------------------------------
console.log('\n[11] label fitting & graceful degradation');
{
    state.options = {};
    fire('options', { options: state.options });
    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);

    // ベースライン（900x600）: ラベル + 値併記あり
    let labels = [...doc.querySelectorAll('.cf-label')];
    check('baseline: labels with value tspans', labels.length > 0
        && doc.querySelectorAll('.cf-label tspan').length > 0, `labels=${labels.length}`);

    // 小サイズ（300x260 → size<240）: ラベルは残るが値併記は自動オフ
    await resize(300, 260);
    labels = [...doc.querySelectorAll('.cf-label')];
    check('small: labels still shown', labels.length > 0, `got ${labels.length}`);
    check('small: value tspans auto-hidden', doc.querySelectorAll('.cf-label tspan').length === 0,
        `got ${doc.querySelectorAll('.cf-label tspan').length}`);

    // 極小（190x180）: ラベル自体を自動非表示、リングは描画継続
    await resize(190, 180);
    check('tiny: ring still rendered', doc.querySelectorAll('.cf-arc').length === 4,
        `got ${doc.querySelectorAll('.cf-arc').length}`);
    check('tiny: labels auto-hidden', doc.querySelectorAll('.cf-label').length === 0,
        `got ${doc.querySelectorAll('.cf-label').length}`);

    // 元に戻すとラベル復帰
    await resize(900, 600);
    check('restore: labels back', doc.querySelectorAll('.cf-label').length > 0);

    // 長い名前は … で切り詰め（フルネームはツールチップで見える）
    state.data = {
        fields: FIELDS,
        rows: [
            ['SuperUltraLongEntityNameThatWouldOverflowThePanel', 'Tokyo', '100'],
            ['Tokyo', 'SuperUltraLongEntityNameThatWouldOverflowThePanel', '50'],
        ],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    const texts = [...doc.querySelectorAll('.cf-label')].map((t) => t.textContent);
    check('long name truncated with ellipsis', texts.some((t) => t.includes('…')), JSON.stringify(texts));
    check('label does not carry the full long name', !texts.some(
        (t) => t.includes('SuperUltraLongEntityNameThatWouldOverflowThePanel')
    ), JSON.stringify(texts));
}

// ---- 12. フィールド選択（editor.columnSelector 対応） -------------------------
console.log('\n[12] field selection (DOS string / plain name / resolved array)');
{
    state.options = {};
    fire('options', { options: state.options });
    const FIELDS4 = [{ name: 'src' }, { name: 'dst' }, { name: 'count' }, { name: 'weight' }];
    state.data = {
        fields: FIELDS4,
        rows: [
            ['A', 'B', '10', '99'],
            ['B', 'C', '20', '1'],
        ],
    };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    check('default: value = last column (weight), total 100',
        doc.body.textContent.includes('100'), doc.body.textContent.slice(0, 120));
    check('default: 3 arcs / 2 ribbons',
        doc.querySelectorAll('.cf-arc').length === 3 && doc.querySelectorAll('.cf-ribbon').length === 2);

    // DOS 文字列（columnSelector が書く形式）でフィールド名指定
    state.options = { valueField: "> primary | seriesByName('count')" };
    fire('options', { options: state.options });
    await sleep(300);
    check('DOS seriesByName: total 30', doc.body.textContent.includes('30'),
        doc.body.textContent.slice(0, 120));

    // DOS の seriesByIndex 形式
    state.options = { valueField: '> primary | seriesByIndex(2)' };
    fire('options', { options: state.options });
    await sleep(300);
    check('DOS seriesByIndex(2): total 30', doc.body.textContent.includes('30'));

    // 生フィールド名
    state.options = { valueField: 'weight' };
    fire('options', { options: state.options });
    await sleep(300);
    check('plain field name: total 100', doc.body.textContent.includes('100'));

    // 存在しないフィールド名 → 最終列にフォールバック
    state.options = { valueField: 'nonexistent' };
    fire('options', { options: state.options });
    await sleep(300);
    check('unknown name falls back to last column', doc.body.textContent.includes('100'));

    // ホストが DOS を解決して列データ配列が届いた場合 → 列内容の照合で解決
    state.options = { valueField: ['10', '20'] };
    fire('options', { options: state.options });
    await sleep(300);
    check('resolved array matches count column: total 30', doc.body.textContent.includes('30'));

    // source と target が同一 → 専用エラーメッセージ
    state.options = { sourceField: 'dst', targetField: 'dst' };
    fire('options', { options: state.options });
    await sleep(300);
    check('same source/target shows dedicated message',
        doc.body.textContent.includes('別の列にしてください'));

    // source/target 入れ替え（生フィールド名）でも普通に描画される
    state.options = { sourceField: 'dst', targetField: 'src' };
    fire('options', { options: state.options });
    await sleep(300);
    check('swapped source/target renders', doc.querySelectorAll('.cf-ribbon').length === 2);
}

// ---- 13. 自己ループ（showSelfLoops） ---------------------------------------
console.log('\n[13] self-loops (source == target)');
{
    const SELF_ROWS = [
        ['Tokyo', 'Osaka', '100'],
        ['Osaka', 'Tokyo', '80'],
        ['Tokyo', 'Tokyo', '40'], // 自己ループ
        ['Osaka', 'Osaka', '20'], // 自己ループ
    ];
    // 既定（OFF）: 自己ループは除去、通常リンク2本だけ
    state.options = {};
    fire('options', { options: state.options });
    state.data = { fields: FIELDS, rows: SELF_ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    check('self-loops OFF: 2 ribbons, no self-loop paths',
        doc.querySelectorAll('.cf-ribbon').length === 2
        && doc.querySelectorAll('.cf-selfloop').length === 0,
        `ribbons=${doc.querySelectorAll('.cf-ribbon').length} self=${doc.querySelectorAll('.cf-selfloop').length}`);
    check('self-loops OFF: header has no self total',
        !doc.body.textContent.includes('自己ループ'));

    // ON: 自己ループ弧が2本描かれ、ヘッダーに合計が出る
    state.options = { showSelfLoops: true };
    fire('options', { options: state.options });
    await sleep(300);
    check('self-loops ON: 2 self-loop paths drawn',
        doc.querySelectorAll('.cf-selfloop').length === 2,
        `got ${doc.querySelectorAll('.cf-selfloop').length}`);
    check('self-loops ON: normal ribbons unchanged (still 2)',
        doc.querySelectorAll('.cf-ribbon').length === 2);
    check('self-loops ON: header shows self total 60', doc.body.textContent.includes('自己ループ'));

    // 自己ループのみのデータ + OFF → nolinks（案内メッセージに自己ループ言及）
    state.options = {};
    fire('options', { options: state.options });
    state.data = { fields: FIELDS, rows: [['A', 'A', '5'], ['B', 'B', '9']] };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    check('only self-loops + OFF → nolinks message mentions self-loop option',
        doc.body.textContent.includes('自己ループを表示'));

    // 自己ループのみのデータ + ON → 環にはならない（リンク0なので nolinks のまま。仕様）
    state.options = { showSelfLoops: true };
    fire('options', { options: state.options });
    await sleep(300);
    check('only self-loops + ON still needs at least one non-self link',
        doc.body.textContent.includes('有効なフローがありません'));
}

// ---- 14. リボンのテーパー（taperRibbons） -----------------------------------
console.log('\n[14] ribbon taper (direction cue)');
{
    state.options = {};
    fire('options', { options: state.options });
    state.data = { fields: FIELDS, rows: ROWS };
    fire('dataSources', { loading: false, dataSources: { primary: { data: state.data } } });
    await sleep(300);
    const dTapered = [...doc.querySelectorAll('.cf-ribbon')].map((p) => p.getAttribute('d'));
    check('tapered path present (default ON)', dTapered.length === 6 && dTapered.every((d) => !!d));

    // 当たり判定パスは全幅（テーパー無し）。テーパー ON でも hit は太いままなので
    // 細い部分でもクリックしやすい。hit の d は taper OFF の見た目リボンと一致する。
    const dHit = [...doc.querySelectorAll('.cf-ribbon-hit')].map((p) => p.getAttribute('d'));
    check('full-width hit path exists per ribbon (6)', dHit.length === 6 && dHit.every((d) => !!d));
    check('hit path is transparent to view but catches events',
        [...doc.querySelectorAll('.cf-ribbon-hit')].every(
            (p) => parseFloat(p.getAttribute('fill-opacity')) === 0));
    check('hit path is wider than tapered visible ribbon (different d)',
        dHit.some((d, i) => d !== dTapered[i]));

    // OFF にすると見た目の d が変わる（同幅パスに戻る）。かつ hit と一致する
    state.options = { taperRibbons: false };
    fire('options', { options: state.options });
    await sleep(300);
    const dFull = [...doc.querySelectorAll('.cf-ribbon')].map((p) => p.getAttribute('d'));
    check('taper OFF changes ribbon path geometry',
        dFull.length === 6 && dFull.some((d, i) => d !== dTapered[i]));
    const dHit2 = [...doc.querySelectorAll('.cf-ribbon-hit')].map((p) => p.getAttribute('d'));
    check('taper OFF: visible ribbon matches full-width hit path',
        dFull.every((d, i) => d === dHit2[i]));
}

// ---- 15. 矢印（showArrows） --------------------------------------------------
console.log('\n[15] arrows on target end');
{
    state.options = {};
    fire('options', { options: state.options });
    await sleep(250);
    check('arrows off by default', doc.querySelectorAll('.cf-arrow').length === 0);

    state.options = { showArrows: true };
    fire('options', { options: state.options });
    await sleep(300);
    const arrows = [...doc.querySelectorAll('.cf-arrow')];
    check('arrows drawn one per flow (6)', arrows.length === 6, `got ${arrows.length}`);
    check('arrows are triangles (3-point Z path)',
        arrows.every((a) => (a.getAttribute('d') || '').match(/L/g)?.length === 2));
}

// ---- 16. クリックで選択固定（clickToFocus） ----------------------------------
console.log('\n[16] click to focus (lock selection)');
{
    state.options = {};
    fire('options', { options: state.options });
    await sleep(250);
    const ribbons = () => [...doc.querySelectorAll('.cf-ribbon')];
    const arcs = () => [...doc.querySelectorAll('.cf-arc')];

    // まだロックなし: ヘッダーに「選択固定中」は出ない
    check('no lock initially', !doc.body.textContent.includes('選択固定中'));

    // 末尾（最小総流量＝接続の少ない）エンティティをクリック → ロック。
    // 関連しないリボンが薄くなる & ヘッダーに固定表示。
    const lastIdx = arcs().length - 1;
    arcs()[lastIdx].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(200);
    check('clicking an arc locks selection (header shows lock)',
        doc.body.textContent.includes('選択固定中'));
    const dimmedRibbons = ribbons().filter((p) => parseFloat(p.getAttribute('fill-opacity') || '1') < 0.1);
    check('unrelated ribbons dimmed while locked', dimmedRibbons.length > 0,
        `dimmed=${dimmedRibbons.length}`);
    const locked = arcs().filter((a) => a.getAttribute('stroke') !== 'rgba(255,255,255,0.20)'
        && a.getAttribute('stroke') !== 'rgba(0,0,0,0.22)');
    check('locked arc has emphasized stroke', locked.length === 1, `got ${locked.length}`);

    // 同じ弧を再クリック → 解除
    arcs()[lastIdx].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(200);
    check('re-click same arc clears lock', !doc.body.textContent.includes('選択固定中'));

    // 弧をロック → 背景（コンテナ）クリックで解除
    arcs()[lastIdx].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(150);
    check('locked again', doc.body.textContent.includes('選択固定中'));
    const container = doc.querySelector('div[style*="position: relative"]') || doc.body;
    container.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(200);
    check('background click clears lock', !doc.body.textContent.includes('選択固定中'));

    // clickToFocus OFF ならクリックしてもロックされない
    state.options = { clickToFocus: false };
    fire('options', { options: state.options });
    await sleep(200);
    arcs()[lastIdx].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(200);
    check('clickToFocus OFF: click does not lock', !doc.body.textContent.includes('選択固定中'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
