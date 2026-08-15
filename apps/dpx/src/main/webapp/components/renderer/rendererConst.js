// ── Renderer の共有定数（寸法・アニメ表）─────────────────────────
//
// `DashboardRenderer.jsx` と `Panel.jsx` の**両方が使う**値をここに集める。
//
// ⚠ **数値を両方のファイルに書かない。** 片方だけ直すと罫や余白がずれる
//   （実際 `GROUP_HEADER_H` が 2 か所に書かれていて、危うく同じ事故になりかけた）。
// ────────────────────────────────────────────────────────────────

/** パネルのタイトル行の高さ(px)。 */
export const TITLE_H = 36;

/**
 * 手描きの枠が中身に食い込まないよう、パネルの内側に確保する余白（px）。
 *
 * ⚠ `HandDrawnFrame` が線を引く位置とこの値は**対で決まる**。
 *   片方だけ変えると線が中身に重なるか、逆に枠と中身が離れすぎる。
 */
export const HAND_DRAWN_INSET = 10;

/** 全画面表示のときに画面端に残す余白（px）。 */
export const FULL_INSET = 12;

/**
 * 登場アニメ。値 → CSS animation 一括指定。
 *
 * ⚠ 尺を変えたいものがあるので**指定ごと持たせる**（drop の跳ね返りは
 *   0.5s だと潰れて見えない）。既定は 0.5s ease。
 */
export const ENTRANCE_ANIM = {
    rise: 'dpxRiseIn 0.5s ease both',
    fade: 'dpxFadeIn 0.5s ease both',
    zoom: 'dpxZoomIn 0.5s ease both',
    slide: 'dpxSlideIn 0.5s ease both',
    slideRight: 'dpxSlideInRight 0.5s ease both',
    flip: 'dpxFlipIn 0.5s ease both',
    swing: 'dpxSwingIn 0.55s ease both',
    unfold: 'dpxUnfold 0.5s ease both',
    unfoldX: 'dpxUnfoldX 0.5s ease both',
    // 跳ね返りは尺が要る。cubic-bezier で軽い overshoot を作る
    drop: 'dpxDropIn 0.62s cubic-bezier(0.22, 1.2, 0.36, 1) both',
    pop: 'dpxPopIn 0.42s cubic-bezier(0.2, 0.9, 0.3, 1) both',
    tilt: 'dpxTiltIn 0.5s ease both',
};

/**
 * 常時アニメ（パネル単位）。控えめな動きだけを用意する。
 *
 * ⚠ 動きは transform / opacity に限る。box-shadow や filter を animate すると
 *   毎フレーム再描画になり、パネル数に比例して重くなる（viz-performance.md §2）。
 */
export const AMBIENT_ANIM = {
    float: 'dpxFloat 4.5s ease-in-out infinite',
    breathe: 'dpxBreathe 3.6s ease-in-out infinite',
};
