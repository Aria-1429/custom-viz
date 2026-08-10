import React from 'react';
import layout from '@splunk/react-page/18';
import { getUserTheme } from '@splunk/splunk-utils/themes';

import Overview from '../../components/Overview';

// ページのエントリポイント。
// @splunk/react-page の layout() が Splunk のヘッダ／アプリバーごと描画し、
// 渡した React 要素を本文として差し込む（React 18 の createRoot 版が /18）。
//
// テーマはユーザー設定（light/dark）を取得してから渡す。
// カスタム viz の useTheme に相当するが、ここでは自分で取りに行く。
getUserTheme()
    .then((theme) => {
        layout(<Overview />, { theme });
    })
    .catch(() => {
        // テーマ取得に失敗してもページは必ず出す（真っ白で終わらせない）
        layout(<Overview />, { theme: 'light' });
    });
