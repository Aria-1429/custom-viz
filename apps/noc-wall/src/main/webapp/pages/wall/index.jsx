import React from 'react';
import layout from '@splunk/react-page/18';

import Wall from '../../components/Wall';

// このページはユーザーのテーマ設定に追従しない。
// 壁掛けモニタ常時表示が前提で、暗色に固定した方が見やすいため
// getUserTheme() は呼ばずに dark 固定で描画する（読み込みも 1 往復速くなる）。
layout(<Wall />, { theme: 'dark' });
