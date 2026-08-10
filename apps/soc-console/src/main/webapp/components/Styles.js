import styled, { createGlobalStyle, keyframes } from 'styled-components';
import { C, MONO } from './theme';

export const GlobalStyle = createGlobalStyle`
    body {
        margin: 0;
        background: ${C.bg};
        overflow: hidden;
    }
    /*
     * Splunk のヘッダを隠して全画面を使う。
     * ⚠ クラス名は styled-components の自動生成でビルドごとに変わるため狙えない。
     *   実体は body 直下の素の <header>（NOC Wall で probe して確認済み）。
     */
    body > header,
    body > #navSkip,
    body > [data-test="header-skip-nav"] {
        display: none !important;
    }
`;

const pulse = keyframes`
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.35; }
`;

export const Screen = styled.div`
    position: fixed;
    inset: 0;
    background: ${C.bg};
    color: ${C.text};
    font-family: ${MONO};
    display: flex;
    flex-direction: column;
    overflow: hidden;

    &::before {
        content: '';
        position: absolute;
        inset: 0;
        background-image:
            linear-gradient(${C.grid} 1px, transparent 1px),
            linear-gradient(90deg, ${C.grid} 1px, transparent 1px);
        background-size: 44px 44px;
        mask-image: radial-gradient(ellipse 90% 80% at 50% 40%, #000 40%, transparent 100%);
        pointer-events: none;
    }
`;

export const TopBar = styled.header`
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 11px 22px;
    border-bottom: 1px solid ${C.border};
    background: linear-gradient(180deg, rgba(20, 32, 60, 0.7), transparent);
    flex: none;
`;

export const Brand = styled.div`
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-shadow: 0 0 16px rgba(90, 170, 255, 0.5);
    white-space: nowrap;
`;

export const StatusDot = styled.span`
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-right: 8px;
    background: ${(p) => p.$color};
    box-shadow: 0 0 10px ${(p) => p.$color};
    animation: ${pulse} 2.4s ease-in-out infinite;
`;

export const Clock = styled.div`
    margin-left: auto;
    font-size: 19px;
    font-weight: 700;
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 0 14px rgba(90, 170, 255, 0.45);
`;

/** 本体。KPI 行 → メイン 3 カラム の縦積み。 */
export const Body = styled.div`
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-height: 0;
    padding: 14px 22px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
`;

export const KpiRow = styled.div`
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 12px;
    flex: none;
`;

export const Panel = styled.div`
    position: relative;
    background: ${C.bgPanel};
    border: 1px solid ${C.border};
    border-radius: 4px;
    padding: ${(p) => p.$pad || '12px 14px'};
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;

    &::before {
        content: '';
        position: absolute;
        top: -1px;
        left: -1px;
        width: 14px;
        height: 14px;
        border-top: 2px solid ${C.borderBright};
        border-left: 2px solid ${C.borderBright};
    }
`;

export const PanelLabel = styled.div`
    font-size: 10px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: ${C.textFaint};
    margin-bottom: 8px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
`;

export const KpiValue = styled.div`
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: ${(p) => p.$color || C.text};
    text-shadow: 0 0 20px ${(p) => p.$color || C.info}55;
`;

export const KpiSub = styled.div`
    font-size: 11px;
    color: ${C.textDim};
    margin-top: 6px;
`;

/** メイン領域：左=一覧 / 右=詳細。 */
export const MainRow = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
    gap: 12px;
`;

export const LeftCol = styled.div`
    display: grid;
    grid-template-rows: minmax(0, 1fr) minmax(0, 240px);
    gap: 12px;
    min-height: 0;
    min-width: 0;
`;

export const RightCol = styled.div`
    display: grid;
    grid-template-rows: minmax(0, auto) minmax(0, 1fr);
    gap: 12px;
    min-height: 0;
    min-width: 0;
`;

export const BottomRow = styled.div`
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 12px;
    min-height: 0;
`;

/* ---------------------------------------------------------------- 一覧 */

export const TableScroll = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;

    /* スクロールバーも画面に馴染ませる */
    scrollbar-width: thin;
    scrollbar-color: ${C.border} transparent;
    &::-webkit-scrollbar { width: 8px; }
    &::-webkit-scrollbar-thumb {
        background: ${C.border};
        border-radius: 4px;
    }
`;

export const HeadRow = styled.div`
    display: grid;
    grid-template-columns: ${(p) => p.$cols};
    gap: 10px;
    padding: 0 10px 7px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: ${C.textFaint};
    border-bottom: 1px solid ${C.border};
    flex: none;
`;

