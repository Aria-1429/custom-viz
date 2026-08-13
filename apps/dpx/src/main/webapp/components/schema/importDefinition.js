// 取り込んだ JSON をこのプラットフォームの定義として受け入れてよいか検証する。
//
// ⚠ **viewStore.js ではなくここに置く理由**：viewStore は @splunk/splunk-utils
//   （ブラウザ専用のランタイム）を読むので、素の Node から import できない
//   ＝テストが書けない。検証は純粋なロジックなので切り出しておく。
//
// 【2026-08-13】スキーマ v2 化に伴い、**検証本体を dashboardSchema へ委譲**した。
// ここは「取り込み UI が期待する戻り値の形」に translate するだけの薄い層。
// ⚠ **判定ロジックを二重に持たない**（片方だけ直して食い違うのを避ける）。

import { parseDefinitionText } from './parse.js';

/** 取り込んだ JSON がこのプラットフォームの定義として使えるか検証する。
 *
 *  ⚠ **落とすのではなく理由を返す。** 手で編集した JSON を貼る導線なので、
 *    「取り込めません」だけだと直しようがない。何が足りないかまで言う。
 *  @returns {{definition: object} | {error: string}}
 */
export function parseImportedDefinition(text) {
    const r = parseDefinitionText(text);
    if (r.ok) return { definition: r.definition };
    // スキーマ検証の内訳（`panels.0.viz: ...`）があれば添える。
    // 「形式が違います」だけだと、どこを直せばよいか分からない
    const detail = r.issues?.length ? `${r.error}: ${r.issues.join(' / ')}` : r.error;
    return { error: detail };
}
