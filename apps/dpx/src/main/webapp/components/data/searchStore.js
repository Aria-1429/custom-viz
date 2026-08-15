// ── サーチの共有ストア（同じサーチを何本も投げない）──────────────
//
// **なぜ要るのか**（2026-08-15 実機計測で判明）:
//
// `dataSources`（共有データソース）は「同じサーチを複数パネルで共有し、
// 実行は1回で済ませる」建て付けだったが、**実行時には共有されていなかった**。
// `resolvePanelSearch` は SPL 文字列を組み立てるだけの純粋関数で、実行は
// パネルごとの `useSplunkSearch` が個別に行うため、同じデータソースを参照する
// パネルが N 枚あれば **同一 SPL のジョブが N 本**飛んでいた。
//
//   実測（dpx/test のタブ2・`ds1` を 4 パネルが参照）:
//     タブを開くたびに `POST search/jobs` が **4 本**（全部同じ SPL・同時刻 +48ms）
//
// さらに結果のキャッシュが無く、`useSplunkSearch` の state は
// コンポーネントローカルの `useState` だったため、**タブを切り替えて戻るたびに
// 全パネルがゼロから再実行**していた（タブ切替はパネルを丸ごと再マウントするため）。
//
// このモジュールは「SPL＋時間範囲＋名前空間」をキーに:
//   1. **実行中のジョブを合流させる**（後から来た購読者は既存の Promise に相乗り）
//   2. **完了した結果を保持する**（再マウント時は即座に返す＝タブ戻りが速い）
//   3. **自動更新（refresh）のタイマーを1本にまとめる**（購読者ごとに持たない）
//
// ⚠ **キャッシュは「同一ダッシュボードを開いている間」だけのもの**。
//   ページを離れれば消える。時間の経過で古くなるのを防ぐため TTL を持たせ、
//   TTL を過ぎたエントリは次の購読で再実行する。
//
// ⚠ **`refresh` は購読者間で最短のものを採用する**。同じサーチを
//   「60秒更新」と「更新なし」で参照している場合、60秒側の期待に合わせる。
// ────────────────────────────────────────────────────────────────

/**
 * 完了した結果を再利用してよい時間（ms）。
 *
 * ⚠ 長くすると「タブを戻したら古い数字が出る」。短くするとタブ切替のたびに
 *   再実行されて元の木阿弥。**タブ往復（数秒）を吸収しつつ、放置した画面には
 *   古い値を残さない**長さとして 30 秒にした。
 *   `refresh` を設定しているサーチは、そちらの間隔が優先される（下の scheduleRefresh）。
 */
export const RESULT_TTL_MS = 30_000;

/** キー付きエントリの入れ物。モジュールスコープ＝同一ページ内で共有される。 */
const entries = new Map();

/** 購読キーを作る。**中身が同じなら同じキー**になるようにする。 */
export function searchKey({ spl, earliest, latest, count, app }) {
    return JSON.stringify([String(spl ?? '').trim(), earliest, latest, count, app ?? '']);
}

function getEntry(key) {
    let e = entries.get(key);
    if (!e) {
        e = {
            key,
            subscribers: new Set(), // 通知先（{ notify, refresh }）
            state: { data: null, loading: true, error: null },
            doneAt: 0, // 最後に結果が確定した時刻
            running: false, // ジョブ実行中か
            generation: 0, // 世代（古い応答を捨てる）
            timer: null, // 自動更新タイマー
        };
        entries.set(key, e);
    }
    return e;
}

function emit(e) {
    for (const sub of e.subscribers) sub.notify(e.state);
}

/** 購読者のうち最短の refresh（秒）。0 なら自動更新しない。 */
function effectiveRefresh(e) {
    let best = 0;
    for (const sub of e.subscribers) {
        const r = Number(sub.refresh) || 0;
        if (r > 0 && (best === 0 || r < best)) best = r;
    }
    return best;
}

function scheduleRefresh(e, run) {
    if (e.timer) {
        clearTimeout(e.timer);
        e.timer = null;
    }
    const r = effectiveRefresh(e);
    // 購読者が居なくなったら回さない（画面外のサーチを回し続けない）
    if (r <= 0 || e.subscribers.size === 0) return;
    e.timer = setTimeout(() => {
        e.timer = null;
        if (e.subscribers.size === 0) return;
        run(e, true);
    }, Math.max(r, 5) * 1000);
}

/**
 * サーチを購読する。
 *
 * @param key    `searchKey()` の戻り
 * @param exec   実際にジョブを走らせる関数 `(isStale) => Promise<data>`
 * @param sub    `{ notify(state), refresh }`
 * @returns 解除関数
 */
export function subscribeSearch(key, exec, sub) {
    const e = getEntry(key);
    e.subscribers.add(sub);

    const run = (entry, isRefresh) => {
        if (entry.running) return; // 既に走っている＝合流するだけ
        entry.running = true;
        const myGen = ++entry.generation;
        const isStale = () => myGen !== entry.generation;
        // ⚠ 自動更新のときは前の結果を消さない（画面がちらつく）。
        //   初回だけ loading を出す
        if (!isRefresh || !entry.state.data) {
            entry.state = { ...entry.state, loading: true };
            emit(entry);
        }
        exec(isStale)
            .then((data) => {
                if (isStale()) return;
                entry.state = { data, loading: false, error: null };
                entry.doneAt = Date.now();
                emit(entry);
            })
            .catch((err) => {
                if (isStale()) return;
                entry.state = { data: null, loading: false, error: String(err?.message ?? err) };
                entry.doneAt = Date.now();
                emit(entry);
            })
            .finally(() => {
                if (isStale()) return;
                entry.running = false;
                scheduleRefresh(entry, run);
            });
    };

    // 既に結果があり、まだ新しいなら**即座に**返す（タブ戻りが速いのはここ）
    const fresh = e.doneAt > 0 && Date.now() - e.doneAt < RESULT_TTL_MS;
    if (e.running) {
        // 実行中のジョブに相乗り。今の state（loading）をそのまま渡す
        sub.notify(e.state);
    } else if (fresh) {
        sub.notify(e.state);
        // TTL 内でも refresh 指定があればタイマーは張り直す
        scheduleRefresh(e, run);
    } else {
        run(e, false);
    }

    return () => {
        e.subscribers.delete(sub);
        if (e.subscribers.size === 0) {
            if (e.timer) {
                clearTimeout(e.timer);
                e.timer = null;
            }
            // ⚠ **エントリ自体は消さない**（結果を残しておくのがタブ戻りの肝）。
            //   ただし実行中のものは世代を進めて応答を捨てる…ということはしない：
            //   購読者が居なくても結果は完成させ、次の購読で再利用する。
            //   TTL を過ぎたエントリは次回 run されるので溜まり続けない。
        } else {
            // 残った購読者の中で最短の refresh に合わせ直す
            scheduleRefresh(e, run);
        }
    };
}

/** テスト用：ストアを空にする。 */
export function __resetSearchStore() {
    for (const e of entries.values()) {
        if (e.timer) clearTimeout(e.timer);
    }
    entries.clear();
}

/** テスト・デバッグ用：現在のエントリ数。 */
export function __searchStoreSize() {
    return entries.size;
}
