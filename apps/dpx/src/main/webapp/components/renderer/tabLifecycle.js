// ── タブの生存管理（どのタブを DOM に残すか）──────────────────────
//
// **「表示中のタブ」と「生かしておくタブ」は別の概念**、というのがこの層の主張。
//
// ## なぜ独立した概念にするのか（2026-08-15）
//
// タブ切替が重かった原因は、**タブ外のパネルを配列から落としていた**こと
// （＝React が丸ごとアンマウントし、戻るたびにサーチ・手描き枠・出現アニメを
// 全部やり直していた。実機計測で安定まで 963ms）。
//
// 直すには「一度開いたタブは隠して残す」必要があるが、これを Renderer の中の
// `useState` で持つと**保存されない状態が描画コンポーネントに散る**。
// DPX は「State / Command 層」を独立させた基盤なので、そこへ逆行してしまう。
//
// → **生存判定を純粋関数として切り出す**。React も DOM も知らないので
//   素の Node でテストでき、方針（下記）を機械的に固定できる。
//
// ## 方針（why つき）
//
// 1. **最初から全タブを描かない。** 初回表示で全タブぶんのサーチが走ると、
//    「開いてもいない画面のために初回が重くなる」＝本末転倒。
//    → 開いたタブだけを覚える（**2 回目以降が速い**）。
// 2. **一度開いたタブは捨てない。** 捨てると往復のたびに作り直しになる。
// 3. **上限を設ける。** タブが 30 枚あるボードで全部生かすと、
//    最終的に全タブぶんのサーチとノードが載る。**最近使った順**で打ち切る
//    （LRU）。上限に達したら**一番長く触っていないタブ**を落とす。
// 4. **表示中のタブは絶対に落とさない。** これを守らないと画面が消える。
//
// ⚠ **順序に意味がある。** `alive` の先頭を「最近使った」とし、
//   末尾から捨てる。単なる Set にすると LRU が表現できない。
// ────────────────────────────────────────────────────────────────

/**
 * 同時に生かしておくタブ数の上限。
 *
 * ⚠ 大きくすると「戻ったとき速い」が増える代わりに、DOM とサーチが積み上がる。
 *   小さくすると往復のたびに作り直しになる。
 *   実運用のボードはタブ 2〜5 枚が大半なので、**8 枚あれば実質「全部生きる」**。
 *   壁掛けの自動送り（rotate）も一巡ぶんはこの範囲に収まる。
 */
export const MAX_ALIVE_TABS = 8;

/**
 * タブを開いたときの生存リストを求める（純粋関数）。
 *
 * @param {string[]} alive   これまで生かしているタブ ID（先頭 = 最近使った順）
 * @param {string|null} current 今表示するタブ ID
 * @param {number} max       同時生存数の上限
 * @returns {string[]} 新しい生存リスト（先頭 = 最近使った順）
 */
export function touchTab(alive, current, max = MAX_ALIVE_TABS) {
    const list = Array.isArray(alive) ? alive.filter((x) => typeof x === 'string' && x) : [];
    if (!current) return list.slice(0, Math.max(1, max));
    // 既に居るなら先頭へ引き上げる（LRU の更新）
    const without = list.filter((x) => x !== current);
    const next = [current, ...without];
    // ⚠ 上限は「最低 1」。0 や負を渡されても表示中のタブは必ず残す
    return next.slice(0, Math.max(1, max));
}

/**
 * 定義から消えたタブを生存リストから外す（純粋関数）。
 *
 * ⚠ これが無いと、**タブを削除しても隠れた DOM が残り続ける**
 *   （サーチも回り続ける）。編集でタブを消したときに効く。
 *
 * @param {string[]} alive     生存リスト
 * @param {string[]} existing  定義に実在するタブ ID
 */
export function pruneTabs(alive, existing) {
    const ok = new Set(Array.isArray(existing) ? existing : []);
    return (Array.isArray(alive) ? alive : []).filter((x) => ok.has(x));
}

/**
 * 実際に描くタブを決める（純粋関数）。
 *
 * ⚠ **表示中のタブは生存リストに無くても必ず含める。**
 *   state の更新を待つ 1 フレームで画面が空になるのを防ぐ
 *   （React の setState は非同期なので、初回描画では alive がまだ空でありうる）。
 *
 * @param {Array<{id:string}>} tabs 定義上のタブ（順序どおり）
 * @param {string[]} alive          生存リスト
 * @param {string|null} current     表示中のタブ ID
 * @returns {Array<{id:string}>} 描画するタブ（**定義の順序を保つ**）
 */
export function tabsToRender(tabs, alive, current) {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    const live = new Set(Array.isArray(alive) ? alive : []);
    if (current) live.add(current);
    // ⚠ `alive` の順（LRU 順）ではなく**定義の順**で返す。
    //   DOM の並び順が切替のたびに変わると、隠れていても
    //   グリッドの自動配置やタブ順に影響しうる
    return tabs.filter((t) => live.has(t.id));
}
