// 軸のスケール計算（純粋関数だけを置く）。
//
// ⚠ **JSX を含むファイルに置かない。** nativeViz.jsx に書くと
//    `node test/*.mjs` から import できず（JSX を素の node が読めない）、
//    テストが書けなくなる。目盛りの計算は「目で見て合っているか」が
//    判定しづらいので、必ずテストできる場所に置く。

/**
 * X 軸ラベルを「読める形」に整える。
 *
 * ⚠ **ISO 文字列を先頭から切り詰めてはいけない。**
 *   `2026-08-11T15:00:00.000+09:00` を10文字で切ると **`2026-08-1…`** になり、
 *   **全部のラベルが同じ文字列**になる（実機で確認：`allSame: true` のパネルが3枚）。
 *   時刻の情報は後ろにあるので、切り詰めると真っ先に消える。
 *
 * 標準 Splunk は `4:00 PM` のように**時刻だけ**を出し、日付が変わる境目でのみ
 * `Sun Aug 9` を添える。それに倣う（日本語ロケールなので `8/9` 形式）。
 *
 * @param labels 生のラベル配列（ISO 文字列 / epoch 秒 / 任意の文字列）
 * @returns [{ main, sub }] … main=主ラベル、sub=日付が変わる位置だけ入る
 */
export function formatAxisLabels(labels) {
    const list = (labels ?? []).map((v) => (v == null ? '' : String(v)));
    const dates = list.map(toDate);
    // 1つでも日時として読めないものがあれば、時刻軸として扱わない
    // （ホスト名などの文字列軸。その場合は末尾を省略する＝先頭は残る）
    if (dates.some((d) => d === null) || dates.length === 0) {
        return list.map((s) => ({ main: s.length > 14 ? `${s.slice(0, 13)}…` : s, sub: '' }));
    }
    const spanMs = Math.abs(dates[dates.length - 1] - dates[0]);
    const days = spanMs / 86400000;
    const p2 = (n) => String(n).padStart(2, '0');

    return dates.map((d, i) => {
        const prev = i > 0 ? dates[i - 1] : null;
        const dayChanged = !prev || d.getDate() !== prev.getDate() || d.getMonth() !== prev.getMonth();
        // 期間の長さで粒度を変える（標準 viz と同じ考え方）
        if (days > 60) return { main: `${d.getMonth() + 1}/${d.getDate()}`, sub: dayChanged && d.getDate() === 1 ? String(d.getFullYear()) : '' };
        if (days > 3) return { main: `${d.getMonth() + 1}/${d.getDate()}`, sub: '' };
        if (days > 0.02) {
            // 数時間〜数日: 時刻を主に出し、日が変わったところだけ日付を添える
            return { main: `${p2(d.getHours())}:${p2(d.getMinutes())}`, sub: dayChanged ? `${d.getMonth() + 1}/${d.getDate()}` : '' };
        }
        // 数分以内: 秒まで
        return { main: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`, sub: '' };
    });
}

/** ISO 文字列 / epoch（秒・ミリ秒）を Date にする。読めなければ null。 */
function toDate(s) {
    if (!s) return null;
    // epoch 秒（Splunk の _time は秒のことがある）
    if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000);
    if (/^\d{12,13}$/.test(s)) return new Date(Number(s));
    // ⚠ **`new Date(任意の文字列)` に判定を任せてはいけない。**
    //    `new Date('srv-web-01')` は **2001年1月1日として通ってしまう**（実測）。
    //    ホスト名の軸が「1/1, 2/1, …」に化ける。
    //    → **先頭が YYYY-MM-DD（または YYYY/MM/DD）である**ことを厳密に確かめる。
    if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]|$)/.test(s)) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 目盛りに使う「切りのいい」間隔で 0 から max までの目盛り値を返す。
 * 刻みは 1 / 2 / 2.5 / 5 × 10^n のいずれか。
 *
 * 標準 Splunk の値軸が 0.05K 刻みのような読みやすい数字になっているのに倣う。
 * 生の max/5 をそのまま使うと 173.4 のような目盛りになって読めない。
 *
 * @param max   データの最大値
 * @param count 目安の目盛り数（厳密には一致しない。刻みを丸めるため）
 * @returns 昇順の目盛り値（先頭は必ず 0）
 */
export function niceTicks(max, count = 4) {
    // ⚠ 0 や負数・NaN で呼ばれる（データが空／全部 0）。
    //    ここで無限ループや Infinity を作らないこと
    if (!Number.isFinite(max) || max <= 0) return [0];
    if (!Number.isFinite(count) || count < 1) count = 4;
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    // ⚠ **最後の目盛りは必ず max 以上まで伸ばす。**
    //    `v <= max` で止めると max=99 のとき最上段が 75 になり、
    //    バーは 99 を基準に描かれるのに一番上のグリッド線が 75 を指す
    //    ＝**線の位置と数字が食い違う**（テストで検出。目視では気づけない）。
    //    軸の上端＝最後の目盛りに揃えることで、線と数字の意味が一致する。
    const out = [];
    // 浮動小数の誤差で最後の目盛りが重複しないよう許容幅を持たせる
    for (let v = 0; v < max - step * 0.001; v += step) out.push(v);
    out.push(out.length ? out[out.length - 1] + step : step);
    // 刻みの積み上げで出る誤差（0.1+0.2 問題）を丸める
    const digits = Math.max(0, -Math.floor(Math.log10(step)) + 2);
    return out.map((v) => Number(v.toFixed(digits)));
}

/**
 * min〜max の範囲に対する「切りのいい」目盛りを返す（折れ線用）。
 *
 * `niceTicks` は 0 起点なので、**負の値を含む系列**や
 * **0 から遠い範囲**（例: 980〜1020）では使えない。
 * こちらは範囲の両端を刻みの倍数まで広げる。
 *
 * @returns { ticks, min, max } … min/max は**軸の下端・上端**（描画はこれで割る）
 */
export function niceScale(minV, maxV, count = 4) {
    let lo = Number(minV);
    let hi = Number(maxV);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ticks: [0, 1], min: 0, max: 1 };
    if (lo > hi) [lo, hi] = [hi, lo];
    // ⚠ 全点が同じ値だと range=0 になり、0 除算やゼロ幅の軸になる。
    //    その値を中央に置いた範囲を作る（実データで普通に起きる）
    if (hi === lo) {
        const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.1 : 1;
        lo -= pad;
        hi += pad;
    }
    if (!Number.isFinite(count) || count < 1) count = 4;
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;
    const digits = Math.max(0, -Math.floor(Math.log10(step)) + 2);
    const ticks = [];
    // 上限は「目盛り数 + 余裕」で必ず打ち切る（浮動小数で終わらない事故を防ぐ）
    for (let v = start, i = 0; v <= end + step * 0.001 && i < 64; v += step, i++) {
        ticks.push(Number(v.toFixed(digits)));
    }
    return { ticks, min: ticks[0], max: ticks[ticks.length - 1] };
}
