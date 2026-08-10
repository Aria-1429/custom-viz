import styled, { createGlobalStyle, keyframes, css } from 'styled-components';
import { C, MONO } from './theme';

// Splunk のページ枠（ヘッダ・アプリバー）を隠して全画面を占有する。
// 壁掛け表示ではクロムが邪魔になるため。
export const GlobalWallStyle = createGlobalStyle`
    body {
        margin: 0;
        background: ${C.bg};
        overflow: hidden;
    }
    /*
     * Splunk のヘッダを隠す。
     *
     * ⚠ 10.4 実機では styled-components が生成したクラス名（.sc-gsFSXq 等）しか付いておらず、
     *   ビルドごとに変わるため**クラス名では狙えない**（DOM を probe して確認）。
     *   実体は body 直下の素の <header> なので、構造で指定する。
     */
    body > header,
    body > #navSkip,
    body > [data-test="header-skip-nav"] {
        display: none !important;
    }
`;

const scan = keyframes`
    0%   { transform: translateY(-100%); }
    100% { transform: translateY(2000%); }
`;

const pulse = keyframes`
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.35; }
`;

const sweep = keyframes`
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
`;

/** 画面全体。背景のグリッドと走査線はここで作る。 */
export const Screen = styled.div`
    position: fixed;
    inset: 0;
    background: ${C.bg};
    color: ${C.text};
    font-family: ${MONO};
    overflow: hidden;
    display: flex;
    flex-direction: column;

    /* 方眼グリッド。奥行きを出すために中央から周辺へ暗くする */
    &::before {
        content: '';
        position: absolute;
        inset: 0;
        background-image:
            linear-gradient(${C.grid} 1px, transparent 1px),
            linear-gradient(90deg, ${C.grid} 1px, transparent 1px);
        background-size: 44px 44px;
        mask-image: radial-gradient(ellipse 80% 70% at 50% 45%, #000 40%, transparent 100%);
        pointer-events: none;
    }

    /* ゆっくり降りる走査線。1本だけなので負荷は小さい */
    &::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        height: 12px;
        background: linear-gradient(180deg, transparent, rgba(90, 200, 255, 0.07), transparent);
        animation: ${scan} 14s linear infinite;
        pointer-events: none;
    }
`;

export const TopBar = styled.header`
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 14px 28px;
    border-bottom: 1px solid ${C.border};
    background: linear-gradient(180deg, rgba(20, 32, 60, 0.7), transparent);
    flex: none;
`;

export const Brand = styled.div`
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 0.22em;
    color: ${C.text};
    text-shadow: 0 0 18px rgba(90, 170, 255, 0.55);
    white-space: nowrap;
`;

export const StatusDot = styled.span`
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 10px;
    background: ${(p) => p.$color};
    box-shadow: 0 0 12px ${(p) => p.$color};
    animation: ${pulse} 2.4s ease-in-out infinite;
`;

export const Clock = styled.div`
    margin-left: auto;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.08em;
    font-variant-numeric: tabular-nums;
    color: ${C.text};
    text-shadow: 0 0 16px rgba(90, 170, 255, 0.5);
`;

export const Stage = styled.main`
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-height: 0;
    padding: 22px 28px;
    display: flex;
    flex-direction: column;
`;

/**
 * セクションの切り替え。表示中以外は隠すが DOM には残す（再マウントを避ける）。
 *
 * ⚠ 非表示側も同じ矩形を占有するので、`visibility` と `z-index` を必ず併用する。
 * opacity だけだと透明な要素が上に乗ったままになり、
 * 下のセクションが透けて二重に見える（実機で発生）。
 */
export const SectionWrap = styled.div`
    position: absolute;
    inset: 22px 28px;
    display: flex;
    flex-direction: column;
    opacity: ${(p) => (p.$active ? 1 : 0)};
    visibility: ${(p) => (p.$active ? 'visible' : 'hidden')};
    z-index: ${(p) => (p.$active ? 1 : 0)};
    transform: translateY(${(p) => (p.$active ? '0' : '18px')});
    transition: opacity 520ms ease, transform 520ms ease, visibility 0s linear ${(p) =>
        p.$active ? '0s' : '520ms'};
    pointer-events: ${(p) => (p.$active ? 'auto' : 'none')};
`;

export const SectionTitle = styled.h2`
    margin: 0 0 16px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: ${C.textDim};
    display: flex;
    align-items: center;
    gap: 14px;
    flex: none;

    /* 見出しの右に伸びる罫線。NOC 画面の定番 */
    &::after {
        content: '';
        flex: 1;
        height: 1px;
        background: linear-gradient(90deg, ${C.border}, transparent);
    }
`;

/** パネル。半透明＋薄い発光で「浮いている」ように見せる。 */
export const Panel = styled.div`
    position: relative;
    background: ${C.bgPanel};
    border: 1px solid ${C.border};
    border-radius: 4px;
    padding: ${(p) => p.$pad || '18px'};
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;

    /* 四隅のブラケット（上左だけ強調して方向感を出す） */
    &::before {
        content: '';
        position: absolute;
        top: -1px;
        left: -1px;
        width: 18px;
        height: 18px;
        border-top: 2px solid ${C.borderBright};
        border-left: 2px solid ${C.borderBright};
    }
`;

