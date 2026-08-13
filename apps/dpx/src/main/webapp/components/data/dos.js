// ── DOS 文字列（Dynamic Options Syntax）⇄ フィールド名 ────────────
//
// **Studio の `columnSelector` が保存する値の形**。
//
//     `> primary | seriesByName("host")`
//
// ⚠ **生のフィールド名ではない。** ここを取り違えると viz 側のパーサが
//   **黙って空を返す**（例外が出ないので「データが無い」と誤診する）。
//
// ## なぜ Data 層に置くのか
//
// これは **UI ではなくデータの表現形式**。以前は `optionEditors.jsx`
// （＝Property Editor の UI ファイル）に置いていたため、
// **viz が Property Editor を import する**という層違反が起きていた:
//
//     nativeViz.jsx ──import──> optionEditors.jsx（Builder の UI）  ✗
//     nativeViz.jsx ──import──> data/dos.js（データの形式）          ✓
//
// viz は「保存された値を読む」ために使い、Property Editor は
// 「値を書く」ために使う。**両者が共有するのは形式の定義だけ**。
//
// ⚠ **依存ゼロで保つ**（React も UI も import しない）。素の Node でテストする。
// ────────────────────────────────────────────────────────────────

/** `seriesByName("...")` の中身を取り出す正規表現。 */
const DOS_RE = /seriesByName\(\s*["']([^"']+)["']\s*\)/;

/**
 * フィールド名 → DOS 文字列。
 *
 * @param field          フィールド名。空なら空文字を返す
 * @param dataSourceKey  データソース名（既定 'primary'）
 */
export function fieldToDos(field, dataSourceKey = 'primary') {
    if (!field) return '';
    return `> ${dataSourceKey} | seriesByName("${field}")`;
}

/**
 * DOS 文字列 → フィールド名。
 *
 * ⚠ **DOS でない素の文字列も受け付ける**（手書き JSON や、
 *   Studio を経由せず設定された値があるため）。
 *   ただし `>` で始まる「DOS のつもりだが解析できない文字列」は
 *   **空を返す**（フィールド名として使うと確実に間違うため）。
 */
export function dosToField(value) {
    if (typeof value !== 'string' || !value) return '';
    const m = value.match(DOS_RE);
    if (m) return m[1];
    return value.startsWith('>') ? '' : value;
}

/** その値が DOS 文字列として解析できるか。 */
export function isDos(value) {
    return typeof value === 'string' && DOS_RE.test(value);
}

/**
 * 列名の配列を正規化する。
 *
 * ⚠ 呼び出し側が Studio 互換の `[{name}]` を渡してくることがある。
 *   均さないと **`[object Object]` が画面に並ぶ**（実機で発生）。
 */
export function toFieldNames(fields) {
    return (Array.isArray(fields) ? fields : [])
        .map((f) => (typeof f === 'string' ? f : f?.name))
        .filter(Boolean);
}
