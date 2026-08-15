// ── 独自エンジンの viz レジストリ ────────────────────────────────
// パネルの `viz` 名 → React コンポーネント。Studio の preset に相当するが、
// ただの Map であり検閲も iframe もない。コンポーネント契約は VizProps 互換:
//   { dataSources: {primary:{data:{fields,columns}}}, loading, options,
//     width, height, mode, onOptionsChange, onEventTrigger }
//
// 既存 Studio 拡張 viz は extensionAdapter（webpack alias）経由でそのまま載る。
// type 名は従来の <appId>.<appId> を維持する（定義の移行を単純にするため）。

import SpikeViz from './SpikeViz';
import { DecoClock, DecoText } from './deco';
import {
    DpxBar,
    DpxDonut,
    DpxGauge,
    DpxHeatmap,
    DpxHistogram,
    DpxLine,
    DpxLinkGraph,
    DpxMarkdown,
    DpxSankey,
    DpxProgress,
    DpxRanking,
    DpxStatus,
    DpxTable,
    DpxValue,
} from './native';
import { ShapeEllipse, ShapeGlow, ShapeLine, ShapeNocFrame, ShapeRect } from './shapes';
import { DpxLinkLine } from './DpxLinkLine';

// ── 既存カスタム viz（Studio 拡張）────────────────────────────────
// ⭐ **一覧は機械生成する**（`tools/gen-viz-registry.mjs`）。
//    以前はここに import 2 行＋登録 1 行を viz ごとに手書きしていたが、
//    30 viz で 90 行の定型コードになり**足し忘れ・綴り間違いが起きる**。
//    新しい viz は `src/host.jsx` と `config.json` を置いて生成し直すだけで載る。
import { EXTENSION_VIZ } from './registry.generated';

export const VIZ_REGISTRY = {
    // DPX ネイティブ（プラットフォーム標準）
    'dpx.line': DpxLine,
    'dpx.bar': DpxBar,
    'dpx.ranking': DpxRanking,
    'dpx.gauge': DpxGauge,
    'dpx.progress': DpxProgress,
    'dpx.histogram': DpxHistogram,
    'dpx.heatmap': DpxHeatmap,
    'dpx.donut': DpxDonut,
    // フロー・関係（標準にもあるが、多段フローと線の太さで差がある）
    'dpx.sankey': DpxSankey,
    'dpx.linkGraph': DpxLinkGraph,
    'dpx.value': DpxValue,
    'dpx.status': DpxStatus,
    'dpx.table': DpxTable,
    // 装飾
    'deco.text': DecoText,
    'dpx.markdown': DpxMarkdown,
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
    // type は Studio と同じ <appId>.<appId>。定義をそのまま移せる。
    // ⭐ 機械生成した一覧を展開する（手で足さない）
    ...EXTENSION_VIZ,
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
