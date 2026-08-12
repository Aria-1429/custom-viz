// ── 独自エンジンの viz レジストリ ────────────────────────────────
// パネルの `viz` 名 → React コンポーネント。Studio の preset に相当するが、
// ただの Map であり検閲も iframe もない。コンポーネント契約は VizProps 互換:
//   { dataSources: {primary:{data:{fields,columns}}}, loading, options,
//     width, height, mode, onOptionsChange, onEventTrigger }
//
// 既存 Studio 拡張 viz は extensionAdapter（webpack alias）経由でそのまま載る。
// type 名は従来の <appId>.<appId> を維持する（定義の移行を単純にするため）。

import SpikeViz from '../SpikeViz';
import { adaptExtensionViz } from '../extensionAdapter';
import { DecoClock, DecoText } from './decoViz';
import { DpxBar, DpxDonut, DpxLine, DpxRanking, DpxStatus, DpxTable, DpxValue } from './nativeViz';
import { ShapeEllipse, ShapeGlow, ShapeLine, ShapeNocFrame, ShapeRect } from './shapeViz';
import { DpxLinkLine } from './linkLineViz';

// ── 既存カスタム viz（Studio 拡張）────────────────────────────────
// ⚠ import するのは host.jsx。visualization.jsx を直接 import しないこと
//    （あちらは esbuild エントリで export を持てない。host.jsx 冒頭の説明を参照）。
// この一覧は tools の生成スクリプトで機械生成できる（viz を追加したら2行足すだけ）。
import { App as AttackGlobeApp } from '../../../../../../../visualizations/attack-globe/visualizations/custom_viz_attack_globe/src/host.jsx';
import AttackGlobeConfig from '../../../../../../../visualizations/attack-globe/visualizations/custom_viz_attack_globe/config.json';
import { App as BulletGraphApp } from '../../../../../../../visualizations/bullet-graph/visualizations/custom_viz_bullet_graph/src/host.jsx';
import BulletGraphConfig from '../../../../../../../visualizations/bullet-graph/visualizations/custom_viz_bullet_graph/config.json';
import { App as CalendarHeatmapApp } from '../../../../../../../visualizations/calendar-heatmap/visualizations/custom_viz_calendar_heatmap/src/host.jsx';
import CalendarHeatmapConfig from '../../../../../../../visualizations/calendar-heatmap/visualizations/custom_viz_calendar_heatmap/config.json';
import { App as ChordFlowApp } from '../../../../../../../visualizations/chord-flow/visualizations/custom_viz_chord_flow/src/host.jsx';
import ChordFlowConfig from '../../../../../../../visualizations/chord-flow/visualizations/custom_viz_chord_flow/config.json';
import { App as CountryGraphApp } from '../../../../../../../visualizations/country-graph/visualizations/custom_viz_country_graph/src/host.jsx';
import CountryGraphConfig from '../../../../../../../visualizations/country-graph/visualizations/custom_viz_country_graph/config.json';
import { App as DonutGraphApp } from '../../../../../../../visualizations/donut-graph/visualizations/custom_viz_donut_graph/src/host.jsx';
import DonutGraphConfig from '../../../../../../../visualizations/donut-graph/visualizations/custom_viz_donut_graph/config.json';
import { App as DonutTimechartApp } from '../../../../../../../visualizations/donut-timechart/visualizations/custom_viz_donut_timechart/src/host.jsx';
import DonutTimechartConfig from '../../../../../../../visualizations/donut-timechart/visualizations/custom_viz_donut_timechart/config.json';
import { App as FunnelLeakApp } from '../../../../../../../visualizations/funnel-leak/visualizations/custom_viz_funnel_leak/src/host.jsx';
import FunnelLeakConfig from '../../../../../../../visualizations/funnel-leak/visualizations/custom_viz_funnel_leak/config.json';
import { App as GaugeArcApp } from '../../../../../../../visualizations/gauge-arc/visualizations/custom_viz_gauge_arc/src/host.jsx';
import GaugeArcConfig from '../../../../../../../visualizations/gauge-arc/visualizations/custom_viz_gauge_arc/config.json';
import { App as GradientBarApp } from '../../../../../../../visualizations/gradient-bar/visualizations/custom_viz_gradient_bar/src/host.jsx';
import GradientBarConfig from '../../../../../../../visualizations/gradient-bar/visualizations/custom_viz_gradient_bar/config.json';
import { App as HeatMatrixApp } from '../../../../../../../visualizations/heat-matrix/visualizations/custom_viz_heat_matrix/src/host.jsx';
import HeatMatrixConfig from '../../../../../../../visualizations/heat-matrix/visualizations/custom_viz_heat_matrix/config.json';
import { App as HorizonChartApp } from '../../../../../../../visualizations/horizon-chart/visualizations/custom_viz_horizon_chart/src/host.jsx';
import HorizonChartConfig from '../../../../../../../visualizations/horizon-chart/visualizations/custom_viz_horizon_chart/config.json';
import { App as IconStatusApp } from '../../../../../../../visualizations/icon-status/visualizations/custom_viz_icon_status/src/host.jsx';
import IconStatusConfig from '../../../../../../../visualizations/icon-status/visualizations/custom_viz_icon_status/config.json';
import { App as JapanmapApp } from '../../../../../../../visualizations/japan-map/visualizations/custom_viz_japanmap/src/host.jsx';
import JapanmapConfig from '../../../../../../../visualizations/japan-map/visualizations/custom_viz_japanmap/config.json';
import { App as KpiTileApp } from '../../../../../../../visualizations/kpi-tile/visualizations/custom_viz_kpi_tile/src/host.jsx';
import KpiTileConfig from '../../../../../../../visualizations/kpi-tile/visualizations/custom_viz_kpi_tile/config.json';
import { App as LinkLineApp } from '../../../../../../../visualizations/link-line/visualizations/custom_viz_link_line/src/host.jsx';
import LinkLineConfig from '../../../../../../../visualizations/link-line/visualizations/custom_viz_link_line/config.json';
import { App as LiquidTubeApp } from '../../../../../../../visualizations/liquid-tube/visualizations/custom_viz_liquid_tube/src/host.jsx';
import LiquidTubeConfig from '../../../../../../../visualizations/liquid-tube/visualizations/custom_viz_liquid_tube/config.json';
import { App as MetricTerrainApp } from '../../../../../../../visualizations/metric-terrain/visualizations/custom_viz_metric_terrain/src/host.jsx';
import MetricTerrainConfig from '../../../../../../../visualizations/metric-terrain/visualizations/custom_viz_metric_terrain/config.json';
import { App as RadarChartApp } from '../../../../../../../visualizations/radar-chart/visualizations/custom_viz_radar_chart/src/host.jsx';
import RadarChartConfig from '../../../../../../../visualizations/radar-chart/visualizations/custom_viz_radar_chart/config.json';
import { App as RadialBarApp } from '../../../../../../../visualizations/radial-bar/visualizations/custom_viz_radial_bar/src/host.jsx';
import RadialBarConfig from '../../../../../../../visualizations/radial-bar/visualizations/custom_viz_radial_bar/config.json';
import { App as SankeyFlowApp } from '../../../../../../../visualizations/sankey-flow/visualizations/custom_viz_sankey_flow/src/host.jsx';
import SankeyFlowConfig from '../../../../../../../visualizations/sankey-flow/visualizations/custom_viz_sankey_flow/config.json';
import { App as SeverityTableApp } from '../../../../../../../visualizations/severity-table/visualizations/custom_viz_severity_table/src/host.jsx';
import SeverityTableConfig from '../../../../../../../visualizations/severity-table/visualizations/custom_viz_severity_table/config.json';
import { App as SpotlightFrameApp } from '../../../../../../../visualizations/spotlight-frame/visualizations/custom_viz_spotlight_frame/src/host.jsx';
import SpotlightFrameConfig from '../../../../../../../visualizations/spotlight-frame/visualizations/custom_viz_spotlight_frame/config.json';
import { App as SunburstApp } from '../../../../../../../visualizations/sunburst/visualizations/custom_viz_sunburst/src/host.jsx';
import SunburstConfig from '../../../../../../../visualizations/sunburst/visualizations/custom_viz_sunburst/config.json';
import { App as TabSelectorApp } from '../../../../../../../visualizations/tab-selector/visualizations/custom_viz_tab_selector/src/host.jsx';
import TabSelectorConfig from '../../../../../../../visualizations/tab-selector/visualizations/custom_viz_tab_selector/config.json';
import { App as TimelineSwimlaneApp } from '../../../../../../../visualizations/timeline-swimlane/visualizations/custom_viz_timeline_swimlane/src/host.jsx';
import TimelineSwimlaneConfig from '../../../../../../../visualizations/timeline-swimlane/visualizations/custom_viz_timeline_swimlane/config.json';
import { App as TreemapApp } from '../../../../../../../visualizations/treemap/visualizations/custom_viz_treemap/src/host.jsx';
import TreemapConfig from '../../../../../../../visualizations/treemap/visualizations/custom_viz_treemap/config.json';
import { App as VuConsoleApp } from '../../../../../../../visualizations/vu-console/visualizations/custom_viz_vu_console/src/host.jsx';
import VuConsoleConfig from '../../../../../../../visualizations/vu-console/visualizations/custom_viz_vu_console/config.json';
import { App as WaterfallChartApp } from '../../../../../../../visualizations/waterfall-chart/visualizations/custom_viz_waterfall_chart/src/host.jsx';
import WaterfallChartConfig from '../../../../../../../visualizations/waterfall-chart/visualizations/custom_viz_waterfall_chart/config.json';
import { App as WorldmapApp } from '../../../../../../../visualizations/world-map/visualizations/custom_viz_worldmap/src/host.jsx';
import WorldmapConfig from '../../../../../../../visualizations/world-map/visualizations/custom_viz_worldmap/config.json';


