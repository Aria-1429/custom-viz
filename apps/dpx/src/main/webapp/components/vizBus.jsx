import React, { createContext, useContext, useMemo, useState } from 'react';

// ── viz 間連携バス（ホバー同期） ─────────────────────────────────
// 全パネルが同一 React ツリーにいるからこそ成立する仕組み。
// Studio ではパネルごとに iframe が分かれるため、これと同じことは
// postMessage ハックでしか実現できない（studio-hacks.md 参照）。
//
// 使い方（viz 側）:
//   const { hoverKey, setHoverKey } = useVizHover();
//   onMouseEnter={() => setHoverKey(`svc:${name}`)}
//   onMouseLeave={() => setHoverKey(null)}
//   const highlighted = hoverKey === `svc:${name}`;
// ────────────────────────────────────────────────────────────────

const HoverContext = createContext({ hoverKey: null, setHoverKey: () => {} });

export function VizBusProvider({ children }) {
    const [hoverKey, setHoverKey] = useState(null);
    const value = useMemo(() => ({ hoverKey, setHoverKey }), [hoverKey]);
    return <HoverContext.Provider value={value}>{children}</HoverContext.Provider>;
}

export function useVizHover() {
    return useContext(HoverContext);
}
