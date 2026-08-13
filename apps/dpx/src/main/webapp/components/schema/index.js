// ── Dashboard Schema 層の公開 API ───────────────────────────────
//
// **他の層はこのファイルだけを import する。**
// `dashboard.js` / `parse.js` を直接読まないこと（内部構成を変えたときに
// 呼び出し側が壊れるため）。
//
// 使い方:
//   import { parseDefinition, emptyDashboard, PANEL_VARIANTS } from '../schema';
//
// ⚠ **既定値をコンポーネント側に書かない。** `parseDefinition()` を通せば
//   既定値は埋まっている。`?? 'noc'` のようなフォールバックを足すと
//   **二重定義**になり、片方を変えたときに UI と実物がズレる（§8.dd）。
// ────────────────────────────────────────────────────────────────

export {
    DashboardSchema,
    DataSourceSchema,
    GroupSchema,
    InputSchema,
    LayoutSchema,
    PanelSchema,
    PanelStyleSchema,
    TabSchema,
    emptyDashboard,
} from './dashboard.js';

export {
    isValidDefinition,
    parseDefinition,
    parseDefinitionText,
    serializeDefinition,
} from './parse.js';

export {
    AMBIENT_VALUES,
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    CHROME_VALUES,
    DEFAULTS,
    ENTRANCE_VALUES,
    GROUP_INCOMPATIBLE_VARIANTS,
    GROUP_VARIANT_VALUES,
    INPUT_LABELS,
    INPUT_TYPES,
    LAYOUT_TYPES,
    PANEL_VARIANTS,
    PANEL_VARIANT_VALUES,
    RANGE_INPUT_TYPES,
    SCHEMA_VERSION,
    TAB_POSITIONS,
    THEME_PRESETS,
    TITLE_ALIGNS,
    categoryRank,
    defaultVariantForCategory,
} from './vocab.js';
