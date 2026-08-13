// ── viz が受け取るデータの読み方 ─────────────────────────────────
//
// **サーチ結果の「形」を知っているのはここだけ**にする。
//
// 以前は 7 つのネイティブ viz すべてが
//
//     const data = dataSources?.primary?.data;
//     const cols = data?.columns ?? [];
//
// と**同じ形を各自で掘っていた**。この形を変えたくなったとき
// （複数データソース対応・列の型情報の追加など）、**7 箇所を直す**ことになる。
//
// ## データの形（Splunk のサーチ結果）
//
// ```
// dataSources.primary.data = {
//   fields:  [{name: 'host'}, {name: 'count'}],   // 列の定義
//   columns: [['a','b'], [1, 2]],                 // ⚠ 列ごとの配列（行ではない）
// }
// ```
//
// ⚠ **`columns` は「列の配列」であって「行の配列」ではない。**
//   `columns[0]` が 1 列目の全行。行で欲しいときは `rows` を使う。
//
// ⚠ **`fields` の要素は文字列ではなくオブジェクト**（`{name}`）。
//   そのまま描画に流すと **`[object Object]` が並ぶ**（実機で発生）。
//   → `fieldNames` を使う。
// ────────────────────────────────────────────────────────────────

import React from 'react';

/** データが無いときの戻り値。⚠ **毎回同じ参照を返す**（useMemo の依存が安定する）。 */
export const EMPTY_VIZ_DATA = Object.freeze({
    fields: Object.freeze([]),
    fieldNames: Object.freeze([]),
    columns: Object.freeze([]),
    rowCount: 0,
    isEmpty: true,
});

/**
 * `dataSources` を viz が扱いやすい形に均す。
 *
 * @param dataSources ホストから届く生の形
 * @param key         データソース名（既定 'primary'）
 * @returns {{fields, fieldNames, columns, rowCount, isEmpty,
 *            column(i), columnByName(name), rows()}}
 */
export function normalizeVizData(dataSources, key = 'primary') {
    const data = dataSources?.[key]?.data;
    const columns = Array.isArray(data?.columns) ? data.columns : [];
    const fields = Array.isArray(data?.fields) ? data.fields : [];
    if (columns.length === 0) return EMPTY_VIZ_DATA;

    const fieldNames = fields
        .map((f) => (typeof f === 'string' ? f : f?.name))
        .filter((n) => n != null)
        .map(String);

    // ⚠ 列ごとに長さが違うことがある（サーチの都合）。**最長に合わせる**。
    //   最短に合わせると末尾の行が黙って消える。
    const rowCount = columns.reduce((m, c) => Math.max(m, Array.isArray(c) ? c.length : 0), 0);

    return {
        fields,
        fieldNames,
        columns,
        rowCount,
        isEmpty: rowCount === 0,
        /** i 列目（無ければ空配列）。 */
        column(i) {
            return Array.isArray(columns[i]) ? columns[i] : [];
        },
        /** 名前で列を引く（無ければ null）。 */
        columnByName(name) {
            const i = fieldNames.indexOf(name);
            return i < 0 ? null : this.column(i);
        },
        /**
         * 行の配列に組み替える。
         * ⚠ **列 → 行の転置はコストがある**。表のように行単位で扱う viz だけが呼ぶこと。
         */
        rows() {
            const out = [];
            for (let r = 0; r < rowCount; r += 1) {
                out.push(columns.map((c) => (Array.isArray(c) ? c[r] : undefined)));
            }
            return out;
        },
    };
}

/**
 * viz の中でサーチ結果を読む（正規化つき）。
 *
 * ⚠ **必ずコンポーネントの先頭で呼ぶ。** データ有無で early return する前に
 *   呼ばないと、**データ到着の瞬間にフックの数が変わって落ちる**
 *   （DPX で最頻の白紙バグ。コンソールにエラーが出ないこともある）。
 */
export function useVizData(dataSources, key = 'primary') {
    return React.useMemo(() => normalizeVizData(dataSources, key), [dataSources, key]);
}