export const Row = styled.div`
    display: grid;
    grid-template-columns: ${(p) => p.$cols};
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    font-size: 12.5px;
    cursor: pointer;
    border-left: 3px solid ${(p) => p.$accent};
    background: ${(p) => (p.$selected ? C.bgRowHover : 'transparent')};
    transition: background 140ms ease;

    &:hover {
        background: ${(p) => (p.$selected ? C.bgRowHover : C.bgRow)};
    }
`;

export const Cell = styled.div`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${(p) => p.$color || C.text};
    font-variant-numeric: tabular-nums;
    text-align: ${(p) => p.$align || 'left'};
`;

/** severity/status のバッジ。 */
export const Badge = styled.span`
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: ${(p) => p.$color};
    background: ${(p) => p.$color}1F;
    border: 1px solid ${(p) => p.$color}55;
    white-space: nowrap;
`;

/** スコアの棒（数値の横に細く出す）。 */
export const ScoreBar = styled.div`
    height: 4px;
    border-radius: 2px;
    background: rgba(80, 120, 200, 0.16);
    overflow: hidden;
    margin-top: 3px;

    &::after {
        content: '';
        display: block;
        height: 100%;
        width: ${(p) => p.$pct}%;
        background: ${(p) => p.$color};
        box-shadow: 0 0 8px ${(p) => p.$color};
    }
`;

/* ---------------------------------------------------------------- 詳細 */

export const DetailGrid = styled.div`
    display: grid;
    grid-template-columns: 92px 1fr;
    gap: 7px 12px;
    font-size: 12.5px;
    align-items: baseline;
`;

export const DKey = styled.div`
    color: ${C.textFaint};
    font-size: 10.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
`;

export const DVal = styled.div`
    color: ${(p) => p.$color || C.text};
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-all;
`;

/** タイムライン。左に軸線、各行にノード。 */
export const Timeline = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    position: relative;
    padding-left: 4px;
    scrollbar-width: thin;
    scrollbar-color: ${C.border} transparent;
    &::-webkit-scrollbar { width: 8px; }
    &::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 4px; }
`;

export const TlItem = styled.div`
    position: relative;
    padding: 0 0 14px 22px;
    border-left: 1px solid ${C.border};

    &:last-child {
        border-left-color: transparent;
        padding-bottom: 0;
    }

    &::before {
        content: '';
        position: absolute;
        left: -5px;
        top: 3px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: ${(p) => p.$color};
        box-shadow: 0 0 9px ${(p) => p.$color};
    }
`;

export const TlTime = styled.div`
    font-size: 10.5px;
    color: ${C.textFaint};
    letter-spacing: 0.06em;
`;

export const TlText = styled.div`
    font-size: 12.5px;
    color: ${C.textDim};
    margin-top: 2px;
    line-height: 1.45;
`;

/* -------------------------------------------------------------- 補助図 */

export const BarRow = styled.div`
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
`;

export const BarLabel = styled.div`
    width: ${(p) => p.$w || '132px'};
    flex: none;
    font-size: 11.5px;
    color: ${C.textDim};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

export const BarTrack = styled.div`
    flex: 1 1 auto;
    height: 12px;
    background: rgba(80, 120, 200, 0.1);
    border-radius: 2px;
    overflow: hidden;
`;

export const BarFill = styled.div`
    height: 100%;
    width: ${(p) => p.$pct}%;
    background: linear-gradient(90deg, ${(p) => p.$color}55, ${(p) => p.$color});
    box-shadow: 0 0 10px ${(p) => p.$color}77;
    transition: width 600ms cubic-bezier(0.22, 1, 0.36, 1);
`;

export const BarValue = styled.div`
    width: 46px;
    flex: none;
    text-align: right;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: ${C.text};
`;

export const Center = styled.div`
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: ${C.textDim};
    font-size: 12px;
    letter-spacing: 0.18em;
    text-align: center;
    padding: 20px;
`;

/** フィルタのトグル群。 */
export const FilterBar = styled.div`
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-left: auto;
`;

export const Chip = styled.button`
    background: ${(p) => (p.$on ? `${p.$color}26` : 'transparent')};
    border: 1px solid ${(p) => (p.$on ? `${p.$color}88` : C.border)};
    color: ${(p) => (p.$on ? p.$color : C.textFaint)};
    font-family: ${MONO};
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 3px;
    cursor: pointer;
    transition: all 150ms ease;

    &:hover {
        border-color: ${(p) => p.$color}aa;
        color: ${(p) => p.$color};
    }
`;
