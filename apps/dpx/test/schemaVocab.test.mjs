// ── 語彙（vocab）と既存実装の突き合わせ ─────────────────────────
//
// **目的は「選択肢と実装のズレ」を機械的に見つけること。**
//
// このズレは**無言で失敗する**ので目視では気づけない:
//   - 一覧にあるのに実装が無い → その質感を選ぶと**ただの素の箱**になる（エラー無し）
//   - 実装だけあって一覧に無い → **死にコード**になり、選ぶ手段が無い
//
// 背景エフェクトで同種のズレが実際に起きており、`backgrounds.test.mjs` が
// 両方向を突き合わせている。質感・プリセットにも同じ網を張る。
//
// 実行: node test/schemaVocab.test.mjs
// ────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    GROUP_INCOMPATIBLE_VARIANTS,
    GROUP_VARIANT_VALUES,
    PANEL_VARIANTS,
    PANEL_VARIANT_VALUES,
    THEME_PRESETS,
} from '../src/main/webapp/components/schema/vocab.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = (f) => path.join(here, '../src/main/webapp/components', f);
// ⚠ **ソースを「文字列として」読む**（import しない）。
//   vocab は依存ゼロで保ちたいので、実装を import すると
//   スキーマ層が描画層に依存してしまう。ここは「2 つの一覧が
//   ズレていないか」だけを見たいので、テキスト照合で十分。
//
// ⚠ themes.js は **Theme と Surface の barrel** になったので、
//   実体のある 2 ファイルを連結して読む。
const themesSrc = [
    enginePath('design/theme/index.js'),
    enginePath('design/surface/index.js'),
]
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

let pass = 0;
const test = (name, fn) => {
    try {
        fn();
        pass += 1;
    } catch (err) {
        console.error(`✗ ${name}\n  ${err.message}`);
        process.exitCode = 1;
    }
};

/** themes.js の配列リテラルから value を抜き出す。 */
function extractValues(src, marker) {
    const start = src.indexOf(marker);
    assert.notEqual(start, -1, `${marker} が themes.js に無い`);
    const end = src.indexOf('];', start);
    const block = src.slice(start, end);
    return [...block.matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** themes.js の DPX_PRESETS のキーを抜き出す。 */
function extractPresetKeys(src) {
    const start = src.indexOf('export const DPX_PRESETS');
    const end = src.indexOf('export const PRESET_ORDER');
    const block = src.slice(start, end);
    // トップレベルのキーだけ（インデント 4 の `key: {`）
    return [...block.matchAll(/^ {4}(\w+):\s*\{/gm)].map((m) => m[1]);
}

// ── 質感 ───────────────────────────────────────────────────────

test('vocab の質感一覧が themes.js の PANEL_VARIANTS と一致する', () => {
    const impl = extractValues(themesSrc, 'export const PANEL_VARIANTS');
    assert.deepEqual(
        [...PANEL_VARIANT_VALUES].sort(),
        [...impl].sort(),
        'vocab と themes.js の質感がズレている（片方に足し忘れ）'
    );
});

test('質感の value が重複していない', () => {
    const seen = new Set();
    for (const v of PANEL_VARIANT_VALUES) {
        assert.ok(!seen.has(v), `質感 ${v} が重複`);
        seen.add(v);
    }
});

test('質感に表示名が必ずある', () => {
    for (const v of PANEL_VARIANTS) {
        assert.ok(v.label && v.label.length > 0, `${v.value} に label が無い`);
    }
});

test('質感の表示名に説明の括弧を足さない', () => {
    // 選択肢が 25 個あるので、括弧付きだとピッカーのタイル内で名前が切れて読めない
    // （実機で確認済み。説明はドキュメントに置き UI に持ち込まない）
    for (const v of PANEL_VARIANTS) {
        assert.ok(
            !/[（(]/.test(v.label),
            `${v.value} の表示名に括弧がある: ${v.label}`
        );
    }
});

// ── 区画（グループ）─────────────────────────────────────────────

test('区画で使えない質感は一覧から外れている', () => {
    // polaroid / punchCard は「中身がある箱」前提の造りで、
    // 中身を持たない区画に当てるとパネルを覆い隠す（実機で破綻・スクショで発覚）
    for (const bad of GROUP_INCOMPATIBLE_VARIANTS) {
        assert.ok(
            !GROUP_VARIANT_VALUES.includes(bad),
            `${bad} が区画の選択肢に残っている`
        );
    }
});

test('区画には専用の rule がある', () => {
    assert.ok(GROUP_VARIANT_VALUES.includes('rule'), '区画専用の rule が無い');
});

test('区画の選択肢は「パネルの質感 − 非互換」＋ rule', () => {
    const expected = PANEL_VARIANT_VALUES.filter(
        (v) => !GROUP_INCOMPATIBLE_VARIANTS.includes(v)
    ).length + 1;
    assert.equal(GROUP_VARIANT_VALUES.length, expected);
});

// ── 配色プリセット ──────────────────────────────────────────────

test('vocab のプリセットが themes.js の DPX_PRESETS と一致する', () => {
    const impl = extractPresetKeys(themesSrc);
    assert.deepEqual(
        [...THEME_PRESETS].sort(),
        [...impl].sort(),
        'vocab と themes.js のプリセットがズレている（片方に足し忘れ）'
    );
});

test('プリセットが重複していない', () => {
    assert.equal(new Set(THEME_PRESETS).size, THEME_PRESETS.length);
});

console.log(`schemaVocab: ${pass} tests passed`);
