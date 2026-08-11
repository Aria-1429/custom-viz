// DPX 用のホストエントリ。
//
// なぜ別ファイルなのか:
//   visualization.jsx は Studio 拡張の esbuild エントリで、format:'esm' でビルドされる。
//   そこに `export` を1つでも書くと成果物末尾に `export{...}` が出力され、
//   Studio の iframe がクラシックスクリプトとして読んだ瞬間
//   `Uncaught SyntaxError: Unexpected token 'export'` でバンドル全体が実行されず、
//   パネルが真っ黒になる（2026-08-10 に実機で確認）。
//
//   一方 DPX は webpack で viz のソースを直接束ねるため、名前付き export が要る。
//   両者を両立させるには「esbuild が読むファイルには export を書かない」しかないので、
//   export はこのファイル（esbuild のエントリではない）に置く。
//
// ⚠ 評価順に依存しないこと:
//   visualization.jsx は import された瞬間に自己マウントの要否を
//   `__DASH_PLATFORM_HOST__` で判定する。extensionAdapter も同じフラグを立てるが、
//   それに頼ると import 文の並び順で判定が変わる（整列で順序が入れ替わると二重マウント）。
//   そこで visualization.jsx を読み込む「前」にここで自分で立てておく。
//   ※ 静的 import は巻き上げられるため require 相当の順序保証を使う。

globalThis.__DASH_PLATFORM_HOST__ = true;

// eslint-disable-next-line global-require, import/no-unresolved
require('./visualization.jsx');

export const App = globalThis.__DONUT_TIMECHART_APP__;
