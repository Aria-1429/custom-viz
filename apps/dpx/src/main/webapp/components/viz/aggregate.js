// ── 集計（viz が描く前にデータを畳む）───────────────────────────
//
// **SPL で書かずに済ませたい集計**をここに置く。
// 階級分け（ヒストグラム）やクロス集計（ヒートマップ）は
// **画面で切り方を変えられる**ほうが便利なので、viz 側で計算する。
//
// ⚠ **依存ゼロで保つ**（React も DOM も import しない）。
//   素の Node からテストできることが、この層に置く理由そのもの。
//   計算は目視で正しさを判定できない（境界のセルが 1 つ欠けても気づけない）。
// ────────────────────────────────────────────────────────────────

/**
 * 階級数を決める（スタージェスの公式）。
 *
 * ⚠ 件数が少ないときに固定値（例: 20）を使うと**ほとんどの階級が空**になり、
 *   「櫛」のような絵になる。`1 + log2(n)` は件数に応じて増える。
 */
export function sturgesBins(n) {
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.max(1, Math.min(50, Math.ceil(1 + Math.log2(n))));
}

/**
 * 値の配列 → 階級ごとの度数。
 *
 * ⚠ **最大値は最後の階級に入れる**。`floor((v-min)/w)` だけだと
 *   最大値が `binCount` 番目（範囲外）を指して**度数が消える**。
 */
export function buildBins(values, binCount) {
    const nums = (Array.isArray(values) ? values : []).map(Number).filter((v) => Number.isFinite(v));
    if (nums.length === 0 || !(binCount >= 1)) return [];
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    // 全部同じ値なら 1 本だけ立てる（幅 0 での除算を避ける）
    if (max === min) return [{ from: min, to: max, count: nums.length }];
    const width = (max - min) / binCount;
    const bins = Array.from({ length: binCount }, (_, i) => ({
        from: min + width * i,
        to: min + width * (i + 1),
        count: 0,
    }));
    nums.forEach((v) => {
        const idx = Math.min(binCount - 1, Math.floor((v - min) / width));
        bins[idx].count += 1;
    });
    return bins;
}

/**
 * 行・列ラベル → Map のキー。
 *
 * ⚠⚠ **区切りに生の NUL（\x00）を書かない。** ファイルが「バイナリ」と
 *   判定されて **grep が一切効かなくなる**（sankey-flow で実際に起きた。
 *   この viz でも一度やらかして `layers.test.mjs` に検出された）。
 *
 * ⚠ 空白や `-` のような**ラベルに現れうる文字**も使わない。
 *   「"a b"×"c"」と「"a"×"b c"」が同じキーに潰れる。
 */
const KEY_SEP = '␟'; // ␟ = 記号としての UNIT SEPARATOR（制御文字ではない）

export const cellKey = (row, col) => `${String(row ?? '')}${KEY_SEP}${String(col ?? '')}`;

/**
 * 3 列のデータ → 行ラベル・列ラベル・値の対応表。
 *
 * ⚠ **出現順を保つ**（`Set` の挿入順）。アルファベット順に並べ替えると
 *   SPL 側で `| sort` した意図が消える（曜日順・時間順が壊れる）。
 *
 * ⚠ **欠測はキーを作らない**。0 を入れると「値が 0」と区別できなくなる。
 */
export function buildMatrix(rowVals, colVals, values) {
    const rowsIn = Array.isArray(rowVals) ? rowVals : [];
    const colsIn = Array.isArray(colVals) ? colVals : [];
    const vals = Array.isArray(values) ? values : [];
    const rows = [...new Set(rowsIn.map((v) => String(v ?? '')))];
    const cols = [...new Set(colsIn.map((v) => String(v ?? '')))];
    const map = new Map();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < rowsIn.length; i += 1) {
        const v = Number(vals[i]);
        if (!Number.isFinite(v)) continue;
        map.set(cellKey(rowsIn[i], colsIn[i]), v);
        if (v < min) min = v;
        if (v > max) max = v;
    }
    // ⚠ 1 つも数値が無いと Infinity が残る。そのまま割り算に使うと NaN になる
    if (!Number.isFinite(min)) {
        min = 0;
        max = 0;
    }
    return { rows, cols, map, min, max };
}

/** 値 → 0〜1 の濃さ。⚠ 全セル同値のときは 1（0 除算にしない）。 */
export function heatRatio(v, min, max) {
    if (!Number.isFinite(v)) return 0;
    if (max === min) return 1;
    return Math.max(0, Math.min(1, (v - min) / (max - min)));
}
