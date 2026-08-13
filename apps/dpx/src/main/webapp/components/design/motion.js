// ── Motion Engine（動きの抽象）──────────────────────────────────
//
// **`none` / `subtle` / `spring` / `organic` の 4 段で「動きの性格」を選ぶ層。**
//
// ⚠⚠ **既存の 12 種（`ENTRANCE_ANIM`）を置き換えない。**（ユーザー指定・2026-08-13）
//   置き換えると、既存ダッシュボードの `style.entrance` 指定が**全部無効になる**。
//   Motion は**その上に乗る抽象**で、
//     - `style.entrance` が指定されていれば **それが最優先**（従来どおり）
//     - 指定が無いときに Motion が「性格に合う既定」を選ぶ
//   という関係にする。
//
// ## 4 つの性格
//
// | motion | 出現 | 常時 | イージング | 用途 |
// |---|---|---|---|---|
// | `none` | 出さない | 出さない | — | 壁面表示・`prefers-reduced-motion` |
// | `subtle` | fade | なし | ease | 実用ダッシュボード（既定） |
// | `spring` | pop（跳ね） | なし | cubic-bezier の overshoot | プレゼン・デモ |
// | `organic` | rise | float（ゆらぎ） | ゆっくりした ease-in-out | 手描き・アンビエント |
//
// ⚠ **動かすのは `transform` / `opacity` だけ**（この層が返す値もその制約に従う）。
//   `filter` / `box-shadow` / `background-position` を animate すると
//   毎フレーム再描画になり、パネル数に比例して重くなる。
//
// ⚠ **依存ゼロで保つ**（React も CSS も import しない）。素の Node でテストする。
// ────────────────────────────────────────────────────────────────

/** 動きの性格。 */
export const MOTION_VALUES = ['none', 'subtle', 'spring', 'organic'];

export const MOTION_OPTIONS = [
    { value: 'none', label: 'なし' },
    { value: 'subtle', label: '控えめ' },
    { value: 'spring', label: 'スプリング' },
    { value: 'organic', label: 'オーガニック' },
];

/**
 * 性格ごとの既定。
 *
 * ⚠ ここに書くのは**「指定が無いときに何を選ぶか」だけ**。
 *   実際のキーフレーム定義（`ENTRANCE_ANIM`）は持たない
 *   ＝**意匠を 2 か所に書かない**（`groupSurface` が `panelSurface` に委譲するのと同じ原則）。
 */
const MOTION_PRESETS = {
    none: { entrance: 'none', ambient: 'none', durationScale: 0, stagger: 0 },
    subtle: { entrance: 'fade', ambient: 'none', durationScale: 1, stagger: 70 },
    spring: { entrance: 'pop', ambient: 'none', durationScale: 1, stagger: 60 },
    organic: { entrance: 'rise', ambient: 'float', durationScale: 1.25, stagger: 90 },
};

/**
 * 動きの設定を解決する。
 *
 * **優先順位（重要）**:
 *   1. `prefers-reduced-motion` … 何より優先（動きで酔う利用者への配慮）
 *   2. 明示指定（`style.entrance` / `panel.style.ambient`）… 既存ボードの指定を守る
 *   3. Motion の性格からの既定
 *
 * @returns {{entrance, ambient, stagger, durationScale, enabled}}
 */
export function resolveMotion({
    motion = 'subtle',
    entrance,
    ambient,
    prefersReducedMotion = false,
    quality,
} = {}) {
    // 1) reduced-motion と minimal 品質は問答無用で止める
    if (prefersReducedMotion || quality === 'minimal' || motion === 'none') {
        return { entrance: 'none', ambient: 'none', stagger: 0, durationScale: 0, enabled: false };
    }
    const preset = MOTION_PRESETS[motion] ?? MOTION_PRESETS.subtle;
    return {
        // 2) 明示指定があればそれを使う（既存ボードの `entrance` を無効にしない）
        entrance: entrance && entrance !== 'auto' ? entrance : preset.entrance,
        ambient: ambient && ambient !== 'auto' ? ambient : preset.ambient,
        stagger: preset.stagger,
        durationScale: preset.durationScale,
        enabled: true,
    };
}

/**
 * パネル `index` 番目の出現遅延（ms）。
 *
 * **方向のあるアニメは、遅延をずらすと盤面を波が走るように見える。**
 * ⚠ ただし**上限を設ける**。パネルが 30 枚あると最後は 2.7 秒後になり、
 *   「壊れて出てこない」ように見える。
 */
export function entranceDelay(index, motion = 'subtle', maxMs = 700) {
    const preset = MOTION_PRESETS[motion] ?? MOTION_PRESETS.subtle;
    if (!preset.stagger) return 0;
    return Math.min((Number(index) || 0) * preset.stagger, maxMs);
}

/** その性格が常時アニメを持つか。 */
export function hasAmbient(motion) {
    return (MOTION_PRESETS[motion] ?? MOTION_PRESETS.subtle).ambient !== 'none';
}
