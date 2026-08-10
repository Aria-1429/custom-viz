import styled from 'styled-components';
import { variables, mixins } from '@splunk/themes';

export const StyledContainer = styled.div`
    ${mixins.reset('block')};
    padding: ${variables.spacingXLarge};
    background-color: ${variables.backgroundColorPage};
    color: ${variables.contentColorDefault};
    min-height: 100vh;
    box-sizing: border-box;
`;

export const StyledHeader = styled.div`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: ${variables.spacingSmall};
    margin-bottom: ${variables.spacingLarge};
`;

export const StyledSubtle = styled.div`
    color: ${variables.contentColorMuted};
    font-size: ${variables.fontSizeSmall};
`;

/** KPI カードを横に並べる領域。幅に応じて自動で折り返す。 */
export const StyledCardRow = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: ${variables.spacingMedium};
    margin-bottom: ${variables.spacingLarge};
`;

export const StyledCard = styled.div`
    background-color: ${variables.backgroundColorSection};
    border: 1px solid ${variables.borderColor};
    border-radius: ${variables.borderRadius};
    padding: ${variables.spacingMedium};
`;

export const StyledCardLabel = styled.div`
    color: ${variables.contentColorMuted};
    font-size: ${variables.fontSizeSmall};
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: ${variables.spacingXSmall};
`;

export const StyledCardValue = styled.div`
    font-size: 28px;
    font-weight: 700;
    line-height: 1.2;
    color: ${(props) => props.$color || variables.contentColorDefault};
    font-variant-numeric: tabular-nums;
`;

/** SPL 入力欄。等幅にして編集しやすくする。 */
export const StyledSearchBar = styled.div`
    display: flex;
    gap: ${variables.spacingSmall};
    align-items: flex-start;
    margin-bottom: ${variables.spacingMedium};
    width: 100%;

    /* TextArea は内側にラッパ div を持つ。ラッパごと伸ばさないと
       幅が既定値で止まるので、子孫まで含めて 100% にする */
    & > *:first-child {
        flex: 1 1 auto;
        min-width: 0;
        width: 100%;
    }

    & > *:first-child > div,
    & > *:first-child > div > div {
        width: 100%;
    }

    textarea {
        font-family: ${variables.fontFamilyMono};
        font-size: 13px;
        white-space: pre;
        overflow-x: auto;
    }
`;

export const StyledBarRow = styled.div`
    display: flex;
    align-items: center;
    gap: ${variables.spacingSmall};
    margin-bottom: ${variables.spacingXSmall};
`;

export const StyledBarLabel = styled.div`
    width: 190px;
    flex: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${variables.fontSizeSmall};
`;

export const StyledBarTrack = styled.div`
    flex: 1 1 auto;
    background-color: ${variables.backgroundColorSection};
    border-radius: ${variables.borderRadius};
    overflow: hidden;
    height: 18px;
`;

export const StyledBarFill = styled.div`
    height: 100%;
    width: ${(props) => props.$pct}%;
    background-color: ${(props) => props.$color};
    transition: width 240ms ease-out;
`;

export const StyledBarValue = styled.div`
    width: 90px;
    flex: none;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: ${variables.fontSizeSmall};
`;
