// ── Surface Engine（面の質感）───────────────────────────────────
//
// **パネル・区画の「面」をどう見せるか**だけを持つ層。
// 25 種の質感（`PANEL_VARIANTS`）と、タイトルの字面（`panelTitleSkin`）。
//
// ⚠ **配色は持たない**（それは Theme の担当）。この層は
//   「渡されたテーマの色を、どういう面として置くか」だけを決める。
//
// ⚠ **React に依存しない**（純粋にスタイルオブジェクトを作る関数の集まり）。
//   そのため素の Node でテストできる。依存を足さないこと。
//
// ## ⚠ ここの値は実機で詰めたもの（推測で動かさない）
//
// 角の丸み・線の太さ・余白・不透明度は、**実機のスクリーンショットを見て
// 決めた値**が多い。「きれいな数字」に丸めると見た目が崩れる。
// 変える時は必ず実機で確認すること。
// ────────────────────────────────────────────────────────────────

/** パネルの見た目（variant 別スタイル）。frameless は装飾なし。 */
/**
 * 「コーナーフレーム」＝四隅のカギ括弧だけの枠を作る。
 *
 * ⚠ スキーマ上のキーは `noc` のまま（表示名だけ変更）。
 *   キーを変えると既存ダッシュボードの `style.variant` が解決できなくなる。
 *
 * 全周の枠線を引かず、**角だけ L 字**にする。管制室のモニタ壁の意匠で、
 * 枠が主張しないぶん中身（数値やグラフ）が前に出る。
 *
 * 実装は `linear-gradient` を8枚重ねる方式にしてある。理由:
 *   - 疑似要素（::before/::after）は2つしか使えず、4隅×2辺には足りない
 *   - 余計な DOM を増やすと viz 側のレイアウト計算に影響する
 *   - **面積に比例する塗りではない**ので raster コストが小さい
 *     （viz-performance.md の方針。半透明の大面積塗りは避ける）
 *
 * @param color 線の色
 * @param len   カギ括弧の腕の長さ(px)
 * @param w     線の太さ(px)
 */
export function cornerBrackets(color, len = 14, w = 1) {
    const line = `linear-gradient(${color}, ${color})`;
    return {
        backgroundImage: Array(8).fill(line).join(', '),
        backgroundRepeat: 'no-repeat',
        // 左上（横・縦）/ 右上 / 左下 / 右下 の順
        backgroundSize: [
            `${len}px ${w}px`, `${w}px ${len}px`,
            `${len}px ${w}px`, `${w}px ${len}px`,
            `${len}px ${w}px`, `${w}px ${len}px`,
            `${len}px ${w}px`, `${w}px ${len}px`,
        ].join(', '),
        backgroundPosition: [
            'left top', 'left top',
            'right top', 'right top',
            'left bottom', 'left bottom',
            'right bottom', 'right bottom',
        ].join(', '),
    };
}

/**
 * カギ括弧の腕の長さを決める。
 *
 * ⚠ **背の低いパネルでは腕を詰める。** 既定の 11px のままだと、
 *   高さ 1 行（約 74px）のパネルで上下の括弧が近づきすぎ、
 *   **タイトルの上下に括弧が二重にあるように見える**（実機で発生）。
 *   パネル高の 1/6 を上限にして、腕どうしが視覚的に繋がらないようにする。
 */
export function bracketArmLength(panelHeightPx, base = 11) {
    if (!Number.isFinite(panelHeightPx) || panelHeightPx <= 0) return base;
    return Math.max(6, Math.min(base, Math.floor(panelHeightPx / 6)));
}

/**
 * 内側に罫を持つ質感（letterpress）で、中身を罫より内側に寄せるための余白。
 *
 * ⚠ **罫の位置（inset 5px）より大きい値**にすること。inset box-shadow は
 *   レイアウト上の場所を取らないので、この padding だけが
 *   「中身が罫を踏まない」ことを保証している。
 */
const PANEL_INNER_PAD = 6;

/**
 * パネル質感の一覧（表示名つき）。**インスペクタのドロップダウンはこれを使う。**
 *
 * ⚠ **UI 側にベタ書きしない。** 以前はインスペクタに直接並べていたため、
 *   質感を足すたびに「描画は対応したのに選べない」というズレが起きうる状態だった。
 *   `panelSurface()` の実装と**同じファイルに置いて**、増減を1か所で済ませる。
 *   区画（グループ）の質感選択も同じ一覧を使う（§groupSurface）。
 */
/**
 * **区画（グループ）で使えない質感**（2026-08-12 実機で確認）。
 *
 * CSS は流用できるが、**この2つは「中身がある箱」を前提にした造り**なので、
 * 中身を持たない区画（パネルの背面に敷く空の箱）では意図した絵にならない:
 *
 * | 質感 | 区画で何が起きるか |
 * |---|---|
 * | `polaroid` | 白縁は **`padding` で中身を押し込んで**作る。中身が無い区画では縁が成立せず、**印画面がベタ塗りの明るい面**になってパネルを覆う |
 * | `punchCard` | `clip-path` で輪郭を欠けさせる質感。区画では**濃い地がパネルの背面全体を覆い**、切り欠きだけが上辺に残って意図が伝わらない |
 *
 * ⚠ **「CSS が同じ＝流用できる」ではない。** `groupSurface` は
 *   `panelSurface` と**バイト単位で同じ値**を返すのに、実機では破綻していた
 *   （JSON 比較のテストだけでは検出できず、スクリーンショットで気づいた）。
 *   質感を足すときは「中身の有無に依存していないか」を必ず見る。
 */
export const GROUP_INCOMPATIBLE_VARIANTS = new Set(['polaroid', 'punchCard']);

