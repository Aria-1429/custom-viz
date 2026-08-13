// ⚠⚠ **このファイルは自動生成です。手で編集しないでください。** ⚠⚠
//
// 生成: node tools/gen-viz-registry.mjs
// 検証: node tools/gen-viz-registry.mjs --check   （CI・再生成忘れの検出）
//
// **新しい Studio 拡張 viz を足したら、このスクリプトを 1 回走らせるだけ**で
// Component Palette / Property Editor / Renderer から使えるようになります。
// 条件は 2 つだけ:
//   1. `src/host.jsx` がある（⚠ エントリ `visualization.jsx` に export を書かない。
//      esbuild が ESM 出力になり Studio 実機でパネルが真っ黒になります）
//   2. `config.json` がある（optionsSchema / editorConfig をそのまま流用します）
//
// 現在 30 個の viz を登録しています。

import { adaptExtensionViz } from './extensionAdapter';

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

/** Studio 拡張 viz（iframe なしでホストしているもの）。 */
export const EXTENSION_VIZ = {
    'custom_viz_attack_globe.custom_viz_attack_globe': adaptExtensionViz(AttackGlobeApp, AttackGlobeConfig), // Attack Globe
    'custom_viz_bullet_graph.custom_viz_bullet_graph': adaptExtensionViz(BulletGraphApp, BulletGraphConfig), // Bullet Graph
    'custom_viz_calendar_heatmap.custom_viz_calendar_heatmap': adaptExtensionViz(CalendarHeatmapApp, CalendarHeatmapConfig), // Calendar Heatmap
    'custom_viz_chord_flow.custom_viz_chord_flow': adaptExtensionViz(ChordFlowApp, ChordFlowConfig), // Chord Flow
    'custom_viz_country_graph.custom_viz_country_graph': adaptExtensionViz(CountryGraphApp, CountryGraphConfig), // Country Graph
    'custom_viz_donut_graph.custom_viz_donut_graph': adaptExtensionViz(DonutGraphApp, DonutGraphConfig), // Donut Graph
    'custom_viz_donut_timechart.custom_viz_donut_timechart': adaptExtensionViz(DonutTimechartApp, DonutTimechartConfig), // Donut Timechart
    'custom_viz_funnel_leak.custom_viz_funnel_leak': adaptExtensionViz(FunnelLeakApp, FunnelLeakConfig), // Funnel Leak
    'custom_viz_gauge_arc.custom_viz_gauge_arc': adaptExtensionViz(GaugeArcApp, GaugeArcConfig), // Gauge Arc
    'custom_viz_gradient_bar.custom_viz_gradient_bar': adaptExtensionViz(GradientBarApp, GradientBarConfig), // Gradient Bar
    'custom_viz_heat_matrix.custom_viz_heat_matrix': adaptExtensionViz(HeatMatrixApp, HeatMatrixConfig), // Heat Matrix
    'custom_viz_horizon_chart.custom_viz_horizon_chart': adaptExtensionViz(HorizonChartApp, HorizonChartConfig), // Horizon Chart
    'custom_viz_icon_status.custom_viz_icon_status': adaptExtensionViz(IconStatusApp, IconStatusConfig), // Icon Status
    'custom_viz_japanmap.custom_viz_japanmap': adaptExtensionViz(JapanmapApp, JapanmapConfig), // Japan Map
    'custom_viz_kpi_tile.custom_viz_kpi_tile': adaptExtensionViz(KpiTileApp, KpiTileConfig), // KPI Tile
    'custom_viz_link_line.custom_viz_link_line': adaptExtensionViz(LinkLineApp, LinkLineConfig), // Link Line
    'custom_viz_liquid_tube.custom_viz_liquid_tube': adaptExtensionViz(LiquidTubeApp, LiquidTubeConfig), // Liquid Tube
    'custom_viz_metric_terrain.custom_viz_metric_terrain': adaptExtensionViz(MetricTerrainApp, MetricTerrainConfig), // Metric Terrain
    'custom_viz_radar_chart.custom_viz_radar_chart': adaptExtensionViz(RadarChartApp, RadarChartConfig), // Radar Chart
    'custom_viz_radial_bar.custom_viz_radial_bar': adaptExtensionViz(RadialBarApp, RadialBarConfig), // Radial Bar
    'custom_viz_sankey_flow.custom_viz_sankey_flow': adaptExtensionViz(SankeyFlowApp, SankeyFlowConfig), // Sankey Flow
    'custom_viz_severity_table.custom_viz_severity_table': adaptExtensionViz(SeverityTableApp, SeverityTableConfig), // Severity Table
    'custom_viz_spotlight_frame.custom_viz_spotlight_frame': adaptExtensionViz(SpotlightFrameApp, SpotlightFrameConfig), // Spotlight Frame
    'custom_viz_sunburst.custom_viz_sunburst': adaptExtensionViz(SunburstApp, SunburstConfig), // Sunburst
    'custom_viz_tab_selector.custom_viz_tab_selector': adaptExtensionViz(TabSelectorApp, TabSelectorConfig), // Tab Selector
    'custom_viz_timeline_swimlane.custom_viz_timeline_swimlane': adaptExtensionViz(TimelineSwimlaneApp, TimelineSwimlaneConfig), // Timeline Swimlane
    'custom_viz_treemap.custom_viz_treemap': adaptExtensionViz(TreemapApp, TreemapConfig), // Treemap
    'custom_viz_vu_console.custom_viz_vu_console': adaptExtensionViz(VuConsoleApp, VuConsoleConfig), // VU Console
    'custom_viz_waterfall_chart.custom_viz_waterfall_chart': adaptExtensionViz(WaterfallChartApp, WaterfallChartConfig), // Waterfall Chart
    'custom_viz_worldmap.custom_viz_worldmap': adaptExtensionViz(WorldmapApp, WorldmapConfig), // World Map
};
