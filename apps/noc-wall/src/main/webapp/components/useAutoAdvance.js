import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * セクションを一定時間ごとに送るフック（自動ページ送り）。
 *
 * 壁掛けモニタ用なので「最後まで行ったら先頭に戻る」ループが既定。
 * 手動操作（次へ／前へ）が入ったら、その回の残り時間はリセットする
 * （押した直後に勝手に送られると操作感が悪いため）。
 *
 * @param {number} count      セクション数
 * @param {number} intervalMs 1 セクションの表示時間
 * @param {boolean} paused    一時停止するか
 * @returns {{index:number, progress:number, next:Function, prev:Function, goTo:Function}}
 *          progress は 0→1。進捗バーの描画に使う。
 */
export function useAutoAdvance(count, intervalMs, paused) {
    const [index, setIndex] = useState(0);
    const [progress, setProgress] = useState(0);

    // 現在のセクションを表示し始めた時刻。手動操作でここを打ち直す。
    const startedAt = useRef(Date.now());

    const goTo = useCallback(
        (i) => {
            if (count <= 0) return;
            // 負数でも巻き戻るように二重剰余を使う
            setIndex(((i % count) + count) % count);
            startedAt.current = Date.now();
            setProgress(0);
        },
        [count]
    );

    const next = useCallback(() => goTo(index + 1), [goTo, index]);
    const prev = useCallback(() => goTo(index - 1), [goTo, index]);

    // セクション数が減ったとき、範囲外を指したままにしない
    useEffect(() => {
        if (count > 0 && index >= count) goTo(0);
    }, [count, index, goTo]);

    useEffect(() => {
        if (paused || count <= 1 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
            return undefined;
        }

        // 進捗バーを滑らかに動かすため、送りとは別に短い間隔で進捗だけ更新する。
        // setInterval だけで送ると、タブが非アクティブな間に間隔が詰まって
        // 一気に何枚も飛ぶことがある。経過時刻から計算する方式にして避ける。
        const tick = setInterval(() => {
            const elapsed = Date.now() - startedAt.current;
            const p = Math.min(1, elapsed / intervalMs);
            setProgress(p);
            if (p >= 1) {
                startedAt.current = Date.now();
                setProgress(0);
                setIndex((i) => (i + 1) % count);
            }
        }, 100);

        return () => clearInterval(tick);
    }, [paused, count, intervalMs]);

    // 一時停止を解除したら、そのセクションを頭から数え直す
    useEffect(() => {
        if (!paused) {
            startedAt.current = Date.now();
            setProgress(0);
        }
    }, [paused]);

    return { index, progress, next, prev, goTo };
}