/** 区画の質感として選べるもの（構造依存の2種を除いた一覧）。 */
export function groupVariants() {
    return PANEL_VARIANTS.filter((v) => !GROUP_INCOMPATIBLE_VARIANTS.has(v.value));
}

/** パネルの質感。**並びは「素っ気ない → 装飾的」**（基本形 → 光り物 → 紙もの → 画材）。
 *  ⚠ ラベルは短い名前だけにする（説明を括弧で足さない）。
 *    選択肢が25個あるので、括弧付きだと一覧が読めなくなる。 */
export const PANEL_VARIANTS = [
    // 基本形
    { value: 'frameless', label: '枠なし' },
    { value: 'outline', label: '枠線' },
    { value: 'card', label: 'カード' },
    { value: 'solid', label: '不透明' },
    { value: 'glass', label: 'すりガラス' },
    { value: 'underline', label: '上線' },
    { value: 'sideAccent', label: '左線' },
    { value: 'inset', label: '沈み込み' },
    { value: 'elevated', label: '浮き上がり' },
    // 管制・光り物
    { value: 'noc', label: 'コーナーフレーム' },
    { value: 'bracketSolid', label: 'コーナーフレーム＋地' },
    { value: 'neonEdge', label: 'ネオン管' },
    { value: 'holo', label: 'ホログラム' },
    { value: 'liquidGlass', label: 'Liquid Glass' },
    // 紙もの・図面
    { value: 'blueprint', label: '方眼紙' },
    { value: 'titleBlock', label: '表題欄' },
    { value: 'letterpress', label: '活版' },
    { value: 'ticket', label: '伝票' },
    { value: 'punchCard', label: 'パンチカード' },
    { value: 'polaroid', label: '印画紙' },
    { value: 'eink', label: '電子ペーパー' },
    // 手描きの画材
    { value: 'watercolor', label: '水彩' },
    { value: 'inkwash', label: 'インク＋水彩' },
    { value: 'pencil', label: '色鉛筆' },
    { value: 'crayon', label: 'クレヨン' },
];

