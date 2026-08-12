// ── パネルのグループ（★Studio では原理的に不可能）─────────────────
//
// 複数のパネルを **1つの領域**としてくくり、枠と見出しを与える。
// 「箱が並んでいる」画面を「1枚の管制盤」に変えるための機能。
//
// **なぜ Studio にできないか**: パネルが iframe に隔離されているため、
// ホストは **パネルとパネルの隙間**に何も描けない。枠を描こうとしても
// iframe の外には 1px も出られず、パネルを束ねる意匠は作れない。
// DPX は全パネルが同じ DOM の CSS grid に載っているので、
// **同じグリッドに背面レイヤとして矩形を敷く**だけで済む。
//
// ⚠ **図形（shape.nocFrame）で代用しない。** 手で位置とサイズを合わせる形だと、
//   パネルを動かすたびに枠がずれる（＝意匠ではなく作業になる）。
//   グループは**メンバーの実際の座標から矩形を計算する**ので、
//   パネルを動かせば枠が追従する。
//
// スキーマ v1 への追加（既存ボードは `groups` が無いだけなので影響なし）:
//   "groups": [
//     { "id": "g1", "label": "認証系", "panels": ["p1","p2"],
//       "tab": "overview",            // 省略時は所属パネルのタブに従う
//       "variant": "bracket",         // bracket | line | solid
//       "color": "",                  // 空でテーマの中性色
//       "pad": 8                      // パネルの外側へ広げる余白(px)
//     }
//   ]
// ────────────────────────────────────────────────────────────────

/** 定義から groups を取り出す（無ければ空配列）。 */
export function getGroups(definition) {
    const g = definition?.groups;
    return Array.isArray(g) ? g : [];
}

/**
 * グループの矩形を**メンバーパネルの座標から**計算する。
 *
 * ⚠ 返すのはグリッド座標（列・行）であって px ではない。
 *   px で持つと `grid.gap` や `rowHeight` を変えたときに追従しない。
 *   実際の描画は CSS grid の `gridColumn` / `gridRow` に任せる
 *   （＝**パネルと同じ配置規則**を通るので、ズレようがない）。
 *
 * @returns {{x,y,w,h}|null} メンバーが1枚も無ければ null
 */
export function groupRect(group, panels) {
    const ids = new Set((group?.panels ?? []).map(String));
    const members = (panels ?? []).filter((p) => ids.has(String(p?.id)));
    if (members.length === 0) return null;

    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of members) {
        const px = Number(p.x) || 0;
        const py = Number(p.y) || 0;
        const pw = Math.max(1, Number(p.w) || 1);
        const ph = Math.max(1, Number(p.h) || 1);
        x0 = Math.min(x0, px);
        y0 = Math.min(y0, py);
        x1 = Math.max(x1, px + pw);
        y1 = Math.max(y1, py + ph);
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * グループが属するタブを決める。
 *
 * 明示指定が無ければ**メンバーの最初のパネルのタブ**に従う。
 * ⚠ これが無いと、タブを切り替えても枠だけが残る
 *   （メンバーが消えているのに枠が浮く）。
 */
export function groupTab(group, panels) {
    if (group?.tab) return group.tab;
    const ids = new Set((group?.panels ?? []).map(String));
    const first = (panels ?? []).find((p) => ids.has(String(p?.id)));
    return first?.tab;
}

/** そのパネルが属するグループを返す（先に見つかった1つ）。 */
export function groupOfPanel(definition, panelId) {
    const id = String(panelId);
    return getGroups(definition).find((g) => (g?.panels ?? []).map(String).includes(id)) ?? null;
}

/** 新しいグループ ID を採番する（g1, g2, …）。 */
export function nextGroupId(definition) {
    const used = new Set(getGroups(definition).map((g) => g?.id));
    let n = used.size + 1;
    while (used.has(`g${n}`)) n += 1;
    return `g${n}`;
}

/**
 * パネルをグループに入れる／外す（インスペクタの操作）。
 *
 * ⚠ **1枚のパネルは1つのグループにしか入れない。** 複数に入れられると
 *   枠が重なって「どっちの区画か」が読めなくなる。入れ替えは
 *   「今の所属から外して、新しい方へ足す」を1回の更新でやる
 *   （2段階にすると、途中経過が保存されて所属なしの状態が残りうる）。
 *
 * @param groupId 入れる先のグループ ID。空文字・null なら**どこにも入れない**
 * @returns 新しい groups 配列
 */
export function assignPanelToGroup(definition, panelId, groupId) {
    const id = String(panelId);
    const next = getGroups(definition).map((g) => {
        const members = (g?.panels ?? []).map(String);
        const without = members.filter((m) => m !== id);
        if (g?.id === groupId) {
            // 入れる先：末尾に足す（既に居るなら重複させない）
            return { ...g, panels: without.concat(id) };
        }
        return without.length === members.length ? g : { ...g, panels: without };
    });
    return next;
}

/**
 * グループを削除する。
 *
 * ⚠ **メンバーのパネルは消さない。** 消えるのは枠だけ。
 *   「グループを消したらパネルまで消えた」は取り返しがつかない事故になる。
 */
export function removeGroup(definition, groupId) {
    return getGroups(definition).filter((g) => g?.id !== groupId);
}

/**
 * ⭐ **グループごと動かす**（メンバー全員を相対位置を保ったまま平行移動）。
 *
 * これが無いとグループは「枠がパネルを追いかけるだけの飾り」になる。
 * **グループがパネルを従える**ことで初めて機能単位になる。
 *
 * ⚠ **クランプは「グループ全体」で判定する。** パネルごとに
 *   `clamp(0, columns - w)` すると、**端に当たったパネルだけが止まって
 *   相対位置が崩れる**（＝グループの形が変わる）。
 *   先に「全体で動ける量」を求めてから、全員に同じ量を足す。
 *
 * @param dx, dy 動かしたいセル数（グリッド単位）
 * @returns 新しい panels 配列（変化が無ければ同じ参照を返す）
 */
export function movePanelsBy(panels, memberIds, dx, dy, columns = 12) {
    const ids = new Set((memberIds ?? []).map(String));
    const members = (panels ?? []).filter((p) => ids.has(String(p?.id)));
    if (members.length === 0) return panels;

    const ddx = Math.round(Number(dx)) || 0;
    const ddy = Math.round(Number(dy)) || 0;
    if (ddx === 0 && ddy === 0) return panels;

    // グループ全体の外接矩形から「動かせる範囲」を出す
    let minX = Infinity;
    let minY = Infinity;
    let maxRight = -Infinity;
    for (const p of members) {
        const px = Number(p.x) || 0;
        const py = Number(p.y) || 0;
        const pw = Math.max(1, Number(p.w) || 1);
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxRight = Math.max(maxRight, px + pw);
    }
    // 左は 0 まで、右は columns まで。上は 0 まで（下は無制限＝行は増やせる）
    const allowedDx = Math.max(-minX, Math.min(ddx, columns - maxRight));
    const allowedDy = Math.max(-minY, ddy);
    if (allowedDx === 0 && allowedDy === 0) return panels;

    return panels.map((p) =>
        ids.has(String(p?.id))
            ? { ...p, x: (Number(p.x) || 0) + allowedDx, y: (Number(p.y) || 0) + allowedDy }
            : p
    );
}

/**
 * グループを削除したときに、メンバーの質感を戻すかどうかの判定材料。
 * 「グループに入れたら透明にした」パネルを覚えておくためのキー。
 */
export const GROUPED_VARIANT = 'frameless';
