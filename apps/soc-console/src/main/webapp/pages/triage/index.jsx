import React from 'react';
import layout from '@splunk/react-page/18';

import Console from '../../components/Console';

// NOC Wall と同じく dark 固定。
// SOC の画面は暗所での長時間利用が前提で、明色テーマだと severity の色が沈むため
// ユーザーのテーマ設定には追従しない（getUserTheme を呼ばないぶん初期表示も速い）。
layout(<Console />, { theme: 'dark' });