export function panelSurface(theme, variant, bracketLen = 11) {
    if (variant === 'frameless') {
        return { background: 'transparent', border: 'none', boxShadow: 'none' };
    }
    if (variant === 'noc') {
        // NOC WALL：四隅のカギ括弧だけ。全周の枠線もタイトル下の区切り線も引かない。
        // 背景はごく薄く沈ませて、パネルの矩形だけそれとなく分かるようにする。
        return {
            // ⚠ `background`（一括）にすると、下の cornerBrackets が返す
            //   `backgroundImage` に**色のレイヤーごと上書きされて地が消える**。
            //   ライトテーマでパネルが暗いまま見える原因になっていた（実機で確認）。
            //   色は必ず `backgroundColor` で指定する。
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255,255,255,0.55)' : 'rgba(10, 18, 34, 0.42)',
            border: 'none',
            boxShadow: 'none',
            // ⚠ 腕は「短く・はっきり」。長いと枠線に見えてしまい、
            //    薄いと壁面ディスプレイでは消える（実機で調整）
            ...cornerBrackets(theme.bracketColor ?? `${theme.accent}66`, bracketLen, 1),
        };
    }
    if (variant === 'glass') {
        return { ...theme.panel.glass };
    }
    if (variant === 'outline') {
        // 塗りを持たない枠だけの質感。図形の上に重ねても下が透ける
        return {
            background: 'transparent',
            border: `1px solid ${theme.accent}66`,
            boxShadow: 'none',
        };
    }
    if (variant === 'bracketSolid') {
        // NOC の括弧＋不透明な地。背景エフェクトが強いときでも中身が読める
        return {
            // ⚠ cornerBrackets の backgroundImage に潰されるので backgroundColor で
            backgroundColor: theme.colorScheme === 'light' ? '#ffffff' : '#0c1424',
            border: 'none',
            boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
            ...cornerBrackets(theme.bracketColor ?? `${theme.accent}66`, bracketLen, 1),
        };
    }
    if (variant === 'underline') {
        // 上辺だけアクセント線。表形式を並べるときに軽くまとまる
        return {
            background: theme.colorScheme === 'light' ? 'rgba(255,255,255,0.7)' : 'rgba(14, 22, 40, 0.55)',
            border: 'none',
            borderTop: `2px solid ${theme.accent}`,
            boxShadow: 'none',
        };
    }
    if (variant === 'sideAccent') {
        // 左辺だけアクセント線。ステータス一覧のような縦積みに合う
        return {
            background: theme.colorScheme === 'light' ? 'rgba(255,255,255,0.7)' : 'rgba(14, 22, 40, 0.55)',
            border: 'none',
            borderLeft: `3px solid ${theme.accent}`,
            boxShadow: 'none',
        };
    }
    if (variant === 'inset') {
        // 沈み込み（内側の影）。押し込まれた計器盤のような質感
        return {
            background: theme.colorScheme === 'light' ? 'rgba(0,0,0,0.04)' : 'rgba(0, 0, 0, 0.3)',
            border: 'none',
            boxShadow:
                theme.colorScheme === 'light'
                    ? 'inset 0 2px 8px rgba(0,0,0,0.10)'
                    : 'inset 0 2px 10px rgba(0,0,0,0.55)',
        };
    }
    if (variant === 'elevated') {
        // 浮き上がり（強い影）。重要なパネルを1枚だけ持ち上げるとき
        return {
            background: theme.colorScheme === 'light' ? '#ffffff' : 'rgba(24, 34, 56, 0.95)',
            border: theme.panel.card.border,
            boxShadow: '0 14px 40px rgba(0,0,0,0.45)',
        };
    }
    if (variant === 'holo') {
        // ホログラム：斜めの薄い縞＋外周のリムライト。
        // ⚠ blur は使わない（backdrop-filter は文字のサブピクセルAAを殺し、
        //    面積に比例して重い。§viz-performance）。縞は repeating-linear-gradient
        //    の1枚だけなので raster が軽い
        const base = theme.colorScheme === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(14, 24, 44, 0.72)';
        return {
            backgroundColor: base,
            backgroundImage: `repeating-linear-gradient(115deg, ${theme.accent}0f 0px, ${theme.accent}0f 1px, transparent 1px, transparent 7px)`,
            border: `1px solid ${theme.accent}3d`,
            boxShadow: `inset 0 1px 0 ${theme.accent}33, 0 4px 18px rgba(0,0,0,0.32)`,
        };
    }
    if (variant === 'neonEdge') {
        // ネオン管：枠だけを強く光らせる。中身は暗いままにして数値を立てる
        return {
            backgroundColor: theme.colorScheme === 'light' ? 'rgba(255,255,255,0.86)' : 'rgba(8, 14, 28, 0.86)',
            border: `1px solid ${theme.accent}`,
            // ⚠ box-shadow は「静的」なら安い。アニメさせると毎フレーム再描画になる
            boxShadow: `0 0 0 1px ${theme.accent}33, 0 0 14px ${theme.accent}55, inset 0 0 12px ${theme.accent}1f`,
        };
    }
    if (variant === 'blueprint') {
        // 方眼紙：設計図の意匠。細い格子を2枚重ねる（16px と 80px）
        const line = theme.colorScheme === 'light' ? 'rgba(60,110,180,0.16)' : 'rgba(120,170,255,0.10)';
        const bold = theme.colorScheme === 'light' ? 'rgba(60,110,180,0.28)' : 'rgba(120,170,255,0.18)';
        return {
            backgroundColor: theme.colorScheme === 'light' ? 'rgba(238,244,252,0.9)' : 'rgba(9, 18, 34, 0.9)',
            backgroundImage:
                `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px),` +
                `linear-gradient(${bold} 1px, transparent 1px), linear-gradient(90deg, ${bold} 1px, transparent 1px)`,
            backgroundSize: '16px 16px, 16px 16px, 80px 80px, 80px 80px',
            border: `1px solid ${theme.accent}33`,
            boxShadow: 'none',
        };
    }
    if (variant === 'letterpress') {
        // 活版：**細いヘアラインの枠1本だけ**。
        //
        // ⚠ **二重罫にしない。** 以前は外罫＋内罫（4px 間隔）だったが、
        //   離れた2本の線は少し引くと**1本の太い帯**に見え、
        //   「線が太い」という印象になる（実機で確認して1本へ変更）。
        //   紙らしさは「線の細さ」と「地の色」で出し、線の本数では出さない。
        // ⚠ 影を付けない（活版は平ら）。animate もしない。
        const rgb = theme.colorScheme === 'light' ? '26, 31, 43' : '226, 221, 208';
        const ink = (a) => `rgba(${rgb}, ${a})`;
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(250, 248, 242, 0.92)' : 'rgba(20, 24, 34, 0.92)',
            // ヘアライン1本。濃さも落として、罫が主張しないようにする
            border: `1px solid ${ink(0.28)}`,
            boxShadow: 'none',
            // 中身を縁から少し離す（罫に文字やスクロールバーが貼り付かないように）
            padding: PANEL_INNER_PAD,
        };
    }
    if (variant === 'watercolor') {
        // 水彩のウォッシュ：輪郭線を引かず、**乾いた縁に顔料が寄る**現象
        // （エッジの濃まり）を inset shadow の2枚重ねで作る。
        // 中心はほぼ紙のまま、縁に向かってアクセントの顔料が濃くなる。
        // ⚠ backgroundImage を使うので色は backgroundColor で指定する（§background 一括の罠）
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255, 255, 253, 0.66)' : 'rgba(22, 30, 44, 0.6)',
            // 塗りムラ：一隅からの薄いウォッシュを1枚だけ（静的・面積の小さい塗り）
            backgroundImage: `radial-gradient(ellipse 120% 90% at 28% 18%, ${theme.accent}1f, transparent 70%)`,
            border: 'none',
            // 実機で「ほぼ普通のカード」に見えたため2回濃くした
            // （「もっと露骨に」のユーザー指示。24/2e → 2b/38 → 45/52）
            boxShadow: `inset 0 0 22px ${theme.accent}45, inset 0 0 5px ${theme.accent}52`,
            // 水の縁は角張らない。質感側で丸みを持つ（個別指定があれば後勝ちで上書きされる）
            borderRadius: 9,
            // ⚠ 水彩は「輪郭線を引かない」画材なので、CSS の内側グラデ（エッジの濃まり）
            //   は残す＝ここは CSS が構造的に苦手な部分ではない。
            //   canvas 側は**ウォッシュの外周がふらつく**ことだけを足す
            __handDrawn: 'watercolor',
        };
    }
    if (variant === 'crayon') {
        // クレヨン：**枠は canvas で実描画する**（`HandDrawnFrame`）。
        //
        // ⚠ v1.10.0 で CSS の枠を撤去した。`border` + `box-shadow` では
        //   直線・等間隔・均一な太さしか作れず、「線がふらつく／二度なぞる／
        //   紙の目でかすれる」という画材の本質が一つも出せなかった
        //   （ユーザー指摘：「小手先の CSS で理想とは遠い」）。
        //   ここは**紙の地だけ**を返し、線は handDrawn.js に任せる。
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255, 255, 255, 0.6)' : 'rgba(30, 27, 23, 0.72)',
            border: 'none',
            borderRadius: 12,
            // 実描画する画材（DpxDashboard が読んで canvas を敷く）
            __handDrawn: 'crayon',
        };
    }
    if (variant === 'pencil') {
        // 色鉛筆：**二度引きの輪郭線**（本線＋わずかにずれた薄い線）と、
        // アクセント色の斜めハッチング。手の角度（115deg）で、
        // holo（7px 間隔）より細かい 4px 間隔にして「塗り」に見せる
        const graphite =
            theme.colorScheme === 'light' ? 'rgba(52, 56, 64, 0.62)' : 'rgba(220, 224, 232, 0.5)';
        // ⚠ v1.10.0: 輪郭とハッチングは canvas で実描画する（handDrawn.js）。
        //   CSS の repeating-linear-gradient は**完全な直線・等間隔**なので、
        //   鉛筆の「線がふらつく・筆圧で濃さが変わる」が出せなかった。
        //   ここは紙の地と、紙に落ちる影だけを担当する。
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255, 255, 255, 0.62)' : 'rgba(18, 24, 36, 0.6)',
            border: 'none',
            boxShadow: `2.5px 2.5px 0 0 ${
                theme.colorScheme === 'light' ? 'rgba(52, 56, 64, 0.28)' : 'rgba(220, 224, 232, 0.2)'
            }`,
            __handDrawn: 'pencil',
        };
    }
    if (variant === 'inkwash') {
        // ペン画（インク＋淡彩）：くっきりしたインクの輪郭線と、
        // **線と重ならない位置に置いたウォッシュ**（淡彩は線からはみ出すのが流儀）。
        // 右下の box-shadow はペンの「入りと抜き」で線が太る癖の表現
        const ink =
            theme.colorScheme === 'light' ? 'rgba(38, 33, 25, 0.72)' : 'rgba(235, 228, 214, 0.6)';
        // ⚠ v1.10.0: インクの輪郭線は canvas で実描画する（handDrawn.js）。
        //   ウォッシュ（淡彩のにじみ）は面の表現なので CSS のまま残す
        //   ——「線」だけが CSS で表現できなかった部分だから。
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(253, 250, 243, 0.7)' : 'rgba(24, 28, 38, 0.7)',
            backgroundImage: `radial-gradient(ellipse 90% 70% at 16% 0%, ${theme.accent}38, transparent 64%)`,
            border: 'none',
            boxShadow: `3px 3px 0 -1px ${
                theme.colorScheme === 'light' ? 'rgba(38, 33, 25, 0.3)' : 'rgba(0, 0, 0, 0.5)'
            }`,
            __handDrawn: 'inkwash',
        };
    }
    if (variant === 'liquidGlass') {
        // Liquid Glass（iOS 26 / WWDC25）：**ほぼ透明な「厚いガラスのレンズ」**。
        // 既存の glass（すりガラス）との違いは、曇らせて隠すのではなく
        // **縁で光が屈折している**ように見せること。要素は4つ:
        //   (1) 上辺のスペキュラハイライト（inset 0 1px）＝光源の写り込み
        //   (2) 全周のヘアラインの明縁＋内側への光の回り込み（厚みの表現）
        //   (3) 下辺の分光（薄い虹の帯）＝WWDC25 キービジュアルの縁の虹
        //   (4) 浮遊感のある柔らかい落ち影
        // ⚠ backdrop-filter を使う（この質感の本質なので例外的に許容。
        //   ただし**動く背景と組み合わせると毎フレーム再ブラー**になるので、
        //   静的背景（グラデ／パターン系）との組み合わせを推奨）
        const isLight = theme.colorScheme === 'light';
        return {
            // 白濁させない：塗りは最小限にして「透けている」ことを最優先する
            // （初版 0.22 では白いカードに見えた。実機スクショで確認して下げた）
            backgroundColor: isLight ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.06)',
            // 4レイヤ：**湾曲したシートグレア**（上半分に大きく回り込む照り。
            // 平面のグラデでは「板」に、楕円の照りは「湾曲したガラス」に見える）／
            // 斜めの窓映り込み（反射ストリーク）／面の照度差／下辺の分光
            // ⚠ **ダークテーマでは光り物を大幅に絞る**（2026-08-12 ユーザー指摘「やりすぎ」）。
            //   暗い地では白いグレアが「油膜の汚れ」に見える。ダーク側は
            //   屈折（フィルタ）とヘアラインに語らせ、面の照りはほぼ消す
            // ⚠ **ダークは照りのレイヤを持たない**（分光ラインのみ）。
            //   微弱（2〜7%）でも紺地では「霧状の滲み」に見える（2026-08-12「まだ滲んでる」）。
            //   ダークのガラスらしさは縁の屈折・ヘアライン・スペキュラだけで出す
            backgroundImage: isLight
                ? `radial-gradient(ellipse 130% 70% at 50% -25%, rgba(255,255,255,0.36) 38%, rgba(255,255,255,0.09) 55%, transparent 68%), ` +
                  `linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.4) 36%, rgba(255,255,255,0.12) 46%, transparent 55%), ` +
                  `linear-gradient(165deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.02) 42%, rgba(255,255,255,0.1) 100%), ` +
                  'linear-gradient(90deg, transparent 16%, rgba(255,80,80,0.38) 36%, rgba(90,235,130,0.38) 52%, rgba(120,110,255,0.38) 68%, transparent 86%)'
                : 'linear-gradient(90deg, transparent 16%, rgba(255,80,80,0.22) 36%, rgba(90,235,130,0.22) 52%, rgba(120,110,255,0.22) 68%, transparent 86%)',
            backgroundRepeat: 'no-repeat',
            backgroundSize: isLight ? '100% 100%, 100% 100%, 100% 100%, 100% 2px' : '100% 2px',
            backgroundPosition: isLight ? '0 0, 0 0, 0 0, 0 100%' : '0 100%',
            border: 'none',
            boxShadow: [
                // (1) 上辺のスペキュラ
                `inset 0 1.5px 1px rgba(255,255,255,${isLight ? 0.95 : 0.4})`,
                // (2) ヘアラインの明縁＋光の回り込み（厚いガラスの縁）。
                //     ⚠ ダークの回り込みは半径・濃度とも最小に（広いと縁の霧になる）
                `inset 0 0 0 1px rgba(255,255,255,${isLight ? 0.7 : 0.24})`,
                `inset 0 0 ${isLight ? 24 : 8}px rgba(255,255,255,${isLight ? 0.42 : 0.06})`,
                // (3) 下縁の沈み＝ガラスの厚みが落とす内側の影
                `inset 0 -1.5px 2px rgba(30, 40, 60, ${isLight ? 0.22 : 0.4})`,
                // (4) 浮遊感（ガラスは面から浮いている）
                isLight ? '0 10px 30px rgba(24, 32, 48, 0.2)' : '0 10px 30px rgba(0, 0, 0, 0.5)',
            ].join(', '),
            // ⭐ レンズの屈折（本質）。SVG の変位マップで backdrop を縁だけ歪ませる。
            //   フィルタ定義は LiquidGlassDefs（DpxDashboard が常設。同一 DOM だから届く）。
            // ⚠ ダークは blur も saturate も掛けない（url のみ）。
            //   ソフトなグローの背景に 2px のブラーが乗るだけで全面の滲みに見える
            backdropFilter: isLight
                ? 'url(#dpx-liquid-lens) blur(2px) saturate(150%)'
                : 'url(#dpx-liquid-lens)',
            // カプセルに近い大きな丸み＝この材質の造形言語。
            // ダッシュボード側の radius 既定（2px）に任せると板ガラスに見えない
            borderRadius: 24,
        };
    }
    if (variant === 'polaroid') {
        // インスタント写真：**下辺だけ極端に広い白縁**。左右と上は細い。
        //
        // ⚠ この質感の肝は「四辺が非対称であること」。既存の質感はすべて
        //   四辺対称なので、対称にした瞬間ただの白いカードになる。
        // ⚠ 余白は `padding` で作る（border だと色が付いてしまい、
        //   「印画紙の白い縁」ではなく「太い枠線」に見える）。
        //   padding なら中身が押し込まれるだけで、地の色がそのまま縁になる。
        // ⚠ **白い縁だけでは「ただの白いカード」にしか見えない**（実機で確認）。
        //   印画紙に見せるには「**印画された面**」が縁と別の色で見えている必要がある。
        //
        // ⚠ 印画面は `background-image` ＋ **`background-clip: content-box`** で作る。
        //   `inset box-shadow` は padding box 全体を塗ってしまい**白縁ごと潰れる**ので使えない
        //   （content-box に限定する手段が box-shadow には無い）。
        //   backgroundColor（＝白紙）は padding box 全体に残るので、
        //   「白い縁の内側に印画面がある」状態が1要素で作れる。
        const paper = theme.colorScheme === 'light' ? '#fbfaf7' : '#ece9e3';
        const photo = theme.colorScheme === 'light' ? 'rgba(24,28,38,0.06)' : 'rgba(24,28,38,0.11)';
        return {
            backgroundColor: paper,
            backgroundImage: `linear-gradient(${photo}, ${photo})`,
            backgroundClip: 'content-box',
            backgroundOrigin: 'content-box',
            backgroundRepeat: 'no-repeat',
            border: 'none',
            // 印画紙は実体のある「もの」なので、ここだけは影を持たせる
            boxShadow:
                theme.colorScheme === 'light'
                    ? '0 2px 8px rgba(16,24,40,0.18)'
                    : '0 3px 12px rgba(0,0,0,0.5)',
            // 上・左右は細く、下だけ広い（写真の下に書き込む余白）
            padding: '11px 11px 32px',
            // ⚠ 印画紙の縁は角が立っている。丸めない
            borderRadius: 0,
        };
    }
    if (variant === 'punchCard') {
        // パンチカード：**上辺に等間隔の矩形ノッチ＋左上の角落とし**。
        //
        // ⚠ 輪郭そのものを欠けさせるので `clip-path` を使う。
        //   border では表現できない（border は矩形の外周にしか引けない）。
        // ⚠ clip-path は**枠線も一緒に切る**ので、border は使わず
        //   地の色だけで面を作る（切った断面に線は残らない）。
        // ⚠ 角丸と併用しない（clip-path が優先され、丸みは見えなくなる）。
        const card = theme.colorScheme === 'light' ? '#efe7d2' : 'rgba(46, 40, 28, 0.94)';
        // 上辺のノッチ：8等分の位置に凹みを作る。polygon の頂点を並べる
        const notches = [];
        const N = 8;
        for (let i = 0; i < N; i++) {
            const a = (i + 0.28) * (100 / N);
            const b = (i + 0.72) * (100 / N);
            notches.push(`${a.toFixed(2)}% 0`, `${a.toFixed(2)}% 7px`, `${b.toFixed(2)}% 7px`, `${b.toFixed(2)}% 0`);
        }
        return {
            backgroundColor: card,
            border: 'none',
            boxShadow: 'none',
            // 左上を斜めに落とす（カードの向きを示す実際の意匠）＋上辺のノッチ
            clipPath: `polygon(0 14px, 14px 0, ${notches.join(', ')}, 100% 0, 100% 100%, 0 100%)`,
            // ノッチのぶん中身を下げ、左上の角落としに文字がかからないようにする
            padding: '10px 8px 6px',
            borderRadius: 0,
        };
    }
    if (variant === 'titleBlock') {
        // 図面のタイトルブロック：右下だけ角を落とした枠。
        // 製図では表題欄が角にあるので、その意匠を borderImage ではなく
        // 単純な枠＋角のノッチで表す（DOM を増やさない）。
        // ⚠ 塗りは薄く。青焼きの地の上に「もう1枚の紙」として乗る想定
        const line = theme.colorScheme === 'light' ? 'rgba(20,40,70,0.4)' : `${theme.accent}55`;
        return {
            backgroundColor:
                theme.colorScheme === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(16, 46, 84, 0.62)',
            border: `1px solid ${line}`,
            // 右下に「表題欄」を思わせる二重線を1本だけ入れる
            boxShadow: `inset -1px -1px 0 0 ${line}, inset -4px -4px 0 -3px ${line}`,
        };
    }
    if (variant === 'eink') {
        // 電子ペーパー：影も光沢も持たない完全に平らな面。
        // ⚠ **影を付けない**。E Ink は反射型ディスプレイで、
        //   浮き上がりや発光は原理的に存在しない。付けると嘘になる
        return {
            backgroundColor: theme.colorScheme === 'light' ? '#e9e9e5' : 'rgba(24,24,24,0.9)',
            border: `1px solid ${theme.colorScheme === 'light' ? 'rgba(28,28,28,0.28)' : 'rgba(220,220,214,0.24)'}`,
            boxShadow: 'none',
        };
    }
    if (variant === 'ticket') {
        // 伝票：上辺だけミシン目風の点線。一覧を「札」に見せたいとき
        return {
            backgroundColor: theme.colorScheme === 'light' ? '#ffffff' : 'rgba(18, 26, 44, 0.94)',
            borderTop: `2px dashed ${theme.accent}66`,
            borderRight: 'none',
            borderBottom: 'none',
            borderLeft: 'none',
            boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
        };
    }
    if (variant === 'solid') {
        // 完全不透明。背景エフェクトの上でも中身のコントラストを保ちたいとき用
        return {
            background: theme.colorScheme === 'light' ? '#ffffff' : '#0c1424',
            border: theme.panelBorder,
            boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        };
    }
    return { ...theme.panel.card };
}