export const VIZ_REGISTRY = {
    // DPX ネイティブ（プラットフォーム標準）
    'dpx.line': DpxLine,
    'dpx.bar': DpxBar,
    'dpx.ranking': DpxRanking,
    'dpx.donut': DpxDonut,
    'dpx.value': DpxValue,
    'dpx.status': DpxStatus,
    'dpx.table': DpxTable,
    // 装飾
    'deco.text': DecoText,
    'deco.clock': DecoClock,
    // 図形（パネルの背面に敷いて構図を作る。Studio には無い）
    'shape.rect': ShapeRect,
    'shape.ellipse': ShapeEllipse,
    'shape.line': ShapeLine,
    'shape.glow': ShapeGlow,
    // コネクタ線：shape.line と違い**サーチ結果で色が変わる**（link-line 相当）。
    // パネル同士を結んで死活・遅延を線の色で見せる用途
    'dpx.linkLine': DpxLinkLine,
    // NOC 枠：パネル質感 `noc` と同じ意匠を図形として置ける。
    // カスタム viz を frameless にしてこれを裏に敷くと意匠が揃う
    'shape.nocFrame': ShapeNocFrame,
    // その他（試作）
    'custom.spike': SpikeViz,
    // ── 既存カスタム viz（Studio 拡張を iframe なしでホスト）──────
    // type は Studio と同じ <appId>.<appId>。定義をそのまま移せる
'custom_viz_attack_globe.custom_viz_attack_globe': adaptExtensionViz(AttackGlobeApp, AttackGlobeConfig),  // Attack Globe
    'custom_viz_bullet_graph.custom_viz_bullet_graph': adaptExtensionViz(BulletGraphApp, BulletGraphConfig),  // Bullet Graph
    'custom_viz_calendar_heatmap.custom_viz_calendar_heatmap': adaptExtensionViz(CalendarHeatmapApp, CalendarHeatmapConfig),  // Calendar Heatmap
    'custom_viz_chord_flow.custom_viz_chord_flow': adaptExtensionViz(ChordFlowApp, ChordFlowConfig),  // Chord Flow
    'custom_viz_country_graph.custom_viz_country_graph': adaptExtensionViz(CountryGraphApp, CountryGraphConfig),  // Country Graph
    'custom_viz_donut_graph.custom_viz_donut_graph': adaptExtensionViz(DonutGraphApp, DonutGraphConfig),  // Donut Graph
    'custom_viz_donut_timechart.custom_viz_donut_timechart': adaptExtensionViz(DonutTimechartApp, DonutTimechartConfig),  // Donut Timechart
    'custom_viz_funnel_leak.custom_viz_funnel_leak': adaptExtensionViz(FunnelLeakApp, FunnelLeakConfig),  // Funnel Leak
    'custom_viz_gauge_arc.custom_viz_gauge_arc': adaptExtensionViz(GaugeArcApp, GaugeArcConfig),  // Gauge Arc
    'custom_viz_gradient_bar.custom_viz_gradient_bar': adaptExtensionViz(GradientBarApp, GradientBarConfig),  // Gradient Bar
    'custom_viz_heat_matrix.custom_viz_heat_matrix': adaptExtensionViz(HeatMatrixApp, HeatMatrixConfig),  // Heat Matrix
    'custom_viz_horizon_chart.custom_viz_horizon_chart': adaptExtensionViz(HorizonChartApp, HorizonChartConfig),  // Horizon Chart
    'custom_viz_icon_status.custom_viz_icon_status': adaptExtensionViz(IconStatusApp, IconStatusConfig),  // Icon Status
    'custom_viz_japanmap.custom_viz_japanmap': adaptExtensionViz(JapanmapApp, JapanmapConfig),  // Japan Map
    'custom_viz_kpi_tile.custom_viz_kpi_tile': adaptExtensionViz(KpiTileApp, KpiTileConfig),  // KPI Tile
    'custom_viz_link_line.custom_viz_link_line': adaptExtensionViz(LinkLineApp, LinkLineConfig),  // Link Line
    'custom_viz_liquid_tube.custom_viz_liquid_tube': adaptExtensionViz(LiquidTubeApp, LiquidTubeConfig),  // Liquid Tube
    'custom_viz_metric_terrain.custom_viz_metric_terrain': adaptExtensionViz(MetricTerrainApp, MetricTerrainConfig),  // Metric Terrain
    'custom_viz_radar_chart.custom_viz_radar_chart': adaptExtensionViz(RadarChartApp, RadarChartConfig),  // Radar Chart
    'custom_viz_radial_bar.custom_viz_radial_bar': adaptExtensionViz(RadialBarApp, RadialBarConfig),  // Radial Bar
    'custom_viz_sankey_flow.custom_viz_sankey_flow': adaptExtensionViz(SankeyFlowApp, SankeyFlowConfig),  // Sankey Flow
    'custom_viz_severity_table.custom_viz_severity_table': adaptExtensionViz(SeverityTableApp, SeverityTableConfig),  // Severity Table
    'custom_viz_spotlight_frame.custom_viz_spotlight_frame': adaptExtensionViz(SpotlightFrameApp, SpotlightFrameConfig),  // Spotlight Frame
    'custom_viz_sunburst.custom_viz_sunburst': adaptExtensionViz(SunburstApp, SunburstConfig),  // Sunburst
    'custom_viz_tab_selector.custom_viz_tab_selector': adaptExtensionViz(TabSelectorApp, TabSelectorConfig),  // Tab Selector
    'custom_viz_timeline_swimlane.custom_viz_timeline_swimlane': adaptExtensionViz(TimelineSwimlaneApp, TimelineSwimlaneConfig),  // Timeline Swimlane
    'custom_viz_treemap.custom_viz_treemap': adaptExtensionViz(TreemapApp, TreemapConfig),  // Treemap
    'custom_viz_vu_console.custom_viz_vu_console': adaptExtensionViz(VuConsoleApp, VuConsoleConfig),  // VU Console
    'custom_viz_waterfall_chart.custom_viz_waterfall_chart': adaptExtensionViz(WaterfallChartApp, WaterfallChartConfig),  // Waterfall Chart
    'custom_viz_worldmap.custom_viz_worldmap': adaptExtensionViz(WorldmapApp, WorldmapConfig),  // World Map
};

