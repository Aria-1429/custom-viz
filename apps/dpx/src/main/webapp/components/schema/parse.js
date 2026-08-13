// ── 定義の検証・正規化（唯一の入口）────────────────────────────
//
// **定義を読むときは必ずここを通す。** REST から読んだもの・JSON で取り込んだもの・
// ソースタブで手編集したもの、すべて同じ関門を通す。
//
// ⚠ **落とすのではなく理由を返す。** 手で編集した JSON を貼る導線があるので、
//   「取り込めません」だけだと直しようがない。**何行目の何が悪いか**まで言う。
//
// ⚠ **v1 は読まない**（2026-08-13 ユーザー決定「これは移行ではない」）。
//   ただし **v1 だと分かるなら、そう言って断る**。黙って「形式が違います」と
//   返すと、利用者は自分の JSON のどこが悪いのか永久に分からない。
// ────────────────────────────────────────────────────────────────

import { DashboardSchema } from './dashboard.js';
import { SCHEMA_VERSION } from './vocab.js';

/**
 * Zod のエラーを人が読める日本語にする。
 *
 * ⚠ **パスを必ず出す。** `panels[2].viz` のように場所が分かれば直せる。
 *   メッセージだけだと「どのパネルの話か」が分からない。
 */
function formatIssues(error) {
    const issues = error?.issues ?? [];
    return issues.slice(0, 8).map((it) => {
        const path = (it.path ?? []).join('.');
        return path ? `${path}: ${it.message}` : it.message;
    });
}

/**
 * 定義を検証して正規化する（既定値が埋まった状態で返る）。
 *
 * @param raw  検証対象（パース済みのオブジェクト）
 * @returns {{ok: true, definition: object} | {ok: false, error: string, issues: string[]}}
 */
export function parseDefinition(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '定義のトップレベルがオブジェクトではありません', issues: [] };
    }

    // ⚠ 旧形式・他形式は「何であるか」を言って断る（黙って弾かない）
    const known = detectForeignFormat(raw);
    if (known) return { ok: false, error: known, issues: [] };

    const result = DashboardSchema.safeParse(raw);
    if (!result.success) {
        const issues = formatIssues(result.error);
        return {
            ok: false,
            error: `定義の形式が正しくありません（${issues.length} 件）`,
            issues,
        };
    }
    return { ok: true, definition: result.data };
}

/**
 * DPX v2 以外の形式だと分かるならその旨を返す（分からなければ null）。
 *
 * **なぜ要るか**: Studio の定義や DPX v1 を貼るのは十分あり得る筋。
 * 「version が無い」ではなく「Studio の定義のようです」と言えれば利用者は納得できる。
 */
function detectForeignFormat(def) {
    // Dashboard Studio の定義（visualizations + layout を持ち version は文字列）
    if (def.visualizations && def.layout && typeof def.version === 'string') {
        return 'Dashboard Studio の定義のようです（DPX の形式ではありません）';
    }
    // DPX v1（version: 1 と panels 配列）
    if (def.version === 1 && Array.isArray(def.panels)) {
        return `DPX v1 の定義です。現在のスキーマは v${SCHEMA_VERSION} で、v1 の読み込みには対応していません`;
    }
    return null;
}

/**
 * 取り込み用（JSON 文字列から）。
 *
 * @returns {{ok: true, definition: object} | {ok: false, error: string, issues: string[]}}
 */
export function parseDefinitionText(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        return { ok: false, error: `JSON として読めません（${String(err?.message ?? err)}）`, issues: [] };
    }
    return parseDefinition(raw);
}

/**
 * 保存前の直列化。
 *
 * ⚠ **保存する前にも検証する。** 編集中に壊れた定義が書き込まれると、
 *   次に開いたときに読めなくなる（実機のボードが開けなくなるのが最悪の事故）。
 */
export function serializeDefinition(definition) {
    const result = parseDefinition(definition);
    if (!result.ok) return result;
    return { ok: true, text: JSON.stringify(result.definition, null, 2) };
}

/** この定義が現行スキーマとして読めるか（真偽だけ欲しいとき）。 */
export function isValidDefinition(def) {
    return parseDefinition(def).ok;
}