/**
 * パネル個別の色欄が「未指定のとき実際に効いている色」を返す。
 *
 * インスペクタの色欄に**実効値を表示する**ために使う。
 * ⚠ ここは**描画と同じ関数（`panelSurface`）から導く**こと。
 *   同じ値を手で書き写すと、質感（variant）を足したときに片方だけ古くなり、
 *   UI が実物と食い違う（＝この関数を作った動機そのもの）。
 *
 * @param key   'bg' | 'borderColor' | 'accent'
 * @param theme resolveTheme() の戻り値
 * @param variant パネルの質感（`panel.style.variant ?? defaultVariantFor(viz)`）
 * @returns CSS 色文字列。決められない場合は null
 */
export function effectivePanelColor(key, theme, variant) {
    if (key === 'accent') return theme?.accent ?? null;

    const surface = panelSurface(theme, variant);
    if (key === 'bg') {
        // panelSurface は variant により backgroundColor / background のどちらでも返す
        return surface.backgroundColor ?? surface.background ?? null;
    }
    if (key === 'borderColor') {
        // `border` は "1px solid <色>" の形。色の部分だけ取り出す。
        // 'none' の質感（noc など）は**枠線が無いのが実効値**なので none を返す
        const b = surface.border ?? surface.borderTop ?? surface.borderLeft;
        if (!b || b === 'none') return 'none';
        const m = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/.exec(String(b));
        return m ? m[1] : null;
    }
    return null;
}