export const PanelLabel = styled.div`
    font-size: 11px;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: ${C.textFaint};
    margin-bottom: 10px;
    flex: none;
`;

/** KPI の巨大数字。発光させて壁掛けでも視認できるようにする。 */
export const BigNumber = styled.div`
    font-size: ${(p) => p.$size || '54px'};
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: ${(p) => p.$color || C.text};
    text-shadow: 0 0 26px ${(p) => p.$color || C.info}66;
    white-space: nowrap;
`;

export const Delta = styled.div`
    font-size: 13px;
    margin-top: 8px;
    color: ${(p) => p.$color};
    letter-spacing: 0.06em;
`;

export const Grid = styled.div`
    display: grid;
    grid-template-columns: ${(p) => p.$cols || 'repeat(4, 1fr)'};
    grid-template-rows: ${(p) => p.$rows || 'none'};
    gap: ${(p) => p.$gap || '16px'};
    flex: ${(p) => (p.$fill ? '1 1 auto' : 'none')};
    min-height: 0;
`;

/** 下部の進捗インジケータ。今どのセクションかを常に示す。 */
export const BottomBar = styled.footer`
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 12px 28px;
    border-top: 1px solid ${C.border};
    background: linear-gradient(0deg, rgba(20, 32, 60, 0.7), transparent);
    flex: none;
`;

export const Pips = styled.div`
    display: flex;
    gap: 10px;
    align-items: center;
`;

export const Pip = styled.button`
    position: relative;
    width: ${(p) => (p.$active ? '54px' : '10px')};
    height: 10px;
    border-radius: 5px;
    border: none;
    padding: 0;
    cursor: pointer;
    background: ${(p) => (p.$active ? 'rgba(90, 170, 255, 0.25)' : C.textFaint)};
    transition: width 420ms ease, background 420ms ease;
    overflow: hidden;

    /* 進行中のセクションだけ、中を進捗で満たす */
    &::after {
        content: '';
        position: absolute;
        inset: 0;
        width: ${(p) => (p.$active ? `${p.$progress * 100}%` : '0')};
        background: ${C.info};
        box-shadow: 0 0 10px ${C.info};
        transition: width 140ms linear;
    }
`;

export const Controls = styled.div`
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
`;

export const CtrlButton = styled.button`
    background: rgba(60, 100, 180, 0.16);
    border: 1px solid ${C.border};
    color: ${C.textDim};
    font-family: ${MONO};
    font-size: 12px;
    letter-spacing: 0.1em;
    padding: 6px 14px;
    border-radius: 3px;
    cursor: pointer;
    transition: all 180ms ease;

    &:hover {
        color: ${C.text};
        border-color: ${C.borderBright};
        background: rgba(80, 140, 240, 0.28);
    }
`;

/** 横棒。値に応じて伸び、色は severity に従う。 */
export const BarRow = styled.div`
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 9px;
`;

export const BarLabel = styled.div`
    width: ${(p) => p.$w || '150px'};
    flex: none;
    font-size: 13px;
    color: ${C.textDim};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

export const BarTrack = styled.div`
    flex: 1 1 auto;
    height: 14px;
    background: rgba(80, 120, 200, 0.1);
    border-radius: 2px;
    overflow: hidden;
    position: relative;
`;

export const BarFill = styled.div`
    height: 100%;
    width: ${(p) => p.$pct}%;
    background: linear-gradient(90deg, ${(p) => p.$color}44, ${(p) => p.$color});
    box-shadow: 0 0 14px ${(p) => p.$color}88;
    transition: width 700ms cubic-bezier(0.22, 1, 0.36, 1);
    position: relative;

    /* 光が走る演出。伸びたバーが「生きている」ように見える */
    &::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        width: 40%;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
        animation: ${sweep} 3.2s ease-in-out infinite;
        animation-delay: ${(p) => p.$delay || '0s'};
    }
`;

export const BarValue = styled.div`
    width: 84px;
    flex: none;
    text-align: right;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: ${C.text};
`;

/** ログストリーム行。新しい行が上から流れ込む。 */
const slideIn = keyframes`
    from { opacity: 0; transform: translateX(-14px); }
    to   { opacity: 1; transform: translateX(0); }
`;

export const LogLine = styled.div`
    display: flex;
    gap: 14px;
    align-items: baseline;
    font-size: 12.5px;
    padding: 5px 8px;
    border-left: 2px solid ${(p) => p.$color};
    background: linear-gradient(90deg, ${(p) => p.$color}14, transparent 60%);
    margin-bottom: 4px;
    animation: ${slideIn} 420ms ease both;
    white-space: nowrap;
    overflow: hidden;
`;

export const LogTime = styled.span`
    color: ${C.textFaint};
    flex: none;
`;

export const LogSev = styled.span`
    color: ${(p) => p.$color};
    font-weight: 700;
    flex: none;
    width: 68px;
    text-transform: uppercase;
    font-size: 11px;
`;

export const LogMsg = styled.span`
    color: ${C.textDim};
    overflow: hidden;
    text-overflow: ellipsis;
`;

export const Center = styled.div`
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${C.textDim};
    font-size: 14px;
    letter-spacing: 0.2em;
    ${(p) =>
        p.$blink &&
        css`
            animation: ${pulse} 1.6s ease-in-out infinite;
        `}
`;
