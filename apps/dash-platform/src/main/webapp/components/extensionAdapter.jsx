import React, { createContext, useContext } from 'react';

import { useDpxTokens } from './engine/tokens';

// ── Studio 拡張互換アダプタ ──────────────────────────────────────
// 既存のカスタム viz（Studio 拡張。@splunk/dashboard-studio-extension/react の
// フックで書かれている）を、iframe なしで preset に登録するための互換層。
//
// webpack alias で
//   '@splunk/dashboard-studio-extension/react'         → このファイル
//   '@splunk/dashboard-studio-extension/visualization' → このファイル
// に差し替えることで、viz のソースを無改変（エントリの export 化のみ）で流用する。
//
// フックの戻り値の形は world-map 等の実消費コードに合わせてある:
//   useDataSources() → { dataSources: {primary:{data:{fields,columns}}}, loading }
//   useOptions()     → { options, setOptions }
//   useTheme()       → { theme: 'light'|'dark' }
//   useMode()        → { mode: 'view'|'edit' }
// ────────────────────────────────────────────────────────────────

// viz 1 枚分のホスト props（framework の VizProps）を配る
const HostContext = createContext(null);

// ページ全体のテーマ（ページエントリが getUserTheme() の結果を入れる）
export const PlatformThemeContext = createContext('light');

// dash-platform ホストの目印。viz エントリの自己マウントを抑止する
// （world-map の mountWhenReady ガードが参照する）。
globalThis.__DASH_PLATFORM_HOST__ = true;

export function useDataSources() {
    const p = useContext(HostContext);
    return { dataSources: p?.dataSources ?? {}, loading: Boolean(p?.loading) };
}

export function useOptions() {
    const p = useContext(HostContext);
    return { options: p?.options ?? {}, setOptions: p?.onOptionsChange ?? (() => {}) };
}

export function useMode() {
    const p = useContext(HostContext);
    return { mode: p?.mode ?? 'view' };
}

export function useDimensions() {
    const p = useContext(HostContext);
    return { width: p?.width, height: p?.height };
}

export function useTheme() {
    const theme = useContext(PlatformThemeContext);
    return { theme };
}

export function useTokens() {
    // DPX のトークン基盤に接続（既存 Studio 拡張 viz の useTokens 互換）
    const { tokens, setToken } = useDpxTokens();
    return { tokens, setToken };
}

export function useError() {
    return { setError: () => {}, clearError: () => {} };
}

// 互換のためのパススルー（iframe 版ではルートを包む Provider だが、
// ホスト版ではコンテキストは adaptExtensionViz が張る）
export const VisualizationExtensionProvider = ({ children }) => children;

// ── ドリルダウン shim ────────────────────────────────────────────
// 拡張の addDrilldownListener({node, action, payloadCallback}) を
// framework の onEventTrigger に橋渡しする。モジュール関数でコンテキストに
// 触れないため、viz のルート要素（data-dp-viz）から owner を逆引きする。
// ⚠ framework のイベントハンドラ（drilldown.*）が拾うかは未検証。
//    クリック→onEventTrigger 呼び出しまでがこの shim の責務。

const vizHostByElement = new Map(); // rootElement -> onEventTrigger

export function addDrilldownListener({ node, action, payloadCallback, payload }) {
    if (!node) return;
    node.style.cursor = 'pointer';
    node.addEventListener('click', (originalEvent) => {
        const root = node.closest?.('[data-dp-viz]');
        const onEventTrigger = root ? vizHostByElement.get(root) : null;
        if (!onEventTrigger) return;
        onEventTrigger({
            type: action || 'point.click',
            originalEvent,
            payload: typeof payloadCallback === 'function' ? payloadCallback() : payload ?? {},
        });
    });
}

// ── 変換関数 ────────────────────────────────────────────────────
// Studio 拡張の App コンポーネントを framework preset 用 viz に変換する。
// statics には viz の config.json（拡張と framework で同形式）をそのまま渡せる。
export function adaptExtensionViz(App, statics = {}) {
    const Adapted = (props) => {
        const setRootRef = (el) => {
            if (el) vizHostByElement.set(el, props.onEventTrigger);
        };
        return (
            <HostContext.Provider value={props}>
                <div
                    ref={setRootRef}
                    data-dp-viz={props.id ?? ''}
                    style={{
                        position: 'relative',
                        width: '100%',
                        height: typeof props.height === 'number' ? props.height : '100%',
                        overflow: 'hidden',
                    }}
                >
                    <App />
                </div>
            </HostContext.Provider>
        );
    };
    Object.assign(Adapted, statics);
    return Adapted;
}