/**
 * タイトルバーの質感（`panel.style.titleSkin`）。
 *
 * これまでタイトルは「左上・小さめ・大文字」で固定だった。パネルの質感は
 * 14 種選べるのにタイトルだけ動かせないのは不釣り合いなので、位置とあわせて
 * 選べるようにした。
 *
 * 返すのは 3 つ:
 *   box  … タイトルバー（外側の div）に足す CSS
 *   text … 文字そのものの CSS
 *   dot  … 先頭のアクセント丸を出すか
 *
 * ⚠ **`background`（一括指定）を使わないこと。** 一括プロパティは
 *   `background-image` を `none` にリセットするので、コーナーフレームの
 *   カギ括弧（linear-gradient 8枚）が消える。ここはパネル本体ではないが、
 *   同じ事故を繰り返さないよう `backgroundColor` / `backgroundImage` を使い分ける。
 *   （経緯は dpx-platform.md §8.jj）
 */
/**
 * 区画（グループ）の見出しの字面。**パネルのタイトル質感から導く**。
 *
 * ⚠ **独自にベタ書きしない**（2026-08-12・ユーザー指摘で修正）。
 *   以前は `fontSize: 10` / 字間 0.22em / 大文字を**区画だけ決め打ち**していたため、
 *   パネルのタイトル質感（`panelTitleSkin` の10種）を変えても区画名だけが
 *   取り残され、**「文字が小さい」「質感が違う」**状態になっていた。
 *   → **同じ関数から取り、区画らしく一段弱めるだけ**にする。
 *
 * 区画はパネルの「親」なので、**同じ字面のまま少しだけ控えめ**にする
 * （大きさで competing させない。字間と色で階層を作る）。
 *
 * @param skin  パネルと同じ質感キー（区画側で未指定ならダッシュボードの既定）
 */
