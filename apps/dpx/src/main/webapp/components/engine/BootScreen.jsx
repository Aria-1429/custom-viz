import React, { useEffect } from 'react';

// ── 起動・遷移まわりの見せ方 ─────────────────────────────────────
// 「画面が一瞬まっ白になって眩しい」への対策一式。
//
// 白フラッシュの原因は2つあり、両方潰さないと消えない:
//   (1) JS が動く前にブラウザが塗る「地」が白い
//       → pages/dpx/bootPaint.js（バンドル評価の先頭で走る副作用モジュール）が
//         html/body を暗くしてスプラッシュ #dpx-boot を出す。
//         ⚠ HTML 表示〜JS 開始までの短い白は標準テンプレートの構造上塗れない
//           （Mako 全廃の代償。詳細は references/dpx-platform.md §1.1）
//   (2) 定義の取得中に何も描いていない
//       → この BootScreen を出す。bootPaint の #dpx-boot と見た目を揃えてあるので、
//         スプラッシュ → React の描画が継ぎ目なく繋がる。
//
// 注意: #dpx-boot を消すのは「中身が描ける状態になってから」。
//       早く消すと結局その隙間で地が見えてしまう。
// ────────────────────────────────────────────────────────────────

/** スプラッシュの最低表示時間（ms）。
 *  速い環境だと一瞬で消えて「かっこいいロード画面」が見えないので、
 *  準備が整っていてもこの時間までは見せてから退場させる（ユーザー指定 350ms）。 */
const MIN_SPLASH_MS = 350;

/** bootPaint が出している起動スプラッシュを（あれば）フェードアウトさせて取り除く。
 *  表示開始（bootPaint が記録した __DPX_BOOT_T0）から MIN_SPLASH_MS 経つまでは待つ。 */
export function dismissBootSplash() {
    const el = document.getElementById('dpx-boot');
    if (!el || el.dataset.dismissing) return;
    el.dataset.dismissing = '1'; // 二重呼び出しでタイマーが重ならないように
    const t0 = window.__DPX_BOOT_T0 ?? 0;
    const wait = Math.max(0, MIN_SPLASH_MS - (Date.now() - t0));
    setTimeout(() => {
        el.classList.add('dpx-boot-hide');
        setTimeout(() => el.remove(), 300);
    }, wait);
}

/**
 * 別ページへ遷移する。**遷移前に暗幕を敷いてから** location を変える。
 *
 * DPX 側の地を暗くしても、遷移先が塗る地までは制御できない
 * （Splunk 標準ページや、まだ CSS が来ていない一瞬）。
 * 出ていく側で覆っておくと、少なくとも「今見ている画面が白く弾ける」のは防げる。
 *
 * ⚠ 外部タブ（window.open）には使わない。今のページは残るため。
 */
export function navigateWithFade(url) {
    if (!document.getElementById('dpx-leave')) {
        const veil = document.createElement('div');
        veil.id = 'dpx-leave';
        veil.setAttribute(
            'style',
            'position:fixed;inset:0;z-index:99999;background:#0a1020;opacity:0;' +
                'transition:opacity .16s ease;pointer-events:none;'
        );
        document.body.appendChild(veil);
        // 1フレーム置いてから不透明にしないと transition が走らない
        requestAnimationFrame(() => {
            veil.style.opacity = '1';
        });
    }
    // 暗幕が乗り切ってから遷移する（待ちすぎると操作が重く感じるので短く）
    setTimeout(() => {
        window.location.href = url;
    }, 170);
}

/** 定義の読み込み中／エラー時に出す全面スクリーン。Mako のスプラッシュと同じ意匠。 */
export default function DpxBootScreen({ error = null }) {
    // エラー時はスプラッシュを消してこちらを見せる（黙って固まらせない）
    useEffect(() => {
        if (error) dismissBootSplash();
    }, [error]);

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#0a1020',
                color: '#e8eefc',
            }}
        >
            <div style={{ textAlign: 'center', maxWidth: 560, padding: 24 }}>
                <div
                    style={{
                        // ⚠ Mako 側のスプラッシュと**同じフォント指定**にすること。
                        //    片方だけ Webフォントにすると、入れ替わりで字形が変わって見える
                        font: '600 22px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
                        letterSpacing: '0.34em',
                        color: error ? '#ff6b6b' : '#4ea1ff',
                        marginBottom: 18,
                        minWidth: 190,
                    }}
                >
                    DPX
                </div>
                {error ? (
                    <div style={{ fontSize: 13, lineHeight: 1.7, color: '#ffb4b4' }}>{error}</div>
                ) : (
                    <div
                        style={{
                            width: 190,
                            height: 2,
                            margin: '0 auto',
                            borderRadius: 2,
                            background: 'rgba(120,160,220,0.18)',
                            overflow: 'hidden',
                        }}
                    >
                        <div
                            style={{
                                width: '40%',
                                height: '100%',
                                borderRadius: 2,
                                background: 'linear-gradient(90deg, transparent, #4ea1ff, transparent)',
                                animation: 'dpxBootSlide 1.05s ease-in-out infinite',
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
