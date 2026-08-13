// 取り込んだ JSON をこのプラットフォームの定義として受け入れてよいか検証する。
//
// ⚠ **viewStore.js ではなくここに置く理由**：viewStore は @splunk/splunk-utils
//   （ブラウザ専用のランタイム）を読むので、素の Node から import できない
//   ＝テストが書けない。検証は純粋なロジックなので切り出しておく。

import { isDpxDefinition } from './schema.js';

/** 取り込んだ JSON がこのプラットフォームの定義として使えるか検証する。
 *
 *  ⚠ **落とすのではなく理由を返す。** 手で編集した JSON を貼る導線なので、
 *    「取り込めません」だけだと直しようがない。何が足りないかまで言う。
 *  @returns {{definition: object} | {error: string}}
 */
export function parseImportedDefinition(text) {
    let def;
    try {
        def = JSON.parse(text);
    } catch (err) {
        return { error: `JSON として読めません（${String(err?.message ?? err)}）` };
    }
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
        return { error: 'JSON のトップレベルがオブジェクトではありません' };
    }
    if (!isDpxDefinition(def)) {
        // Studio の定義を間違えて貼るのはあり得る筋なので、そうだと分かるなら言う
        if (def.visualizations && def.layout) {
            return { error: 'Dashboard Studio の定義のようです（このプラットフォームの形式ではありません）' };
        }
        return { error: '定義の形式が違います（version: 1 と panels 配列が必要です）' };
    }
    return { definition: def };
}