export function groupTitleStyle(skin, theme, accent) {
    const base = panelTitleSkin(skin, theme, undefined, accent).text ?? {};
    const size = Number(base.fontSize) || 13;
    return {
        ...base,
        // ⚠ パネルより**わずかに小さく**（1px）。大きく差を付けると
        //   「小さくて読めない」になる（実機のスクリーンショットで指摘された症状）
        fontSize: Math.max(10, size - 1),
        // 親であることは**字間**で示す（大きさではなく）
        letterSpacing: base.letterSpacing ?? '0.14em',
        color: base.color ?? theme?.titleColor,
    };
}

export function panelTitleSkin(skin, theme, variant, accent) {
    const ac = accent || theme?.accent;
    // 管制ラベル（従来の noc）。小さめ・大文字・字間広め
    const control = {
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: theme?.subColor,
    };
    const plain = { fontSize: 13, fontWeight: 600, color: theme?.titleColor };

    switch (skin) {
        case 'plain':
            return { box: {}, text: plain, dot: false };
        case 'badge':
            // 従来のカード質感（丸＋通常の文字）
            return { box: {}, text: plain, dot: true };
        case 'bold':
            return {
                box: {},
                text: { ...plain, fontSize: 15, fontWeight: 800, letterSpacing: '0.01em' },
                dot: false,
            };
        case 'accentBar':
            // 左に太いアクセント帯。縦積みの一覧で見出しが立つ
            return {
                box: { boxShadow: `inset 3px 0 0 ${ac}`, paddingLeft: 14 },
                text: plain,
                dot: false,
            };
        case 'filled':
            // 見出しだけ地を敷く。パネルの中身と切り分けたいとき
            return {
                box: { backgroundColor: `${ac}1c` },
                text: { ...plain, color: ac },
                dot: false,
            };
        case 'ribbon':
            // 左端から伸びる帯。タイトルが「ラベル」として読める
            return {
                box: {
                    backgroundImage: `linear-gradient(90deg, ${ac}2e, transparent 62%)`,
                },
                text: { ...control, color: theme?.titleColor },
                dot: false,
            };
        case 'underline':
            // 下線つき（区切り線を明示する）
            return { box: {}, text: plain, dot: false, divider: true };
        case 'stamp':
            // ゴム印：二重の枠で囲った大文字・等幅のラベル。
            //
            // ⚠ **枠は `text`（文字の span）側に付ける。** `box` はタイトルバー
            //   （幅いっぱいの flex コンテナ）に当たるので、そちらに border を
            //   置くと**判子ではなく帯**になる（実機で確認して直した）。
            // ⚠ **傾けない**。transform を持たせると子孫の position:fixed が
            //   祖先基準になり、全画面表示とツールチップが壊れる（§8.z）。
            //   紙の意匠は枠と字間で出し、傾きには頼らない
            return {
                box: {},
                text: {
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: ac,
                    fontFamily: "'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    border: `2px solid ${ac}`,
                    // 外側にもう1本の細罫を回して「二重枠の判子」にする
                    boxShadow: `0 0 0 1px ${ac}`,
                    padding: '2px 8px',
                    borderRadius: 2,
                    // 枠が文字に貼り付くよう、span を行ボックスとして扱う
                    display: 'inline-block',
                    lineHeight: 1.35,
                },
                dot: false,
            };
        case 'mono':
            // 等幅。ID やホスト名を見出しにするとき桁が揃う
            return {
                box: {},
                text: {
                    ...control,
                    letterSpacing: '0.08em',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                },
                dot: false,
            };
        case 'control':
            return { box: {}, text: control, dot: false };
        default:
            // 'auto'（既定）＝ 従来どおり質感に追従する。
            // ⚠ ここを変えると**既存ダッシュボードの見た目が黙って動く**。
            //   判定は改修前とまったく同じ `variant === 'noc'` のみにする
            //   （bracketSolid まで含めると従来バッジだったものが変わってしまう）
            return variant === 'noc'
                ? { box: {}, text: control, dot: false }
                : { box: {}, text: plain, dot: true };
    }
}