export const VIZ_CATEGORY_LABELS = {
    chart: 'チャート',
    status: 'ステータス',
    deco: '装飾',
    shape: '図形',
    custom: 'その他',
};

/**
 * その viz の「既定のパネル質感」を返す。
 *
 * ⚠ **既定値をここ以外にベタ書きしない。** 描画側とインスペクタで別々に
 *   `?? 'noc'` / `?? 'card'` と書いていたためズレた前科がある（§8.dd）。
 *
 * 図形・装飾は **枠なし**。図形自身が枠を描くので、パネル側も枠を付けると
 * **二重になる**（コーナーフレーム図形で実際に発生）。
 */
export function defaultVariantFor(type) {
    const cat = VIZ_REGISTRY[type]?.config?.category ?? 'custom';
    return cat === 'shape' || cat === 'deco' ? 'frameless' : 'noc';
}

export function resolveViz(type) {
    return VIZ_REGISTRY[type] ?? null;
}

/** viz ピッカー用の一覧（表示名は各 viz の statics config.name から取る）。 */
export function listViz() {
    return Object.entries(VIZ_REGISTRY).map(([type, comp]) => ({
        type,
        name: comp?.config?.name ?? type,
        category: comp?.config?.category ?? 'custom',
    }));
}

/** viz の editorConfig（オプションフォーム自動生成の材料）。無ければ null。 */
export function vizEditorConfig(type) {
    const comp = VIZ_REGISTRY[type];
    return Array.isArray(comp?.config?.editorConfig) ? comp.config.editorConfig : null;
}

/** viz の optionsSchema（未設定オプションの既定値表示に使う）。 */
export function vizOptionsSchema(type) {
    const comp = VIZ_REGISTRY[type];
    return comp?.config?.optionsSchema ?? {};
}
