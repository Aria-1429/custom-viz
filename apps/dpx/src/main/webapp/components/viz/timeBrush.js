// ── 時間ブラシ（クロスパネル）の純粋ロジック ───────────────────────
//
// 折れ線の上を横にドラッグして選んだ区間を、**ダッシュボード全体の時間範囲**
// （時間範囲入力のトークン）へ流し込むための計算をここに置く。
//
// ⚠ **JSX を含むファイルに置かない**（scale.js と同じ理由）。
//    `node test/*.mjs` から import できなくなり、テストが書けない。
//    ブラシは「選んだ区間 → Splunk の earliest/latest 文字列」への変換なので、
//    **目で見て合っているか判定できない**（1バケットずれても絵は同じに見える）。
//    必ずテストできる場所に置く。
//
// **なぜ DPX でしかできないか**:
//   Studio はパネルが iframe に隔離されているので、パネル内のドラッグ座標を
//   ホストの時間ピッカーに繋げられない（トークン書き込みは合成クリック経由の
//   裏技しかなく、ドラッグの連続値は流せない）。DPX は全パネルが同一 React
//   ツリーにいるので TokenProvider を直接叩ける。
// ────────────────────────────────────────────────────────────────

/**
 * ISO 文字列 / epoch（秒・ミリ秒）を Date にする。読めなければ null。
 *
 * ⚠ **`new Date(任意の文字列)` に判定を任せてはいけない。**
 *   `new Date('srv-web-01')` は **2001年1月1日として通ってしまう**（実測）。
 *   ホスト名の軸を「時刻軸」と誤認すると、**ブラシがホスト名の並びを
 *   時間範囲に変換してしまう**（scale.js の同名関数と同じ防御。
 *   あちらはラベル整形用、こちらは範囲計算用で用途が違うため別々に持つ）。
 */
export function parseAxisTime(s) {
    if (s == null || s === '') return null;
    const str = String(s);
    if (/^\d{9,10}$/.test(str)) return new Date(Number(str) * 1000);
    if (/^\d{12,13}$/.test(str)) return new Date(Number(str));
    if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]|$)/.test(str)) return null;
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * X 軸ラベルの配列が「時刻軸」かどうかを判定する。
 *
 * **1つでも読めないものがあれば時刻軸ではない**とする（scale.js と同じ基準）。
 * ここを緩めて「半分読めれば時刻軸」にすると、`srv-01`〜`srv-09` の間に
 * 1つだけ日付らしい文字列が混ざったときに誤作動する。
 *
 * @returns {Date[]|null} 全て読めれば Date 配列、そうでなければ null
 */
export function axisTimes(labels) {
    const list = labels ?? [];
    if (list.length < 2) return null; // 1点では範囲が作れない
    const dates = list.map(parseAxisTime);
    return dates.some((d) => d === null) ? null : dates;
}

/**
 * Splunk の earliest/latest に渡せる**絶対時刻文字列**にする。
 *
 * ⚠ **epoch 秒（数値）を使わない。** Splunk は数値も受け付けるが、
 *   時間ピッカーに戻したときに「1754985600」と表示されて人が読めない。
 *   `%Y-%m-%dT%H:%M:%S` 形式ならピッカーの「絶対」タブがそのまま解釈でき、
 *   ブラシで選んだ範囲を人が後から手直しできる。
 *
 * ⚠ **UTC に変換しない。** Splunk のこの形式は**サーバのローカルタイム**として
 *   解釈される。`toISOString()` を使うと UTC になり、JST 環境では **9時間ずれる**。
 *   ローカルの年月日時分秒をそのまま組み立てる。
 */
export function toSplunkTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const p2 = (n) => String(n).padStart(2, '0');
    return (
        `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}` +
        `T${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`
    );
}

/**
 * ブラシで選んだ「X インデックスの範囲」を earliest/latest に変換する。
 *
 * バケットの意味づけ:
 *   `timechart` の各点は「そのバケットの**開始時刻**」を表す。したがって
 *   選択の右端バケットは **1バケットぶん後ろまで**が選択範囲になる。
 *   ここを `times[hi]` で切ると、**右端のバケットが選択から漏れる**
 *   （選んだ山のてっぺんが再サーチ後に消える、という形で表面化する）。
 *
 * @param times Date 配列（axisTimes の戻り値）
 * @param a, b  ドラッグの始点・終点のインデックス（順不同・範囲外は丸める）
 * @returns {{earliest:string, latest:string, from:Date, to:Date}|null}
 */
export function rangeFromIndices(times, a, b) {
    if (!Array.isArray(times) || times.length < 2) return null;
    const n = times.length;
    // ⚠ `Math.max(0, Math.min(n-1, NaN))` は **NaN のまま**（Math.min/max は
    //    NaN を伝播する）。丸めたつもりで NaN が素通りし、
    //    `times[NaN]` が undefined になって落ちる。数値でないものは
    //    **丸める前に**弾く（テストで検出。目視では出ない経路）。
    const clamp = (i) => {
        const v = Math.round(Number(i));
        if (!Number.isFinite(v)) return 0;
        return Math.max(0, Math.min(n - 1, v));
    };
    let lo = clamp(a);
    let hi = clamp(b);
    if (lo > hi) [lo, hi] = [hi, lo];

    const from = times[lo];
    // 右端は「次のバケットの開始」まで含める。最終バケットには次が無いので、
    // 直前の間隔を1つぶん足して補う（等間隔前提。timechart は等間隔）。
    let to;
    if (hi + 1 < n) {
        to = times[hi + 1];
    } else {
        const stepMs = times[n - 1] - times[n - 2];
        to = new Date(times[n - 1].getTime() + (stepMs > 0 ? stepMs : 0));
    }

    const earliest = toSplunkTime(from);
    const latest = toSplunkTime(to);
    if (!earliest || !latest) return null;
    return { earliest, latest, from, to };
}

/**
 * 選択範囲を「人が読める長さ」にする（ブラシ中のラベル表示用）。
 * 例: `12分` / `3.5時間` / `2.1日`
 */
export function formatSpan(fromDate, toDate) {
    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) return '';
    const ms = Math.abs(toDate - fromDate);
    if (ms < 1000) return '0秒';
    const sec = ms / 1000;
    if (sec < 90) return `${Math.round(sec)}秒`;
    const min = sec / 60;
    if (min < 90) return `${Math.round(min)}分`;
    const hour = min / 60;
    if (hour < 48) return `${hour < 10 ? hour.toFixed(1) : Math.round(hour)}時間`;
    const day = hour / 24;
    return `${day < 10 ? day.toFixed(1) : Math.round(day)}日`;
}

/**
 * 時間範囲入力（type=timerange）のうち、ブラシの書き込み先にするものを選ぶ。
 *
 * @param inputs      definition.inputs
 * @param preferToken パネルの `brushToken` 指定（あればそれを優先）
 * @returns {string|null} トークン名（`<token>.earliest` / `.latest` に書く）
 */
export function resolveBrushToken(inputs, preferToken) {
    const list = (inputs ?? []).filter((x) => x?.type === 'timerange' && x?.token);
    if (list.length === 0) return null;
    if (preferToken) {
        const hit = list.find((x) => String(x.token) === String(preferToken));
        if (hit) return hit.token;
        // ⚠ 指定されたトークンが**見つからないときに先頭へ勝手に落とさない**。
        //   別の時間入力を黙って書き換えることになり、原因が追えない事故になる。
        return null;
    }
    return list[0].token;
}
