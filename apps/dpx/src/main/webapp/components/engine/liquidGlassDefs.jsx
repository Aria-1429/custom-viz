import React from 'react';

// ── Liquid Glass のレンズフィルタ（SVG feDisplacementMap） ──────────
// パネル質感 `liquidGlass` の backdrop-filter が参照する。
//
// CSS の影・ブラーだけでは「すりガラスのカード」にしかならず、
// ガラスに見えるための本質＝**背景が縁で屈折して歪む**が出ない
// （2026-08-12 ユーザー指摘「これを見てガラスだと思う人はいない」）。
// → 変位マップで backdrop そのものを歪ませる。
//
// 仕組み:
//   - 変位マップ＝data URI の SVG 画像。R チャンネルが X 方向・G が Y 方向の
//     変位量（128 が「変位ゼロ」）。横に黒→赤・縦に黒→緑のグラデーションを
//     screen 合成すると、**中心が (128,128)＝不動、縁ほど大きく歪む**
//     一様レンズ場になる
//   - 中央に #808000（R=G=128 の中立色）の角丸をぼかして重ね、
//     **中央は歪まず縁だけ屈折する「厚いガラスの縁」**にする
//   - `feImage preserveAspectRatio='none'` でパネルの大きさに引き伸ばすので、
//     どんな縦横比のパネルでも縁に屈折が乗る
//
// ⚠ `backdrop-filter: url(#…)` は同一ドキュメント参照。DPX はパネルが
//    iframe に隔離されていない（全パネル同一 DOM）ので成立する。
//    Studio 拡張 viz（iframe 内）へはこの手はそのまま持ち出せない。
// ⚠ フィルタは**使われているパネルがあるときだけ raster コストが発生**する。
//    定義自体は width/height 0 の SVG で、置いておくだけなら無料。

// 変位マップ（256x256）。データ URI に埋めるので依存ファイルなし
const DISPLACEMENT_MAP = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'>` +
        `<defs>` +
        `<linearGradient id='rx' x1='0' y1='0' x2='1' y2='0'>` +
        `<stop offset='0' stop-color='#000000'/><stop offset='1' stop-color='#ff0000'/>` +
        `</linearGradient>` +
        `<linearGradient id='gy' x1='0' y1='0' x2='0' y2='1'>` +
        `<stop offset='0' stop-color='#000000'/><stop offset='1' stop-color='#00ff00'/>` +
        `</linearGradient>` +
        // ⚠ ぼかしは**弱く**（stdDeviation 22 → 10）。遷移が広いと中央部まで
        //   薄く変位が残り、背景のグラデーションが**パネル全面の霧状の滲み**になる
        //   （2026-08-12「まだ滲んでる」。屈折は縁の帯に閉じ込める）
        `<filter id='soft'><feGaussianBlur stdDeviation='10'/></filter>` +
        `</defs>` +
        `<rect width='256' height='256' fill='url(%23rx)'/>` +
        `<rect width='256' height='256' fill='url(%23gy)' style='mix-blend-mode:screen'/>` +
        // 中央の中立ゾーン（R=G=128）。屈折帯は各辺 52px（20%）に絞る
        `<rect x='52' y='52' width='152' height='152' rx='44' fill='%23808000' filter='url(%23soft)'/>` +
        `</svg>`
)}`;

/** panelSurface('liquidGlass') が参照するフィルタ ID。 */
export const LIQUID_LENS_FILTER_ID = 'dpx-liquid-lens';

/**
 * フィルタ定義。DpxDashboard のルートに常設する（画面に何も描かない）。
 * ⚠ 全画面パネルは createPortal で body 直下に出るが、**同一ドキュメント**なので
 *   フィルタ参照はそのまま生きる。
 */
export default function LiquidGlassDefs() {
    return (
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
            <defs>
                {/* 色収差つきレンズ：R/G/B を**別々の強さ**で変位させて加算合成する。
                    実ガラスは波長で屈折率が違う（分散）ので、縁で色がわずかにズレる。
                    この色ズレが「ガラスらしさ」の決め手（2026-08-12「もっとガラスに」で追加）。
                    ⚠ feColorMatrix でチャンネルを分離し、feComposite の
                       arithmetic(k2=1,k3=1)＝加算で戻す（screen だと中間調が浮く） */}
                <filter id={LIQUID_LENS_FILTER_ID} x="0%" y="0%" width="100%" height="100%">
                    <feImage href={DISPLACEMENT_MAP} preserveAspectRatio="none" result="map" />
                    {/* ⚠ チャンネル間の scale 差は控えめに（差 20 で端に派手な色帯が出た。
                        バックドロップ端のクランプ画素が R/G/B で別々にずれると
                        「実在しない色の帯」になる。実機スクショで確認して差 9 に短縮） */}
                    <feDisplacementMap in="SourceGraphic" in2="map" scale="114" xChannelSelector="R" yChannelSelector="G" result="dR" />
                    <feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR" />
                    <feDisplacementMap in="SourceGraphic" in2="map" scale="105" xChannelSelector="R" yChannelSelector="G" result="dG" />
                    <feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG" />
                    <feDisplacementMap in="SourceGraphic" in2="map" scale="96" xChannelSelector="R" yChannelSelector="G" result="dB" />
                    <feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB" />
                    <feComposite in="cR" in2="cG" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rg" />
                    <feComposite in="rg" in2="cB" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" />
                </filter>
            </defs>
        </svg>
    );
}
