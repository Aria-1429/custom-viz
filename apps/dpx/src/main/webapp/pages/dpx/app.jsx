// ── DPX アプリ本体（遅延読み込みされるチャンク）─────────────────
// エントリは pages/dpx/index.jsx（極小のシム）。そこから動的 import される。
//   /app/dpx/dpx                → ホーム（一覧）
//   /app/dpx/dpx?id=<app>/<name> → ダッシュボード
// 画面間は pushState の SPA 遷移＝ページ再読込ゼロ（白フラッシュも出ない）。
//
// ⚠ **暗転とスプラッシュはここではなくエントリ（index.jsx）が出す。**
//   このファイルは 1.3MB のチャンクに入るため、評価が始まるのは
//   ダウンロード＋パースが終わったあと（実測 800ms）。そこで塗り始めたら遅い。
//   ここでは `showBootSplash` を SPA 遷移の演出として使うだけ。
// ────────────────────────────────────────────────────────────────
import { showBootSplash } from './bootPaint';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import layout from '@splunk/react-page/18';

import HomePage from '../../components/pages/HomePage';
import DashboardPage from '../../components/pages/DashboardPage';
import { parseDpxRoute, homeHref } from '../../components/data/viewStore';

const DpxApp = () => {
    const [route, setRoute] = useState(() => parseDpxRoute());
    const routeIdRef = useRef(route.id);
    routeIdRef.current = route.id;

    // 戻る/進むで URL が変わったらルートを取り直す。
    // モードだけの変更（?mode=edit）は DashboardPage 側も独自に追随するが、
    // id が同じなら key が変わらないので再マウントは起きない（意図どおり）。
    useEffect(() => {
        const onPop = () => {
            const next = parseDpxRoute();
            // 画面が切り替わる（id が変わる）ときだけロード画面を挟む。
            // mode だけの往復では出さない
            if (routeIdRef.current !== next.id) showBootSplash();
            setRoute(next);
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const navigate = useCallback((href) => {
        // SPA 遷移でも「かっこいいロード画面」を見せる（最低表示時間は
        // dismissBootSplash 側が保証）。切替自体は一瞬でも、演出として挟む
        showBootSplash();
        window.history.pushState({}, '', href);
        setRoute(parseDpxRoute());
    }, []);

    if (!route.id) {
        return <HomePage navigate={navigate} />;
    }
    return (
        <DashboardPage
            // key でボード切替時に確実に作り直す（前のボードのサーチ・タイマーを
            // React のアンマウントで一括停止させる。長時間の SPA 滞在でも漏らさない）
            key={route.id}
            app={route.app}
            view={route.view}
            initialMode={route.mode}
            onNavigateHome={() => navigate(homeHref())}
        />
    );
};

// ⚠ 常に dark 固定。Splunk のユーザーテーマ（多くの環境で light）を渡すと、
//    @splunk/react-page が明るいローディング画面（3点リーダー）を描いてしまう
//    （実機で 58ms 地点に rgb(242,244,245) のパネルを確認済み）。
layout(<DpxApp />, { theme: 'dark' });
