// Spotlight Frame viz のローカル検証（happy-dom、Splunk実機なし）
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'dist', 'custom_viz_spotlight_frame', 'visualization.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- happy-dom セットアップ ------------------------------------------------
const win = new Window({ width: 900, height: 400 });
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
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 400 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 900, bottom: 400, width: 900, height: 400, x: 0, y: 0 };
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

// 既定データ: ホスト×severity（1件 critical / 複数 warning / 残り ok）
const FIELDS = [{ name: 'host' }, { name: 'severity' }];
const ROWS = [
    ['web-01', 'ok'],
    ['web-02', 'warning'],
    ['api-01', 'critical'],
    ['api-02', 'warning'],
    ['db-01', 'ok'],
];

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
    getDimensions: () => ({ width: 900, height: 400 }),
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
    await sleep(220);
};
const setData = async (data) => {
    state.data = data;
    fire('dataSources', { loading: false, dataSources: { primary: { data } } });
    await sleep(220);
};

const frame = () => doc.querySelector('[data-role="frame"]');
const badge = () => doc.querySelector('[data-role="status-badge"]');

// ---- バンドル実行 -----------------------------------------------------------
const code = readFileSync(BUNDLE, 'utf8');
(0, eval)(code);
await sleep(400);

// ---- 1. 文字列 severity → 最悪(critical)に丸める ------------------------------
console.log('\n[1] worst-of text severity (critical wins)');
{
    const f = frame();
    check('frame rendered', !!f);
    check('frame status = crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    check('border uses crit color #ef4444', f && f.style.border.includes('#ef4444'), f && f.style.border);
    const b = badge();
    check('badge shows CRITICAL', b && b.textContent.includes('CRITICAL'), b && b.textContent);
    const body = doc.body.textContent;
    check('counts: Crit 1', body.includes('Crit 1'), body.slice(0, 200));
    check('counts: Warn 2', body.includes('Warn 2'));
    check('counts: OK 2', body.includes('OK 2'));
    check('crit sample host shown (api-01)', body.includes('api-01'), body.slice(0, 300));
    check('title = severity field name', body.includes('severity'));
}

// ---- 2. critical を除くと warning に落ちる -----------------------------------
console.log('\n[2] downgrade to warning when no critical');
{
    await setData({ fields: FIELDS, rows: [['web-01', 'ok'], ['web-02', 'warning'], ['db-01', 'ok']] });
    const f = frame();
    check('frame status = warn', f && f.getAttribute('data-status') === 'warn', f && f.getAttribute('data-status'));
    check('border uses warn color #f59e0b', f && f.style.border.includes('#f59e0b'), f && f.style.border);
    check('badge WARNING', badge() && badge().textContent.includes('WARNING'));
}

// ---- 3. 全て正常 → OK -------------------------------------------------------
console.log('\n[3] all ok → OK');
{
    await setData({ fields: FIELDS, rows: [['web-01', 'up'], ['db-01', 'healthy'], ['api', 'normal']] });
    const f = frame();
    check('frame status = ok', f && f.getAttribute('data-status') === 'ok', f && f.getAttribute('data-status'));
    check('border uses ok color #22c55e', f && f.style.border.includes('#22c55e'), f && f.style.border);
    check('badge OK', badge() && badge().textContent.includes('OK'));
}

// ---- 4. 数値モード：editor.threshold の帯が色と段を決める --------------------
// v1.2.0 で warnThreshold / critThreshold / higherIsWorse を廃止し、
// 「値の範囲と色」（colorBands）1本に統合した。帯は何段でも作れる。
console.log('\n[4] numeric mode driven by editor.threshold colorBands');
{
    await setData({ fields: [{ name: 'host' }, { name: 'errors' }], rows: [['a', '0'], ['b', '3'], ['c', '12']] });
    await setOpts({
        matchMode: 'numeric',
        colorBands: [
            { from: null, to: 3, value: '#00ff00' },
            { from: 3, to: 10, value: '#ffaa00' },
            { from: 10, to: null, value: '#ff0000' },
        ],
    });
    let f = frame();
    check('worst is top band (12 → 10+)', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    check('border uses the top band color #ff0000', f && f.style.border.includes('#ff0000'), f && f.style.border);
    let body = doc.body.textContent;
    check('breakdown shows top band 10+ x1', body.includes('10 + 1'), body.slice(0, 240));
    check('breakdown shows middle band 3–10 x1', body.includes('3–10 1'), body.slice(0, 240));
    check('breakdown shows bottom band < 3 x1', body.includes('< 3 1'), body.slice(0, 240));

    // 帯の色を変えると枠色が追随する（新コントロールが色を駆動している証拠）
    await setOpts({
        matchMode: 'numeric',
        colorBands: [
            { from: null, to: 3, value: '#00ff00' },
            { from: 3, to: 10, value: '#ffaa00' },
            { from: 10, to: null, value: '#0000ff' },
        ],
    });
    f = frame();
    check('changing the top band color changes the frame', f && f.style.border.includes('#0000ff'), f && f.style.border);

    // 帯の上限を上げると最上段に届かず1段下がる
    await setOpts({
        matchMode: 'numeric',
        colorBands: [
            { from: null, to: 3, value: '#00ff00' },
            { from: 3, to: 100, value: '#ffaa00' },
            { from: 100, to: null, value: '#ff0000' },
        ],
    });
    f = frame();
    check('raising the top band → not top tier', f && f.getAttribute('data-status') === 'warn', f && f.getAttribute('data-status'));
    check('border uses the middle band color', f && f.style.border.includes('#ffaa00'), f && f.style.border);
}

// ---- 4b. 任意段数（2段 / 5段）でも動く ----------------------------------------
console.log('\n[4b] arbitrary number of bands');
{
    // 5段
    await setData({ fields: [{ name: 'h' }, { name: 'v' }], rows: [['a', '5'], ['b', '25'], ['c', '45'], ['d', '65'], ['e', '85']] });
    await setOpts({
        matchMode: 'numeric',
        colorBands: [
            { from: null, to: 20, value: '#111111' },
            { from: 20, to: 40, value: '#222222' },
            { from: 40, to: 60, value: '#333333' },
            { from: 60, to: 80, value: '#444444' },
            { from: 80, to: null, value: '#555555' },
        ],
    });
    let f = frame();
    check('5 bands: worst is the 5th', f && f.style.border.includes('#555555'), f && f.style.border);
    {
        const body = doc.body.textContent;
        const labels = ['80 + 1', '60–80 1', '40–60 1', '20–40 1', '< 20 1'];
        check('5 bands: all 5 breakdown entries shown', labels.every((l) => body.includes(l)),
            `${JSON.stringify(labels.filter((l) => !body.includes(l)))} missing in ${body.slice(0, 300)}`);
    }

    // 2段
    await setOpts({ matchMode: 'numeric', colorBands: [{ from: null, to: 50, value: '#00ff00' }, { from: 50, to: null, value: '#ff0000' }] });
    f = frame();
    check('2 bands: worst is the 2nd', f && f.style.border.includes('#ff0000'), f && f.style.border);
    check('2 bands: top tier reached', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
}

// ---- 5. 「小さいほど悪い」は降順の帯で表現する（higherIsWorse は不要） ----------
console.log('\n[5] lower-is-worse expressed as descending bands');
{
    await setData({ fields: [{ name: 'svc' }, { name: 'uptime' }], rows: [['a', '99.9'], ['b', '95'], ['c', '80']] });
    // 小さいほど悪い = 低い方の帯を「最上段（危険）」にはできないので、
    // 帯の色を逆順にすることで表現する（80 が赤くなる）
    await setOpts({
        matchMode: 'numeric',
        colorBands: [
            { from: null, to: 90, value: '#ff0000' },
            { from: 90, to: 98, value: '#ffaa00' },
            { from: 98, to: null, value: '#00ff00' },
        ],
    });
    const f = frame();
    check('80 falls into the lowest band (red)', doc.body.textContent.includes('< 90 1'), doc.body.textContent.slice(0, 240));
    check('renders without crashing', !!f);
}

// ---- 5b. 壊れた/未ソート/重複/開区間の帯でも落ちない -------------------------
console.log('\n[5b] malformed / unsorted / overlapping / open bands degrade safely');
{
    await setData({ fields: [{ name: 'h' }, { name: 'v' }], rows: [['a', '5'], ['b', '55']] });
    const bads = [
        [],
        'not-an-array',
        null,
        [{ from: 'x', to: 'y', value: 'not-a-color' }],
        [{ value: '#ff0000' }],                                        // 上下限なし（全域）
        [{ from: 50, to: 10, value: '#ff0000' }, { from: 0, to: 50, value: '#00ff00' }], // 逆転＋未ソート
        [{ from: 0, to: 100, value: '#00ff00' }, { from: 40, to: 80, value: '#ff0000' }], // 重複
        [{ from: null, to: null, value: '#00ff00' }],
    ];
    for (const b of bads) {
        await setOpts({ matchMode: 'numeric', colorBands: b });
        const f = frame();
        check(`bands ${JSON.stringify(b).slice(0, 46)} → still renders`, !!f, String(f));
        check(`  ... and no crash message`, !doc.body.textContent.includes('状態を判定できませんでした'), doc.body.textContent.slice(0, 100));
    }
    await setOpts({});
}

// ---- 5c. 文字列パスの色は statusColors パレット（正常→警告→危険の順） ---------
// 文字列カテゴリは数値レンジで表せないため threshold ではなく順序付きパレットを使う。
console.log('\n[5c] string path colored by statusColors palette');
{
    await setData({ fields: FIELDS, rows: ROWS }); // critical あり
    await setOpts({ matchMode: 'string', statusColors: ['#00ff00', '#0000ff', '#ff00ff'] });
    let f = frame();
    check('3rd palette entry → crit frame', f && f.style.border.includes('#ff00ff'), f && f.style.border);
    check('status still crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));

    // warning 止まりのデータ → 2番目の色
    await setData({ fields: FIELDS, rows: [['a', 'ok'], ['b', 'warning']] });
    f = frame();
    check('2nd palette entry → warn frame', f && f.style.border.includes('#0000ff'), f && f.style.border);

    // ok のみ → 1番目の色
    await setData({ fields: FIELDS, rows: [['a', 'ok'], ['b', 'healthy']] });
    f = frame();
    check('1st palette entry → ok frame', f && f.style.border.includes('#00ff00'), f && f.style.border);

    // パレットが短ければ循環する（落ちない）
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ matchMode: 'string', statusColors: ['#00ff00'] });
    f = frame();
    check('short palette cycles (crit reuses only color)', f && f.style.border.includes('#00ff00'), f && f.style.border);

    // 壊れたパレット → 既定へ
    for (const bad of [[], ['nope', 7], 'x', null, {}]) {
        await setOpts({ matchMode: 'string', statusColors: bad });
        f = frame();
        check(`malformed statusColors ${JSON.stringify(bad)} → default crit #ef4444`, f && f.style.border.includes('#ef4444'), f && f.style.border);
    }
    await setOpts({});
}

// ---- 5d. 独自ステータス語彙でも落ちず、妥当な色が付く ------------------------
// 文字列パスはキーワード辞書で 正常/警告/危険 に丸める。辞書に無い語は
// 「判定不能」になるが、混在していても既知の語だけで判定でき、落ちない。
console.log('\n[5d] custom / unknown status vocabulary');
{
    // 完全に独自の語彙のみ → 判定不能メッセージ（クラッシュしない）
    await setData({ fields: FIELDS, rows: [['a', 'zzz'], ['b', 'qqq']] });
    await setOpts({ matchMode: 'string' });
    check('unknown-only vocabulary → guard message, no crash',
        doc.body.textContent.includes('状態を判定できませんでした'), doc.body.textContent.slice(0, 120));

    // 既知語と未知語の混在 → 既知語だけで判定される
    await setData({ fields: FIELDS, rows: [['a', 'zzz'], ['b', 'P1 alert'], ['c', 'ok']] });
    let f = frame();
    check('mixed known/unknown classifies on known words', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    check('mixed: still renders a frame', !!f);

    // 日本語のステータス語彙
    await setData({ fields: FIELDS, rows: [['a', '正常'], ['b', '警告'], ['c', '重大']] });
    f = frame();
    check('Japanese vocabulary → crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    const body = doc.body.textContent;
    check('Japanese vocabulary breakdown has 3 tiers', body.includes('Crit 1') && body.includes('Warn 1') && body.includes('OK 1'), body.slice(0, 240));

    // 数値と文字列が混ざる auto モードでも落ちない
    await setData({ fields: FIELDS, rows: [['a', '42'], ['b', 'critical'], ['c', 'ok'], ['d', ''], ['e', null]] });
    await setOpts({});
    check('auto mode with mixed types renders', !!frame());
    check('auto mode with mixed types has no guard message',
        !doc.body.textContent.includes('状態を判定できませんでした'), doc.body.textContent.slice(0, 120));
}

// ---- 6. フィールド選択（columnSelector DOS 文字列） --------------------------
console.log('\n[6] field selection via DOS string');
{
    await setData({
        fields: [{ name: 'host' }, { name: 'label' }, { name: 'state' }],
        rows: [['h1', 'foo', 'ok'], ['h2', 'bar', 'critical'], ['h3', 'baz', 'ok']],
    });
    await setOpts({ matchMode: 'string', valueField: "> primary | seriesByName('state')", labelField: "> primary | seriesByName('host')" });
    const f = frame();
    check('DOS: value field state → crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
    check('DOS: crit sample from host (h2)', doc.body.textContent.includes('h2'), doc.body.textContent.slice(0, 300));
}

// ---- 7. 単値データ（1列/1行） ------------------------------------------------
console.log('\n[7] single scalar value');
{
    await setOpts({});
    await setData({ fields: [{ name: 'status' }], rows: [['CRITICAL']] });
    const f = frame();
    check('scalar: single critical → crit', f && f.getAttribute('data-status') === 'crit', f && f.getAttribute('data-status'));
}

// ---- 8. 点滅（pulseMode='crit'） --------------------------------------
console.log('\n[8] pulse animation on critical');
{
    await setData({ fields: FIELDS, rows: ROWS }); // critical あり
    await setOpts({ pulseMode: 'crit', pulsePeriod: 1.6 });
    let f = frame();
    check('pulse active on crit', f && /spotlightFramePulse/.test(f.style.animation), f && f.style.animation);

    // OK データでは点滅しない
    await setData({ fields: FIELDS, rows: [['a', 'ok'], ['b', 'up']] });
    f = frame();
    check('no pulse when ok', f && (!f.style.animation || f.style.animation === 'none'), f && f.style.animation);

    // pulsePeriod=0 で停止
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ pulseMode: 'crit', pulsePeriod: 0 });
    f = frame();
    check('pulsePeriod 0 disables pulse', f && (!f.style.animation || f.style.animation === 'none'), f && f.style.animation);
    check('keyframes injected', !!doc.getElementById('spotlight-frame-pulse-keyframes'));
}

// ---- 9. frameOnly（中央透明） -----------------------------------------------
console.log('\n[9] frameOnly transparent center');
{
    await setOpts({ frameOnly: true });
    const f = frame();
    check('center transparent', f && f.style.background === 'transparent', f && f.style.background);

    await setOpts({ frameOnly: false });
    const f2 = frame();
    check('center filled when not frameOnly', f2 && f2.style.background !== 'transparent' && f2.style.background !== '', f2 && f2.style.background.slice(0, 40));
}

// ---- 10. light テーマ -------------------------------------------------------
console.log('\n[10] light theme');
{
    state.theme = 'light';
    fire('theme', { theme: 'light' });
    await sleep(220);
    const f = frame();
    check('renders in light theme (crit border)', f && f.style.border.includes('#ef4444'), f && f.style.border);
    state.theme = 'dark';
    fire('theme', { theme: 'dark' });
    await sleep(150);
}

// ---- 11. ガード（空データ / 判定不能） ---------------------------------------
console.log('\n[11] guards');
{
    await setData({ fields: [{ name: 'x' }], rows: [] });
    check('empty data message', doc.body.textContent.includes('データがありません'), doc.body.textContent.slice(0, 120));

    // 判定不能（未知の文字列のみ、文字列一致モード）
    await setData({ fields: [{ name: 'x' }], rows: [['zzz'], ['qqq']] });
    await setOpts({ matchMode: 'string' });
    check('unclassifiable message', doc.body.textContent.includes('状態を判定できませんでした'), doc.body.textContent.slice(0, 160));
}

// ---- 12. 旧数値コードの回帰（後方互換は意図的に実装しない） --------------------
// v1.1.0 で matchMode/pulseMode を editor.select の文字列へ移行した。旧ダッシュボードに
// 残った数値コードは「読み替えず」既定値へ倒す（既定値と同じ値は options に載らないため、
// 読み替えを実装すると「既定値を選び直したときだけ直らない」不具合になる）。
console.log('\n[12] legacy numeric codes fall back to defaults (no back-compat)');
{
    // matchMode: 旧 2（文字列一致）→ 既定 'auto' に倒れる。
    // 'auto' は数値を数値として判定するので、数値データが文字列一致で無視されず分類される
    await setData({ fields: [{ name: 'host' }, { name: 'errors' }], rows: [['a', '0'], ['b', '99']] });
    await setOpts({ matchMode: 2, warnThreshold: 3, critThreshold: 10, higherIsWorse: true });
    let f = frame();
    check(
        'legacy matchMode:2 does NOT select string mode (falls back to auto → numeric classified)',
        f && f.getAttribute('data-status') === 'crit',
        f && f.getAttribute('data-status')
    );
    check(
        'legacy matchMode:2 did not produce unclassifiable message',
        !doc.body.textContent.includes('状態を判定できませんでした')
    );

    // pulseMode: 旧 0（点滅なし）→ 既定 'crit' に倒れる ⇒ crit データでは点滅する
    await setData({ fields: FIELDS, rows: ROWS }); // critical あり
    await setOpts({ pulseMode: 0, pulsePeriod: 1.6 });
    f = frame();
    check(
        'legacy pulseMode:0 does NOT disable pulse (falls back to crit default)',
        f && /spotlightFramePulse/.test(f.style.animation),
        f && f.style.animation
    );

    // pulseMode: 旧 3（常時）→ 既定 'crit' に倒れる ⇒ ok データでは点滅しない
    await setData({ fields: FIELDS, rows: [['a', 'ok'], ['b', 'up']] });
    await setOpts({ pulseMode: 3, pulsePeriod: 1.6 });
    f = frame();
    check(
        'legacy pulseMode:3 does NOT force always-on pulse (falls back to crit default)',
        f && (!f.style.animation || f.style.animation === 'none'),
        f && f.style.animation
    );

    // --- v1.2.0 で廃止したキーは一切読まない ---
    // okColor/warnColor/critColor（→ statusColors / colorBands へ統合）
    await setData({ fields: FIELDS, rows: ROWS }); // critical あり
    await setOpts({ matchMode: 'string', okColor: '#111111', warnColor: '#222222', critColor: '#00ffff' });
    f = frame();
    check(
        'legacy critColor ignored (frame keeps default #ef4444)',
        f && f.style.border.includes('#ef4444') && !f.style.border.includes('#00ffff'),
        f && f.style.border
    );

    // warnThreshold / critThreshold / higherIsWorse（→ colorBands へ統合）
    await setData({ fields: [{ name: 'h' }, { name: 'v' }], rows: [['a', '0'], ['b', '5']] });
    await setOpts({ matchMode: 'numeric', warnThreshold: 100, critThreshold: 200, higherIsWorse: false });
    f = frame();
    // 既定の帯（<1 / 1-10 / 10+）で判定される。旧しきい値が効いていれば 5 は crit になるはず
    check(
        'legacy warn/critThreshold + higherIsWorse ignored (default bands used → 5 is middle band)',
        f && f.getAttribute('data-status') === 'warn',
        f && f.getAttribute('data-status')
    );
    check(
        'legacy numeric keys did not resurrect old classification',
        doc.body.textContent.includes('1–10 1'),
        doc.body.textContent.slice(0, 240)
    );
    await setOpts({});
}

// ---- 13. debug オプション廃止（オーバーレイが出ないこと） ----------------------
console.log('\n[13] debug option removed');
{
    await setData({ fields: FIELDS, rows: ROWS });
    await setOpts({ debug: true });
    check('debug overlay no longer renders', !doc.body.textContent.includes('"normalized"'), doc.body.textContent.slice(0, 160));
    check('frame still renders with stale debug option', !!frame());
    await setOpts({});
}

// ---- 結果 -------------------------------------------------------------------
console.log(`\n${'='.repeat(48)}`);
console.log(`  PASS ${pass}  /  FAIL ${fail}`);
console.log('='.repeat(48));
if (fail > 0) process.exit(1);
