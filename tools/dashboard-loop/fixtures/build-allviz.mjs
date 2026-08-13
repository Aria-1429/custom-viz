// ── 全 viz 展示ボードを生成する ──────────────────────────────────
//
// 登録されている **46 個すべて**（DPX ネイティブ 16 + カスタム viz 30）を
// 1 枚に並べ、実機で「全部描けるか」を目視確認するためのボードを作る。
//
// ⚠ **オプション名を推測で書かない。** 各 viz の `config.json` から
//   `optionsSchema` を読み、実在するキーだけを使う。
//
// ⚠ **列を指すオプションは DOS 文字列**（`> primary | seriesByName("x")`）。
//   生のフィールド名を入れると viz 側のパーサが黙って空を返す。
//
// 実行: node fixtures/build-allviz.mjs > fixtures/dpx-allviz.json
// ────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');
const COMPONENTS = join(REPO, 'apps/dpx/src/main/webapp/components');

const dos = (f) => `> primary | seriesByName("${f}")`;

// ── データソース ────────────────────────────────────────────────
// viz の形に合わせて数種類用意する。**1 種類で全部賄おうとしない**
// （列が合わないと「データがありません」になり、実装の問題と誤診する）。
const DS = {
    // ラベル + 値（棒・ドーナツ・ランキング・ゲージ…）
    ds_cat: {
        name: 'カテゴリ別',
        spl: '| makeresults count=6 | streamstats count as i | eval name="svc-".i, value=(i*17)%37+8, target=30, prev=(i*11)%29+6, state=if(value>25,"critical",if(value>15,"warning","ok")), type=if(i=1,"total","delta") | table name value target prev state type',
        earliest: '-24h',
        latest: 'now',
    },
    // 時系列（折れ線・ホライゾン・ドーナツ時系列）
    ds_time: {
        name: '時系列',
        spl: '| makeresults count=24 | streamstats count as i | eval _time=now()-(24-i)*600, name=if(i%2=0,"api","web"), value=(i*13)%31+5 | table _time name value',
        earliest: '-24h',
        latest: 'now',
    },
    // 2 軸 + 値（ヒートマップ・地形）
    ds_matrix: {
        name: '行列',
        spl: '| makeresults count=25 | streamstats count as i | eval row="r".(((i-1)%5)+1), col="c".(floor((i-1)/5)+1), value=(i*7)%23+2 | table row col value',
        earliest: '-24h',
        latest: 'now',
    },
    // 階層（サンバースト・ツリーマップ）
    ds_tree: {
        name: '階層',
        spl: '| makeresults count=9 | streamstats count as i | eval l1=if(i<=4,"東日本","西日本"), l2=case(i<=2,"東京",i<=4,"仙台",i<=6,"大阪",1=1,"福岡"), l3="n".i, value=(i*13)%19+4 | table l1 l2 l3 value',
        earliest: '-24h',
        latest: 'now',
    },
    // フロー（サンキー・コード）
    ds_flow: {
        name: 'フロー',
        spl: '| makeresults count=8 | streamstats count as i | eval src=case(i<=3,"web",i<=5,"api",1=1,"batch"), dst=case(i%3=0,"db",i%3=1,"cache",1=1,"queue"), value=(i*11)%23+5 | table src dst value',
        earliest: '-24h',
        latest: 'now',
    },
    // 座標（世界地図・攻撃グローブ）
    ds_geo: {
        name: '地理',
        spl: '| makeresults count=6 | streamstats count as i | eval slat=case(i=1,35.68,i=2,51.5,i=3,40.7,i=4,-33.87,i=5,55.75,1=1,1.35), slon=case(i=1,139.69,i=2,-0.12,i=3,-74.0,i=4,151.2,i=5,37.61,1=1,103.8), dlat=case(i=1,37.77,i=2,48.85,i=3,35.68,i=4,1.35,i=5,52.52,1=1,22.3), dlon=case(i=1,-122.4,i=2,2.35,i=3,139.69,i=4,103.8,i=5,13.4,1=1,114.17), sname="src".i, dname="dst".i, cat=case(i%3=0,"critical",i%3=1,"warning",1=1,"info"), cnt=(i*13)%29+3 | table slat slon dlat dlon sname dname cat cnt',
        earliest: '-24h',
        latest: 'now',
    },
    // 日本地図（国内座標）
    ds_jp: {
        name: '国内',
        spl: '| makeresults count=6 | streamstats count as i | eval slat=case(i=1,35.68,i=2,34.69,i=3,43.06,i=4,33.59,i=5,38.26,1=1,26.21), slon=case(i=1,139.69,i=2,135.50,i=3,141.35,i=4,130.40,i=5,140.87,1=1,127.68), dlat=case(i=1,34.69,i=2,35.18,i=3,35.68,i=4,34.39,i=5,35.68,1=1,35.68), dlon=case(i=1,135.50,i=2,136.91,i=3,139.69,i=4,132.46,i=5,139.69,1=1,139.69), sname="拠点".i, dname="中央", sev=case(i%3=0,"critical",i%3=1,"warning",1=1,"info"), cnt=(i*7)%17+2 | table slat slon dlat dlon sname dname sev cnt',
        earliest: '-24h',
        latest: 'now',
    },
    // 期間（タイムラインスイムレーン）
    ds_span: {
        name: '期間',
        spl: '| makeresults count=8 | streamstats count as i | eval lane="lane".(((i-1)%3)+1), start=now()-(9-i)*1800, end=start+1200, cat=if(i%2=0,"batch","job"), label="task".i | table lane start end cat label',
        earliest: '-24h',
        latest: 'now',
    },
    // 単一値・複数メトリック（VU コンソール・レーダー）
    ds_metrics: {
        name: '複数メトリック',
        spl: '| makeresults count=5 | streamstats count as i | eval axis="軸".i, cpu=(i*13)%40+30, mem=(i*17)%35+40, io=(i*7)%30+25 | table axis cpu mem io',
        earliest: '-24h',
        latest: 'now',
    },
};

