const fs = require('fs');
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { merge: webpackMerge } = require('webpack-merge');
const baseConfig = require('@splunk/webpack-configs/base.config').default;

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
    output: {
        // Splunk は appserver/static/ 配下を静的配信する。
        // ここに出した pages/<name>.js を Mako テンプレートが読み込む。
        path: path.join(__dirname, 'stage/appserver/static/pages/'),
        filename: '[name].js',
    },
    plugins: [
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
        rules: [{ test: /\.css$/, use: 'css-loader' }],
    },
});
