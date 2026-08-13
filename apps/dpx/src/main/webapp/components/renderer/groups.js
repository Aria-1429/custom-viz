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

/**
 * 区画が**パネルの外へ広げてよい量**(px)を決める。
 *
 * ⚠ **gap の内側を超えてはいけない**（2026-08-12・ユーザー指摘で修正）。
 *   パネルは元のサイズのまま動かないので、区画が gap を超えて広がると
 *   **隣・下の（区画外の）パネルに食い込む**。
 *   実測では下端の余白が 4px しか残らず、下のパネルのカギ括弧と
 *   区画の返しが重なっていた。
 *
 * ⚠ 以前は**左右だけ gap/2、下は生の `pad`** という非対称な実装だった。
 *   「隣り合う区画の罫が繋がる」問題だけを見て左右を直したため、
 *   **区画の外にあるパネル**への食い込みを見落とした。
 *   → 4辺すべて同じ規則にして、**構造的に重ならないことを保証する**。
 *
 * @param pad 利用者の希望値（区画の「外側の余白」）
 * @param gap グリッドの間隔
 */
export function groupInset(pad, gap = 12) {
    const p = Number(pad);
    const g = Number(gap);
    const want = Number.isFinite(p) ? Math.max(0, p) : 8;
    const limit = Math.max(0, Math.floor((Number.isFinite(g) ? g : 12) / 2) - 1);
    return Math.min(want, limit);
}

/**
 * ⭐ **区画の見出し用の行を確保する**（2026-08-12・ユーザー指定）。
 *
 * 最上段の区画はグリッド上部の余白に見出しを置けるが、**途中の行では
 * 上のパネルとの隙間が `gap` しか無く、見出しの居場所が無い**。
 * → **区画が始まる行の手前に「細い行」を1本挿し込む**。
 *
 * CSS grid の行番号は 1 始まりで、`gridAutoRows` は全行同じ高さになるため、
 * **`gridTemplateRows` を明示して「見出し行だけ低く」する**。
 *
 * ⚠ 定義（`panel.y`）は**書き換えない**。あくまで**描画時の行番号**を
 *   ずらすだけ。座標を書き換えると、保存された定義が見出しの有無で
 *   変わってしまい、区画を消したときに元へ戻せなくなる。
 *
 * @param groups  表示中の区画（見出しを持つものだけが対象）
 * @param panels  表示中のパネル
 * @returns {{headerRows:Set<number>, rowOf:(y:number)=>number, rowCount:number}}
 *   - `headerRows` … 見出し行を挿し込む「元の行番号」の集合
 *   - `rowOf(y)`   … 元の行 y が描画上どの行になるか（1 始まり）
 */
export function reserveHeaderRows(groups, panels, maxRow = 0) {
    const headerRows = new Set();
    for (const g of groups ?? []) {
        if (!String(g?.label ?? '').trim()) continue;
        const r = groupRect(g, panels);
        // 最上段（y=0）はグリッド上部の余白を使うので行は要らない
        if (r && r.y > 0) headerRows.add(r.y);
    }
    // 元の行 y の手前に、y より小さい見出し行の数だけ挿し込む
    const rowOf = (y) => {
        const n = Number(y) || 0;
        let shift = 0;
        for (const h of headerRows) if (h <= n) shift += 1;
        return n + shift + 1; // grid は 1 始まり
    };
    return { headerRows, rowOf, rowCount: (Number(maxRow) || 0) + headerRows.size };
}

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

/**
 * ⭐ **ドラッグ中の見た目だけを差し替える**（2026-08-12・定義には書かない）。
 *
 * ドラッグ中の座標は**一時的な表示状態**であって、保存される定義ではない。
 * 中間状態を定義に書くと:
 *   - 履歴がドラッグの途中経過で埋まる（Ctrl+Z が1セルずつになる）
 *   - 「JSON が変わった＝編集された」という素直な判定が使えなくなる
 * → **掴んでいる間はここで上書きして描き、離した時に1回だけ定義へ書く。**
 *
 * ⚠ **区画の枠もこれを通す。** パネルだけ差し替えると、ドラッグ中に
 *   枠だけが元の位置に取り残される（区画は所属パネルの外接矩形で描くため）。
 *
 * 2つの形を受ける（パネル1枚のドラッグと、区画ごとの移動で必要な形が違う）:
 *   - `{ id, patch }`  … 1枚だけ差し替える（パネルの移動・リサイズ）
 *   - `{ byId: { <id>: patch } }` … 複数をそれぞれ違う値で差し替える（区画ごと移動）
 *
 * @param panels  定義上のパネル配列
 * @param preview 上記いずれか。null / 空なら**同じ参照をそのまま返す**
 * @returns 差し替え後の配列
 */
export function applyLayoutPreview(panels, preview) {
    if (!preview) return panels;
    const list = Array.isArray(panels) ? panels : [];

    if (preview.byId && typeof preview.byId === 'object') {
        const map = preview.byId;
        if (Object.keys(map).length === 0) return panels;
        return list.map((p) => {
            const patch = map[String(p?.id)];
            return patch ? { ...p, ...patch } : p;
        });
    }

    if (preview.id != null && preview.patch) {
        const id = String(preview.id);
        return list.map((p) => (String(p?.id) === id ? { ...p, ...preview.patch } : p));
    }

    return panels;
}
