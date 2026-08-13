const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { merge: webpackMerge } = require('webpack-merge');
const baseConfigRaw = require('@splunk/webpack-configs/base.config').default;

// ⚠ base.config は画像系をまとめて `asset/resource`（別ファイル出力）にしている:
//     { test: /\.(png|jpg|jpeg|gif|svg|eot|wav|mp3)$/, type: 'asset/resource', generator: {filename} }
//   既存 viz は SVG を `<img src={import した値}>` で使い、esbuild 側は dataurl なので
//   DPX でも data URL に揃えたい。しかし webpackMerge はルールを**追記**するため、
//   自前ルールを足すと base のルールと二重に当たり generator が衝突して
//   ValidationError（"generator has an unknown property 'filename'"）になる。
//   → base 側のテストから svg を外してから merge する（他の拡張子は据え置き）。
const baseConfig = {
    ...baseConfigRaw,
    module: {
        ...baseConfigRaw.module,
        rules: baseConfigRaw.module.rules.map((r) =>
            String(r.test) === String(/\.(png|jpg|jpeg|gif|svg|eot|wav|mp3)$/)
                ? { ...r, test: /\.(png|jpg|jpeg|gif|eot|wav|mp3)$/ }
                : r
        ),
    },
};

const DEBUG = process.env.NODE_ENV !== 'production';

// src/main/webapp/pages/ 配下の各ディレクトリが 1 ページ = 1 エントリになる。
// ページを増やすときはディレクトリを足すだけでよい（この設定は触らない）。
const PAGES_DIR = path.join(__dirname, 'src/main/webapp/pages');
const entries = fs
    .readdirSync(PAGES_DIR)
    .filter((page) => !/^\./.test(page))
    .filter((page) => fs.statSync(path.join(PAGES_DIR, page)).isDirectory())
    .reduce((accum, page) => {
        accum[page] = path.join(PAGES_DIR, page);
        return accum;
    }, {});

module.exports = webpackMerge(baseConfig, {
    entry: entries,
    resolve: {
        alias: {
            // モノレポの viz ソースを import すると、その viz 自身の node_modules の
            // react が解決されて React が二重になる（hooks が null で落ちる）。
            // ランタイム共有ライブラリはこのアプリ側の1本に寄せる。
            react: path.join(__dirname, 'node_modules/react'),
            'react-dom': path.join(__dirname, 'node_modules/react-dom'),
            'react-is': path.join(__dirname, 'node_modules/react-is'),
            'styled-components': path.join(__dirname, 'node_modules/styled-components'),
            '@splunk/themes': path.join(__dirname, 'node_modules/@splunk/themes'),
            '@splunk/react-ui': path.join(__dirname, 'node_modules/@splunk/react-ui'),
            // 既存 Studio 拡張 viz のソースを iframe なしでホストするための差し替え。
            // 拡張のフック/ドリルダウン API を互換アダプタに向ける。
            '@splunk/dashboard-studio-extension/react$': path.join(
                __dirname,
                'src/main/webapp/components/viz/extensionAdapter.jsx'
            ),
            '@splunk/dashboard-studio-extension/visualization$': path.join(
                __dirname,
                'src/main/webapp/components/viz/extensionAdapter.jsx'
            ),
        },
    },
    output: {
        // Splunk は appserver/static/ 配下を静的配信する。
        // ここに出した pages/<name>.js を Mako テンプレートが読み込む。
        path: path.join(__dirname, 'stage/appserver/static/pages/'),
        filename: '[name].js',
    },
    plugins: [
        // 既存 viz のソースは自動 JSX ランタイム前提（`import React` を書かない）だが、
        // @splunk/babel-preset は classic 変換なので React をグローバル注入する
        new webpack.ProvidePlugin({ React: 'react' }),
        new CopyWebpackPlugin({
            patterns: [
                {
                    // default/ や appserver/templates/ をそのまま stage/ に配置する
                    from: path.join(__dirname, 'src/main/resources/splunk'),
                    to: path.join(__dirname, 'stage'),
                },
            ],
        }),
    ],
    devtool: DEBUG ? 'eval-source-map' : false,
    module: {
        rules: [
            // style-loader が無いと import した CSS が DOM に注入されない
            { test: /\.css$/, use: ['style-loader', 'css-loader'] },
            // 既存 viz は SVG を `import icon from './assets/x.svg'` して <img src> に渡す。
            // esbuild 側は loader '.svg': 'dataurl' なので、**同じく data URL に揃える**。
            // asset/resource だと別ファイルとして出力され、DPX の静的配信では解決できず
            // アイコンが崩れる（実機で黒い矩形になるのを確認）。
            //
            // （base 側の svg ルールは上で除去済み。ここが唯一の svg ルールになる）
            { test: /\.svg$/i, type: 'asset/inline' },
            // モノレポの visualizations/ 配下（既存 viz のソース）も babel を通す。
            // babel の設定探索は「対象ファイルの場所」基準なので、外部ソースには
            // このアプリの .babelrc.js が届かない。presets を rule で直接指定する。
            {
                test: /\.jsx?$/,
                include: [path.join(__dirname, '../../visualizations')],
                use: {
                    loader: 'babel-loader',
                    options: {
                        babelrc: false,
                        configFile: false,
                        presets: [require.resolve('@splunk/babel-preset')],
                    },
                },
            },
        ],
    },
});