// ── viz ごとの定義 ──────────────────────────────────────────────
// [type, タイトル, データソース, options]
const SPEC = [
    // ── DPX ネイティブ ─────────────────────────────────────────
    ['dpx.line', '折れ線', 'ds_time', {}],
    ['dpx.bar', '棒', 'ds_cat', {}],
    ['dpx.ranking', 'ランキング', 'ds_cat', {}],
    ['dpx.donut', 'ドーナツ', 'ds_cat', {}],
    ['dpx.value', '単一値', 'ds_cat', {}],
    ['dpx.status', 'ステータス', 'ds_cat', {}],
    ['dpx.table', 'テーブル', 'ds_cat', {}],
    ['deco.text', '装飾テキスト', null, { text: 'DPX 全 viz 展示' }],
    ['deco.clock', '時計', null, {}],
    ['shape.rect', '矩形', null, {}],
    ['shape.ellipse', '楕円', null, {}],
    ['shape.line', '線', null, {}],
    ['shape.glow', '発光', null, {}],
    ['shape.nocFrame', 'NOC枠', null, {}],
    ['dpx.linkLine', 'リンク線', 'ds_cat', {}],
    ['custom.spike', 'スパイク（試作）', 'ds_cat', {}],

    // ── カスタム viz（Studio 拡張）────────────────────────────
    ['custom_viz_attack_globe.custom_viz_attack_globe', 'Attack Globe', 'ds_geo',
        { srcLatField: dos('slat'), srcLonField: dos('slon'), dstLatField: dos('dlat'),
          dstLonField: dos('dlon'), categoryField: dos('cat'), countField: dos('cnt'),
          srcNameField: dos('sname'), dstNameField: dos('dname') }],
    ['custom_viz_bullet_graph.custom_viz_bullet_graph', 'Bullet Graph', 'ds_cat',
        { labelField: dos('name'), valueField: dos('value'), targetField: dos('target') }],
    ['custom_viz_calendar_heatmap.custom_viz_calendar_heatmap', 'Calendar Heatmap', 'ds_time',
        { dateField: dos('_time'), valueField: dos('value') }],
    ['custom_viz_chord_flow.custom_viz_chord_flow', 'Chord Flow', 'ds_flow',
        { sourceField: dos('src'), targetField: dos('dst'), valueField: dos('value') }],
    ['custom_viz_country_graph.custom_viz_country_graph', 'Country Graph', 'ds_cat', {}],
    ['custom_viz_donut_graph.custom_viz_donut_graph', 'Donut Graph', 'ds_cat',
        { categoryField: dos('name'), valueField: dos('value') }],
    ['custom_viz_donut_timechart.custom_viz_donut_timechart', 'Donut Timechart', 'ds_time',
        { timeField: dos('_time'), categoryField: dos('name'), valueField: dos('value') }],
    ['custom_viz_funnel_leak.custom_viz_funnel_leak', 'Funnel Leak', 'ds_cat',
        { stepField: dos('name'), valueField: dos('value') }],
    ['custom_viz_gauge_arc.custom_viz_gauge_arc', 'Gauge Arc', 'ds_cat',
        { valueField: dos('value'), labelField: dos('name'), minValue: 0, maxValue: 50 }],
    ['custom_viz_gradient_bar.custom_viz_gradient_bar', 'Gradient Bar', 'ds_cat',
        { labelField: dos('name'), valueField: dos('value') }],
    ['custom_viz_heat_matrix.custom_viz_heat_matrix', 'Heat Matrix', 'ds_matrix',
        { rowField: dos('row'), colField: dos('col'), valueField: dos('value') }],
    ['custom_viz_horizon_chart.custom_viz_horizon_chart', 'Horizon Chart', 'ds_time',
        { timeField: dos('_time'), seriesField: dos('name'), valueField: dos('value') }],
    ['custom_viz_icon_status.custom_viz_icon_status', 'Icon Status', 'ds_cat',
        { labelField: dos('name'), valueField: dos('value') }],
    ['custom_viz_japanmap.custom_viz_japanmap', 'Japan Map', 'ds_jp',
        { srcLatField: dos('slat'), srcLonField: dos('slon'), dstLatField: dos('dlat'),
          dstLonField: dos('dlon'), severityField: dos('sev'), countField: dos('cnt'),
          srcNameField: dos('sname'), dstNameField: dos('dname') }],
    ['custom_viz_kpi_tile.custom_viz_kpi_tile', 'KPI Tile', 'ds_cat',
        { labelField: dos('name'), valueField: dos('value') }],
    ['custom_viz_link_line.custom_viz_link_line', 'Link Line', 'ds_cat',
        { valueField: dos('value') }],
    ['custom_viz_liquid_tube.custom_viz_liquid_tube', 'Liquid Tube', 'ds_cat',
        { labelField: dos('name'), valueField: dos('value'), minValue: 0, maxValue: 50 }],
    ['custom_viz_metric_terrain.custom_viz_metric_terrain', 'Metric Terrain', 'ds_matrix',
        { xField: dos('row'), yField: dos('col'), valueField: dos('value') }],
    ['custom_viz_radar_chart.custom_viz_radar_chart', 'Radar Chart', 'ds_metrics',
        { axisField: dos('axis'), seriesFields: ['cpu', 'mem', 'io'] }],
    ['custom_viz_radial_bar.custom_viz_radial_bar', 'Radial Bar', 'ds_cat',
        { categoryField: dos('name'), valueField: dos('value') }],
    ['custom_viz_sankey_flow.custom_viz_sankey_flow', 'Sankey Flow', 'ds_flow', {}],
    ['custom_viz_severity_table.custom_viz_severity_table', 'Severity Table', 'ds_cat',
        { severityField: dos('state') }],
    ['custom_viz_spotlight_frame.custom_viz_spotlight_frame', 'Spotlight Frame', 'ds_cat',
        { valueField: dos('value'), labelField: dos('name') }],
    ['custom_viz_sunburst.custom_viz_sunburst', 'Sunburst', 'ds_tree',
        { valueField: dos('value'), level1Field: dos('l1'), level2Field: dos('l2'), level3Field: dos('l3') }],
    ['custom_viz_tab_selector.custom_viz_tab_selector', 'Tab Selector', 'ds_cat', {}],
    ['custom_viz_timeline_swimlane.custom_viz_timeline_swimlane', 'Timeline Swimlane', 'ds_span',
        { laneField: dos('lane'), startField: dos('start'), endField: dos('end'),
          categoryField: dos('cat'), labelField: dos('label') }],
    ['custom_viz_treemap.custom_viz_treemap', 'Treemap', 'ds_tree',
        { valueField: dos('value'), level1Field: dos('l1'), level2Field: dos('l2') }],
    ['custom_viz_vu_console.custom_viz_vu_console', 'VU Console', 'ds_metrics',
        { fields: ['cpu', 'mem', 'io'] }],
    ['custom_viz_waterfall_chart.custom_viz_waterfall_chart', 'Waterfall Chart', 'ds_cat',
        { labelField: dos('name'), valueField: dos('value') }],
    ['custom_viz_worldmap.custom_viz_worldmap', 'World Map', 'ds_geo',
        { srcLatField: dos('slat'), srcLonField: dos('slon'), dstLatField: dos('dlat'),
          dstLonField: dos('dlon'), categoryField: dos('cat'), countField: dos('cnt'),
          srcNameField: dos('sname'), dstNameField: dos('dname') }],
];