/**
 * パネル個別の見た目上書きを CSS に落とす（`panel.style` の拡張分）。
 *
 * 質感プリセット（variant）だけでは「もっと自由に」に応えられないので、
 * 1枚ごとに効かせられるつまみを用意する。**未指定のキーは触らない**
 * （プリセットの値をそのまま活かすため、既定値で上書きしない）。
 *
 *   accent      … このパネルだけアクセント色を変える（タイトルの丸・枠の発光）
 *   bg          … 背景色の直接指定
 *   opacity     … パネル全体の不透明度（背面の図形を透かす）
 *   radius      … 角の丸み
 *   borderColor … 枠線の色
 *   glow        … 枠の外側に出す発光の強さ（0〜1）
 *   blur        … 背面のぼかし（すりガラスの強さ）
 *   rotate      … 傾き（deg）。⚠ transform は position:fixed を壊すので
 *                  0 のときは指定そのものを出さない（§8.z）
 */
/**
 * パネルグループの枠。**複数パネルを1つの領域としてくくる**ための意匠。
 *
 * Studio では iframe の外に描けないので作れない（＝DPX 固有）。
 *
 * 意匠の方針（既存の DPX 言語に合わせる）:
 *   - **新しい色を持ち込まない。** 既定は `t.bracketColor` と同系の中性色。
 *     グループが主張すると中身（数値・グラフ）が引っ込むため
 *   - **塗らない。** 面積に比例する半透明の塗りは raster が重く、
 *     性能方針（§7.1）に反する。枠と見出しだけで領域を示す
 *   - 角の丸みはテーマの `radius` に従う（ここだけ丸いと浮く）
 *
 * ⭐ **質感は `panelSurface()` をそのまま流用する**（2026-08-12・ユーザー指定）。
 * 区画専用の質感を別実装で持つと、**質感を足すたびに2か所を直す**ことになり
 * 必ず片方が古くなる（`radius` を決め打ちして全廃した前科と同じ構図）。
 * 区画固有なのは `rule`（上辺の罫＋下辺の返し）だけで、
 * **残り20種はパネルと同じ関数から取る**。
 *
 * ⚠ 流用にあたっての注意:
 *   - **カギ括弧の腕はパネルより長くする**（区画の方が大きいので、
 *     同じ 11px だと角の印が小さすぎて枠に見えない）
 *   - `色` を指定されたときは**枠線系のプロパティだけ**上書きする
 *     （地色まで塗り替えると質感の意図が壊れる）
 *
 * @param variant 'rule'（既定・区画固有）ほか `PANEL_VARIANTS` の全種
 */
