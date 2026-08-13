// DPX スキーマ v1 の判定。
//
// ⚠ **依存ゼロで保つこと。** viewStore（@splunk/splunk-utils を読む＝ブラウザ専用）
//   から切り出してあるのは、素の Node で import してテストできるようにするため。

/**
 * DPX スキーマ v1 の定義かどうか。
 *
 * ⚠ **Dashboard Studio も `<definition>` に JSON を入れる**ので、
 *   入れ物の形だけでは区別できない（実機で確認）。
 *   DPX は `version: 1` と `panels` 配列を必ず持つので、それで判定する。
 *   Studio 側は `visualizations` / `dataSources` / `layout` を持ち `version` は
 *   文字列（"1.1" 等）なので、この条件には合致しない。
 */
export function isDpxDefinition(def) {
    return Boolean(def) && def.version === 1 && Array.isArray(def.panels);
}