// ── レイアウト（3 列 × 各 4 行）─────────────────────────────────
const COLS = 3;
const W = 4;
const H = 4;

const panels = SPEC.map(([viz, title, ds, options], i) => ({
    id: `p${String(i + 1).padStart(2, '0')}`,
    viz,
    title,
    x: (i % COLS) * W,
    y: Math.floor(i / COLS) * H,
    w: W,
    h: H,
    ...(ds ? { search: { ref: ds } } : {}),
    options,
}));

// ⚠ 実際に registry にある型か検証する（綴り間違いを防ぐ）
const reg = readFileSync(join(COMPONENTS, 'viz/registry.js'), 'utf8');
const gen = readFileSync(join(COMPONENTS, 'viz/registry.generated.js'), 'utf8');
const known = new Set([
    ...[...reg.matchAll(/^\s+'([\w.]+)':\s*(?!\.\.\.)/gm)].map((m) => m[1]),
    ...[...gen.matchAll(/'([\w.]+)':\s*adaptExtensionViz/g)].map((m) => m[1]),
]);
const unknown = panels.map((p) => p.viz).filter((v) => !known.has(v));
if (unknown.length) {
    console.error(`registry に無い型: ${unknown.join(', ')}`);
    process.exit(1);
}
const missing = [...known].filter((k) => !panels.some((p) => p.viz === k));
if (missing.length) {
    console.error(`ボードに載っていない viz: ${missing.join(', ')}`);
    process.exit(1);
}

process.stdout.write(
    `${JSON.stringify(
        {
            schemaVersion: 2,
            title: 'DPX 全 viz 展示',
            description: `登録されている ${panels.length} 個すべてを並べて描画を確認する`,
            style: { preset: 'midnight', background: 'grid', entrance: 'fade' },
            layout: { type: 'grid', grid: { columns: 12, rowHeight: 72, gap: 12 } },
            dataSources: DS,
            panels,
        },
        null,
        2
    )}\n`
);