export function groupSurface(theme, variant = 'rule', color) {
    const c = color || theme.bracketColor || `${theme.accent}66`;

    // ⭐ 区画固有の `rule` 以外は**パネルの質感をそのまま使う**。
    //   区画は面積が大きいので、カギ括弧の腕だけ長め（22px）にする。
    // ⚠ 中身がある前提の質感（polaroid / punchCard）は区画では破綻するので、
    //   既存の定義に入っていても**既定（rule）に落とす**（黙って壊れた絵を出さない）
    if (variant && variant !== 'rule' && !GROUP_INCOMPATIBLE_VARIANTS.has(variant)) {
        const surface = panelSurface(theme, variant, 22);
        if (!color) return surface;

        // 色の指定があるときは**もともと線を持っているプロパティだけ**差し替える。
        // ⚠ `panelSurface` は「線なし」を **`border: 'none'`** で表す（truthy）。
        //   単純に `if (tinted.border)` で書き換えると、
        //   **コーナーフレームに全周の枠が生えたり、枠なしに枠が付く**
        //   （実際にこの実装で発生させ、値を出力して気づいた）。
        //   `none` を除外し、**線幅と種別は元のまま**色だけ入れ替える。
        const tinted = { ...surface };
        const recolor = (v) => {
            if (typeof v !== 'string' || v === 'none' || !v.trim()) return v;
            // 「<幅> <種別> <色>」の色だけを置き換える（幅・種別は質感の意図）
            const m = v.match(/^(\S+\s+\S+)\s+.+$/);
            return m ? `${m[1]} ${c}` : v;
        };
        for (const k of ['border', 'borderTop', 'borderLeft', 'borderRight', 'borderBottom']) {
            if (k in tinted) tinted[k] = recolor(tinted[k]);
        }
        // コーナーフレーム系は backgroundImage が線そのものなので引き直す
        if (variant === 'noc' || variant === 'bracketSolid') {
            Object.assign(tinted, cornerBrackets(c, 22, 1));
        }
        return tinted;
    }
    // 既定＝**上辺の罫＋下辺の返し**（設計図の表題欄の語彙）。
    //
    // ⚠ 当初は四隅のカギ括弧にしたが、**パネルの `noc` 質感と見分けが付かなかった**
    //   （実機のスクリーンショットで確認。腕の長さを変えても、括弧が並ぶだけで
    //   「どれがグループでどれがパネルか」が読めない）。
    //   グループは**パネルが持たない device** を使う必要がある。
    //
    // ⚠ **上辺の罫だけでは「区画の終わり」が分からない**（2026-08-12・2x 拡大で判明）。
    //   下に境界が無いので、次のパネルとの境目が読めなかった。
    //   → **下辺の左右だけに短い垂直の「返し」**を足す。全周を囲うと
    //   パネルの枠と競合するので、**線量は最小**にして区画の下端だけを示す。
    //
    // 実装は linear-gradient の重ね（`cornerBrackets` と同じ方式）。
    // 面積比例の塗りではないので raster が軽い（§7.1 の性能方針）。
    // ⚠ 返しを**垂直線**にしたら、パネルのカギ括弧と近接して
    //   「見分けが付かない一塊」に見えた（2x 拡大で確認）。
    //   → **水平の短い罫**にする。上辺の罫と同じ語彙なので
    //   「同じものの下端」と読め、括弧（パネル）とは競合しない。
    const line = `linear-gradient(${c}, ${c})`;
    const RETURN_W = 26; // 返しの長さ(px)。上辺の罫の「続き」に見える程度に短く
    return {
        borderRadius: 0,
        backgroundColor: 'transparent',
        borderTop: `1px solid ${c}`,
        backgroundImage: [line, line].join(', '),
        backgroundRepeat: 'no-repeat',
        backgroundSize: [`${RETURN_W}px 1px`, `${RETURN_W}px 1px`].join(', '),
        backgroundPosition: ['left bottom', 'right bottom'].join(', '),
    };
}

export function panelStyleOverrides(style = {}, theme) {
    const css = {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

    // ⚠ **`background`（一括）で書いてはいけない。**
    //   一括プロパティは `background-image` を `none` にリセットするので、
    //   コーナーフレーム（`cornerBrackets()` が敷く linear-gradient 8枚）が
    //   **丸ごと消える**。`style.bg` を触った瞬間に枠が無くなり、
    //   色を戻しても枠は戻らない（実機で発生。`bg` が空文字でない限り消え続ける）。
    //   `transparent` に限らず**どんな色でも**同じ。必ず backgroundColor で書く。
    //   `''`（未指定）は下の if で弾かれるので、プリセットの地がそのまま残る。
    if (style.bg) css.backgroundColor = style.bg;
    if (style.borderColor) css.border = `1px solid ${style.borderColor}`;

    const radius = num(style.radius);
    if (radius !== null) css.borderRadius = radius;

    const opacity = num(style.opacity);
    if (opacity !== null && opacity < 1) css.opacity = Math.max(0, opacity);

    const glow = num(style.glow);
    if (glow) {
        const c = style.accent || theme.accent;
        css.boxShadow = `0 0 ${Math.round(glow * 40)}px ${c}${Math.round(
            Math.min(Math.max(glow, 0), 1) * 120
        )
            .toString(16)
            .padStart(2, '0')}`;
    }

    const blur = num(style.blur);
    if (blur) css.backdropFilter = `blur(${blur}px)`;

    const rotate = num(style.rotate);
    // ⚠ 0 のときは transform を書かない。transform があるだけで子孫の
    //   position:fixed が壊れる（全画面・ツールチップが消える。§8.z）
    if (rotate) css.transform = `rotate(${rotate}deg)`;

    return css;
}
