// DPX 用のホストエントリ。
//
// なぜ別ファイルなのか:
//   visualization.jsx は Studio 拡張の esbuild エントリで、format:'esm' でビルドされる。
//   そこに `export` を1つでも書くと成果物末尾に `export{...}` が出力され、
//   Studio の iframe がクラシックスクリプトとして読んだ瞬間
//   `Uncaught SyntaxError: Unexpected token 'export'` でバンドル全体が実行されず、
//   パネルが真っ黒になる（2026-08-10 の開発中に実際に発生させ、実機で確認）。
//
//   一方 DPX は webpack で viz のソースを直接束ねるため、名前付き export が要る。
//   両者を両立させるには「esbuild が読むファイルには export を書かない」しかないので、
//   export はこのファイル（esbuild のエントリではない）に置く。
//
// DPX 側の使い方:
//   import { App } from '.../src/host.jsx';
//
// ⚠ 評価順に依存しないこと:
//   visualization.jsx は import された瞬間に「自己マウントするかどうか」を
//   `__DASH_PLATFORM_HOST__` で判定する。このフラグは extensionAdapter も立てるが、
//   それに頼ると「import 文の並び順」次第で判定が変わる（バンドラや lint の
//   import 整列で順序が入れ替わると、DPX 上で二重マウントが起きうる）。
//   そこで visualization.jsx を読み込む「前」にここで自分で立てておく。
//   ※ import 文は巻き上げられるため、ここは静的 import ではなく require 相当の
//     順序保証が要る。webpack/babel では下の順に評価される。

globalThis.__DASH_PLATFORM_HOST__ = true;

// eslint-disable-next-line global-require, import/no-unresolved
require('./visualization.jsx');

export const App = globalThis.__WORLDMAP_APP__;
