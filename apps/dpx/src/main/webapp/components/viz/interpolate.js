// ── 本文への値の差し込み（$トークン$ / $列名$）─────────────────
//
// **`$...$` は 2 種類あり、置換の順番と担当が違う**:
//
//   1. **トークン** … 入力（ドロップダウン等）やクリックで決まる。`applyTokens` が担当
//   2. **列名** … サーチ結果の 1 行目の値。ここの `applyFieldValues` が担当
//
// ⚠ **依存ゼロで保つ**（React も DOM も import しない）。
//   置換の順番を間違えると「消えるべきでないものが消える」が、
//   これは**画面を見ても気づけない**（空文字になるだけで、エラーも出ない）。
//   → 素の Node からテストできることが、この層に置く理由。
// ────────────────────────────────────────────────────────────────

/**
 * `applyTokens` に渡す「未設定でも空文字にしてよい」判定器を作る。
 *
 * **本文の `$name$` は 3 通りに分かれる**。それぞれ扱いが違う:
 *
 * | 種類 | 判定 | 扱い |
 * |---|---|---|
 * | 設定済みトークン | `tokens` にある | 値に置換（`applyTokens` が行う） |
 * | **未設定トークン** | 入力等で宣言はあるが空 | **空文字**（本文は SPL ではないので描画を止めない） |
 * | **列名** | `fieldNames` にある | 素通し → `applyFieldValues` が値を入れる |
 * | **どれでもない** | 上のどれにも該当しない | **`$name$` のまま残す**（＝綴り間違い。見えないと直せない） |
 *
 * ⚠⚠ **素朴に `has: () => true` にしてはいけない**（2026-08-15 実機で発覚）。
 *   `$列名$` まで「未設定トークン」とみなされて**トークン展開の段階で空文字に消え**、
 *   後段の `applyFieldValues` に何も残らない＝**列の差し込みが常に空**になる。
 *   さらに `$綴り間違い$` も黙って消えるので**書き間違いに気づけない**。
 *   どちらも画面上はただ空になるだけで、エラーも警告も出ない。
 *
 * @param fieldNames サーチ結果の列名。素通しして後段に判断させる。
 * @param tokens 現在のトークン。**キーの有無だけ**を見る（値が空でも「宣言済み」なら
 *   空文字に落としてよい＝未選択の絞り込みは「条件なし」が自然だから）。
 */
export function optionalExcept(fieldNames, tokens) {
    const fields = new Set(Array.isArray(fieldNames) ? fieldNames : []);
    const declared = tokens && typeof tokens === 'object' ? tokens : {};
    return {
        has: (name) => {
            if (fields.has(name)) return false; // 列名 → 後段へ回す
            // 宣言のあるトークンだけ空文字に落とす。知らない名前は残して見せる
            return Object.prototype.hasOwnProperty.call(declared, name);
        },
    };
}

/**
 * `$列名$` をサーチ結果の**1 行目**の値に置き換える。
 *
 * ⚠ **トークン展開より後に行う**（トークンで列名を組み立てられるように）。
 * ⚠ 該当しない `$...$` は**そのまま残す**（消すと書き間違いに気づけない）。
 *   ここを空文字にしてしまうと、列名の打ち間違いが「本文から 1 語消えるだけ」に
 *   なって発見できない。**残っていれば画面上で `$typo$` と見えて気づける。**
 */
export function applyFieldValues(text, fieldNames, firstRow) {
    if (typeof text !== 'string' || !text) return '';
    if (!Array.isArray(fieldNames) || fieldNames.length === 0) return text;
    return text.replace(/\$([^$\s]+)\$/g, (whole, name) => {
        const i = fieldNames.indexOf(name);
        if (i < 0) return whole;
        const v = firstRow?.[i];
        return v == null ? '' : String(v);
    });
}
