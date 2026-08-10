import {
    VisualizationExtensionProvider,
    useDataSources,
    useMode,
    useOptions,
    useTheme,
} from '@splunk/dashboard-studio-extension/react';
// ドリルダウン API は /react ではなくコア側にある（公式 docs の記載は誤り。
// 型定義 visualization.d.mts の export 一覧で確認済み）。
import { addDrilldownListener } from '@splunk/dashboard-studio-extension/visualization';
import Paragraph from '@splunk/react-ui/Paragraph';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { SplunkThemeProvider } from '@splunk/themes';
import { geoBounds, geoGraticule10, geoNaturalEarth1, geoPath } from 'd3-geo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { feature, mesh } from 'topojson-client';
import worldTopo from 'world-atlas/countries-110m.json';
import worldTopo50 from 'world-atlas/countries-50m.json';
import CITY_DATA from './data/cities.json';
import COUNTRY_JA from './data/country-names-ja.json';
import './visualization.css';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
// 色分けの基準となる列（categoryField）は **何でもよい**。
// severity（深刻度）とは限らず、ログ種別・プロトコル・部署・ステータス等、
// ユーザーが選んだ任意の文字列カテゴリを色分けに使える。
//
// 【設計方針】色の決定は「ユーザーが明示したものだけ」に依存する
//   この viz は以前 KNOWN_SEVERITY_ORDER（critical→high→medium→low）で
//   カテゴリを勝手に並べ替え、その順にパレットを配っていた。これは
//   「色分けの基準は深刻度である」という前提を viz が押し付けるもので、
//   ログ種別（`auth` / `firewall` / `dns` …）のような語彙では
//   **並び順に意味が無いのに色だけ勝手に決まる**という問題があった。
//
//   現在は「カテゴリ名 → 色」をユーザーが editor.arrayOfStrings で
//   1行ずつ明示する。viz 側の語彙推測・自動解釈は一切行わない。
//   マッピングに無いカテゴリは fallbackColor（既定色）で描く。
//
// 明示マッピングが1件も無いときだけ、見た目が壊れないよう最低限の
// 既定色として使う（ユーザーが色を決めていない状態のプレースホルダ）。
const DEFAULT_CATEGORY_COLOR = '#38a6ff';

/**
 * 「カテゴリ名|色」形式の行（editor.arrayOfStrings）を解釈して
 * Map<カテゴリ名(小文字), 色文字列> を返す。
 *
 * 受け付ける書式（tab-selector の「表示名|トークン値」と同じ区切り文字）:
 *   "high|#ff0000"      → high を赤
 *   "auth | #00ff00"    → 空白は無視
 *   "firewall|red"      → CSS 色名も可（parseColor が解釈できるものはそのまま使う）
 *
 * 色が解釈できない行・区切りが無い行は**黙って捨てる**（描画を壊さない）。
 * 大文字小文字は同一視する（`High` と `high` を別カテゴリにしない）。
 */
function parseCategoryColorMap(raw) {
    const map = new Map();
    if (!Array.isArray(raw)) return map;
    raw.forEach((line) => {
        if (typeof line !== 'string') return;
        const sep = line.indexOf('|');
        if (sep < 0) return;
        const name = line.slice(0, sep).trim();
        const color = line.slice(sep + 1).trim();
        if (name === '' || color === '') return;
        // parseColor で解釈できる色だけ採用（不正値で描画が壊れるのを防ぐ）
        if (parseColor(color) === null) return;
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, color);
    });
    return map;
}

// ライト/ダークモード別の地図配色
const MAP_PALETTES = {
    dark: {
        containerBg: '#03080f',
        bgStops: [
            { offset: '0%', color: '#0a1a33' },
            { offset: '60%', color: '#061224' },
            { offset: '100%', color: '#03080f' },
        ],
        landGlow: '#1d5aa8',
        landGlowOpacity: 0.4,
        landFill: '#0d2b52',
        landStroke: '#3d84d6',
        landStrokeOpacity: 0.35,
        titleColor: '#f2f6fb',
        titleShadow: '0 0 14px rgba(60, 140, 255, 0.6)',
        panelBg: 'rgba(10, 22, 42, 0.94)',
        panelBorder: '1px solid rgba(90, 140, 200, 0.35)',
        legendBg: 'rgba(10, 22, 42, 0.92)',
        legendBorder: '1px solid rgba(90, 140, 200, 0.25)',
        legendText: '#e8eef6',
        // 地名ラベル（地図由来）と始点/終点ラベル（データ由来）。
        // labelHalo は文字の縁取り色（背景に溶けず読めるようにする）
        placeLabel: '#cfe0f5',
        endpointLabel: '#ffffff',
        labelHalo: 'rgba(3, 8, 15, 0.9)',
        // 経緯線（graticule）。管制室らしさを出す薄いグリッド
        graticule: '#3d84d6',
        graticuleOpacity: 0.1,
        // HUD の LIVE インジケータ
        liveDot: '#ff5a2e',
    },
    light: {
        containerBg: '#dde7f2',
        bgStops: [
            { offset: '0%', color: '#f6fafe' },
            { offset: '60%', color: '#e9f0f8' },
            { offset: '100%', color: '#dde7f2' },
        ],
        landGlow: '#9db8d8',
        landGlowOpacity: 0.35,
        landFill: '#c3d4e6',
        landStroke: '#6f96c2',
        landStrokeOpacity: 0.6,
        titleColor: '#16283e',
        titleShadow: '0 0 10px rgba(255, 255, 255, 0.8)',
        panelBg: 'rgba(252, 254, 255, 0.96)',
        panelBorder: '1px solid rgba(90, 140, 200, 0.45)',
        legendBg: 'rgba(252, 254, 255, 0.94)',
        legendBorder: '1px solid rgba(90, 140, 200, 0.35)',
        legendText: '#24354a',
        placeLabel: '#31445c',
        endpointLabel: '#0e1a29',
        labelHalo: 'rgba(255, 255, 255, 0.92)',
        graticule: '#6f96c2',
        graticuleOpacity: 0.16,
        liveDot: '#d63a12',
    },
};

// ---------------------------------------------------------------------------
// オーバーレイ UI（タイトル・フィルタ・凡例・フロー一覧）の共通の質感。
// 【v2.2.0】以前はフロー一覧だけ別の色・角丸・影を持っていて、
// 折りたたみピルがカテゴリフィルタの隣に来ると質感が揃わなかった。
// 角丸・影・ぼかしはここに集約し、全オーバーレイで同じ値を使う。
// ---------------------------------------------------------------------------
const OVERLAY_RADIUS = 10;
const OVERLAY_SHADOW = '0 6px 24px rgba(0, 0, 0, 0.28)';
// 【v2.1.0】backdrop-filter(blur) は全廃した。
//   1. オーバーレイが専用コンポジタレイヤーになり、**文字のサブピクセル AA が
//      無効化されて小さい文字がぼやける**（実機スクリーンショットの拡大で確認）
//   2. 下のアニメーションが動くたびに毎フレーム再ブラーされ、合成コストを食う
// 代わりに背景の不透明度を上げて（0.92〜0.96）読みやすさとガラス調の両立を図る。
// オーバーレイ同士の間隔（px）。フィルタとフロー一覧のピルが重ならないよう、
// 右上に縦積みするときの段の高さにも使う
const OVERLAY_GAP = 8;

// ---------------------------------------------------------------------------
// 色ユーティリティ
// （ユーザーが設定した線の色から、ホットスポットのグローと中心点の色を導出する）
// Splunkのカラーピッカーは "transparent" やアルファ付きhex（#RRGGBBAA）を
// 返すことがあるため、{r, g, b, a} に正規化して扱う
// ---------------------------------------------------------------------------
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// 手入力（editor.arrayOfStrings の「カテゴリ名|色」）で使われやすい色名。
// tint/shade でトーンを導出する都合上 {r,g,b} が必要なため、
// ブラウザ任せにせず自前で hex に解決する。ここに無い色名は hex 指定を促す。
const NAMED_COLORS = {
    red: '#ff0000', crimson: '#dc143c', orange: '#ffa500', gold: '#ffd700',
    yellow: '#ffff00', lime: '#00ff00', green: '#008000', teal: '#008080',
    cyan: '#00ffff', aqua: '#00ffff', blue: '#0000ff', navy: '#000080',
    purple: '#800080', magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb',
    brown: '#a52a2a', white: '#ffffff', black: '#000000', gray: '#808080',
    grey: '#808080', silver: '#c0c0c0',
};

// 色文字列を {r, g, b, a} へ変換。解釈できない値は null
function parseColor(value) {
    if (typeof value !== 'string') return null;
    let v = value.trim().toLowerCase();
    if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMED_COLORS[v]) v = NAMED_COLORS[v];
    if (!HEX_RE.test(v)) return null;
    let h = v.slice(1);
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
}

function toCss({ r, g, b, a }) {
    return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

// 既存の色（{r,g,b,a}）に不透明度を掛けた CSS 文字列を作る。
// Canvas のグラデーションは SVG の stopOpacity に相当するものが無いため、
// 色そのものにアルファを載せて同じ見た目を作る（v2.2.0）
function withAlpha(c, alpha) {
    if (!c) return 'rgba(0, 0, 0, 0)';
    return toCss({ r: c.r, g: c.g, b: c.b, a: (c.a ?? 1) * alpha });
}

// 白と混ぜて明るいトーンを作る（amount: 0=元の色, 1=白）。アルファは維持
function tint(c, amount) {
    const mix = (v) => Math.round(v + (255 - v) * amount);
    return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: c.a };
}

// 黒と混ぜて暗いトーンを作る（amount: 0=元の色, 1=黒）。アルファは維持
function shade(c, amount) {
    const mix = (v) => Math.round(v * (1 - amount));
    return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: c.a };
}

// ---------------------------------------------------------------------------
// 世界地図（ビルド時にバンドルされるため実行時のインターネット通信は不要）
// ---------------------------------------------------------------------------
const WORLD = (() => {
    try {
        const geo = feature(worldTopo, worldTopo.objects.countries);
        geo.features = geo.features.filter((f) => f?.properties?.name !== 'Antarctica');
        return geo;
    } catch (e) {
        return null;
    }
})();

// 高詳細の国境（Natural Earth 50m 相当）。世界全体表示では 110m で十分なため、
// 初めて必要になったときに一度だけデコードして使い回す（初期表示を遅くしない）。
// デコードに失敗しても 110m へ退避して描画は続ける。
let WORLD_50M_CACHE = null;
function getWorld50() {
    if (WORLD_50M_CACHE) return WORLD_50M_CACHE;
    try {
        const geo = feature(worldTopo50, worldTopo50.objects.countries);
        geo.features = geo.features.filter((f) => f?.properties?.name !== 'Antarctica');
        WORLD_50M_CACHE = geo;
    } catch (e) {
        WORLD_50M_CACHE = WORLD;
    }
    return WORLD_50M_CACHE;
}

// 経緯線（10度間隔）。地理座標のまま持ち、描画時に現在の投影でパス化する
const GRATICULE = (() => {
    try {
        return geoGraticule10();
    } catch (e) {
        return null;
    }
})();

// 国境の階層表現に使う「海岸線」と「内側の国境」。
// 従来は全フィーチャの外形をまとめて同じ線で描いていたため、隣接国の共有国境が
// 二重に引かれ、海岸線と内陸国境の区別も無かった。topojson の mesh で
//   - 海岸線（どのポリゴンにも共有されない辺）→ 明るめの線
//   - 内側の国境（2国に共有される辺）→ 薄い線
// に分離する。ビューポート絞り込みを効かせるため、MultiLineString を
// 1本ずつの LineString フィーチャに割って経緯度バウンディングボックスを付与する。
const BORDER_CACHE = new Map(); // world(FeatureCollection) → { coast: [], inner: [] }

function getBorders(world) {
    if (BORDER_CACHE.has(world)) return BORDER_CACHE.get(world);
    const topo = world === WORLD ? worldTopo : worldTopo50;
    let out = { coast: [], inner: [] };
    try {
        // 陸地の描画から除いている南極は、線も引かない
        const notAnt = (g) => g?.properties?.name !== 'Antarctica';
        const toLines = (m) => {
            const lines = m.type === 'MultiLineString' ? m.coordinates : [m.coordinates];
            return lines.map((coords) => {
                const f = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
                try {
                    f.__bounds = geoBounds(f);
                } catch (e) {
                    f.__bounds = null;
                }
                return f;
            });
        };
        out = {
            coast: toLines(mesh(topo, topo.objects.countries, (a, b) => a === b && notAnt(a))),
            inner: toLines(mesh(topo, topo.objects.countries, (a, b) => a !== b && notAnt(a) && notAnt(b))),
        };
    } catch (e) {
        /* 国境線は装飾。失敗しても陸地の塗りだけで描画は成立する */
    }
    BORDER_CACHE.set(world, out);
    return out;
}

// mapDetail='auto' の 110m ↔ 50m 切替ズーム。
// 上げるとき（IN）と下げるとき（OUT）をずらしたヒステリシスにして、
// しきい値付近のズーム操作で詳細度がパカパカ切り替わるのを防ぐ。
// IN=4 は実測に基づく：50m は画面内の国だけに絞ってもパス生成が
// zoom3 で約31ms/フレームと重く、zoom4 以上なら約16ms以下に収まる。
const DETAIL_ZOOM_IN = 4;
const DETAIL_ZOOM_OUT = 3;

// ---------------------------------------------------------------------------
// ビューポート絞り込み（50m 国境を操作中も使い続けるための最適化）
// ---------------------------------------------------------------------------
// 50m の全 242 フィーチャを毎フレーム投影すると約 60ms/フレームかかり、
// ドラッグ / ズームがカクつく。ズーム中は画面に映る国が数個〜数十個しか
// 無いため、**フィーチャの経緯度バウンディングボックスが画面と重なるものだけ**
// パス生成する（zoom6 で 15/242 件・約13ms/フレームまで下がる実測）。

// 各フィーチャの経緯度バウンディングボックスを一度だけ計算して付与する
function ensureFeatureBounds(world) {
    if (!world || world.__boundsReady) return;
    try {
        world.features.forEach((f) => {
            f.__bounds = geoBounds(f);
        });
        world.__boundsReady = true;
    } catch (e) {
        /* 失敗しても絞り込み無しで描けるので握りつぶす */
    }
}

// 画面の枠を逆投影して「見えている経緯度範囲」を求める。
// 経度は中心経度からの角距離（±180 をまたいでも壊れない形）で持つ。
// 逆投影が十分に取れない（＝ほぼ世界全体が見えている）場合は null ＝絞り込み無し。
function viewportGeoBounds(projection, size, centerLon) {
    if (!projection || !projection.invert || !size) return null;
    const { w, h } = size;
    let dLon = 0;
    let minLat = 90;
    let maxLat = -90;
    let ok = 0;
    const SAMPLES = 16;
    for (let i = 0; i < SAMPLES; i += 1) {
        const t = i / (SAMPLES - 1);
        const pts = [[t * w, 0], [t * w, h], [0, t * h], [w, t * h]];
        for (const [x, y] of pts) {
            const g = projection.invert([x, y]);
            if (!g || !g.every(Number.isFinite)) continue;
            ok += 1;
            const d = Math.abs((((g[0] - centerLon) % 360) + 540) % 360 - 180);
            if (d > dLon) dLon = d;
            if (g[1] < minLat) minLat = g[1];
            if (g[1] > maxLat) maxLat = g[1];
        }
    }
    if (ok < SAMPLES) return null; // 枠の多くが地図の外＝広域表示。絞り込み不要
    return {
        dLon: Math.min(dLon * 1.15 + 2, 180), // 端でのポップイン防止マージン
        minLat: minLat - 3,
        maxLat: maxLat + 3,
    };
}

// フィーチャのバウンディングボックスが表示範囲と重なるか（経度は円環として判定）
function featureInView(f, vb, centerLon) {
    const b = f.__bounds;
    if (!b) return true; // バウンディングボックスが無ければ安全側（描く）
    const [[west, south], [east, north]] = b;
    if (north < vb.minLat || south > vb.maxLat) return false;
    if (west > east) return true; // 反対経線をまたぐ広大なフィーチャは保守的に描く
    const dw = ((((west - centerLon) % 360) + 540) % 360) - 180;
    const de = ((((east - centerLon) % 360) + 540) % 360) - 180;
    const d = dw <= 0 && de >= 0 ? 0 : Math.min(Math.abs(dw), Math.abs(de));
    return d <= vb.dLon;
}

// 国名ラベルの表示位置（各国ポリゴンの重心を経緯度で保持）。
// 投影は毎フレーム変わるので、ここでは地理座標のままにしておき描画時に投影する。
// 面積の小さい国は低ズームで潰れるため、面積順でしきい値を持たせる。
const COUNTRY_LABELS = (() => {
    if (!WORLD) return [];
    try {
        const path = geoPath(geoNaturalEarth1());
        return WORLD.features
            .map((f) => {
                const name = f?.properties?.name;
                if (!name) return null;
                const c = path.centroid(f);
                if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
                // 投影平面上の面積を「表示に値する大きさ」の代理指標にする
                const area = Math.abs(path.area(f)) || 0;
                // 重心を経緯度へ戻す（描画時に現在の投影で投影し直すため）
                const inv = geoNaturalEarth1().invert ? geoNaturalEarth1().invert(c) : null;
                if (!inv || !Number.isFinite(inv[0]) || !Number.isFinite(inv[1])) return null;
                // 日本語国名（Natural Earth admin-0 の NAME_JA 由来・パブリックドメイン）
                return { name, ja: COUNTRY_JA[name] || '', lon: inv[0], lat: inv[1], area };
            })
            .filter(Boolean)
            .sort((a, b) => b.area - a.area);
    } catch (e) {
        return [];
    }
})();

// 都市ラベル（Natural Earth ne_10m_populated_places / パブリックドメイン）。
// [name, lon, lat, scalerank, isCapital, name_ja?] のタプル配列。scalerank は小さいほど主要。
// 重要度順にソート済みなので、ズームに応じて先頭から N 件を採用すればよい。
// 6要素目の日本語名（NAME_JA）は英語名と同じ場合に省略されている。
const CITY_LABELS = (() => {
    try {
        if (!Array.isArray(CITY_DATA)) return [];
        return CITY_DATA.map((c) => {
            if (!Array.isArray(c) || c.length < 4) return null;
            const [name, lon, lat, rank, cap, ja] = c;
            if (typeof name !== 'string' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
                return null;
            }
            return {
                name,
                ja: typeof ja === 'string' ? ja : '',
                lon,
                lat,
                rank: Number(rank) || 0,
                capital: cap === 1,
            };
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
})();

// ---------------------------------------------------------------------------
// カメラ（ズーム / 中心座標）
// ---------------------------------------------------------------------------
// zoom=1 が「世界全体がパネルに収まる」状態。地図アプリと同じくホイールで
// 拡大縮小し、ドラッグでパンする。上限は都市名が読める程度まで。
const ZOOM_MIN = 1;
const ZOOM_MAX = 40;
// ホイール1ノッチあたりの倍率（トラックパッドの細かい delta でも滑らかに効く）
const ZOOM_WHEEL_SENSITIVITY = 0.0015;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// 経度は -180..180 に正規化（入力が 190 や -400 でも破綻させない）
function wrapLon(lon) {
    let v = ((lon + 180) % 360 + 360) % 360 - 180;
    if (!Number.isFinite(v)) v = 0;
    return v;
}

/**
 * ズーム段階に応じて表示するラベルを決める。
 *
 * 低ズームでは主要国のみ、拡大するほど小さい国 → 主要都市 → 地方都市の順に
 * 現れる（地図アプリの挙動）。件数を絞ることで文字の洪水と描画負荷を防ぐ。
 */
/**
 * カメラ（中心経緯度＋ズーム）から投影を作る。
 *
 * 描画とズーム計算の両方がこの関数を通ることで、「画面上のどこが
 * どの地理座標か」の解釈が必ず一致する（食い違うとホイールズームが
 * カーソル位置からずれる）。
 *
 *   - 経度方向は rotate で回す（東西の継ぎ目が出ない）
 *   - 緯度方向は投影後の translate で寄せる（rotate すると図法が歪むため）
 */
function makeProjection(size, camera) {
    if (!WORLD || !size) return null;
    try {
        const { w, h } = size;
        // 世界全体がちょうど収まる基準スケール（zoom=1 の定義）
        const baseScale = geoNaturalEarth1().fitSize([w, h], WORLD).scale();
        const projection = geoNaturalEarth1()
            .rotate([-camera.lon, 0])
            .scale(baseScale * camera.zoom)
            .translate([w / 2, h / 2]);
        const centerPt = projection([camera.lon, camera.lat]);
        if (centerPt && centerPt.every(Number.isFinite)) {
            projection.translate([
                w / 2 - (centerPt[0] - w / 2),
                h / 2 - (centerPt[1] - h / 2),
            ]);
        }
        return projection;
    } catch (e) {
        return null;
    }
}

function labelBudget(zoom, density) {
    // density: 地名の表示量の倍率（ユーザー設定。1 = 標準）
    const k = Number.isFinite(density) && density > 0 ? density : 1;
    // 国: zoom1 で 14 件、zoom8 以上でほぼ全件
    const countries = Math.round(
        clamp((10 + (zoom - 1) * 14) * k, 10, COUNTRY_LABELS.length || 10)
    );
    // 都市: zoom<2 では出さない（世界表示では国名だけの方が読みやすい）。
    // 上限はデータ件数そのもの（画面内に絞ってから採るので、
    // 実際に描かれる数は重なり判定で自然に頭打ちになる）。
    let cities = 0;
    if (zoom >= 2) {
        cities = Math.round(clamp((zoom - 2) * 40 * k + 20 * k, 0, CITY_LABELS.length || 0));
    }
    return { countries, cities };
}

// ---------------------------------------------------------------------------
// 件数（count）しきい値の色分け（colorMode='count'）
// ---------------------------------------------------------------------------
// editor.threshold から届く [{from, to, value}] を正規化する。
// openRanges:true のため from/to は null（開いた範囲）でありうる → ±Infinity に読み替える。
// 色が解釈できない行・数値でない行は捨てる（描画を壊さない）。from 昇順に整列する。
function normalizeThresholds(raw) {
    if (!Array.isArray(raw)) return [];
    const bands = [];
    raw.forEach((b) => {
        if (!b || typeof b !== 'object') return;
        const from = b.from === null || b.from === undefined ? -Infinity : Number(b.from);
        const to = b.to === null || b.to === undefined ? Infinity : Number(b.to);
        if (Number.isNaN(from) || Number.isNaN(to) || from > to) return;
        if (typeof b.value !== 'string' || parseColor(b.value) === null) return;
        bands.push({ from, to, value: b.value });
    });
    bands.sort((a, b) => a.from - b.from || a.to - b.to);
    return bands;
}

// バンドの表示名（凡例・フィルタ・ツールチップに使う）。
// 判定は from <= count < to（下端を含み上端を含まない）
function bandLabel(band) {
    if (!Number.isFinite(band.from) && !Number.isFinite(band.to)) return 'すべて';
    if (!Number.isFinite(band.from)) return `${band.to}未満`;
    if (!Number.isFinite(band.to)) return `${band.from}以上`;
    return `${band.from}〜${band.to}`;
}

// ホストは既定値と同じ値を options に載せないため、未設定（＝schema の default のまま）は
// ここで同じ内容を再現する。schema 側の default と一致させておくこと
const DEFAULT_COUNT_BANDS = [
    { from: 0, to: 100, value: '#38a6ff' },
    { from: 100, to: Infinity, value: '#ff5a2e' },
];

// ---------------------------------------------------------------------------
// オプション正規化（未設定・型不一致でも安全側に倒す）
// ---------------------------------------------------------------------------
const LABEL_LANGS = ['en', 'ja'];
const MAP_DETAILS = ['auto', 'low', 'high'];
const COLOR_MODES = ['category', 'count'];
const LAND_STYLES = ['solid', 'dots'];

function normalizeOptions(options) {
    const o = options && typeof options === 'object' ? options : {};
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const num = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
    };
    return {
        showTitle: bool(o.showTitle, true),
        // タイトル文字列。編集画面のテキスト欄で自由に変更できる。
        // 空文字は「タイトル無し」として尊重する（既定値へ戻さない）。
        // ホストは未設定のキーを options に載せないため、
        // 「キーが無い＝未設定」だけを既定値に倒す。
        titleText:
            typeof o.titleText === 'string' ? o.titleText : 'GLOBAL THREAT MAP',
        showLegend: bool(o.showLegend, true),
        showFilter: bool(o.showFilter, true),
        // 光の筋がパスを走り切る秒数。0 でアニメーション停止（静的表示）
        animDuration: Math.min(Math.max(num(o.animDuration, 2.8), 0), 60),
        // --- カメラ（地図の中心とズーム） ---
        // 中心経度・中心緯度。ここを変えると地図の中心が動く（例: 経度135=日本中心）
        centerLon: wrapLon(num(o.centerLon, 0)),
        centerLat: clamp(num(o.centerLat, 0), -85, 85),
        // 初期ズーム倍率。1=世界全体
        initialZoom: clamp(num(o.initialZoom, 1), ZOOM_MIN, ZOOM_MAX),
        // ホイールズーム / ドラッグパンを許可するか
        enableZoom: bool(o.enableZoom, true),
        // --- 弧の見た目・件数 ---
        // count に応じた太さの強調度。0 で一律の細線、大きいほど差が出る
        widthScale: clamp(num(o.widthScale, 1), 0, 10),
        // 描画する弧の上限（count の多い順）。0 で無制限
        maxArcs: Math.max(0, Math.round(num(o.maxArcs, 0))),
        // 地点にマウスを乗せたとき、その地点に繋がる弧だけを強調する
        highlightOnHover: bool(o.highlightOnHover, true),
        // 【スキーマ外】フロー一覧の位置（正規化座標の JSON "[x,y]"。'' = 既定の右下）。
        // テーブルのヘッダーをドラッグすると setOptions で保存される。
        // 編集パネルには出さない＝ optionsSchema に載せない＝ splunkd 再起動不要
        // （スキーマ外キーが保存され viz に届くことは link-line labelPos で実機確認済み）
        tablePos: typeof o.tablePos === 'string' ? o.tablePos : '',
        // 【スキーマ外】フロー一覧のサイズ（正規化の JSON "[w,h]"。'' = 既定サイズ）。
        // 右下グリップのドラッグで setOptions 保存される
        tableSize: typeof o.tableSize === 'string' ? o.tableSize : '',
        // 【検証用・スキーマ外】光の帯レンダラーの強制指定（'webgl' | '2d'）。
        // 既定は自動（実 GPU があれば WebGL、無ければ 2D）。
        // optionsSchema に載せていないキーもダッシュボード定義に書けば viz に届く
        // （実機確認済み）ため、再起動なしで切り替えて検証できる
        forceRenderer: ['webgl', '2d'].includes(o.forceRenderer) ? o.forceRenderer : '',
        // 近接した地点をまとめる半径（画面px）。0 で集約しない（1点1マーカー）。
        // 画面距離なので、ズームすると同じ設定値でもクラスタは自然に分離する
        clusterRadius: clamp(num(o.clusterRadius, 18), 0, 80),
        // 凡例に「表示 N / 全 M」の内訳を出す
        showTotals: bool(o.showTotals, true),
        // 凡例の各カテゴリ行に件数を併記する
        showCategoryCounts: bool(o.showCategoryCounts, true),
        // --- フロー一覧テーブル（v2.0.0） ---
        // マップの右下に、表示中のフロー一覧（送信元/宛先/カテゴリ/値）を重ねて表示する
        showTable: bool(o.showTable, false),
        // テーブルの最大高さ（パネルの高さに対する%。内容が少なければ縮む）
        tableHeight: clamp(num(o.tableHeight, 35), 15, 60),
        // テーブルを折りたたんだ状態で初期表示する（ヘッダーバーのクリックで展開）
        tableCollapsed: bool(o.tableCollapsed, false),
        // count 列の値の単位（凡例・HUD・ツールチップ・テーブル見出しに使う表示上のラベル）。
        // count は「件数」とは限らない（バイト数・接続数などの量でもよい）
        countLabel:
            typeof o.countLabel === 'string' && o.countLabel.trim() !== ''
                ? o.countLabel.trim()
                : '件',
        // --- 地図の詳細度（国境の解像度） ---
        // auto: ズームに応じて 110m → 50m へ切り替え / low: 常に 110m / high: 常に 50m
        mapDetail: MAP_DETAILS.includes(o.mapDetail) ? o.mapDetail : 'auto',
        // --- 地図のスタイル ---
        // 経緯線（10度グリッド）を薄く敷く
        showGraticule: bool(o.showGraticule, true),
        // 陸地の質感。solid: ベタ塗り（従来） / dots: ドットマトリクス
        landStyle: LAND_STYLES.includes(o.landStyle) ? o.landStyle : 'solid',
        // タイトル下に総件数と LIVE インジケータを出す（HUD 風の統計行）
        showHudStats: bool(o.showHudStats, true),
        // --- 地名ラベル ---
        showPlaceLabels: bool(o.showPlaceLabels, true),
        showEndpointLabels: bool(o.showEndpointLabels, true),
        placeLabelSize: clamp(num(o.placeLabelSize, 11), 6, 24),
        // 地名の表示量の倍率。大きいほど多くの地名が出る（重なると自動で間引かれる）
        labelDensity: clamp(num(o.labelDensity, 1), 0.2, 5),
        // 地名の言語（地図由来の国名・都市名のみ。データ由来の src_name/dst_name には影響しない）
        labelLang: LABEL_LANGS.includes(o.labelLang) ? o.labelLang : 'en',
        // --- 色分けモード ---
        // category: 色分け列の文字列カテゴリで色分け（従来どおり）
        // count:    件数（count）のしきい値バンドで色分け（editor.threshold）
        colorMode: COLOR_MODES.includes(o.colorMode) ? o.colorMode : 'category',
        countThresholds: (() => {
            const bands = normalizeThresholds(o.countThresholds);
            return bands.length > 0 ? bands : DEFAULT_COUNT_BANDS;
        })(),
        // --- 色分け（カテゴリ） ---
        // 「カテゴリ名|色」の明示マッピング。ここに書かれたものだけが色の根拠になる
        categoryColors: Array.isArray(o.categoryColors) ? o.categoryColors : [],
        // マッピングに無いカテゴリの色（未分類をどう見せるか）
        fallbackColor:
            parseColor(o.fallbackColor) !== null ? o.fallbackColor : DEFAULT_CATEGORY_COLOR,
        // 凡例・フィルタに出すカテゴリの並び順（明示指定が最優先）
        categoryOrder: Array.isArray(o.categoryOrder) ? o.categoryOrder : [],
        // 色分けの基準列を何と呼ぶか（凡例やフィルタの見出しに使う表示上のラベル）
        categoryLabel:
            typeof o.categoryLabel === 'string' && o.categoryLabel.trim() !== ''
                ? o.categoryLabel.trim()
                : '',
        // フィールド選択（editor.columnSelector）。未設定は名前ベースの自動判定
        srcLatField: o.srcLatField,
        srcLonField: o.srcLonField,
        dstLatField: o.dstLatField,
        dstLonField: o.dstLonField,
        categoryField: o.categoryField,
        countField: o.countField,
        srcNameField: o.srcNameField,
        dstNameField: o.dstNameField,
    };
}

// ---------------------------------------------------------------------------
// データ処理ユーティリティ
// ---------------------------------------------------------------------------
function normalizeData(data) {
    if (data.rows && data.rows.length > 0) return data.rows;
    if (data.columns && data.columns.length > 0) {
        const numRows = data.columns[0].length;
        return Array.from({ length: numRows }, (_, i) => data.columns.map((col) => col[i]));
    }
    return [];
}

function findFieldIndex(fieldNames, candidates) {
    return fieldNames.findIndex((name) => candidates.includes(String(name).toLowerCase()));
}

/**
 * editor.columnSelector の選択値を列インデックスへ解決する。
 * カスタムvizには DOS 文字列（"> primary | seriesByName('x')"）が未解決のまま
 * 届くため自前でパースする。以下すべてを受けて壊れない:
 * - 未設定/空文字 → fallbackIdx（名前ベースの自動判定結果）
 * - DOS 文字列 → seriesByName / seriesByIndex を正規表現で解決
 * - 生フィールド名 → そのまま照合
 * - ホスト解決済みの列データ（配列）→ 先頭数行を各列と照合して特定
 */
function resolveFieldIndex(spec, fieldNames, sampleRows, fallbackIdx) {
    if (spec === null || spec === undefined || spec === '') return fallbackIdx;
    if (Array.isArray(spec)) {
        for (let i = 0; i < fieldNames.length; i += 1) {
            const n = Math.min(spec.length, sampleRows.length, 5);
            let ok = n > 0;
            for (let k = 0; k < n; k += 1) {
                const cell = Array.isArray(sampleRows[k]) ? sampleRows[k][i] : undefined;
                if (String(cell) !== String(spec[k])) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return fallbackIdx;
    }
    if (typeof spec !== 'string') return fallbackIdx;
    const s = spec.trim();
    if (s === '') return fallbackIdx;
    let name = s;
    if (s.startsWith('>')) {
        const byName = s.match(/seriesByName\(\s*['"]([^'"]+)['"]\s*\)/);
        const byIndex = s.match(/seriesByIndex\(\s*(\d+)\s*\)/);
        if (byName) {
            name = byName[1];
        } else if (byIndex) {
            const idx = Number(byIndex[1]);
            return idx >= 0 && idx < fieldNames.length ? idx : fallbackIdx;
        } else {
            return fallbackIdx; // 解釈できない DOS はデフォルト列に退避
        }
    }
    const idx = fieldNames.indexOf(name);
    return idx >= 0 ? idx : fallbackIdx;
}

// 色分けカテゴリが空だった行に使う表示名。
// 「未分類」という事実を示すだけで、深刻度のような意味は持たせない。
const UNCATEGORIZED = '(未分類)';

/**
 * サーチ結果をレコードの配列へ変換する。
 * 列の決定: editor.columnSelector の選択が最優先。未設定の列は
 * フィールド名の候補リスト（src_lat 等）で自動判定する。
 * 必須: 起点/終点の緯度経度4列。任意: 色分けカテゴリ, count, 表示名2列。
 *
 * カテゴリ値はサーチ結果の文字列を**そのまま**使う（大文字小文字だけ同一視し、
 * 最初に登場した表記を代表とする）。viz 側で意味の解釈・並べ替えは行わない。
 */
function parseThreats(fieldNames, rows, opts) {
    const lower = fieldNames.map((f) => String(f).toLowerCase());
    const auto = {
        srcLat: findFieldIndex(lower, ['src_lat', 'source_lat', 'slat']),
        srcLon: findFieldIndex(lower, ['src_lon', 'src_lng', 'source_lon', 'slon']),
        dstLat: findFieldIndex(lower, ['dst_lat', 'dest_lat', 'target_lat', 'dlat']),
        dstLon: findFieldIndex(lower, ['dst_lon', 'dst_lng', 'dest_lon', 'target_lon', 'dlon']),
        // 色分け列の自動判定は「よくある列名」の便宜的な当て推量にすぎない。
        // severity 以外（category/type/status…）も同列に扱い、深刻度を特別視しない。
        // 明示指定（categoryField）があれば常にそちらが優先される。
        category: findFieldIndex(lower, [
            'category', 'type', 'log_type', 'event_type', 'status', 'protocol',
            'severity', 'threat_level', 'level',
        ]),
        count: findFieldIndex(lower, ['count', 'events', 'total']),
        srcName: findFieldIndex(lower, ['src_name', 'src', 'source']),
        dstName: findFieldIndex(lower, ['dst_name', 'dst', 'dest', 'target']),
    };
    const iSrcLat = resolveFieldIndex(opts.srcLatField, fieldNames, rows, auto.srcLat);
    const iSrcLon = resolveFieldIndex(opts.srcLonField, fieldNames, rows, auto.srcLon);
    const iDstLat = resolveFieldIndex(opts.dstLatField, fieldNames, rows, auto.dstLat);
    const iDstLon = resolveFieldIndex(opts.dstLonField, fieldNames, rows, auto.dstLon);
    const iCat = resolveFieldIndex(opts.categoryField, fieldNames, rows, auto.category);
    const iCount = resolveFieldIndex(opts.countField, fieldNames, rows, auto.count);
    const iSrcName = resolveFieldIndex(opts.srcNameField, fieldNames, rows, auto.srcName);
    const iDstName = resolveFieldIndex(opts.dstNameField, fieldNames, rows, auto.dstName);

    // 見つからなかった必須列「だけ」を報告する（存在する列まで「見つからない」と
    // 列挙すると、ユーザーがデータ側を疑って時間を失う。2026-08-08 実機で確認した実害）
    const missing = [
        ['src_lat', iSrcLat],
        ['src_lon', iSrcLon],
        ['dst_lat', iDstLat],
        ['dst_lon', iDstLon],
    ]
        .filter(([, idx]) => idx < 0)
        .map(([name]) => name);
    if (missing.length > 0) {
        return { threats: [], missingFields: missing, hasCount: false };
    }

    // 表記ゆれ（high / High / HIGH）を同一カテゴリに束ねる。
    // 代表表記は「最初に登場したもの」＝データ側の表記を尊重する。
    const catCanon = new Map();
    const toCategory = (raw) => {
        const s = String(raw ?? '').trim();
        if (s === '') return UNCATEGORIZED;
        const key = s.toLowerCase();
        if (!catCanon.has(key)) catCanon.set(key, s);
        return catCanon.get(key);
    };

    const threats = [];
    rows.forEach((row, i) => {
        const srcLat = parseFloat(row[iSrcLat]);
        const srcLon = parseFloat(row[iSrcLon]);
        const dstLat = parseFloat(row[iDstLat]);
        const dstLon = parseFloat(row[iDstLon]);
        if (![srcLat, srcLon, dstLat, dstLon].every(Number.isFinite)) return;
        if (Math.abs(srcLat) > 90 || Math.abs(dstLat) > 90) return;
        threats.push({
            id: i,
            srcLat,
            srcLon,
            dstLat,
            dstLon,
            category: toCategory(iCat >= 0 ? row[iCat] : ''),
            count: iCount >= 0 ? parseFloat(row[iCount]) || 1 : 1,
            srcName: iSrcName >= 0 ? String(row[iSrcName] ?? '') : '',
            dstName: iDstName >= 0 ? String(row[iDstName] ?? '') : '',
        });
    });
    // count 列が解決できたかを返す（件数サマリーの単位を「件」/「本」で切り替えるため）
    return { threats, missingFields: [], hasCount: iCount >= 0 };
}

/**
 * サーチ結果に登場したカテゴリの一覧（表示順）と色の割り当てを作る。
 *
 * 【重要】色も並び順も、viz は一切推測しない。
 *
 * - **色**: `categoryColors`（「カテゴリ名|色」の明示マッピング）に書かれた色だけを使う。
 *   マッピングに無いカテゴリは `fallbackColor` で描く（勝手にパレットを配らない）。
 *   これにより「深刻度だと思って赤が振られる」ような意図しない色付けが起きない。
 * - **並び順**: `categoryOrder` に書かれた順を最優先。書かれていないカテゴリは
 *   その後ろに**検索結果への登場順**で続く（同じサーチなら毎回同じ順序＝決定的）。
 *   語彙の意味（critical が high より重い等）による並べ替えはしない。
 */
function buildCategoryModel(threats, opts) {
    // 検索結果に実際に登場したカテゴリ（登場順）
    const seen = [];
    threats.forEach((t) => {
        if (!seen.includes(t.category)) seen.push(t.category);
    });

    // 並び順: ユーザー指定を先頭に（指定されたが実データに無いものは出さない）
    const orderSpec = opts.categoryOrder
        .map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
        .filter((s) => s !== '');
    const ordered = [];
    orderSpec.forEach((key) => {
        const hit = seen.find((s) => s.toLowerCase() === key);
        if (hit !== undefined && !ordered.includes(hit)) ordered.push(hit);
    });
    const categoryList = [...ordered, ...seen.filter((s) => !ordered.includes(s))];

    // 色: 明示マッピングのみ。無ければ fallbackColor
    const colorMap = parseCategoryColorMap(opts.categoryColors);
    const fallback = parseColor(opts.fallbackColor) || parseColor(DEFAULT_CATEGORY_COLOR);
    const categoryColors = {};
    // どのカテゴリがユーザー指定の色を持つか（凡例で「未設定」を示すのに使う）
    const explicit = {};
    categoryList.forEach((cat) => {
        const hit = colorMap.get(cat.toLowerCase());
        explicit[cat] = hit !== undefined;
        categoryColors[cat] = (hit !== undefined ? parseColor(hit) : null) || fallback;
    });
    return { categoryList, categoryColors, explicit };
}

// 弧（2次ベジェ曲線）の制御点を求める。
// SVG パス文字列と Canvas サンプリングの両方で同一曲線を使うため、
// 制御点 (cx, cy) を単一の関数から供給して食い違いを防ぐ。
function arcControl(sx, sy, tx, ty) {
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy) || 1;
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;
    const nx = -dy / dist;
    const ny = dx / dist;
    const bend = dist * 0.22;
    const dir = ny < 0 ? 1 : -1;
    const cx = mx + nx * bend * dir;
    const cy = my + ny * bend * dir - dist * 0.12;
    return { cx, cy };
}

// 2次ベジェの点 (t: 0..1)。Canvas での彗星サンプリングに使用
function bezierPoint(sx, sy, cx, cy, tx, ty, t) {
    const u = 1 - t;
    const a = u * u;
    const b = 2 * u * t;
    const c = t * t;
    return { x: a * sx + b * cx + c * tx, y: a * sy + b * cy + c * ty };
}

// ---------------------------------------------------------------------------
// 弧ジオメトリ（2次ベジェの装飾的アーチ）
//   SVG のベース軌道（パス文字列）と Canvas の彗星サンプリングの両方が
//   ここを通ることで、2つの描画レイヤーの軌道が必ず一致する。
//
//   【v2.1.0】大円航路（poly / geoInterpolate）は廃止した。折れ線1本あたり
//   49点の投影とセグメント走査が必要で、線が増えるほど生成コストが積み上がる
//   （ベジェは制御点1個で済む）。形状の選択肢も無くなったため、geom は
//   常に bezier の1種類だけになり、各ヘルパーの分岐も消えている。
// ---------------------------------------------------------------------------
function buildArcGeom(a) {
    const { cx, cy } = arcControl(a.sx, a.sy, a.tx, a.ty);
    return { sx: a.sx, sy: a.sy, cx, cy, tx: a.tx, ty: a.ty };
}

// ジオメトリ → SVG パス文字列（ベース軌道・当たり判定に使用）
function geomPath(geom) {
    const { sx, sy, cx, cy, tx, ty } = geom;
    return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
}

// ジオメトリ上の点 (t: 0..1) と単位法線。パス外は null
function geomPoint(geom, t) {
    if (t < 0 || t > 1) return null;
    const { sx, sy, cx, cy, tx, ty } = geom;
    const p = bezierPoint(sx, sy, cx, cy, tx, ty, t);
    const dx = 2 * (1 - t) * (cx - sx) + 2 * t * (tx - cx);
    const dy = 2 * (1 - t) * (cy - sy) + 2 * t * (ty - cy);
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x, y: p.y, nx: -dy / len, ny: dx / len };
}

// ジオメトリの終点（到達リップルの中心）
function geomEnd(geom) {
    return { x: geom.tx, y: geom.ty };
}

// ジオメトリの画面上の長さ（px 近似）。
// 光の帯の「速度の正規化」と「サンプル数の調整」に使う（毎フレームではなく生成時に1回）
function geomLength(geom) {
    const { sx, sy, cx, cy, tx, ty } = geom;
    let len = 0;
    let prev = { x: sx, y: sy };
    for (let i = 1; i <= 12; i += 1) {
        const p = bezierPoint(sx, sy, cx, cy, tx, ty, i / 12);
        len += Math.hypot(p.x - prev.x, p.y - prev.y);
        prev = p;
    }
    return len;
}

// ツールチップ用の地点表記（名前が無ければ緯度経度で代替）
function pointLabel(name, lat, lon) {
    return name || `${lat.toFixed(1)}, ${lon.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// 地点クラスタリング（画面距離ベース）
// ---------------------------------------------------------------------------
// 【なぜ必要か】v1.8.2 までの地点集約は「投影後の座標を小数1桁で丸めたキー」
// （`${x.toFixed(1)},${y.toFixed(1)}`）の完全一致だけで、実質 0.1px 以内に
// 重なった点しかまとまらなかった。IP ジオロケーションのデータは同一都市でも
// 緯度経度がわずかにばらけるため、東京付近に数百個のホットスポットが重なって
// 描かれ、弧の終端も同様に潰れて読めなくなる。
//
// ここでは **画面上の距離** で集約する。地理座標ではなく画面距離を使うのは、
// ズームすると同じ radius が地理的により狭い範囲を指すことになり、
// 拡大するにつれてクラスタが自然に分離する（地図アプリのピンクラスタと同じ挙動）ため。
//
// アルゴリズム: radius をセル幅とした均一グリッドに点を撒き、各点は自セル＋
// 隣接8セルだけを探索して既存クラスタに吸着する（総当たり O(n^2) を避ける）。
// 入力順に貪欲に処理するので、同じ入力なら常に同じ結果になる（決定的）。
//
// 代表座標はクラスタ内の **count 加重平均**。件数の多い地点へ寄るため、
// 大量の小さな地点に引っ張られて代表点が実態からずれるのを防ぐ。
//
// 【重み付けの安全弁】count は生のサーチ結果なので 0 や負値もありうる
// （`| eval count=a-b` のような差分を入れられる）。負の重みをそのまま使うと
// 加重平均がクラスタの外へ飛ぶ（実測: x=100 と x=110 の2点に count=10/-9 を
// 与えると代表点が x=10 になる）。重みは 0 以上に丸め、合計が 0 以下の
// ときは単純平均へ退避する。arcWidth が Math.max(count,0) で守っているのと同じ方針。
function clusterPoints(points, radius) {
    if (!(radius > 0)) return null;
    const cell = radius;
    const grid = new Map();
    const clusters = [];
    const key = (cx, cy) => `${cx}|${cy}`;
    // 重みは非負に丸める（負値・NaN は 0 として扱う）
    const weightOf = (p) => (Number.isFinite(p.count) && p.count > 0 ? p.count : 0);
    // 重みの合計が 0（全点が count<=0）のクラスタは単純平均で代表点を出す
    const recenter = (c) => {
        if (c.w > 0) {
            c.x = c.ax / c.w;
            c.y = c.ay / c.w;
            return;
        }
        let sx = 0;
        let sy = 0;
        c.members.forEach((m) => {
            sx += m.x;
            sy += m.y;
        });
        c.x = sx / c.members.length;
        c.y = sy / c.members.length;
    };
    points.forEach((p) => {
        const cx = Math.floor(p.x / cell);
        const cy = Math.floor(p.y / cell);
        // 自セル＋隣接8セルの中から、半径内で最も近いクラスタを探す
        let best = null;
        let bestD2 = radius * radius;
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                const bucket = grid.get(key(cx + dx, cy + dy));
                if (!bucket) continue;
                bucket.forEach((ci) => {
                    const c = clusters[ci];
                    const d2 = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
                    if (d2 <= bestD2) {
                        bestD2 = d2;
                        best = ci;
                    }
                });
            }
        }
        if (best === null) {
            // 新しいクラスタ。位置はグリッドに登録した時点で固定する
            // （吸着で代表点が動くとグリッドとの整合が崩れるため、
            //   セル登録は「作成時の座標」で行い、以降も同じセルに属させる）
            const ci = clusters.length;
            const w0 = weightOf(p);
            clusters.push({
                x: p.x,
                y: p.y,
                ax: p.x * w0,
                ay: p.y * w0,
                w: w0,
                members: [p],
            });
            const k = key(cx, cy);
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(ci);
        } else {
            const c = clusters[best];
            const w = weightOf(p);
            c.members.push(p);
            c.ax += p.x * w;
            c.ay += p.y * w;
            c.w += w;
            // 代表座標は count 加重平均へ更新（吸着判定の中心も追従させる）
            recenter(c);
        }
    });
    return clusters;
}

// カスタムツールチップをカーソル近くへ置く。右端・下端ではカーソルの反対側へ
// 反転させ、パネルの外へはみ出さないようにする
function applyTooltipPos(el, x, y, w, h) {
    const tw = el.offsetWidth || 240;
    const th = el.offsetHeight || 52;
    let left = x + 14;
    if (left + tw > w - 6) left = Math.max(6, x - tw - 14);
    let top = y + 16;
    if (top + th > h - 6) top = Math.max(6, y - th - 12);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

// 値の桁区切り表記（8432 → "8,432"）。
// toLocaleString はロケール依存で happy-dom / 実機の差が出るため自前で整形する。
// count 列は件数とは限らず量（バイト数・帯域など）でもあるため、
// 整数でない値は小数1桁まで残す（丸め殺して 12.5 MB を 13 にしない）
function formatCount(n) {
    if (!Number.isFinite(n)) return '0';
    const isInt = Math.abs(n - Math.round(n)) < 1e-9;
    const v = isInt ? Math.round(n) : Math.round(n * 10) / 10;
    const sign = v < 0 ? '-' : '';
    const [intPart, fracPart] = String(Math.abs(v)).split('.');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + grouped + (fracPart ? `.${fracPart}` : '');
}

// ツールチップ用のカテゴリ表記。末尾に区切りを含めて返す（呼び出し側は
// `(${describeCategory(c)}count N)` の形で使う）。
// 色分け列が無い／値が空のときは「(未分類)」を出さず、カテゴリごと省略する。
function describeCategory(category) {
    return !category || category === UNCATEGORIZED ? '' : `${category}, `;
}

// ---------------------------------------------------------------------------
// コンテナの実サイズを監視するフック
// （地図をパネル全体にフィットさせるため）
// ---------------------------------------------------------------------------
function useContainerSize() {
    const ref = useRef(null);
    const [size, setSize] = useState(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (w > 0 && h > 0) {
                setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
            }
        };
        update();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
        }
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return [ref, size];
}

// ---------------------------------------------------------------------------
// 弧を流れる「光の帯」キャンバス
//   流れる筋だけを Canvas に描く（地図・陸地・ホットスポット・弧のベース軌道は
//   SVG のまま）。元の意図どおり「カテゴリ色の短いセグメントが弧に沿って
//   飛んでいく」表現。
//   ※加算合成(lighter)での発光は廃止：弧が終点に収束する場所で重なった光の
//     RGB が飽和して真っ白に見えたため。通常合成＋純粋なカテゴリ色のみで
//     描くことで、何本重なっても色相が保たれる（白くならない）。
//   チープな単色ベタ棒に見せないため:
//     - 帯は「両端が滑らかに窄まるテーパー形状」のポリゴンを 1 回塗りで描く
//       （幅・不透明度とも sin エンベロープで両端 0 へ。急な切れ目が無い）
//     - 下に太く淡い同色グローを敷き、柔らかい輪郭を出す
//   実装メモ:
//     - 弧は 2次ベジェ。SVG と同じ制御点(arcControl)をサンプリングして完全一致。
//     - ポリゴン 1 回塗りなのでサンプル同士のアルファ累積も起きない。
//     - devicePixelRatio は 2 で頭打ち（高精細でも描画量を抑える）。
//
// 【v2.1.0 パフォーマンス対策】
// 2026-08-08 の実機計測で「複数パネルで重い」主因がこの Canvas の
// 毎フレーム全面再描画（ペイント/コンポジットのコスト。JS ではない）と確定した
// （4面で 4fps、アニメーションを止めると 49fps）。線が多いときはさらに悪化する。
// 対策を3層で入れている:
//   1. **画面外・非表示なら rAF を完全に止める**（IntersectionObserver +
//      visibilitychange）。ダッシュボードをスクロールして見えていないパネルや、
//      別タブに切り替えたときのコストがゼロになる。見た目は一切変わらない。
//   2. **本数に応じて描画 fps を自動で落とす**（30 → 20 → 15fps）。
//      塗る面積は本数に比例するので、多いときだけ間引いて総ペイント量を抑える。
//   3. **本数が多いときは帯の描画自体を軽くする**（グロー層を省く・
//      サンプル点数を減らす）。1本あたりの塗り面積とパス頂点数が直接減る。
//   さらに duration<=0 では rAF ループ自体を起動しない
//   （従来は「ループは回して描画だけスキップ」で、コメントの『CPU 0』は不正確だった）。
// ---------------------------------------------------------------------------
// 帯の弧長比（パス全体に対する光の帯の長さ）
const FLOW_LEN = 0.22;
// 帯を構成するサンプル点の数（多いほど滑らか。数十本×この数でも 60fps 余裕）
const FLOW_SAMPLES = 16;

// 描画本数に応じた品質段階。しきい値は「塗り面積 ≒ 本数 × 帯の面積」が
// 一定に収まるように置いた（実機計測の 4面=4fps を基準に、
// 多数本でも 1面あたりのペイント量が既定 30fps 相当を超えないようにする）。
//   frameMs     : 描画間隔（大きいほど低 fps）
//   glow        : 太く淡いグロー層を描くか（false で塗り面積が約 2.4 倍減る）
//   maxSamples  : 帯の中心線サンプル点数の上限（パス頂点数の上限）
//   ripple      : 到達演出（着弾フラッシュ＋リップル）を描くか
//   rippleRings : 到達リップルの重ね枚数（v2.2.0。1 で従来と同じ）
//   flash2D     : 2D 経路でも着弾フラッシュを描くか（v2.2.0）
//
// 【v2.2.0 の追加分の考え方】着弾フラッシュは**弧1本につき fill() が1回増える**。
// GL 経路は三角形が増えるだけで安いが、2D 経路（ソフトウェア描画）では
// fill() 回数がそのままコストになるため、**本数が少ない段階だけ**に限る。
const FLOW_TIERS = [
    // 〜120本: 30fps・フル品質（着弾フラッシュ＋リップル3重）
    { limit: 120, frameMs: 32, glow: true, maxSamples: 40, ripple: true, rippleRings: 3, flash2D: true },
    // 〜400本: 20fps・サンプル削減（リップル2重。フラッシュは GL 経路のみ）
    { limit: 400, frameMs: 50, glow: true, maxSamples: 28, ripple: true, rippleRings: 2, flash2D: false },
    // 400本超: 15fps・グロー無し、到達演出も省く
    { limit: Infinity, frameMs: 66, glow: false, maxSamples: 16, ripple: false, rippleRings: 0, flash2D: false },
];

function flowTier(n) {
    return FLOW_TIERS.find((t) => n <= t.limit) || FLOW_TIERS[FLOW_TIERS.length - 1];
}

// パネルが大きいときは描画間隔をさらに広げる（⚠ **2D フォールバック専用**）。
// Canvas 2D は塗り＋合成のコストが表示面積に比例し、内部解像度を下げても
// 減らない（実機で確認済み: 解像度上限を 1280x720 → 1000x560 に下げても
// 25.3 → 25.9fps とほぼ変化なし）。減らせるのは「描く回数」だけなので、
// 面積に応じて fps を落とす。基準は 1920x1080（約207万px）。
// WebGL2 レンダラー（既定）はこのスロットルを使わない＝大画面でも fps を落とさない。
const FLOW_AREA_BASE = 1920 * 1080;

function frameMsForArea(baseMs, w, h) {
    const area = Math.max(1, w * h);
    if (area <= FLOW_AREA_BASE) return baseMs;
    // 面積比に比例して間隔を伸ばす（上限 100ms ＝ 10fps）
    return Math.min(100, Math.round(baseMs * (area / FLOW_AREA_BASE)));
}

// ---------------------------------------------------------------------------
// WebGL2 レンダラー（v2.1.0）
//
// 【なぜ WebGL か・実機計測 2026-08-09】
// Canvas 2D は「半透明の帯・グローを塗って全面合成する」コストが
// **表示面積に比例**し、4K フルスクリーンでは面積スロットルで 10fps まで
// 落とすしかなかった（それでも重い）。ラスタライズを GPU パイプラインへ
// 移せばこの面積コストが消える。WebGL2 がカスタム viz の iframe で動くことは
// 実機確認済み（webgl-in-custom-viz.md: 全画面シェーダで 62fps）。
//
// 設計: 光の帯・到達リップル・ホットスポットグローを**すべて
// 「位置＋頂点色の三角形」**に落とし、1シェーダ・1バッファ・
// 1 drawArrays で描く。radialGradient は同心リングの頂点色補間で再現する
// （Canvas のグラデーションもストップ間は線形補間なので、見た目は一致する。
// 円周の分割誤差は r=44px・24分割で 0.4px 未満＝視認不可）。
//
// 透過3点セット（webgl-in-custom-viz.md）:
//   1. alpha:true / premultipliedAlpha:true でコンテキスト取得
//   2. シェーダは premultiplied で出力（rgb×a）
//   3. blendFunc(ONE, ONE_MINUS_SRC_ALPHA) ＋ clearColor(0,0,0,0)
//
// WebGL2 が取れない環境は従来の Canvas 2D へフォールバックする
// （happy-dom のローカル検証もこの 2D 経路を通る）。
// ---------------------------------------------------------------------------
const FLOW_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColor;
uniform vec2 uRes;
out vec4 vColor;
void main() {
    vec2 clip = aPos / uRes * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    vColor = aColor;
}`;

const FLOW_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() {
    outColor = vec4(vColor.rgb * vColor.a, vColor.a);
}`;

// WebGL を使うべき環境かの判定（iframe ごとに1回だけ・使い捨て canvas で調べる）。
//
// 【実機計測 2026-08-09】ソフトウェア GL（SwiftShader）では WebGL にしても
// 速くならない（合成が CPU のままなので、面積スロットル付きの 2D 経路と同等か
// わずかに遅い。1080p 30本: 2D 60.1fps / GL 50.7fps）。GPU が無い環境では
// 2D へ倒し、実 GPU がある環境だけ WebGL を使う。
//
// ⚠ 判定は必ず**使い捨ての canvas** で行う。一度 webgl2 コンテキストを取った
// canvas では getContext('2d') が二度と取れないため、本番の canvas で試すと
// 「GL をやめて 2D」ができなくなる。
let FLOW_GL_SUPPORT = null;
function flowGLSupported() {
    if (FLOW_GL_SUPPORT !== null) return FLOW_GL_SUPPORT;
    FLOW_GL_SUPPORT = false;
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2', { alpha: true });
        if (gl && typeof gl.createShader === 'function' && typeof gl.getParameter === 'function') {
            let name = '';
            try {
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                name = String(
                    dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
                );
            } catch (e) {
                name = '';
            }
            // ソフトウェアラスタライザは除外（実測で 2D のほうが速い）
            FLOW_GL_SUPPORT = !/swiftshader|llvmpipe|softpipe|software/i.test(name);
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        }
    } catch (e) {
        FLOW_GL_SUPPORT = false;
    }
    return FLOW_GL_SUPPORT;
}

function createFlowGL(canvas) {
    let gl = null;
    try {
        gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: true,
            antialias: true,
        });
    } catch (e) {
        return null;
    }
    // happy-dom のスタブは任意の type に 2D 相当を返すため、
    // 「webgl2 と言って返ってきたが GL の関数が無い」ケースも弾く
    if (!gl || typeof gl.createShader !== 'function') return null;

    let uRes = null;
    let vbo = null;
    let lost = false;

    const setup = () => {
        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
            }
            return sh;
        };
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, FLOW_VS));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FLOW_FS));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
        }
        gl.useProgram(program);
        uRes = gl.getUniformLocation(program, 'uRes');
        vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        // 頂点レイアウト: [x, y, r, g, b, a] × float32（stride 24 バイト）
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
    };
    try {
        setup();
    } catch (e) {
        return null;
    }
    // コンテキストロスト: preventDefault しないと restored が来ない。
    // ロスト中は描画をスキップし、復帰したらプログラムを組み直す
    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
        try {
            setup();
            lost = false;
        } catch (e) {
            /* 復帰失敗時は描画停止のまま（次のマウントで再試行される） */
        }
    });

    return {
        isLost: () => lost,
        // verts: Float32Array（[x,y,r,g,b,a]×count）。count=0 なら消すだけ
        draw(verts, count, w, h) {
            if (lost) return;
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (count > 0 && verts) {
                // aPos は CSS px の論理座標。viewport がバッファ解像度差を吸収する
                gl.uniform2f(uRes, w, h);
                gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
                gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, count * 6), gl.DYNAMIC_DRAW);
                gl.drawArrays(gl.TRIANGLES, 0, count);
            }
        },
    };
}

// 毎フレーム作り直さない可変長の頂点バッファ（[x,y,r,g,b,a] × 頂点数）
const VTX_FLOATS = 6;
function makeVertexSink() {
    let buf = new Float32Array(VTX_FLOATS * 4096);
    let n = 0;
    const ensure = (add) => {
        const need = (n + add) * VTX_FLOATS;
        if (need <= buf.length) return;
        let cap = buf.length;
        while (cap < need) cap *= 2;
        const next = new Float32Array(cap);
        next.set(buf.subarray(0, n * VTX_FLOATS));
        buf = next;
    };
    return {
        reset() {
            n = 0;
        },
        push(x, y, r, g, b, a) {
            ensure(1);
            const o = n * VTX_FLOATS;
            buf[o] = x;
            buf[o + 1] = y;
            buf[o + 2] = r;
            buf[o + 3] = g;
            buf[o + 4] = b;
            buf[o + 5] = a;
            n += 1;
        },
        get count() {
            return n;
        },
        get array() {
            return buf;
        },
    };
}

// 帯（テーパーポリゴン）を三角形列に落とす。pts は collectBandPts の出力
function emitBandGL(sink, pts, w, scale, cv, alpha) {
    for (let i = 1; i < pts.length; i += 1) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const h0 = w * scale * p0.env;
        const h1 = w * scale * p1.env;
        const x0l = p0.x + p0.nx * h0;
        const y0l = p0.y + p0.ny * h0;
        const x0r = p0.x - p0.nx * h0;
        const y0r = p0.y - p0.ny * h0;
        const x1l = p1.x + p1.nx * h1;
        const y1l = p1.y + p1.ny * h1;
        const x1r = p1.x - p1.nx * h1;
        const y1r = p1.y - p1.ny * h1;
        sink.push(x0l, y0l, cv[0], cv[1], cv[2], alpha);
        sink.push(x0r, y0r, cv[0], cv[1], cv[2], alpha);
        sink.push(x1l, y1l, cv[0], cv[1], cv[2], alpha);
        sink.push(x1l, y1l, cv[0], cv[1], cv[2], alpha);
        sink.push(x0r, y0r, cv[0], cv[1], cv[2], alpha);
        sink.push(x1r, y1r, cv[0], cv[1], cv[2], alpha);
    }
}

// 到達リップル（輪）を三角形列に落とす
const RING_SEGS = 28;
function emitRingGL(sink, cx, cy, radius, thickness, cv, alpha) {
    const rIn = Math.max(0, radius - thickness / 2);
    const rOut = radius + thickness / 2;
    let pix = 0;
    let piy = 0;
    let pox = 0;
    let poy = 0;
    for (let i = 0; i <= RING_SEGS; i += 1) {
        const t = (i / RING_SEGS) * Math.PI * 2;
        const cos = Math.cos(t);
        const sin = Math.sin(t);
        const xi = cx + cos * rIn;
        const yi = cy + sin * rIn;
        const xo = cx + cos * rOut;
        const yo = cy + sin * rOut;
        if (i > 0) {
            sink.push(pix, piy, cv[0], cv[1], cv[2], alpha);
            sink.push(pox, poy, cv[0], cv[1], cv[2], alpha);
            sink.push(xi, yi, cv[0], cv[1], cv[2], alpha);
            sink.push(xi, yi, cv[0], cv[1], cv[2], alpha);
            sink.push(pox, poy, cv[0], cv[1], cv[2], alpha);
            sink.push(xo, yo, cv[0], cv[1], cv[2], alpha);
        }
        pix = xi;
        piy = yi;
        pox = xo;
        poy = yo;
    }
}

// 放射グラデーション円（ホットスポットのグロー）を同心リングの頂点色補間で描く。
// stopsV は [r,g,b,a]×4（半径 0 / 0.3r / 0.7r / r の色）。
// Canvas の createRadialGradient もストップ間は線形補間なので見た目は一致する
const DISC_SEGS = 24;
const DISC_STOP_T = [0, 0.3, 0.7, 1];
function emitDiscGL(sink, cx, cy, r, stopsV, alphaMul) {
    for (let band = 0; band < 3; band += 1) {
        const r0 = r * DISC_STOP_T[band];
        const r1 = r * DISC_STOP_T[band + 1];
        const c0 = stopsV[band];
        const c1 = stopsV[band + 1];
        const a0 = c0[3] * alphaMul;
        const a1 = c1[3] * alphaMul;
        let pix = 0;
        let piy = 0;
        let pox = 0;
        let poy = 0;
        for (let i = 0; i <= DISC_SEGS; i += 1) {
            const t = (i / DISC_SEGS) * Math.PI * 2;
            const cos = Math.cos(t);
            const sin = Math.sin(t);
            const xi = cx + cos * r0;
            const yi = cy + sin * r0;
            const xo = cx + cos * r1;
            const yo = cy + sin * r1;
            if (i > 0) {
                sink.push(pix, piy, c0[0], c0[1], c0[2], a0);
                sink.push(pox, poy, c1[0], c1[1], c1[2], a1);
                sink.push(xi, yi, c0[0], c0[1], c0[2], a0);
                sink.push(xi, yi, c0[0], c0[1], c0[2], a0);
                sink.push(pox, poy, c1[0], c1[1], c1[2], a1);
                sink.push(xo, yo, c1[0], c1[1], c1[2], a1);
            }
            pix = xi;
            piy = yi;
            pox = xo;
            poy = yo;
        }
    }
}

// 帯の中心線サンプルを集める（2D / WebGL の両経路で共有 → 軌道が食い違わない）。
// 帯はパス上の [head-FLOW_LEN, head] を占めるが、始点前・終点後には出られないので、
// **見えている区間 [lo, hi] にエンベロープを張り直す**。これで帯の両端は常に幅 0 へ
// 窄まり、到達時は「先端が終点に留まり、末尾が追いついて縮みながら吸い込まれる」
// 形になる（出発時はその逆で、始点から伸び出す）。
// ⚠ 旧実装ははみ出したサンプルを捨てるだけでエンベロープは全長基準のままだった。
//   そのため終点通過中は sin(π·u)>0 の「太い切り口」が終点に現れ、帯が長い
//   遠距離の弧ほどブツ切りに見えた（v2.1.1 で修正）。
function collectBandPts(a, head, maxSamples) {
    const samples = Math.min(a.samples || FLOW_SAMPLES, maxSamples);
    const hi = Math.min(head, 1); // 見えている先頭（終点で止まる）
    const lo = Math.max(head - FLOW_LEN, 0); // 見えている末尾（始点より前へ出ない）
    const span = hi - lo;
    if (span <= 0) return [];
    const pts = [];
    for (let s = 0; s <= samples; s += 1) {
        const u = s / samples; // 0=帯の先頭, 1=帯の末尾
        const p = geomPoint(a.geom, hi - u * span);
        if (!p) continue;
        pts.push({ x: p.x, y: p.y, nx: p.nx, ny: p.ny, env: Math.sin(Math.PI * u) });
    }
    return pts;
}

// 着弾フラッシュが消えるまでの時間（リップル進行 rt に対する比率）
const IMPACT_FLASH_T = 0.35;
// 多重リップルの位相差（rt 上のずれ）
const RIPPLE_STAGGER = 0.22;

// 【v2.2.0】着弾フラッシュ（面光源の円）。
// 中心が最も明るく縁で 0 になる扇の集まり。頂点色の補間でグラデーションが出る。
const FLASH_SEGS = 20;
function emitFlashGL(sink, cx, cy, r, cv, alpha) {
    for (let i = 1; i <= FLASH_SEGS; i += 1) {
        const t0 = ((i - 1) / FLASH_SEGS) * Math.PI * 2;
        const t1 = (i / FLASH_SEGS) * Math.PI * 2;
        const x0 = cx + Math.cos(t0) * r;
        const y0 = cy + Math.sin(t0) * r;
        const x1 = cx + Math.cos(t1) * r;
        const y1 = cy + Math.sin(t1) * r;
        sink.push(cx, cy, cv[0], cv[1], cv[2], alpha);
        sink.push(x0, y0, cv[0], cv[1], cv[2], 0);
        sink.push(x1, y1, cv[0], cv[1], cv[2], 0);
    }
}

// 光の帯キャンバスの「塗るピクセル数」の上限（CSS px 換算の面積）。
//
// 【なぜ必要か・実機計測 2026-08-09】
// この Canvas は毎フレーム全面を塗り直すため、コストは**画面の広さに比例**する。
// 弧30本・4パネルで解像度だけを変えた実測:
//     1280x720 → 13.2fps ／ 1920x1080 → 5.9fps ／ 2560x1440 → 3.5fps
// 本数ではなく面積が支配的で、**大画面ほど不利**（面積が4倍になれば4倍重い）。
// そこで内部バッファを一定面積で頭打ちにし、CSS で引き伸ばして表示する。
// 光の帯はもともと柔らかい発光なので、多少低い解像度で描いても見た目の差が出にくい
// （輪郭のある地図・文字は SVG 側なので、そちらの精細さは一切落ちない）。
// 1280x720 相当（約92万px）を上限にすると、4K でも塗る量はこの値で一定になる。
const FLOW_MAX_PIXELS = 1280 * 720;

function ArcFlowCanvas({ arcs, spots, width, height, duration, hoverKey, forceRenderer }) {
    const canvasRef = useRef(null);
    // 最新の arcs / サイズを rAF ループから参照するための ref（再購読でループを
    // 張り直さず、値だけ差し替える）
    const stateRef = useRef({ arcs, spots, width, height, duration, hoverKey });
    stateRef.current = { arcs, spots, width, height, duration, hoverKey };
    const forceRef = useRef(forceRenderer);
    forceRef.current = forceRenderer;
    // ホバー強調の減光係数（弧ID → 現在値）。毎フレーム目標値へ漸近させ、
    // 強調の ON/OFF をフェードで切り替える（瞬時に切り替わると画面がチカつく）
    const dimRef = useRef(new Map());

    // --- 画面外・非表示の検出（rAF を完全に止めるための条件） ----------------
    // ダッシュボードに複数パネルを並べると、見えていないパネルのアニメーションも
    // 同じメインスレッドを食う（同一オリジン iframe はスレッドを共有する。
    // 2026-08-08 実機計測で確認）。見えていない間は描画する意味が無いので止める。
    const [visible, setVisible] = useState(true);
    useEffect(() => {
        const canvas = canvasRef.current;
        // ドキュメントが隠れている（別タブ・最小化）間も止める
        const isDocVisible = () =>
            typeof document === 'undefined' || document.visibilityState !== 'hidden';
        let inView = true;
        const sync = () => setVisible(inView && isDocVisible());

        const onVis = () => sync();
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVis);
        }

        let observer = null;
        if (canvas && typeof IntersectionObserver !== 'undefined') {
            observer = new IntersectionObserver(
                (entries) => {
                    const e = entries[entries.length - 1];
                    if (e) {
                        inView = e.isIntersecting;
                        sync();
                    }
                },
                // わずかでも見えていれば描く（境界で点滅させない）
                { threshold: 0 }
            );
            observer.observe(canvas);
        }
        sync();
        return () => {
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVis);
            }
            if (observer) observer.disconnect();
        };
    }, []);

    // アニメーションが不要な条件（静止指定 / 弧が無い / 見えていない）では
    // rAF ループそのものを起動しない。依存に入れることで、条件が変わった
    // ときだけループが張り直される
    const animate = visible && duration > 0 && (arcs.length > 0 || spots.length > 0);

    // レンダラーは canvas 要素ごとに1回だけ決める。
    // 【重要】一度 webgl2 コンテキストを取った canvas では getContext('2d') が
    // 二度と取れない（null になる）ため、途中でのモード切替はできない。
    const rendererRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !width || !height) return undefined;
        let renderer = rendererRef.current;
        if (!renderer || renderer.canvas !== canvas) {
            // 既定は自動判定（実 GPU があれば WebGL）。forceRenderer で上書き可
            const force = forceRef.current;
            const wantGL = force === 'webgl' || (force !== '2d' && flowGLSupported());
            const glr = wantGL ? createFlowGL(canvas) : null;
            if (glr) {
                renderer = { kind: 'gl', glr, canvas };
            } else {
                const ctx2d = canvas.getContext('2d');
                renderer = ctx2d ? { kind: '2d', ctx: ctx2d, canvas } : null;
            }
            rendererRef.current = renderer;
            if (renderer) {
                // 実機での経路確認用（スクリーンショットだけでは GL か 2D か
                // 区別できないため、コンソールと data 属性の両方に残す）
                canvas.dataset.gtmRenderer = renderer.kind;
                // eslint-disable-next-line no-console
                console.info(`[world-map] flow renderer: ${renderer.kind === 'gl' ? 'webgl2' : 'canvas2d'}`);
            }
        }
        if (!renderer) return undefined;
        const isGL = renderer.kind === 'gl';
        const ctx = isGL ? null : renderer.ctx;

        // 内部バッファの倍率。
        // WebGL はフラグメントが「光の帯の面積ぶん」しか走らないので
        // 表示解像度そのまま（dpr 上限2）。2D は塗り＋合成が面積に比例するため、
        // FLOW_MAX_PIXELS に収まるよう倍率を下げる（＝塗る量を頭打ちにする）。
        // canvas は CSS で 100% に引き伸ばされるので、倍率を下げても
        // 表示サイズは変わらない（解像度だけが下がる）。
        const dprRaw = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        let dpr = dprRaw;
        if (!isGL) {
            // 2D は塗り＋合成が面積に比例するため FLOW_MAX_PIXELS で頭打ちにする。
            // GL は実 GPU 前提（ソフトウェア GL は自動判定で 2D に倒れる）なので
            // 表示解像度そのまま＝4K でも精細に描く
            const area = Math.max(1, width * height);
            const fit = Math.sqrt(FLOW_MAX_PIXELS / area);
            // 極端に小さくすると光が粗く見えるので下限を置く
            dpr = clamp(Math.min(dprRaw, fit), 0.5, 2);
        }
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));

        // 停止条件のときは「消してから」ループを起動せずに抜ける。
        // 直前まで描いていた光が残像として残らないようにする
        if (!animate) {
            if (isGL) {
                renderer.glr.draw(null, 0, width, height);
            } else {
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, width, height);
            }
            return undefined;
        }

        let raf = 0;
        // WebGL 用の頂点バッファ（毎フレーム reset して使い回す）
        const sink = isGL ? makeVertexSink() : null;

        // --- 2D フォールバック用の描画関数 --------------------------------
        // 光の帯1本を描く。中心線の左右に halfWidth ぶん張り出した
        // テーパーポリゴンを1回で塗る（重ね塗りしないのでアルファが累積せず、
        // 色は fillStyle のカテゴリ色を超えない＝白飛びしない）。
        const fillBand2D = (pts, w, scale, alpha) => {
            ctx.beginPath();
            pts.forEach((p, i) => {
                const hw = w * scale * p.env;
                if (i === 0) ctx.moveTo(p.x + p.nx * hw, p.y + p.ny * hw);
                else ctx.lineTo(p.x + p.nx * hw, p.y + p.ny * hw);
            });
            for (let i = pts.length - 1; i >= 0; i -= 1) {
                const p = pts[i];
                const hw = w * scale * p.env;
                ctx.lineTo(p.x - p.nx * hw, p.y - p.ny * hw);
            }
            ctx.closePath();
            ctx.globalAlpha = alpha;
            ctx.fill();
        };
        // ⚠ ここを粒子や多層に増やすと fill() 回数が本数×枚数で効くため増やさない
        //   （2026-08-10 実測: 弧30本×4面で fill() は 91回/フレーム）
        const drawFlow2D = (a, pts, k, tier) => {
            ctx.save();
            ctx.fillStyle = a.color;
            // グロー層は塗り面積が芯の約2.4倍あり、ペイントコストの大半を占める。
            // 本数が多い段階では省き、芯だけを少し濃くして見え方を補う
            if (tier.glow) {
                fillBand2D(pts, a.w, 2.4, 0.18 * k); // 太く淡い同色グロー
                fillBand2D(pts, a.w, 1.0, 0.9 * k); // 締まった芯
            } else {
                fillBand2D(pts, a.w, 1.0, 0.95 * k);
            }
            ctx.restore();
        };
        // 到達リップル: 終点から細い輪を広げて消す。
        // 【v2.2.0】半径・太さ・不透明度を呼び出し側で決める（多重リップル対応）
        const drawRipple2D = (a, radius, thick, alpha) => {
            ctx.save();
            ctx.beginPath();
            ctx.arc(a.end.x, a.end.y, radius, 0, Math.PI * 2);
            ctx.strokeStyle = a.color;
            ctx.lineWidth = thick;
            ctx.globalAlpha = alpha;
            ctx.stroke();
            ctx.restore();
        };
        // 【v2.2.0 案2】着弾フラッシュ: 到達の瞬間、着弾点が強く光って素早く消える
        const drawFlash2D = (a, r, alpha) => {
            const g = ctx.createRadialGradient(a.end.x, a.end.y, 0, a.end.x, a.end.y, r);
            g.addColorStop(0, a.color);
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(a.end.x, a.end.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        };
        const drawSpot2D = (s, r, alpha) => {
            const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
            g.addColorStop(0, s.inner);
            g.addColorStop(0.3, s.mid);
            g.addColorStop(0.7, s.outer);
            g.addColorStop(1, s.edge);
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        };

        // 描画間隔は本数に応じて決まる（FLOW_TIERS）。既定（〜120本）は従来どおり
        // 32ms＝約30fps で、本数が増えるほど間引いて総ペイント量を一定に近づける。
        let lastDraw = 0;
        // アニメーションの時刻は実時間（wall clock）ではなく、
        // 「描画したフレームごとに一定量」進める（固定ステップ方式）。
        // 実時間追従だと、描画が遅れたフレームで遅れたぶん光が大きく跳び、
        // それが「ガクつき」に見える（特に画面上の速度が高い遠距離の弧で顕著）。
        // 固定ステップなら移動量が毎フレーム等しく、負荷でフレームが落ちても
        // 「全体がわずかにゆっくりになる」だけで、跳びは原理的に発生しない。
        // 装飾アニメーションであり実時間との同期に意味は無いので、滑らかさを優先する。
        // ⚠ 品質段階で frameMs が変わっても「1秒あたりの進み量」は変えない
        //   （fps を落としても光の速度が変わらないよう、実際の間隔で積算する）
        let animT = 0;

        const frame = (now) => {
            raf = requestAnimationFrame(frame);
            const st = stateRef.current;
            // 本数は絞り込み（凡例フィルタ・maxArcs）で動くため、毎フレーム見て
            // 品質段階を決める。ループを張り直さずに段階だけ切り替わる
            const tier = flowTier(st.arcs.length);
            const dt = now - lastDraw;
            // 2D フォールバックのみ表示面積でも間引く（塗り＋合成が面積比例のため）。
            // WebGL は面積の影響が小さいので本数段階の fps だけで描く
            const minMs = isGL ? tier.frameMs : frameMsForArea(tier.frameMs, st.width, st.height);
            if (dt < minMs) return;
            lastDraw = now;
            if (isGL) {
                if (renderer.glr.isLost()) return;
                sink.reset();
            } else {
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, st.width, st.height);
            }
            if (st.duration > 0 && (st.arcs.length > 0 || st.spots.length > 0)) {
                // 実際に経過した間隔で進める（上限を置いてタブ復帰時の大跳びを防ぐ）
                animT += Math.min(dt, 250) / 1000;
                // 帯の先頭は 0→1 を周回。帯の末尾が終点を過ぎてから次周が始点に
                // 入るよう、1+FLOW_LEN 周期で動かして「到達 → リップル → 再出発」を
                // 途切れなくループさせる。弧ごとに固有の位相オフセット（a.off）を
                // 足すことで、全弧が同時に出発・到達する単調さを崩し、常に
                // どこかでトラフィックが流れている画にする。
                // 速度の基準となる弧の長さ（パネル対角の約半分）。
                // これより長い弧は周期を伸ばし（＝画面上の速度を頭打ちにし）、
                // 遠距離の光だけが高速に飛ぶのを防ぐ。
                // 短い弧は従来どおり duration 秒で走る（これ以上速くはしない）
                const refLen = Math.hypot(st.width, st.height) * 0.5;
                const dims = dimRef.current;
                // ホットスポットのグロー（攻撃元は3秒周期で脈動・攻撃先は静的）。
                // SVG で描くと半透明の大きなグラデーション円の合成が重いため、
                // 毎フレーム描いているこのレイヤーに相乗りさせている（実機計測:
                // 2560x1440・4面で SVG 描画 21.6fps → 移設で大幅改善）
                st.spots.forEach((s) => {
                    let env = 0;
                    if (s.pulse) {
                        const ph = ((animT + s.off * 3) / 3) % 1;
                        env = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2); // 0→1→0
                    }
                    const r = s.r * (1 + 0.3 * env);
                    const alpha = 1 - 0.4 * env;
                    if (isGL) emitDiscGL(sink, s.x, s.y, r, s.stopsV, alpha);
                    else drawSpot2D(s, r, alpha);
                });
                st.arcs.forEach((a) => {
                    const durScale = Math.min(Math.max((a.len || refLen) / refLen, 1), 4);
                    const phase = (animT / (st.duration * durScale)) % 1;
                    const head = ((phase + a.off) % 1) * (1 + FLOW_LEN);
                    const target =
                        st.hoverKey && a.srcKey !== st.hoverKey && a.dstKey !== st.hoverKey
                            ? 0.18
                            : 1;
                    const cur = dims.has(a.id) ? dims.get(a.id) : 1;
                    const k = Math.abs(target - cur) < 0.01 ? target : cur + (target - cur) * 0.18;
                    dims.set(a.id, k);
                    // 帯の中心線サンプル（2D / GL 共通 → 軌道が食い違わない）
                    const pts = collectBandPts(a, head, tier.maxSamples);
                    // 到達後（head>1）は帯が縮むのに加えて減光もかけ、
                    // 終点に吸い込まれるように消す（リップルの減衰と歩調が合う）
                    const kb = head > 1 ? k * (1 - (head - 1) / FLOW_LEN) : k;
                    if (pts.length >= 2) {
                        if (isGL) {
                            if (tier.glow) {
                                emitBandGL(sink, pts, a.w, 2.4, a.colorV, 0.18 * kb);
                                emitBandGL(sink, pts, a.w, 1.0, a.colorV, 0.9 * kb);
                            } else {
                                emitBandGL(sink, pts, a.w, 1.0, a.colorV, 0.95 * kb);
                            }
                        } else {
                            drawFlow2D(a, pts, kb, tier);
                        }
                    }
                    // 到達演出（head が 1 を超えている間だけ）。
                    // 【v2.2.0 案2】従来は輪1つだったのを「着弾フラッシュ＋多重リップル」へ。
                    //   フラッシュ: 到達の瞬間に着弾点そのものが強く光り、素早く減衰する
                    //   多重リップル: 位相をずらした輪が続けて広がる（遠距離便の見応え）
                    if (tier.ripple && head > 1 && a.end) {
                        const rt = Math.min((head - 1) / FLOW_LEN, 1); // 0→1 で拡大しつつ減衰
                        // 着弾フラッシュ（rt が小さいうちだけ・鋭く落ちる）。
                        // 2D 経路では radialGradient の塗りが1回増えるため、
                        // fill() が1回増えるため、本数が多い段階では省く（flash2D）
                        const flash =
                            isGL || tier.flash2D ? Math.max(0, 1 - rt / IMPACT_FLASH_T) : 0;
                        if (flash > 0.01) {
                            const fa = flash * flash * 0.85 * k;
                            const fr = (3 + a.w * 2.2) * (1 + 0.8 * (1 - flash));
                            if (isGL) {
                                emitFlashGL(sink, a.end.x, a.end.y, fr, a.colorV, fa);
                            } else {
                                drawFlash2D(a, fr, fa);
                            }
                        }
                        // 多重リップル（位相をずらした輪。後続ほど弱い）
                        for (let ri = 0; ri < tier.rippleRings; ri += 1) {
                            const rp = rt - ri * RIPPLE_STAGGER;
                            if (rp <= 0 || rp >= 1) continue;
                            const decay = (1 - rp) * (1 - ri * 0.3);
                            const radius = 2.5 + rp * (10 + a.w * 4);
                            const thick = 0.5 + 1.4 * (1 - rp);
                            if (isGL) {
                                emitRingGL(
                                    sink,
                                    a.end.x,
                                    a.end.y,
                                    radius,
                                    thick,
                                    a.colorV,
                                    0.5 * decay * k
                                );
                            } else {
                                drawRipple2D(a, radius, thick, 0.5 * decay * k);
                            }
                        }
                    }
                });
                // 減光係数の記録が、消えた弧のぶんだけ際限なく増えないようにする
                if (dims.size > st.arcs.length * 2 + 64) dims.clear();
            }
            if (isGL) renderer.glr.draw(sink.array, sink.count, st.width, st.height);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [width, height, animate]);

    // width/height 属性は **付けない**。バッファ解像度は上の effect が
    // FLOW_MAX_PIXELS に合わせて決めるので、React に CSS px で上書きさせない
    // （属性を書くと再レンダリングのたびに解像度の頭打ちが外れてしまう）。
    // 表示サイズは CSS の 100% で決まる。
    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 1,
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// 表示ステート
// ---------------------------------------------------------------------------
function LoadingState() {
    return (
        <div className="viz-container viz-container--empty">
            <WaitSpinner size="large" />
        </div>
    );
}

function MessageState({ message }) {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">
                <Paragraph>{message}</Paragraph>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// カテゴリフィルタのドロップダウン（v2.1.0）
//
// 以前は @splunk/react-ui の Select を使っていたが、ポップアップが SUI テーマの
// 標準スタイル（ベタ塗りの角ばったメニュー・太い選択枠）で描かれ、
// ガラス調 HUD のオーバーレイ群から**この欄だけ浮いていた**
// （実機スクリーンショットで指摘）。自前の軽量ドロップダウンに置き換え、
// 閉じた状態もポップアップも OVERLAY_* トークンと MAP_PALETTES で統一する。
// ---------------------------------------------------------------------------
function HudSelect({ value, options, onChange, mode }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const dark = mode === 'dark';
    const palette = MAP_PALETTES[dark ? 'dark' : 'light'];
    const hoverBg = dark ? 'rgba(56, 166, 255, 0.14)' : 'rgba(56, 166, 255, 0.10)';

    // 外側クリック / Escape で閉じる（開いている間だけ購読する）
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const current = options.find((o) => o.value === value) || options[0];
    return (
        <div ref={rootRef} style={{ position: 'relative' }}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'transparent',
                    border: 'none',
                    padding: '6px 10px',
                    color: palette.legendText,
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                }}
            >
                {current ? current.label : ''}
                <span
                    aria-hidden="true"
                    style={{
                        fontSize: 9,
                        opacity: 0.8,
                        transform: open ? 'rotate(180deg)' : 'none',
                        transition: 'transform 0.15s',
                    }}
                >
                    ▼
                </span>
            </button>
            {open && (
                <div
                    role="listbox"
                    className="gtm-scroll"
                    style={{
                        position: 'absolute',
                        top: `calc(100% + ${OVERLAY_GAP + 4}px)`,
                        right: -4, // 外枠（padding 4px）の右端に揃える
                        minWidth: 'calc(100% + 8px)',
                        maxWidth: 280,
                        maxHeight: 260,
                        overflowY: 'auto',
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: OVERLAY_RADIUS,
                        boxShadow: OVERLAY_SHADOW,
                        padding: 4,
                        zIndex: 10,
                    }}
                >
                    {options.map((o) => {
                        const sel = o.value === value;
                        return (
                            <div
                                key={o.value}
                                role="option"
                                aria-selected={sel}
                                onClick={() => {
                                    onChange(o.value);
                                    setOpen(false);
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.background = hoverBg;
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.background = 'transparent';
                                }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 10,
                                    padding: '6px 10px',
                                    borderRadius: 6,
                                    color: palette.legendText,
                                    fontSize: 12,
                                    fontWeight: sel ? 700 : 400,
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {o.label}
                                </span>
                                {sel && (
                                    <span aria-hidden="true" style={{ opacity: 0.9, flexShrink: 0 }}>
                                        ✓
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// マップ本体
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// フロー一覧テーブル（v2.0.0）
//   マップ右下に浮かぶオーバーレイパネル（凡例・フィルタと同じガラス調 HUD）。
//   マップは常にパネル全域へ描画されるため、テーブルを出しても地図は縮まない
//   （見切れない）。高さは内容にフィットし、上限（heightPct）を超えるとスクロール。
//   表示中の弧（凡例フィルタ・maxArcs 適用後）と同じデータを count の多い順に出す。
//   行ホバーで該当する送信元に繋がる弧を強調し、行クリックは弧クリックと同じ
//   ドリルダウン（link.click）を発火する（登録は ThreatMap 側の effect）。
//   data-viz-ui="1" により、テーブル上のホイール／ドラッグは地図のズーム・パンにならない。
// ---------------------------------------------------------------------------
// 一度に描画する行数の上限。visibleData が数千行でも DOM を溢れさせない。
// 切り捨てが起きたときはフッターに「上位 N 行を表示（全 M 行）」と明示する
const TABLE_MAX_ROWS = 200;

// フロー一覧の保存位置（"[x,y]" 正規化 0..1）を解釈する。不正値は null（既定位置）
function parseTablePos(str) {
    if (typeof str !== 'string' || str === '') return null;
    try {
        const v = JSON.parse(str);
        if (!Array.isArray(v) || v.length < 2) return null;
        const x = Number(v[0]);
        const y = Number(v[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x: clamp(x, 0, 0.95), y: clamp(y, 0, 0.95) };
    } catch (e) {
        return null;
    }
}

// フロー一覧の保存サイズ（"[w,h]" 正規化 0..1）を解釈する。不正値は null（既定サイズ）
function parseTableSize(str) {
    if (typeof str !== 'string' || str === '') return null;
    try {
        const v = JSON.parse(str);
        if (!Array.isArray(v) || v.length < 2) return null;
        const w = Number(v[0]);
        const h = Number(v[1]);
        if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
        return { w: clamp(w, 0.15, 1), h: clamp(h, 0.1, 0.95) };
    } catch (e) {
        return null;
    }
}

// 表示名が無い地点は座標で示す（テーブルの表示とソートの両方で同じ表記を使う）
function endpointText(name, lat, lon) {
    return name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

function FlowTable({ rows, totalRows, colorOf, showCategory, categoryHeader, countHeader, hasCount, mode, heightPct, collapsed, setCollapsed, filterBottom, pos, size, dirty, onSavePos, onSaveSize, onResetLayout, sort, onSort, onRowHover, registerRow }) {
    const [hoverId, setHoverId] = useState(null);
    // 折りたたみ状態は **呼び出し側（ThreatMap）が持つ**。
    // ズーム倍率ピルをこのピルの下へ積む必要があり、位置の決定に
    // 折りたたみ状態が要るため（v2.2.0 で state を持ち上げた）。
    // 【v2.2.0】オーバーレイの質感はフィルタ・凡例と共通のトークン（MAP_PALETTES）
    // から作る。以前はこのテーブルだけ独自の色・角丸・影を持っていたため、
    // 折りたたみピルとカテゴリフィルタが隣り合うと**見た目が揃わなかった**
    // （実機スクリーンショットで指摘）。共通化して同じ「板」に見えるようにする。
    const dark = mode === 'dark';
    const base = MAP_PALETTES[dark ? 'dark' : 'light'];
    const palette = {
        bg: base.panelBg,
        border: base.panelBorder,
        headBg: 'transparent',
        headText: dark ? 'rgba(160, 200, 255, 0.85)' : '#5a6672',
        text: base.legendText,
        subText: dark ? 'rgba(160, 185, 220, 0.75)' : '#6b7684',
        rowBorder: dark ? 'rgba(120, 180, 255, 0.10)' : 'rgba(90, 140, 200, 0.15)',
        hoverBg: dark ? 'rgba(56, 166, 255, 0.14)' : 'rgba(56, 166, 255, 0.10)',
        shadow: OVERLAY_SHADOW,
    };
    const th = {
        position: 'sticky',
        top: 0,
        // スクロール時に行が透けないよう、見出しだけは不透明寄りの下地を敷く
        background: dark ? 'rgba(10, 24, 46, 0.95)' : 'rgba(255, 255, 255, 0.95)',
        color: palette.headText,
        textAlign: 'left',
        fontWeight: 600,
        fontSize: 11,
        letterSpacing: '0.06em',
        padding: '5px 8px',
        borderBottom: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
    };
    const td = {
        padding: '4px 8px',
        fontSize: 12,
        color: palette.text,
        borderBottom: `1px solid ${palette.rowBorder}`,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 200,
    };
    const leave = () => {
        setHoverId(null);
        onRowHover(null);
    };
    // ソート状態の表示（アクティブな列に ▲ / ▼ を付ける）
    const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

    // --- ヘッダーバーのドラッグでテーブルを移動する（v2.1.0） ---
    // 【性能設計】移動中は React を通さず **DOM の style を直接書く**
    // （再レンダリングゼロ。200行のテーブルをドラッグ中に再描画しない）。
    // 保存（onSavePos → setOptions）は**離した時に1回だけ**。
    // クリック（折りたたみトグル）との区別は移動量 4px のしきい値で行い、
    // ドラッグ後のクリックイベントは1回だけ握りつぶす。
    const rootRef = useRef(null);
    const headerDragRef = useRef(null);
    const suppressClickRef = useRef(false);
    const onHeaderPointerDown = useCallback((e) => {
        // 折りたたみピルは常に右上ドック固定なのでドラッグ対象にしない
        // （クリック＝展開トグルはそのまま生きる）
        if (collapsed) return;
        const root = rootRef.current;
        const panel = root ? root.offsetParent : null;
        if (!root || !panel) return;
        const panelRect = panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
        const boxRect = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
        // happy-dom 等で実寸が取れない環境ではドラッグ無効（クリックは生きる）
        if (!panelRect || !panelRect.width || !panelRect.height || !boxRect) return;
        const st = {
            startX: e.clientX,
            startY: e.clientY,
            // 掴んだ瞬間の箱の左上（パネル座標）
            boxX: boxRect.left - panelRect.left,
            boxY: boxRect.top - panelRect.top,
            boxW: boxRect.width,
            boxH: boxRect.height,
            panelW: panelRect.width,
            panelH: panelRect.height,
            moved: false,
            last: null,
        };
        headerDragRef.current = st;
        const w = window;
        const onMove = (mv) => {
            const d = headerDragRef.current;
            if (!d || !Number.isFinite(mv.clientX)) return;
            const dx = mv.clientX - d.startX;
            const dy = mv.clientY - d.startY;
            if (!d.moved && Math.hypot(dx, dy) < 4) return; // クリックとの区別
            d.moved = true;
            // 箱がパネルの外へ出ないようクランプ（ヘッダーを掴めなくならないように）
            const x = clamp(d.boxX + dx, 4, Math.max(4, d.panelW - d.boxW - 4));
            const y = clamp(d.boxY + dy, 4, Math.max(4, d.panelH - 28));
            d.last = { x: x / d.panelW, y: y / d.panelH };
            const el = rootRef.current;
            if (el) {
                el.style.left = `${x}px`;
                el.style.top = `${y}px`;
                el.style.right = 'auto';
                el.style.bottom = 'auto';
            }
        };
        const onUp = () => {
            const d = headerDragRef.current;
            headerDragRef.current = null;
            ['pointermove', 'mousemove'].forEach((t) => w.removeEventListener(t, onMove));
            ['pointerup', 'mouseup'].forEach((t) => w.removeEventListener(t, onUp));
            if (d && d.moved && d.last) {
                suppressClickRef.current = true; // 直後の click（トグル）を1回無効化
                onSavePos(d.last);
            }
        };
        ['pointermove', 'mousemove'].forEach((t) => w.addEventListener(t, onMove));
        ['pointerup', 'mouseup'].forEach((t) => w.addEventListener(t, onUp));
    }, [onSavePos, collapsed]);
    const onHeaderClick = useCallback(() => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        setCollapsed((c) => !c);
    }, [setCollapsed]);

    // --- 右下グリップのドラッグでサイズ変更（v2.1.0） ---
    // ヘッダードラッグと同じ性能設計: 移動中は DOM の style を直接書き
    // （再レンダリングゼロ）、保存は離した時に1回だけ
    const gripDragRef = useRef(null);
    const onGripPointerDown = useCallback((e) => {
        e.stopPropagation();
        e.preventDefault();
        const root = rootRef.current;
        const panel = root ? root.offsetParent : null;
        if (!root || !panel) return;
        const panelRect = panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
        const boxRect = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
        if (!panelRect || !panelRect.width || !panelRect.height || !boxRect) return;
        gripDragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            w0: boxRect.width,
            h0: boxRect.height,
            boxX: boxRect.left - panelRect.left,
            boxY: boxRect.top - panelRect.top,
            panelW: panelRect.width,
            panelH: panelRect.height,
            moved: false,
            last: null,
        };
        const w = window;
        const onMove = (mv) => {
            const d = gripDragRef.current;
            if (!d || !Number.isFinite(mv.clientX)) return;
            const dw = mv.clientX - d.startX;
            const dh = mv.clientY - d.startY;
            if (!d.moved && Math.hypot(dw, dh) < 3) return;
            d.moved = true;
            // パネルからはみ出さない範囲で 220x64px を下限にクランプ
            const nw = clamp(d.w0 + dw, 220, Math.max(220, d.panelW - d.boxX - 4));
            const nh = clamp(d.h0 + dh, 64, Math.max(64, d.panelH - d.boxY - 4));
            d.last = { w: nw / d.panelW, h: nh / d.panelH };
            const el = rootRef.current;
            if (el) {
                el.style.width = `${nw}px`;
                el.style.height = `${nh}px`;
                // 既定スタイルの maxWidth/maxHeight に阻まれないよう一時解除
                el.style.maxWidth = 'none';
                el.style.maxHeight = 'none';
            }
        };
        const onUp = () => {
            const d = gripDragRef.current;
            gripDragRef.current = null;
            ['pointermove', 'mousemove'].forEach((t) => w.removeEventListener(t, onMove));
            ['pointerup', 'mouseup'].forEach((t) => w.removeEventListener(t, onUp));
            const el = rootRef.current;
            if (el) {
                // 直接書いた一時スタイルを消し、React（size prop）に管理を戻す
                el.style.maxWidth = '';
                el.style.maxHeight = '';
            }
            if (d && d.moved && d.last) onSaveSize(d.last);
        };
        ['pointermove', 'mousemove'].forEach((t) => w.addEventListener(t, onMove));
        ['pointerup', 'mouseup'].forEach((t) => w.addEventListener(t, onUp));
    }, [onSaveSize]);

    // 位置・サイズ由来のスタイル（restored 値が枠外へはみ出さないよう数値でクランプ）
    const effSize = collapsed || !size
        ? null
        : {
              w: clamp(Math.min(size.w, pos ? 0.99 - pos.x : 0.9), 0.15, 1),
              h: clamp(Math.min(size.h, pos ? 0.99 - pos.y : 0.9), 0.1, 0.95),
          };

    return (
        <div
            ref={rootRef}
            data-viz-ui="1"
            onDoubleClick={(e) => e.stopPropagation()}
            onMouseLeave={leave}
            style={{
                position: 'absolute',
                // 【位置】折りたたみピルは**常に右上のドック位置**（カテゴリフィルタの
                // 真下）。保存位置（pos）は**展開時のみ**適用する。
                // ピルまで保存位置に付いていくと、畳んだ意味（地図を空ける）が
                // 失われるため（実機で指摘）。展開すると保存位置に戻る。
                ...(collapsed
                    ? { top: filterBottom, right: 16 }
                    : pos
                      ? { left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }
                      : { bottom: 12, right: 190 }),
                // 【サイズ】グリップで変えたサイズ（effSize。枠外へ出ない値に
                // クランプ済み）が最優先。未設定なら従来の既定:
                //   幅 = パネルの約38%（最低280px、入らなければ残り幅まで縮む）
                //   高さ = 内容にフィットし、上限 heightPct% で中身がスクロール
                // 折りたたみ中はヘッダーバーだけのピルに縮む（サイズ指定は無視）
                ...(effSize
                    ? {
                          width: `${effSize.w * 100}%`,
                          height: `${effSize.h * 100}%`,
                          minWidth: 220,
                          minHeight: 64,
                      }
                    : {
                          width: collapsed ? 'auto' : 'clamp(280px, 38%, calc(100% - 202px))',
                          maxHeight: `${heightPct}%`,
                      }),
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                background: palette.bg,
                border: palette.border,
                borderRadius: OVERLAY_RADIUS,
                boxShadow: palette.shadow,
                zIndex: 4,
            }}
        >
            {/* ヘッダーバー: クリックで折りたたみ／展開、ドラッグで移動。
                地図がテーブルに隠れて見たいときに、どかす手段が2つある */}
            <div
                data-gtm="flow-table-toggle"
                onClick={onHeaderClick}
                onPointerDown={onHeaderPointerDown}
                title={collapsed ? 'クリックで展開' : 'ドラッグで移動 / クリックで折りたたむ'}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    cursor: collapsed ? 'pointer' : 'grab',
                    userSelect: 'none',
                    touchAction: 'none',
                    flex: '0 0 auto',
                    color: palette.headText,
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                    borderBottom: collapsed ? 'none' : `1px solid ${palette.rowBorder}`,
                }}
            >
                <span
                    aria-hidden="true"
                    style={{
                        display: 'inline-block',
                        transform: collapsed ? 'rotate(-90deg)' : 'none',
                        transition: 'transform 0.15s',
                        fontSize: 10,
                    }}
                >
                    ▼
                </span>
                フロー一覧
                <span style={{ marginLeft: 4, color: palette.subText, fontWeight: 400 }}>
                    {`${formatCount(totalRows)} 行`}
                </span>
                {/* 位置・サイズの変更が未確定（表示モードで動かしただけ）の間の目印。
                    編集モードに入って保存すると確定し、この表示は消える */}
                {dirty && (
                    <span
                        data-gtm="flow-table-dirty"
                        title="位置・サイズの変更は未確定です。編集モードに入って保存すると恒久化されます"
                        style={{
                            marginLeft: 2,
                            color: palette.subText,
                            fontWeight: 400,
                            fontSize: 10,
                            opacity: 0.9,
                        }}
                    >
                        未保存
                    </span>
                )}
                {/* ドラッグ／リサイズした後だけ出る「既定に戻す」。
                    クリック（トグル）と衝突しないよう伝播を止める */}
                {(pos || size) && (
                    <span
                        data-gtm="flow-table-reset-pos"
                        title="既定の位置とサイズに戻す"
                        onClick={(e) => {
                            e.stopPropagation();
                            onResetLayout();
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{
                            marginLeft: 2,
                            padding: '0 4px',
                            cursor: 'pointer',
                            opacity: 0.75,
                            fontSize: 12,
                        }}
                    >
                        ⟲
                    </span>
                )}
            </div>
            {collapsed ? null : (
            <div className="gtm-scroll" style={{ overflow: 'auto', minHeight: 0, flex: '0 1 auto' }}>
            {rows.length === 0 ? (
                <div style={{ padding: '10px 12px', fontSize: 12, color: palette.subText }}>
                    表示できるフローがありません（絞り込みで全件が除外されています）
                </div>
            ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        {/* 列ヘッダーのクリックでソート（同じ列をもう一度でクリックで昇降反転） */}
                        <tr>
                            <th style={{ ...th, cursor: 'pointer' }} onClick={() => onSort('src')}>
                                {`送信元${arrow('src')}`}
                            </th>
                            <th style={{ ...th, cursor: 'pointer' }} onClick={() => onSort('dst')}>
                                {`宛先${arrow('dst')}`}
                            </th>
                            {showCategory && (
                                <th style={{ ...th, cursor: 'pointer' }} onClick={() => onSort('category')}>
                                    {`${categoryHeader}${arrow('category')}`}
                                </th>
                            )}
                            {hasCount && (
                                <th
                                    style={{ ...th, textAlign: 'right', cursor: 'pointer' }}
                                    onClick={() => onSort('count')}
                                >
                                    {`${countHeader}${arrow('count')}`}
                                </th>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr
                                key={r.id}
                                ref={(node) => registerRow(r.id, node)}
                                onMouseEnter={() => {
                                    setHoverId(r.id);
                                    onRowHover(r);
                                }}
                                style={{
                                    cursor: 'pointer',
                                    background: hoverId === r.id ? palette.hoverBg : 'transparent',
                                }}
                            >
                                <td style={td}>{endpointText(r.srcName, r.srcLat, r.srcLon)}</td>
                                <td style={td}>{endpointText(r.dstName, r.dstLat, r.dstLon)}</td>
                                {showCategory && (
                                    <td style={td}>
                                        <span
                                            style={{
                                                display: 'inline-block',
                                                width: 10,
                                                height: 10,
                                                borderRadius: 2,
                                                background: colorOf(r.category),
                                                marginRight: 6,
                                                verticalAlign: 'baseline',
                                            }}
                                        />
                                        {r.category}
                                    </td>
                                )}
                                {hasCount && (
                                    <td
                                        style={{
                                            ...td,
                                            textAlign: 'right',
                                            fontVariantNumeric: 'tabular-nums',
                                        }}
                                    >
                                        {formatCount(r.count)}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {totalRows > rows.length && (
                <div
                    style={{
                        padding: '5px 10px',
                        fontSize: 11,
                        color: palette.subText,
                        borderTop: `1px solid ${palette.rowBorder}`,
                    }}
                >
                    {`上位 ${rows.length} 行を表示（全 ${formatCount(totalRows)} 行）`}
                </div>
            )}
            </div>
            )}
            {/* 右下のリサイズグリップ（展開時のみ）。ドラッグでサイズ変更 */}
            {!collapsed && (
                <div
                    data-gtm="flow-table-resize"
                    onPointerDown={onGripPointerDown}
                    title="ドラッグでサイズ変更"
                    style={{
                        position: 'absolute',
                        right: 1,
                        bottom: 0,
                        width: 16,
                        height: 16,
                        cursor: 'nwse-resize',
                        color: palette.subText,
                        fontSize: 10,
                        lineHeight: '16px',
                        textAlign: 'center',
                        userSelect: 'none',
                        touchAction: 'none',
                        opacity: 0.7,
                    }}
                >
                    ◢
                </div>
            )}
        </div>
    );
}

function ThreatMap({ threats, hasCount, mode, categoryList, categoryColors, explicit, customBg, customLand, opts }) {
    const [categoryFilter, setCategoryFilter] = useState('all');
    // ホバー中の地点キー（"x,y"）。その地点に繋がる弧だけを強調する
    const [hoverKey, setHoverKey] = useState(null);
    // カスタムツールチップ（ブラウザ標準の <title> は表示が遅くスタイルも
    // 当たらないため自前で描く）。内容は state で持ち（表示/非表示の切替のみ
    // 再レンダリング）、カーソル追従は ref への直接書き込みで行う
    // （mousemove のたびに SVG 全体を再レンダリングしない）。
    const [tooltip, setTooltip] = useState(null); // { lines: string[] }
    const tooltipRef = useRef(null);
    const tooltipPosRef = useRef({ x: 0, y: 0 });
    const [containerRef, size] = useContainerSize();
    const palette = MAP_PALETTES[mode] || MAP_PALETTES.dark;

    // --- カメラ状態 -------------------------------------------------------
    // オプションで与えられた中心・ズームを初期値とし、以降はユーザーの
    // ホイール / ドラッグ操作で上書きする（地図アプリと同じ挙動）。
    // オプション側が変わったらカメラをそれに追従させる（編集画面で経度を
    // 入力した結果が即座に地図へ反映されるように）。
    const [camera, setCamera] = useState(() => ({
        lon: opts.centerLon,
        lat: opts.centerLat,
        zoom: opts.initialZoom,
    }));

    // --- カメラアニメーション（慣性パン / イージング付きリセット） ----------
    // どちらも rAF で camera を動かす。ユーザーの新たな操作（ドラッグ開始・
    // ホイール）とオプション変更で必ず打ち切る（操作の主導権を奪わない）
    const camAnimRef = useRef(0);
    const cancelCameraAnim = useCallback(() => {
        if (camAnimRef.current) {
            cancelAnimationFrame(camAnimRef.current);
            camAnimRef.current = 0;
        }
    }, []);
    useEffect(() => cancelCameraAnim, [cancelCameraAnim]); // アンマウント時に停止

    // 編集画面でオプションを変えたときはカメラをリセットする。
    // 手動操作した後でもオプション変更が確実に効くよう、オプション値の
    // 変化だけを依存にする（camera 自体を依存に入れるとループする）。
    useEffect(() => {
        cancelCameraAnim();
        setCamera({ lon: opts.centerLon, lat: opts.centerLat, zoom: opts.initialZoom });
    }, [opts.centerLon, opts.centerLat, opts.initialZoom, cancelCameraAnim]);

    // 「操作が落ち着いたカメラ」。ドラッグ / ホイール操作中は camera が毎フレーム
    // 変わるため、重い処理（地名ラベルの選定・50m 国境への切替）はこちらに
    // 追従させる。camera が LABEL_SETTLE_MS 動かなかったら同期する。
    const LABEL_SETTLE_MS = 150;
    const [settledCamera, setSettledCamera] = useState(camera);
    useEffect(() => {
        const id = setTimeout(() => setSettledCamera(camera), LABEL_SETTLE_MS);
        return () => clearTimeout(id);
    }, [camera]);

    // アニメーション: animDuration=0 で停止（静的表示）
    const animOn = opts.animDuration > 0;

    // サーチ結果が変わってフィルタ中のカテゴリが消えた場合は全件表示に戻す
    const effectiveFilter =
        categoryFilter === 'all' || categoryList.includes(categoryFilter)
            ? categoryFilter
            : 'all';

    // カテゴリ → 表示順index（グラデーションIDとホットスポットの代表色選びに使う）
    const catIndex = useMemo(
        () => Object.fromEntries(categoryList.map((s, i) => [s, i])),
        [categoryList]
    );

    // 背景: カスタム背景色が有効なら、その色からグラデーションを生成して
    // テーマ配色を上書きする（中心をやや明るく・外周をやや暗く）
    // 完全透過（transparent / アルファ0）の場合はグラデーションを描かず、
    // ダッシュボードのパネル背景をそのまま透かす
    const background = useMemo(() => {
        if (!customBg) {
            return { containerBg: palette.containerBg, bgStops: palette.bgStops };
        }
        if (customBg.a === 0) {
            return { containerBg: 'transparent', bgStops: null };
        }
        return {
            containerBg: toCss(shade(customBg, 0.4)),
            bgStops: [
                { offset: '0%', color: toCss(tint(customBg, 0.12)) },
                { offset: '60%', color: toCss(customBg) },
                { offset: '100%', color: toCss(shade(customBg, 0.4)) },
            ],
        };
    }, [customBg, palette]);

    // 陸地: カスタム陸地色が有効なら、縁取りもその色から導出する。
    // 完全透過の場合は陸地を描画しない。
    // 【v2.1.0】グロー層は廃止したため glow / glowOpacity は持たない
    const land = useMemo(() => {
        if (!customLand) {
            return {
                visible: true,
                fill: palette.landFill,
                stroke: palette.landStroke,
                strokeOpacity: palette.landStrokeOpacity,
            };
        }
        if (customLand.a === 0) {
            return { visible: false };
        }
        return {
            visible: true,
            fill: toCss(customLand),
            stroke: toCss(tint(customLand, 0.4)),
            strokeOpacity: 0.5,
        };
    }, [customLand, palette]);

    // 線の色から導出する派生色（ホットスポットの中心点・グロー・コメット先端）
    const derived = useMemo(() => {
        const out = {};
        categoryList.forEach((sev) => {
            const base = categoryColors[sev];
            out[sev] = {
                css: toCss(base),
                core: toCss(tint(base, 0.72)),
                glowInner: toCss(tint(base, 0.55)),
                glowMid: toCss(tint(base, 0.2)),
                // WebGL 用の 0-1 正規化 RGB（頂点色として使う）
                rgbV: [base.r / 255, base.g / 255, base.b / 255],
            };
        });
        return out;
    }, [categoryList, categoryColors]);

    // パネルの実サイズとカメラに合わせて投影を計算。
    //
    // 従来は fitExtent + preserveAspectRatio="none" で「引き伸ばして全面に敷く」
    // 実装だったが、それではズームしても地理的に正しい拡大にならない。
    // ここでは:
    //   1. 一度 fitSize で「世界全体がちょうど収まる」基準スケールを求める
    //   2. そのスケールに zoom を掛け、rotate で中心経度、translate で中心緯度を寄せる
    // これで地図アプリと同じ「中心を保ったまま拡大縮小」が成立する。
    // 描画に使う国境データ。mapDetail='high'（常に50m）/'low'（常に110m）/
    // 'auto'（ズームに応じて切替。上げ=4倍・下げ=3倍のヒステリシス付き）。
    //
    // 【v1.8.1】操作中（ドラッグ・ズーム）も詳細度を落とさない。
    // v1.8.0 では「操作中は110m・静止後に50m」の段階的描画にしていたが、
    // 操作のたびに国境が粗くなるのは操作感が悪いという指摘を受けて廃止した。
    // 代わりに、50m のコスト問題（全242国のパス生成で約60ms/フレーム）は
    // 「画面に映っている国だけをパス生成する」ビューポート絞り込みで解決している
    // （geo memo 内。zoom6 実測で 15/242 件・約13ms/フレーム）。
    const detailRef = useRef(false);
    if (opts.mapDetail === 'high') {
        detailRef.current = true;
    } else if (opts.mapDetail === 'low') {
        detailRef.current = false;
    } else {
        detailRef.current = detailRef.current
            ? camera.zoom >= DETAIL_ZOOM_OUT
            : camera.zoom >= DETAIL_ZOOM_IN;
    }
    const activeWorld = detailRef.current ? getWorld50() : WORLD;

    const geo = useMemo(() => {
        const projection = makeProjection(size, camera);
        if (!projection) return null;
        try {
            const path = geoPath(projection);
            // ズーム中は画面外の国をパス生成から除外する（50m を常用するための
            // 最適化。110m でも無害に効く）。広域表示（zoom<2）では画面枠の
            // 逆投影が世界全体を覆って絞り込めないため、全件描画する。
            let features = activeWorld.features;
            let vb = null;
            if (camera.zoom >= 2) {
                ensureFeatureBounds(activeWorld);
                vb = viewportGeoBounds(projection, size, camera.lon);
                if (vb) {
                    features = features.filter((f) => featureInView(f, vb, camera.lon));
                }
            }
            // 海岸線 / 内側の国境。LineString 単位に割ってあるので、国と同じ
            // ビューポート絞り込みがそのまま効く（50m 常用時の負荷対策）
            const borders = getBorders(activeWorld);
            const inView = (list) =>
                vb ? list.filter((f) => featureInView(f, vb, camera.lon)) : list;
            return {
                projection,
                path,
                landPath: features.map((f) => path(f)).join(' '),
                coastPath: inView(borders.coast).map((f) => path(f)).join(' '),
                innerBorderPath: inView(borders.inner).map((f) => path(f)).join(' '),
                graticulePath: opts.showGraticule && GRATICULE ? path(GRATICULE) || '' : '',
            };
        } catch (e) {
            return null;
        }
    }, [size, camera, activeWorld, opts.showGraticule]);

    // --- ホイールズーム / ドラッグパン -------------------------------------
    // カーソル位置を固定点として拡大する（地図アプリの標準挙動）。
    // wheel は passive:false でないと preventDefault できないため、
    // React の onWheel ではなくネイティブリスナーで張る。
    const cameraRef = useRef(camera);
    cameraRef.current = camera;
    const geoRef = useRef(geo);
    geoRef.current = geo;
    const sizeRef = useRef(size);
    sizeRef.current = size;
    const zoomEnabledRef = useRef(opts.enableZoom);
    zoomEnabledRef.current = opts.enableZoom;

    // 慣性パン: ドラッグを離した速度（度/ms）で滑走し、指数減衰で止まる。
    // 地図アプリの「投げる」操作感。速度が小さければ何もしない
    const startInertia = useCallback(
        (vLon, vLat) => {
            const MAX_V = 0.3; // 暴走ガード（度/ms）
            vLon = clamp(vLon, -MAX_V, MAX_V);
            vLat = clamp(vLat, -MAX_V, MAX_V);
            if (Math.hypot(vLon, vLat) < 0.00004) return;
            cancelCameraAnim();
            let last = performance.now();
            const step = (now) => {
                const dt = Math.min(Math.max(now - last, 0), 50); // タブ復帰等の巨大 dt を抑制
                last = now;
                const f = Math.exp(-0.004 * dt); // 減衰（約250msで1/e）
                vLon *= f;
                vLat *= f;
                if (Math.hypot(vLon, vLat) < 0.00002) {
                    camAnimRef.current = 0;
                    return;
                }
                setCamera((c) => ({
                    lon: wrapLon(c.lon + vLon * dt),
                    lat: clamp(c.lat + vLat * dt, -85, 85),
                    zoom: c.zoom,
                }));
                camAnimRef.current = requestAnimationFrame(step);
            };
            camAnimRef.current = requestAnimationFrame(step);
        },
        [cancelCameraAnim]
    );

    // 現在のカメラから target へイージング付きで遷移する（リセット時に使用）。
    // 経度は近い側へ回り、ズームは対数空間で補間する（倍率変化が等速に見える）
    const animateCameraTo = useCallback(
        (target) => {
            cancelCameraAnim();
            const from = cameraRef.current;
            const dLon = ((target.lon - from.lon + 540) % 360) - 180;
            const dLat = target.lat - from.lat;
            const zoomRatio = target.zoom / Math.max(from.zoom, 0.001);
            const T = 480; // ms
            const t0 = performance.now();
            const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2);
            const step = (now) => {
                const u = clamp((now - t0) / T, 0, 1);
                const e = ease(u);
                setCamera({
                    lon: wrapLon(from.lon + dLon * e),
                    lat: clamp(from.lat + dLat * e, -85, 85),
                    zoom: clamp(from.zoom * (zoomRatio ** e), ZOOM_MIN, ZOOM_MAX),
                });
                if (u < 1) {
                    camAnimRef.current = requestAnimationFrame(step);
                } else {
                    camAnimRef.current = 0;
                }
            };
            camAnimRef.current = requestAnimationFrame(step);
        },
        [cancelCameraAnim]
    );

    // ズーム後も「カーソルが指していた地点」がカーソル位置に留まるように中心を補正する。
    //   1. 拡大前にカーソルが指していた地理座標 anchor を得る
    //   2. 新ズームの投影を作り、そこで anchor がどこに来るかを見る
    //   3. ズレたぶんだけ中心をずらす（＝ずらした後の中心が指す地理座標を新しい中心にする）
    const recenterFrom = useCallback((screenX, screenY, nextZoom) => {
        const g = geoRef.current;
        const s = sizeRef.current;
        if (!g || !s || !g.projection.invert) return;
        const anchor = g.projection.invert([screenX, screenY]);
        if (!anchor || !anchor.every(Number.isFinite)) return;

        const cur = cameraRef.current;
        const zoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
        // 中心は据え置きのままズームだけ変えた投影を作る
        const probe = makeProjection(s, { lon: cur.lon, lat: cur.lat, zoom });
        if (!probe || !probe.invert) {
            setCamera((c) => ({ ...c, zoom }));
            return;
        }
        const after = probe(anchor);
        if (!after || !after.every(Number.isFinite)) {
            setCamera((c) => ({ ...c, zoom }));
            return;
        }
        // anchor がカーソルからズレた量だけ、画面中心を逆向きに動かす
        const target = probe.invert([
            s.w / 2 + (after[0] - screenX),
            s.h / 2 + (after[1] - screenY),
        ]);
        if (target && target.every(Number.isFinite)) {
            setCamera({ lon: wrapLon(target[0]), lat: clamp(target[1], -85, 85), zoom });
        } else {
            setCamera((c) => ({ ...c, zoom }));
        }
    }, []);

    // wheel はネイティブリスナー（passive:false）で登録し、ページスクロールを止める
    const wheelElRef = useRef(null);
    const attachWheel = useCallback((el) => {
        wheelElRef.current = el;
    }, []);

    useEffect(() => {
        const el = wheelElRef.current;
        if (!el || !opts.enableZoom) return undefined;
        const onWheel = (e) => {
            if (!zoomEnabledRef.current) return;
            // オーバーレイUI（ドロップダウンの選択肢リスト等）の上でのホイールは
            // 地図のズームにしない。リストのスクロールを妨げないため。
            if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-viz-ui="1"]')) {
                return;
            }
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const s = sizeRef.current;
            // カーソル位置を固定点にする。座標が取れない環境ではパネル中心を使う
            // （NaN のまま計算すると投影が壊れてズームが黙って効かなくなる）
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                if (!s) return;
                x = s.w / 2;
                y = s.h / 2;
            }
            const cur = cameraRef.current;
            const delta = Number.isFinite(e.deltaY) ? e.deltaY : 0;
            if (delta === 0) return;
            cancelCameraAnim(); // 慣性・リセット遷移中のホイールは手動操作を優先
            // deltaY>0（手前に回す）で縮小。指数変換で倍率が滑らかに変わる
            const factor = Math.exp(-delta * ZOOM_WHEEL_SENSITIVITY);
            recenterFrom(x, y, cur.zoom * factor);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [opts.enableZoom, recenterFrom, cancelCameraAnim, geo !== null, size !== null]);

    // ドラッグでパン（ポインタイベントでマウス/タッチ両対応）
    const dragRef = useRef(null);
    const onPointerDown = useCallback((e) => {
        if (!zoomEnabledRef.current) return;
        // 【重要】オーバーレイUI（フィルタのドロップダウン等）の上で押した場合は
        // パンを開始しない。ここで setPointerCapture すると以降のポインタイベントが
        // すべてコンテナへ横取りされ、Select が自身の pointerup / click を
        // 受け取れなくなる（＝クリックしてもドロップダウンが開かない）。
        // data-viz-ui="1" を付けた要素の内側からの操作は viz 側では扱わない。
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-viz-ui="1"]')) {
            return;
        }
        const g = geoRef.current;
        if (!g || !g.projection.invert) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        if (!Number.isFinite(px) || !Number.isFinite(py)) return;
        const origin = g.projection.invert([px, py]);
        if (!origin || !origin.every(Number.isFinite)) return;
        cancelCameraAnim(); // 滑走中に掴んだら即座に止める（地図アプリの挙動）
        // samples: 慣性パンの初速を求めるための直近のカメラ位置履歴
        dragRef.current = { origin, rect, camera: cameraRef.current, moved: false, samples: [] };
        // ポインタ捕捉は「実際に動き始めてから」行う（onPointerMove 側）。
        // 押した瞬間に捕捉すると、単なるクリックでも下の要素がイベントを失う。
    }, [cancelCameraAnim]);

    const onPointerMove = useCallback((e) => {
        const drag = dragRef.current;
        const g = geoRef.current;
        if (!drag || !g || !g.projection.invert) return;
        const here = g.projection.invert([
            e.clientX - drag.rect.left,
            e.clientY - drag.rect.top,
        ]);
        if (!here || !here.every(Number.isFinite)) return;
        // 実際に動き始めた最初の1回だけポインタを捕捉する。
        // こうするとクリック（押して離すだけ）では捕捉が起きないため、
        // オーバーレイUIや将来のドリルダウンのクリックを妨げない。
        if (!drag.moved) {
            drag.moved = true;
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch (err) { /* 未対応環境では捕捉なしでも概ね動く */ }
        }
        // 掴んだ地点がカーソルに追従するよう中心をずらす
        const cur = cameraRef.current;
        const next = {
            lon: wrapLon(cur.lon - (here[0] - drag.origin[0])),
            lat: clamp(cur.lat - (here[1] - drag.origin[1]), -85, 85),
            zoom: cur.zoom,
        };
        setCamera(next);
        // 慣性パンの初速用にカメラ位置の履歴を取る（直近数点だけ保持）
        drag.samples.push({ t: performance.now(), lon: next.lon, lat: next.lat });
        if (drag.samples.length > 6) drag.samples.shift();
    }, []);

    const endDrag = useCallback((e) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        if (!drag.moved) return; // 捕捉していないので解放も不要
        try {
            e.currentTarget.releasePointerCapture(e.pointerId);
        } catch (err) { /* noop */ }
        // 離した瞬間の速度から慣性パンを開始する。
        // 直近 120ms 以内のサンプルだけで速度を出す（途中で止めてから離した
        // 場合は古い速度で滑らないように）。dt が小さすぎる場合は速度が
        // 発散するため開始しない
        const now = performance.now();
        const recent = drag.samples.filter((s) => now - s.t < 120);
        if (recent.length >= 2) {
            const a = recent[0];
            const b = recent[recent.length - 1];
            const dt = b.t - a.t;
            if (dt >= 8 && now - b.t < 80) {
                const dLon = ((b.lon - a.lon + 540) % 360) - 180; // ±180 をまたいでも最短方向
                startInertia(dLon / dt, (b.lat - a.lat) / dt);
            }
        }
    }, [startInertia]);

    // ダブルクリックで初期表示（オプションの中心・ズーム）へイージング付きで戻す
    const onDoubleClick = useCallback(() => {
        animateCameraTo({ lon: opts.centerLon, lat: opts.centerLat, zoom: opts.initialZoom });
    }, [opts.centerLon, opts.centerLat, opts.initialZoom, animateCameraTo]);

    // ツールチップのカーソル追従（state を介さず DOM を直接動かす）
    const positionTooltip = useCallback((e) => {
        const host = containerRef.current;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        tooltipPosRef.current = { x, y };
        const el = tooltipRef.current;
        if (el) applyTooltipPos(el, x, y, rect.width || 0, rect.height || 0);
    }, [containerRef]);

    // 表示直後は要素の実サイズが確定してから位置を合わせ直す
    // （初回レンダリング時点では offsetWidth が取れないため）
    useEffect(() => {
        const el = tooltipRef.current;
        if (!el || !size) return;
        applyTooltipPos(el, tooltipPosRef.current.x, tooltipPosRef.current.y, size.w, size.h);
    }, [tooltip, size]);

    // フィルタと上限（maxArcs）は投影前のデータに適用する。
    // カメラ操作では変わらないため、地名ラベルの選定など「操作中に再計算したくない」
    // 処理の依存をここに寄せられる（投影後の visible はカメラごとに変わる）。
    const visibleData = useMemo(() => {
        const filtered =
            effectiveFilter === 'all'
                ? threats
                : threats.filter((t) => t.category === effectiveFilter);
        // 上限が設定されていれば count の多い順に絞る（0 = 無制限）。
        // 元の並び順は維持したいので、残す id の集合を作ってから filter する。
        if (opts.maxArcs > 0 && filtered.length > opts.maxArcs) {
            const keep = new Set(
                [...filtered]
                    .sort((a, b) => b.count - a.count)
                    .slice(0, opts.maxArcs)
                    .map((t) => t.id)
            );
            return filtered.filter((t) => keep.has(t.id));
        }
        return filtered;
    }, [threats, effectiveFilter, opts.maxArcs]);

    // 座標を投影（カメラが動くたびに再計算する軽い処理だけを残す）
    const visible = useMemo(() => {
        if (!geo) return [];
        return visibleData
            .map((t) => {
                const s = geo.projection([t.srcLon, t.srcLat]);
                const d = geo.projection([t.dstLon, t.dstLat]);
                if (!s || !d || ![...s, ...d].every(Number.isFinite)) return null;
                return { ...t, sx: s[0], sy: s[1], tx: d[0], ty: d[1] };
            })
            .filter(Boolean);
    }, [geo, visibleData]);

    // 表示中の弧における count の範囲。太さの正規化に使う。
    // 固定式（sqrt(count)）だと count が 10 でも 10000 でも太さがほぼ変わらないため、
    // 「実データの最小〜最大」を基準に相対的な太さを決める。
    const countRange = useMemo(() => {
        let lo = Infinity;
        let hi = -Infinity;
        visible.forEach((t) => {
            if (t.count < lo) lo = t.count;
            if (t.count > hi) hi = t.count;
        });
        return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : { lo: 0, hi: 0 };
    }, [visible]);

    // --- 件数サマリー（v1.9.0） -------------------------------------------
    // 【なぜ必要か】maxArcs は「count 上位 N 本だけ描いて残りを捨てる」動作なので、
    // 捨てられた分の存在が画面上どこにも出ず「全体で何件あるのか」が分からなかった。
    // ここでは **絞り込み前の全件（threats）** と **実際に描いた分（visibleData）** の
    // 両方を数え、凡例に「表示 N / 全 M」として出す。
    //
    // 数える対象は count 列の有無で変える:
    //   - count 列あり … 合計イベント数（単位「件」）。データの実量を表す
    //   - count 列なし … 弧の本数（単位「本」）。count は 1 固定なので本数と一致する
    // hasCount は「count 列が解決できたか」＝ parseThreats が付けた印を見る。
    const totals = useMemo(() => {
        // 1行あたりの寄与。count 列が無ければ「1本」として数える。
        // 現状 parseThreats が count を必ず有限値にしているが、非有限が紛れ込むと
        // 凡例に NaN が出てしまうため、合計・内訳の両方で同じガードを通す。
        const weigh = (t) => {
            if (!hasCount) return 1;
            return Number.isFinite(t.count) ? t.count : 0;
        };
        const sum = (list) => list.reduce((acc, t) => acc + weigh(t), 0);
        // カテゴリ別の内訳は **絞り込み前の全件** で数える。
        // 【重要】visibleData（描画中の分）で数えてはいけない。凡例クリックで
        // 絞り込むと他カテゴリが全て 0 になり、「medium のデータが無い」と
        // 誤読させてしまう（実際は隠れているだけ）。凡例は「どのカテゴリに
        // どれだけあるか」の一覧なので、フィルタ状態に依存させない。
        // maxArcs による上限も同様に無視する（捨てた分は総数側で示す）。
        const byCategory = {};
        threats.forEach((t) => {
            byCategory[t.category] = (byCategory[t.category] || 0) + weigh(t);
        });
        return {
            shown: sum(visibleData),
            all: sum(threats),
            // 絞り込み（凡例クリック）や maxArcs で実際に減っているか
            truncated: visibleData.length < threats.length,
            // count 列がある → ユーザー指定の単位（既定「件」。バイト数等の量でもよい）。
            // 無い → 弧の本数を数えているので「本」
            unit: hasCount ? opts.countLabel : '本',
            byCategory,
        };
    }, [threats, visibleData, hasCount, opts.countLabel]);

    // ホバー強調が有効なときだけ実際に適用する
    const activeHoverKey = opts.highlightOnHover ? hoverKey : null;

    // --- ドリルダウン（インタラクション） ---------------------------------
    // 発火するのは addDrilldownListener に登録した DOM ノードのクリックだけ。
    // triggerDrilldown() を自前の onClick から呼んでも効かない（サイレントに無視される）。
    // そのため「要素1つずつ」に、その要素専用の payload を閉じ込めて登録する。
    // payloadCallback を使い回して行番号を固定すると、どこを押しても同じ行が飛ぶ。
    const arcRefs = useRef(new Map());
    const spotRefs = useRef(new Map());

    // 起点・終点のホットスポット
    // 重複除去 + 同一地点に複数カテゴリの線が集まる場合は「表示順が先の」色を採用する。
    // 表示順はユーザーの categoryOrder（未指定なら登場順）なので、
    // **どのカテゴリを代表色にするかもユーザーの指定に従う**ことになる。
    // 「深刻度が高い方を優先」のような意味的な判断は viz では行わない。
    // 表示名は最初に見つかった非空のものを使う。
    // 【v1.9.0】集約は「画面距離が clusterRadius 以内」で行う（従来は 0.1px 完全一致）。
    // 併せて、各弧がどのクラスタに属するかを引ける対応表（arcEnds）も作る。
    // 弧の始点・終点をクラスタ代表点へ吸着させることで、束ねられた地点から
    // 弧が伸びる見た目になり、終端が数十本に割れて潰れるのを防ぐ。
    const { sources, targets, arcEnds } = useMemo(() => {
        // 1点1レコードに展開してから集約する（集約前の粒度を保つ）
        const srcPts = visible.map((t) => ({
            x: t.sx, y: t.sy, count: t.count, category: t.category, name: t.srcName, id: t.id,
        }));
        const dstPts = visible.map((t) => ({
            x: t.tx, y: t.ty, count: t.count, category: t.category, name: t.dstName, id: t.id,
        }));

        // クラスタ（またはキー完全一致）を「表示用の地点」へ畳む。
        // 代表カテゴリ・代表名の決め方は従来の merge と同じ規則を踏襲する:
        //   - カテゴリ: 表示順（categoryOrder → 登場順）が先のものを採用
        //   - 表示名  : 最初に見つかった非空のもの
        //   - count   : 合算
        const fold = (pts) => {
            const spots = [];
            const byId = new Map(); // 弧の id → 所属スポット（弧の端点吸着に使う）
            const groups = clusterPoints(pts, opts.clusterRadius);
            const buckets = groups
                ? groups.map((c) => ({ x: c.x, y: c.y, members: c.members }))
                : (() => {
                      // 集約無効時は従来どおり 0.1px 完全一致でまとめる
                      const m = new Map();
                      pts.forEach((p) => {
                          const k = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
                          if (!m.has(k)) m.set(k, { x: p.x, y: p.y, members: [] });
                          m.get(k).members.push(p);
                      });
                      return [...m.values()];
                  })();

            buckets.forEach((b) => {
                let count = 0;
                let category;
                let name = '';
                b.members.forEach((p) => {
                    count += p.count;
                    if (!name && p.name) name = p.name;
                    if (category === undefined || (catIndex[p.category] ?? 0) < (catIndex[category] ?? 0)) {
                        category = p.category;
                    }
                });
                const spot = {
                    x: b.x,
                    y: b.y,
                    count,
                    category,
                    name,
                    // 集約された元地点の数（1 なら単独地点）。ツールチップに出す
                    size: b.members.length,
                };
                spots.push(spot);
                b.members.forEach((p) => byId.set(p.id, spot));
            });
            return { spots, byId };
        };

        const s = fold(srcPts);
        const d = fold(dstPts);
        return {
            sources: s.spots,
            targets: d.spots,
            arcEnds: { src: s.byId, dst: d.byId },
        };
    }, [visible, catIndex, opts.clusterRadius]);

    // 弧の端点をクラスタ代表点へ吸着させた描画用データ。
    // 集約が無効（clusterRadius=0）なら元の座標と一致するので見た目は変わらない。
    const arcs = useMemo(
        () =>
            visible.map((t) => {
                const s = arcEnds.src.get(t.id);
                const d = arcEnds.dst.get(t.id);
                return {
                    ...t,
                    sx: s ? s.x : t.sx,
                    sy: s ? s.y : t.sy,
                    tx: d ? d.x : t.tx,
                    ty: d ? d.y : t.ty,
                };
            }),
        [visible, arcEnds]
    );

    // count → 線幅。widthScale=0 なら一律。データが全て同値なら中庸の太さ。
    const arcWidth = useCallback(
        (count) => {
            const BASE = 0.9;
            if (opts.widthScale <= 0) return BASE;
            const { lo, hi } = countRange;
            // sqrt で圧縮してから 0..1 に正規化（極端な外れ値に引っ張られにくい）
            const norm =
                hi > lo
                    ? (Math.sqrt(Math.max(count, 0)) - Math.sqrt(Math.max(lo, 0))) /
                      (Math.sqrt(Math.max(hi, 0)) - Math.sqrt(Math.max(lo, 0)))
                    : 0.5;
            return BASE + clamp(norm, 0, 1) * 3.2 * opts.widthScale;
        },
        [countRange, opts.widthScale]
    );

    // 弧のジオメトリ（2次ベジェ）。
    // SVG のベース軌道・当たり判定・Canvas の彗星がすべて同じ geom を使うので、
    // どの描画レイヤーでも軌道が食い違わない
    const arcGeoms = useMemo(
        () =>
            arcs.map((t) => {
                const geom = buildArcGeom(t);
                return { t, geom, d: geomPath(geom) };
            }),
        [arcs]
    );

    // Canvas の光の帯用の弧データ（ジオメトリ・色・線幅を事前計算して rAF から使う）
    const flowArcs = useMemo(
        () =>
            arcGeoms.map(({ t, geom }) => {
                // 画面上の長さ（px）。速度の正規化（長い弧ほど速く動いてガクつくのを
                // 防ぐ）と、帯のサンプル数の調整（長い帯が折れ線に見えるのを防ぐ）に使う
                const len = geomLength(geom);
                return {
                    geom,
                    end: geomEnd(geom), // 到達リップルの中心
                    color: derived[t.category]?.css || 'rgb(56, 166, 255)',
                    // WebGL 用の頂点色（0-1 正規化）。css と同じ色
                    colorV: derived[t.category]?.rgbV || [56 / 255, 166 / 255, 1],
                    w: arcWidth(t.count),
                    len,
                    // 帯の中心線サンプル数。帯の画面長 ≒ len×FLOW_LEN に対して
                    // 約6pxに1点。短い弧は従来どおり16点、長い弧は最大72点まで増やす
                    samples: Math.min(72, Math.max(16, Math.round((len * FLOW_LEN) / 6))),
                    // ホバー強調時に「関係ない弧」を薄くするための識別子
                    id: t.id,
                    // 弧ごとの位相オフセット（0..1）。id から決定的に散らし、
                    // 全弧が同時に出発・到達する単調さを崩す
                    off: (Math.imul(t.id + 1, 2654435761) >>> 0) / 4294967296,
                    srcKey: `${t.sx.toFixed(1)},${t.sy.toFixed(1)}`,
                    dstKey: `${t.tx.toFixed(1)},${t.ty.toFixed(1)}`,
                };
            }),
        [arcGeoms, derived, arcWidth]
    );

    // Canvas に描くホットスポットのグロー（v2.2.0）。
    // 攻撃元は脈動（3秒周期・位相をずらす）、攻撃先は静的な淡いグロー。
    // SVG の radialGradient（gtm-hot-*）と同じ色・同じ停止位置を再現する。
    const flowSpots = useMemo(() => {
        if (!animOn) return []; // 静止時は SVG 側が1回だけ描く
        const build = (list, radiusOf, scale, pulse) =>
            list.map((s, i) => {
                const base = categoryColors[s.category] || parseColor(DEFAULT_CATEGORY_COLOR);
                const inner = tint(base, 0.55);
                const mid = tint(base, 0.2);
                return {
                    x: s.x,
                    y: s.y,
                    r: radiusOf(s),
                    // SVG の stop（0%/30%/70%/100%）と同じ不透明度を色に載せる
                    // （2D フォールバックの createRadialGradient 用の CSS 文字列）
                    inner: withAlpha(inner, 0.95 * scale),
                    mid: withAlpha(mid, 0.5 * scale),
                    outer: withAlpha(base, 0.17 * scale),
                    edge: withAlpha(base, 0),
                    // WebGL 用の同じ4ストップ（[r,g,b,a] 0-1 正規化。半径 0/0.3r/0.7r/r）
                    stopsV: [
                        [inner.r / 255, inner.g / 255, inner.b / 255, (inner.a ?? 1) * 0.95 * scale],
                        [mid.r / 255, mid.g / 255, mid.b / 255, (mid.a ?? 1) * 0.5 * scale],
                        [base.r / 255, base.g / 255, base.b / 255, (base.a ?? 1) * 0.17 * scale],
                        [base.r / 255, base.g / 255, base.b / 255, 0],
                    ],
                    // 脈動の位相。従来の begin={(i%5)*0.5s} と同じ5段階
                    off: pulse ? (i % 5) * 0.5 / 3 : 0,
                    pulse,
                };
            });
        return [
            // 攻撃先（静的・やや淡い）を先に描き、攻撃元を上に重ねる
            ...build(targets, () => 20, 0.85, false),
            ...build(sources, (s) => Math.min(26 + Math.sqrt(s.count) * 1.5, 44), 1, true),
        ];
    }, [animOn, sources, targets, categoryColors]);

    // --- 地名ラベル（ズーム段階で国名 → 都市名が現れる） -------------------
    // 画面外は捨て、重なるものは重要度の高い方を残す（地図アプリの間引きと同じ）。
    // 始点/終点の都市ラベルを優先したいので、そちらが先に場所を確保する。
    //
    // 【パフォーマンス】この選定は全都市（約7,300件）の走査＋重なり判定を伴い重い。
    // ドラッグ / ホイールの毎フレーム実行すると低スペック環境でカクつくため、
    // **選定は settledCamera（操作が150ms止まったカメラ）基準**で行い、
    // 操作中は「選定済みラベルを現在のカメラで投影し直すだけ」（次の placeLabels memo）
    // にする。操作中のラベルは一瞬古い選定のまま流れるが、止まると確定する。
    const labelSelection = useMemo(() => {
        if (!size || !opts.showPlaceLabels) return [];
        const projection = makeProjection(size, settledCamera);
        if (!projection) return [];
        const { w, h } = size;
        const fs = opts.placeLabelSize;
        const budget = labelBudget(settledCamera.zoom, opts.labelDensity);
        // 地図由来の地名の表示名（labelLang='ja' なら日本語名。無ければ英語名のまま）
        const displayName = (entry) =>
            opts.labelLang === 'ja' && entry.ja ? entry.ja : entry.name;
        // 占有済み矩形。ラベル同士が重ならないかの判定に使う
        const taken = [];
        // 表示量に応じてラベル同士の間隔を変える（＝重なり判定の厳しさを変える）。
        // 件数の上限だけ動かしても、判定が固定だと実際の表示数はほとんど変わらないため、
        // 「候補数」と「間隔」の両方を連動させる。
        //   density>1 … 間隔を詰めて多く出す（下限 0.45）
        //   density<1 … 間隔を広げて厳選する（上限 2.0）
        const pad = clamp(1 / (opts.labelDensity || 1), 0.45, 2);
        const fits = (x, y, text) => {
            // SVG に measureText は無いため推定幅（CJK は全角、他は約0.6em）
            let wEst = 0;
            for (const ch of text) {
                wEst += ch.codePointAt(0) > 0x2e7f ? fs : fs * 0.6;
            }
            wEst *= pad;
            const box = { x0: x - wEst / 2, x1: x + wEst / 2, y0: y - fs * pad, y1: y + fs * 0.4 * pad };
            if (box.x0 < 2 || box.x1 > w - 2 || box.y0 < 2 || box.y1 > h - 2) return null;
            for (const t of taken) {
                if (box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0) return null;
            }
            return box;
        };
        const out = [];
        const place = (name, lon, lat, kind) => {
            const p = projection([lon, lat]);
            if (!p || !p.every(Number.isFinite)) return;
            const box = fits(p[0], p[1], name);
            if (!box) return;
            taken.push(box);
            // 位置は経緯度で持ち、描画時に「現在の」カメラで投影し直す
            out.push({ name, lon, lat, kind });
        };

        // 1. 始点/終点の都市名は最優先で確保する（ユーザーのデータそのもの）。
        //    カメラ操作中に依存が変わらないよう、投影前の visibleData から経緯度で集める
        if (opts.showEndpointLabels) {
            const endpoints = new Map();
            visibleData.forEach((t) => {
                if (t.srcName) endpoints.set(`${t.srcLon},${t.srcLat}`, { n: t.srcName, lon: t.srcLon, lat: t.srcLat });
                if (t.dstName) endpoints.set(`${t.dstLon},${t.dstLat}`, { n: t.dstName, lon: t.dstLon, lat: t.dstLat });
            });
            endpoints.forEach((e) => place(e.n, e.lon, e.lat, 'endpoint'));
        }

        // 2. 国名（面積の大きい順に budget 件まで）
        COUNTRY_LABELS.slice(0, budget.countries).forEach((c) => place(displayName(c), c.lon, c.lat, 'country'));

        // 3. 都市名（重要度順に budget 件まで。ズームが浅いうちは 0 件）
        //
        // 【重要】「上位N件を取ってから画面内かを見る」のは誤り。
        // 拡大すると世界の主要都市はほとんど画面外になるため、
        // 上位N件がまるごと捨てられ「ズームするほど地名が減る」症状になっていた
        // （zoom40 で budget=600 件なのに実際は3件しか出ない、という実測値）。
        // 正しくは **先に画面内へ絞り、そのうえで重要度順に budget 件** を採る。
        if (budget.cities > 0) {
            const inView = [];
            for (let i = 0; i < CITY_LABELS.length; i += 1) {
                const c = CITY_LABELS[i];
                const p = projection([c.lon, c.lat]);
                if (!p || !p.every(Number.isFinite)) continue;
                if (p[0] < 0 || p[0] > w || p[1] < 0 || p[1] > h) continue;
                // CITY_LABELS は重要度順に並んでいるので、この順序がそのまま優先度になる
                inView.push({ c, p });
                if (inView.length >= budget.cities) break;
            }
            inView.forEach(({ c }) => place(displayName(c), c.lon, c.lat, 'city'));
        }
        return out;
    }, [size, settledCamera, opts.showPlaceLabels, opts.showEndpointLabels, opts.placeLabelSize, opts.labelDensity, opts.labelLang, visibleData]);

    // 選定済みラベルを現在のカメラで投影する（軽い処理。毎フレーム実行してよい）。
    // 操作中に画面外へ流れたラベルはここで落ちる
    const placeLabels = useMemo(() => {
        if (!geo || !size) return [];
        const out = [];
        labelSelection.forEach((l) => {
            const p = geo.projection([l.lon, l.lat]);
            if (!p || !p.every(Number.isFinite)) return;
            if (p[0] < -40 || p[0] > size.w + 40 || p[1] < -40 || p[1] > size.h + 40) return;
            out.push({ name: l.name, kind: l.kind, x: p[0], y: p[1] });
        });
        return out;
    }, [geo, size, labelSelection]);

    // 弧とホットスポットをドリルダウン対象として登録する。
    // 要素は再描画で作り直されるため、データが変わるたびに登録し直す。
    // 登録に失敗しても描画は続行する（ホスト API 未提供の環境で落とさない）。
    useEffect(() => {
        if (typeof addDrilldownListener !== 'function') return;
        try {
            arcs.forEach((t) => {
                const node = arcRefs.current.get(t.id);
                if (!node) return;
                addDrilldownListener({
                    node,
                    action: 'link.click',
                    // この要素専用の payload（固定でよい）。
                    // row.<フィールド名>.value 形式にすると
                    // 編集画面「インタラクション」からフィールド名で参照できる。
                    payloadCallback: () => ({
                        'row.src_name.value': t.srcName,
                        'row.dst_name.value': t.dstName,
                        'row.src_lat.value': t.srcLat,
                        'row.src_lon.value': t.srcLon,
                        'row.dst_lat.value': t.dstLat,
                        'row.dst_lon.value': t.dstLon,
                        'row.category.value': t.category,
                        'row.count.value': t.count,
                        name: 'src_name',
                        value: t.srcName || `${t.srcLat},${t.srcLon}`,
                    }),
                });
            });
            [...sources.map((s) => ({ s, kind: 'src' })), ...targets.map((s) => ({ s, kind: 'dst' }))]
                .forEach(({ s, kind }) => {
                    const key = `${kind}:${s.x.toFixed(1)},${s.y.toFixed(1)}`;
                    const node = spotRefs.current.get(key);
                    if (!node) return;
                    addDrilldownListener({
                        node,
                        action: 'point.click',
                        payloadCallback: () => ({
                            'row.name.value': s.name,
                            'row.category.value': s.category,
                            'row.count.value': s.count,
                            'row.role.value': kind === 'src' ? 'source' : 'target',
                            name: kind === 'src' ? 'src_name' : 'dst_name',
                            value: s.name || `${s.x.toFixed(1)},${s.y.toFixed(1)}`,
                        }),
                    });
                });
        } catch (e) {
            /* ドリルダウン未対応環境でも描画は続ける */
        }
    }, [arcs, sources, targets]);

    // --- フロー一覧テーブル（v2.0.0） -------------------------------------
    // 表示中の弧（凡例フィルタ・maxArcs 適用後）と同じデータを出す。
    // 地図と食い違う一覧を出さない（絞り込んだら表も絞る）。
    // 並び順は列ヘッダーのクリックで変更できる（既定は値の大きい順）
    const [tableSort, setTableSort] = useState({ key: 'count', dir: 'desc' });
    // フロー一覧の折りたたみ状態。ズーム倍率ピルをこのピルの下に積むため、
    // FlowTable のローカル state ではなくここで持つ（v2.2.0）。
    // オプション（編集画面のチェック）が変わったら表示へ反映する
    const [tableCollapsed, setTableCollapsed] = useState(!!opts.tableCollapsed);
    useEffect(() => {
        setTableCollapsed(!!opts.tableCollapsed);
    }, [opts.tableCollapsed]);

    // --- フロー一覧の位置とサイズ（ドラッグ／リサイズ ⇔ options 保存） --------
    // link-line の labelPos と同じ機構（実機確認済み）:
    //   - 位置は tablePos（"[x,y]"）、サイズは tableSize（"[w,h]"）。どちらも
    //     正規化座標のスキーマ外キーとして setOptions で保存する（再起動不要）
    //   - 表示モード中の setOptions はダッシュボード定義に取り込まれないことが
    //     あるため、pending に保持して**編集モードに入った瞬間に再送（flush）**する。
    //     編集モードで「保存」すると定義に永続化される
    //   - 外部変更（undo・他画面）には追従し、自分の保存の echo は消し込む。
    //     【v2.1.0 修正】ただし **pending がある間は外部値で上書きしない**。
    //     以前は「外部値 ≠ 直近保存値なら pending ごと破棄」していたため、
    //     編集モード突入時にホストが定義から古い options を再配信すると
    //     保存待ちの位置がその瞬間に消え、flush が空振り＝**保存したはずの
    //     位置修正が再読み込みで元に戻る**ことがあった。ユーザーの最新操作を
    //     ホストへの反映が確認できるまで保持する
    const { options: rawOptions, setOptions } = useOptions();
    const modeApi = useMode();
    const isEdit = modeApi?.mode === 'edit';
    const optsTablePos = useMemo(() => parseTablePos(opts.tablePos), [opts.tablePos]);
    const optsTableSize = useMemo(() => parseTableSize(opts.tableSize), [opts.tableSize]);
    // 'default' = リセット直後（echo 到着前でも既定の位置・サイズを出すためのセンチネル）
    const [tablePosDraft, setTablePosDraft] = useState(null);
    const [tableSizeDraft, setTableSizeDraft] = useState(null);
    const tablePendingRef = useRef({}); // { tablePos?, tableSize? }
    const lastSavedRef = useRef({}); // { tablePos?, tableSize? }
    // 未保存の変更があるか（ヘッダーの「未保存」表示用。ref だけだと再描画されない）
    const [tableDirty, setTableDirty] = useState(false);
    const syncDirty = () => setTableDirty(Object.keys(tablePendingRef.current).length > 0);
    const rawOptionsRef = useRef(rawOptions);
    rawOptionsRef.current = rawOptions;
    const setOptionsRef = useRef(setOptions);
    setOptionsRef.current = setOptions;

    // 外部変更への追従（キーごと共通）。
    //   - 自分の保存の echo（incoming === pending）→ pending を消費して確定
    //   - それ以外の外部値 → draft を捨てて追従する。ただし **pending は消さない**。
    //     編集モード突入時にホストが古い定義の options を再配信しても、
    //     直後の flush（下の effect）が pending を再送するので最終的に
    //     ユーザーの最新操作が勝つ。
    //     ⚠ pending を「外部値と不一致」で消してはいけない（旧実装のバグ）。
    //       また「不一致の間は draft も維持」にすると、echo と同値の変更イベントが
    //       来ない限り pending が残留し、以後の正当な外部更新まで永遠にブロックする
    //       （テストで検出）。追従と pending 保持は分離するのが正しい
    const followExternal = (key, incoming, setDraft) => {
        if (tablePendingRef.current[key] !== undefined && incoming === tablePendingRef.current[key]) {
            delete tablePendingRef.current[key]; // ホストに反映された（draft は表示継続でよい）
            syncDirty();
            return;
        }
        if (incoming !== lastSavedRef.current[key]) setDraft(null);
    };
    useEffect(() => {
        followExternal('tablePos', typeof opts.tablePos === 'string' ? opts.tablePos : '', setTablePosDraft);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opts.tablePos]);
    useEffect(() => {
        followExternal('tableSize', typeof opts.tableSize === 'string' ? opts.tableSize : '', setTableSizeDraft);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opts.tableSize]);

    // 編集モードに入った瞬間、未確定の変更を正規ルートで再送して定義を dirty にする
    useEffect(() => {
        if (!isEdit) return;
        const raw = rawOptionsRef.current && typeof rawOptionsRef.current === 'object' ? rawOptionsRef.current : {};
        const pend = tablePendingRef.current;
        const patch = {};
        ['tablePos', 'tableSize'].forEach((key) => {
            if (pend[key] !== undefined && pend[key] !== (typeof raw[key] === 'string' ? raw[key] : '')) {
                patch[key] = pend[key];
            }
        });
        if (Object.keys(patch).length > 0 && typeof setOptionsRef.current === 'function') {
            setOptionsRef.current({ ...raw, ...patch });
        }
    }, [isEdit]);

    // 保存の共通処理（pending 登録・setOptions 送信）。
    // 【重要】送信は必ず1回にまとめ、**pending 全体を毎回重ねて**送る。
    //   - 2回に分けると、2回目が古い rawOptions を展開して1回目を上書きする
    //     （リセットで実際に発生。テストで検出した実バグ）
    //   - 表示モード中はホストが options を echo しないことがあるため、
    //     rawOptions には直前の保存が載っていない。pending を重ねないと
    //     次の保存で前の保存が落ちる
    const saveTableFields = (patch, drafts) => {
        Object.entries(patch).forEach(([key, json]) => {
            lastSavedRef.current[key] = json;
            tablePendingRef.current[key] = json;
        });
        drafts.forEach(([setDraft, v]) => setDraft(v));
        syncDirty();
        const raw = rawOptionsRef.current && typeof rawOptionsRef.current === 'object' ? rawOptionsRef.current : {};
        if (typeof setOptionsRef.current === 'function') {
            setOptionsRef.current({ ...raw, ...tablePendingRef.current });
        }
    };
    const saveTablePos = useCallback((p) => {
        const json = p
            ? JSON.stringify([Math.round(p.x * 10000) / 10000, Math.round(p.y * 10000) / 10000])
            : '';
        saveTableFields({ tablePos: json }, [[setTablePosDraft, p ? { ...p } : 'default']]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const saveTableSize = useCallback((sz) => {
        const json = sz
            ? JSON.stringify([Math.round(sz.w * 10000) / 10000, Math.round(sz.h * 10000) / 10000])
            : '';
        saveTableFields({ tableSize: json }, [[setTableSizeDraft, sz ? { ...sz } : 'default']]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // ⟲ は位置とサイズの両方を既定へ戻す（setOptions は1回だけ）
    const resetTableLayout = useCallback(() => {
        saveTableFields(
            { tablePos: '', tableSize: '' },
            [
                [setTablePosDraft, 'default'],
                [setTableSizeDraft, 'default'],
            ]
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const tablePos = tablePosDraft === 'default' ? null : tablePosDraft || optsTablePos;
    const tableSize = tableSizeDraft === 'default' ? null : tableSizeDraft || optsTableSize;
    const onTableSort = useCallback((key) => {
        setTableSort((s) =>
            s.key === key
                ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
                // 新しい列: 数値（値）は大きい順、文字列は昇順から始める
                : { key, dir: key === 'count' ? 'desc' : 'asc' }
        );
    }, []);
    const tableRowsAll = useMemo(() => {
        if (!opts.showTable) return [];
        const { key, dir } = tableSort;
        const sign = dir === 'asc' ? 1 : -1;
        const val = (t) => {
            if (key === 'count') return t.count;
            if (key === 'src') return endpointText(t.srcName, t.srcLat, t.srcLon);
            if (key === 'dst') return endpointText(t.dstName, t.dstLat, t.dstLon);
            return t.category || '';
        };
        return [...visibleData].sort((a, b) => {
            const va = val(a);
            const vb = val(b);
            const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ja');
            // 同値は id（元データの行順）で安定化する
            return cmp !== 0 ? sign * cmp : a.id - b.id;
        });
    }, [opts.showTable, visibleData, tableSort]);
    // DOM を溢れさせない描画上限。ソートを変えると「上位200行」の中身も変わるため、
    // スライスはここで行い、下のドリルダウン登録 effect が新しい行に追従できるようにする
    const tableRows = useMemo(() => tableRowsAll.slice(0, TABLE_MAX_ROWS), [tableRowsAll]);
    // カテゴリ列は「意味のあるカテゴリがある」ときだけ出す（全行 (未分類) なら省く）
    const tableShowCategory = useMemo(
        () => categoryList.some((c) => c !== UNCATEGORIZED),
        [categoryList]
    );
    // 行ホバーで、その行の送信元クラスタに繋がる弧を強調する（地点ホバーと同じ機構）
    const onTableRowHover = useCallback(
        (t) => {
            if (!t) {
                setHoverKey(null);
                return;
            }
            const spot = arcEnds.src.get(t.id);
            setHoverKey(spot ? `${spot.x.toFixed(1)},${spot.y.toFixed(1)}` : null);
        },
        [arcEnds]
    );
    const tableRowRefs = useRef(new Map());
    const registerTableRow = useCallback((id, node) => {
        if (node) tableRowRefs.current.set(id, node);
        else tableRowRefs.current.delete(id);
    }, []);
    const tableColorOf = useCallback(
        (category) => derived[category]?.css || 'rgb(56, 166, 255)',
        [derived]
    );

    // テーブル行をドリルダウン対象として登録する（弧クリックと同じ link.click・同じ payload）。
    // 行は再描画で作り直されるため、データが変わるたびに登録し直す。
    useEffect(() => {
        if (typeof addDrilldownListener !== 'function') return;
        try {
            tableRows.forEach((t) => {
                const node = tableRowRefs.current.get(t.id);
                if (!node) return;
                addDrilldownListener({
                    node,
                    action: 'link.click',
                    payloadCallback: () => ({
                        'row.src_name.value': t.srcName,
                        'row.dst_name.value': t.dstName,
                        'row.src_lat.value': t.srcLat,
                        'row.src_lon.value': t.srcLon,
                        'row.dst_lat.value': t.dstLat,
                        'row.dst_lon.value': t.dstLon,
                        'row.category.value': t.category,
                        'row.count.value': t.count,
                        name: 'src_name',
                        value: t.srcName || `${t.srcLat},${t.srcLon}`,
                    }),
                });
            });
        } catch (e) {
            /* ドリルダウン未対応環境でも描画は続ける */
        }
    }, [tableRows]);

    // パネル実サイズに応じたオーバーレイのレイアウト計算
    // （小パネルで文字がはみ出したり要素同士が重ならないよう、
    //   サイズに合わせて縮小・非表示・コンパクト化する）
    const overlay = useMemo(() => {
        // size 未計測時は通常サイズ相当のフォールバックを使う
        const w = size ? size.w : 900;
        const h = size ? size.h : 500;

        // フィルタは右上に出るので、狭幅では非表示にしてタイトルと衝突させない
        const showFilter = opts.showFilter && w >= 220;
        // タイトルは幅が狭い / フィルタと重なる恐れがある場合に隠す
        //  - w<260 では横幅不足で隠す
        //  - フィルタ表示中かつ w<420 では上部バンドで重なるため隠す
        // 文字列が空ならタイトル枠自体を出さない（空欄＝タイトル無しの指定）
        const showTitle =
            opts.showTitle && opts.titleText.trim() !== '' && w >= 260 && !(showFilter && w < 420);
        // 凡例は極端に小さいパネルでは隠す。中間サイズでは横並びのコンパクト表示
        const showLegend = opts.showLegend && w >= 200 && h >= 140;
        const legendCompact = w < 360 || h < 240;

        // 右上の縦積みの基準。フィルタが出ていればその下、無ければ最上段。
        // フィルタの高さ ≒ 44px（Select 36px + padding 4px×2）
        // 自前ドロップダウン（HudSelect）の高さ ≒ 40px（ボタン 6px pad×2 +
        // 文字 ~16px + 外枠 padding 4px×2 + 境界線）
        const filterBottom = showFilter ? 12 + 40 + OVERLAY_GAP : 12;
        // フロー一覧が「折りたたみピル」として右上のドック位置に居るか。
        // ピルは保存位置に関係なく常にドックに居る（展開時のみ保存位置が効く）
        const stackFlowPill = opts.showTable && tableCollapsed;

        // タイトルのフォントは幅に応じて 22px→12px にクランプ
        const titleFont = Math.max(12, Math.min(22, Math.round(w * 0.028)));
        // タイトルの最大横幅（パネル幅から左右余白と右側フィルタ分を差し引く）
        const titleMaxW = Math.max(60, w - 40 - (showFilter ? 120 : 0));

        // 凡例のスケール（コンパクト時は詰める）
        const legPad = legendCompact ? '5px 8px' : '10px 16px';
        const legGap = legendCompact ? 6 : 8;
        const legRowGap = legendCompact ? 4 : 8;
        const legFont = legendCompact ? 11 : 14;
        const legSwatchW = legendCompact ? 14 : 22;
        const legSwatchH = legendCompact ? 4 : 5;
        // 幅が狭いときは凡例内の各行も横並びに（縦積みだと縦に長くなり地図に被る）
        const legDir = w < 300 ? 'row' : 'column';

        // 件数表示は凡例の中に出す。コンパクト表示（極小パネル）では
        // 桁数で凡例が横に膨らんで地図を覆うため出さない。
        const showTotals = opts.showTotals && !legendCompact;
        const showCategoryCounts = opts.showCategoryCounts && !legendCompact;

        return {
            showFilter,
            showTitle,
            showLegend,
            showTotals,
            showCategoryCounts,
            titleFont,
            titleMaxW,
            legPad,
            legGap,
            legRowGap,
            legFont,
            legSwatchW,
            legSwatchH,
            legDir,
            // 右上に縦積みするオーバーレイの段の位置（px）。
            // 【v2.2.0】ズーム倍率ピルとフロー一覧の折りたたみピルが
            // カテゴリフィルタと重ならないよう、**相手の幅に依存しない縦積み**にする。
            // フィルタの高さは約 44px（Select + padding 4px×2）。
            filterBottom,
            // ズームピルはさらにその下。フロー一覧を折りたたみ表示している場合は
            // そのピル（高さ約 29px）のぶんも下げる
            zoomPillTop:
                filterBottom + (stackFlowPill ? 29 + OVERLAY_GAP : 0),
        };
    }, [size, opts.showTitle, opts.titleText, opts.showFilter, opts.showLegend,
        opts.showTotals, opts.showCategoryCounts, opts.showTable, tableCollapsed]);

    return (
        <div
            ref={(el) => {
                containerRef.current = el;
                attachWheel(el);
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                minHeight: 200,
                background: background.containerBg,
                overflow: 'hidden',
                // ズーム有効時は掴めることを示す。ドラッグ中は握った形に変える
                cursor: opts.enableZoom ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
                // ドラッグ中にテキスト選択やブラウザのパンが割り込まないようにする
                userSelect: 'none',
                touchAction: opts.enableZoom ? 'none' : 'auto',
                fontFamily:
                    'Splunk Platform Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
            }}
        >
            {geo && size && (
                <svg
                    viewBox={`0 0 ${size.w} ${size.h}`}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                >
                    <defs>
                        {background.bgStops && (
                            <radialGradient id="gtm-bg" cx="50%" cy="42%" r="75%">
                                {background.bgStops.map((s) => (
                                    <stop key={s.offset} offset={s.offset} stopColor={s.color} />
                                ))}
                            </radialGradient>
                        )}
                        {/* カテゴリ別のホットスポットグロー（線の色から導出・動的） */}
                        {categoryList.map((sev, i) => (
                            <radialGradient key={sev} id={`gtm-hot-${i}`}>
                                <stop
                                    offset="0%"
                                    stopColor={derived[sev].glowInner}
                                    stopOpacity="0.95"
                                />
                                <stop
                                    offset="30%"
                                    stopColor={derived[sev].glowMid}
                                    stopOpacity="0.5"
                                />
                                <stop
                                    offset="70%"
                                    stopColor={derived[sev].css}
                                    stopOpacity="0.17"
                                />
                                <stop offset="100%" stopColor={derived[sev].css} stopOpacity="0" />
                            </radialGradient>
                        ))}
                        {/* ドットマトリクス陸地。userSpaceOnUse なので画面上の
                            ドット密度が一定になる（スクリーングリッドで陸地を
                            サンプリングした定番の表現） */}
                        {opts.landStyle === 'dots' && (
                            <pattern
                                id="gtm-land-dots"
                                width="7"
                                height="7"
                                patternUnits="userSpaceOnUse"
                            >
                                <circle cx="3.5" cy="3.5" r="1.3" fill={land.visible ? land.fill : 'none'} />
                            </pattern>
                        )}
                        {/* 【v2.1.0】弧の発光フィルタ（feGaussianBlur）は廃止した。
                            弧ごとにぼかしがラスタライズされ、コストが
                            「本数 × パネル面積」で増える最大の重さの原因だった
                            （実機計測: 2560x1440 で 3.5fps → 外すと 12.2fps）。
                            今は太く薄い実線を重ねてにじみを表現している。 */}
                    </defs>

                    {/* 背景（完全透過時は描画しない） */}
                    {background.bgStops && (
                        <rect width={size.w} height={size.h} fill="url(#gtm-bg)" />
                    )}

                    {/* 経緯線（10度グリッド）。陸地の下に薄く敷く */}
                    {opts.showGraticule && geo.graticulePath && (
                        <path
                            d={geo.graticulePath}
                            data-gtm="graticule"
                            fill="none"
                            stroke={palette.graticule}
                            strokeWidth="0.5"
                            strokeOpacity={palette.graticuleOpacity}
                        />
                    )}

                    {/* 大陸（グロー層 + 本体 + 階層国境。完全透過時は描画しない） */}
                    {land.visible && (
                        <>
                            {/* 【v2.1.0】陸地のグロー層は**丸ごと廃止**した。
                                ぼかしフィルタ版も、その代替として試した
                                「太い縁取りストローク」版も、どちらも
                                大陸の全頂点をなぞる巨大なパスを半透明で塗るため
                                大画面で極端に重い（実機計測 2560x1440・弧30本・4面:
                                グロー有り 7.4fps → 廃止 23.3fps ＝ 3.1倍）。
                                陸地の輪郭は下の海岸線ストロークで十分読めるので、
                                グロー層は復活させないこと。 */}
                            {/* ドットマトリクス時は淡いベタ塗りを下敷きにして
                                シルエットを読めるようにし、その上にドットを重ねる */}
                            {opts.landStyle === 'dots' && (
                                <path d={geo.landPath} fill={land.fill} opacity="0.14" />
                            )}
                            <path
                                d={geo.landPath}
                                fill={opts.landStyle === 'dots' ? 'url(#gtm-land-dots)' : land.fill}
                            />
                            {/* 国境の階層表現: 隣接国どうしの内側国境は薄く、
                                海岸線（大陸の輪郭）は明るく。遠目にはシルエット、
                                ズームすると国境が立つ */}
                            <path
                                d={geo.innerBorderPath}
                                data-gtm="border-inner"
                                fill="none"
                                stroke={land.stroke}
                                strokeWidth="0.4"
                                strokeOpacity={land.strokeOpacity * 0.45}
                            />
                            <path
                                d={geo.coastPath}
                                data-gtm="coast"
                                fill="none"
                                stroke={land.stroke}
                                strokeWidth="0.7"
                                strokeOpacity={land.strokeOpacity}
                            />
                        </>
                    )}

                    {/* 攻撃元ホットスポット（脈動アニメーション付き・線の色に対応） */}
                    {sources.map((s, i) => {
                        const base = Math.min(26 + Math.sqrt(s.count) * 1.5, 44);
                        // 集約された地点は「代表名 ほか N 地点」と示す（何が畳まれたか分かるように）
                        const tipHead = `Source: ${s.name || 'unknown'}${s.size > 1 ? ` ほか ${s.size - 1} 地点` : ''}`;
                        const tipSub = `${describeCategory(s.category)}${formatCount(s.count)} ${totals.unit}`;
                        return (
                            <g key={`src-${i}`}>
                                {/* 脈動グロー。
                                    【v2.2.0】SMIL の <animate>（r / opacity）をやめ、
                                    **CSS の transform アニメーション**に置き換えた。
                                    `r` を動かすとジオメトリが変わるため、地図レイヤー全体が
                                    毎フレーム再ラスタライズされる（実機計測: これだけで
                                    2560x1440・4面が 22.1fps → 止めると 26.1fps）。
                                    transform / opacity は**コンポジタだけで処理される**ので、
                                    ラスタライズをやり直さずに同じ見た目が出せる。
                                    transform-origin をスポット座標に置き、拡大の中心を合わせる。 */}
                                {/* 脈動グローは **アニメーション時は Canvas 側**が描く
                                    （ArcFlowCanvas の spots）。半透明の大きな
                                    グラデーション円を SVG で毎フレーム合成すると、
                                    コンポジタ処理でも極端に重いため（実機計測:
                                    2560x1440・4面で 21.6fps → 消すと 48.1fps）。
                                    静止時（animDuration=0）は Canvas が動かないので、
                                    ここで一度だけ SVG として描く。 */}
                                {!animOn && (
                                    <circle
                                        cx={s.x}
                                        cy={s.y}
                                        r={base}
                                        fill={`url(#gtm-hot-${catIndex[s.category] ?? 0})`}
                                    />
                                )}
                                <circle
                                    cx={s.x}
                                    cy={s.y}
                                    r="3"
                                    fill={derived[s.category]?.core}
                                />
                                {/* 透明な当たり判定。ホバー強調とドリルダウンの受け口。 */}
                                <circle
                                    ref={(el) => {
                                        const k = `src:${s.x.toFixed(1)},${s.y.toFixed(1)}`;
                                        if (el) spotRefs.current.set(k, el);
                                        else spotRefs.current.delete(k);
                                    }}
                                    cx={s.x}
                                    cy={s.y}
                                    r="12"
                                    fill="transparent"
                                    style={{ cursor: 'pointer' }}
                                    aria-label={`${tipHead} (${tipSub})`}
                                    onMouseEnter={(e) => {
                                        setHoverKey(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
                                        setTooltip({ lines: [tipHead, tipSub] });
                                        positionTooltip(e);
                                    }}
                                    onMouseMove={positionTooltip}
                                    onMouseLeave={() => {
                                        setHoverKey(null);
                                        setTooltip(null);
                                    }}
                                />
                            </g>
                        );
                    })}

                    {/* 攻撃先（線の色に対応） */}
                    {targets.map((t, i) => {
                        const tipHead = `Target: ${t.name || 'unknown'}${t.size > 1 ? ` ほか ${t.size - 1} 地点` : ''}`;
                        const tipSub = `${describeCategory(t.category)}${formatCount(t.count)} ${totals.unit}`;
                        return (
                        <g key={`dst-${i}`}>
                            {/* 攻撃先のグローも、アニメーション時は Canvas 側が描く
                                （半透明の大きな円は SVG だと合成コストが高いため）。
                                静止時のみ SVG で1回だけ描く。 */}
                            {!animOn && (
                                <circle
                                    cx={t.x}
                                    cy={t.y}
                                    r="20"
                                    fill={`url(#gtm-hot-${catIndex[t.category] ?? 0})`}
                                    opacity="0.85"
                                />
                            )}
                            <circle
                                cx={t.x}
                                cy={t.y}
                                r="2.5"
                                fill={derived[t.category]?.core}
                            />
                            <circle
                                ref={(el) => {
                                    const k = `dst:${t.x.toFixed(1)},${t.y.toFixed(1)}`;
                                    if (el) spotRefs.current.set(k, el);
                                    else spotRefs.current.delete(k);
                                }}
                                cx={t.x}
                                cy={t.y}
                                r="12"
                                fill="transparent"
                                style={{ cursor: 'pointer' }}
                                aria-label={`${tipHead} (${tipSub})`}
                                onMouseEnter={(e) => {
                                    setHoverKey(`${t.x.toFixed(1)},${t.y.toFixed(1)}`);
                                    setTooltip({ lines: [tipHead, tipSub] });
                                    positionTooltip(e);
                                }}
                                onMouseMove={positionTooltip}
                                onMouseLeave={() => {
                                    setHoverKey(null);
                                    setTooltip(null);
                                }}
                            />
                        </g>
                        );
                    })}

                    {/* 攻撃の弧のベース軌道（SVG）。流れる彗星は上に重ねた Canvas が担当。
                        ツールチップ(title)はここに置き、常にホバー可能にする。
                          軌道1: 太く柔らかい発光ハロー（熱をにじませる）
                          軌道2: 細い芯線（弧の存在を常に示す薄い実線）
                        animOn 時は軌道を控えめにして彗星を主役に、静的時は芯線を濃くする。

                        【v2.1.0】ハローに feGaussianBlur を使うのをやめた。
                        SVG フィルタは弧ごとにラスタライズされ、コストが
                        「本数 × パネル面積」で効くため、**大画面ほど極端に重くなる**
                        （実機計測: 弧30本・4面・2560x1440 で 3.5fps。フィルタを
                        外すだけで 12.2fps ＝ 3.4倍）。太さと不透明度の違う実線を
                        重ねてにじみを出す方式に置き換え、フィルタを完全に無くした。 */}
                    {arcGeoms.map(({ t, d }) => {
                        const color = derived[t.category]?.css || 'rgb(56, 166, 255)';
                        const width = arcWidth(t.count);
                        const srcKey = `${t.sx.toFixed(1)},${t.sy.toFixed(1)}`;
                        const dstKey = `${t.tx.toFixed(1)},${t.ty.toFixed(1)}`;
                        // ホバー強調中、その地点に繋がらない弧は薄くする
                        const dim =
                            activeHoverKey !== null &&
                            srcKey !== activeHoverKey &&
                            dstKey !== activeHoverKey;
                        const k = dim ? 0.22 : 1;
                        const tipHead = `${pointLabel(t.srcName, t.srcLat, t.srcLon)} → ${pointLabel(t.dstName, t.dstLat, t.dstLon)}`;
                        const tipSub = `${describeCategory(t.category)}${formatCount(t.count)} ${totals.unit}`;
                        return (
                            <g key={`arc-${t.id}`}>
                                {/* ハロー（熱のにじみ）。
                                    ぼかしフィルタは使わず「太くて薄い実線」で表現する。
                                    2本重ねることで中心ほど濃くなり、ぼかしに近い見え方になる。 */}
                                <path
                                    d={d}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={width * 3.4}
                                    strokeLinecap="round"
                                    opacity={(animOn ? 0.05 : 0.09) * k}
                                    style={{ transition: 'opacity 0.25s ease' }}
                                />
                                <path
                                    d={d}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={width * 1.8}
                                    strokeLinecap="round"
                                    opacity={(animOn ? 0.1 : 0.2) * k}
                                    style={{ transition: 'opacity 0.25s ease' }}
                                />
                                {/* 芯線。data-gtm="arc" は「弧の本数と色」を指す安定した目印 */}
                                <path
                                    d={d}
                                    data-gtm="arc"
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={width * 0.7}
                                    strokeLinecap="round"
                                    opacity={(animOn ? 0.34 : 0.75) * k}
                                    style={{ transition: 'opacity 0.25s ease' }}
                                />
                                {/* 透明な太い当たり判定。細い線でもホバー/クリックしやすくする。
                                    ドリルダウンはこの要素に登録する（addDrilldownListener）。 */}
                                <path
                                    ref={(el) => {
                                        if (el) arcRefs.current.set(t.id, el);
                                        else arcRefs.current.delete(t.id);
                                    }}
                                    d={d}
                                    fill="none"
                                    stroke="transparent"
                                    strokeWidth={Math.max(width * 3, 10)}
                                    strokeLinecap="round"
                                    style={{ cursor: 'pointer' }}
                                    aria-label={`${tipHead} (${tipSub})`}
                                    onMouseEnter={(e) => {
                                        setHoverKey(srcKey);
                                        setTooltip({ lines: [tipHead, tipSub] });
                                        positionTooltip(e);
                                    }}
                                    onMouseMove={positionTooltip}
                                    onMouseLeave={() => {
                                        setHoverKey(null);
                                        setTooltip(null);
                                    }}
                                />
                            </g>
                        );
                    })}

                    {/* 地名ラベル。ズームに応じて国名 → 都市名の順に現れる。
                        始点/終点の都市名は最優先で場所を確保し、地図の地名より
                        目立つ配色にする（データが主役であることを崩さないため）。
                        縁取り(paint-order: stroke)で地図の上でも読めるようにする。 */}
                    {placeLabels.map((l) => {
                        const isEndpoint = l.kind === 'endpoint';
                        const isCountry = l.kind === 'country';
                        return (
                            <text
                                key={`lbl-${l.kind}-${l.name}-${Math.round(l.x)}-${Math.round(l.y)}`}
                                x={l.x}
                                y={l.y - (isEndpoint ? 9 : 0)}
                                textAnchor="middle"
                                fontSize={
                                    isEndpoint
                                        ? opts.placeLabelSize + 1
                                        : isCountry
                                          ? opts.placeLabelSize
                                          : opts.placeLabelSize - 1
                                }
                                fontWeight={isEndpoint ? 700 : isCountry ? 600 : 400}
                                fill={isEndpoint ? palette.endpointLabel : palette.placeLabel}
                                opacity={isEndpoint ? 1 : isCountry ? 0.9 : 0.75}
                                stroke={palette.labelHalo}
                                strokeWidth={isEndpoint ? 3.5 : 2.5}
                                strokeOpacity={0.85}
                                paintOrder="stroke"
                                strokeLinejoin="round"
                                style={{ pointerEvents: 'none' }}
                            >
                                {l.name}
                            </text>
                        );
                    })}
                </svg>
            )}

            {/* 流れる光の帯（Canvas オーバーレイ）。地図 SVG の上・オーバーレイ UI の下。
                animDuration=0 のときは rAF を回さず何も描かない（静的表示・CPU 0）。 */}
            {geo && size && (
                <ArcFlowCanvas
                    arcs={flowArcs}
                    spots={flowSpots}
                    forceRenderer={opts.forceRenderer}
                    width={size.w}
                    height={size.h}
                    duration={opts.animDuration}
                    hoverKey={opts.highlightOnHover ? hoverKey : null}
                />
            )}

            {/* カスタムツールチップ（弧・地点のホバーで表示。カーソルに追従）。
                pointerEvents:none でホバー対象のイベントを妨げない */}
            {tooltip && size && (
                <div
                    ref={tooltipRef}
                    style={{
                        position: 'absolute',
                        left: Math.max(6, Math.min(tooltipPosRef.current.x + 14, size.w - 180)),
                        top: Math.max(6, Math.min(tooltipPosRef.current.y + 16, size.h - 60)),
                        maxWidth: Math.max(120, Math.min(340, size.w - 24)),
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: 8,
                        padding: '6px 10px',
                        color: palette.legendText,
                        fontSize: 12,
                        lineHeight: 1.5,
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                        zIndex: 5,
                    }}
                >
                    {tooltip.lines.map((line, i) => (
                        <div
                            key={i}
                            style={{
                                fontWeight: i === 0 ? 700 : 400,
                                opacity: i === 0 ? 1 : 0.85,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {line}
                        </div>
                    ))}
                </div>
            )}

            {/* タイトル（左上・地図の内側）
                幅に応じてフォントを縮小し、はみ出す場合は省略記号で切り詰め */}
            {overlay.showTitle && (
                <div
                    style={{
                        position: 'absolute',
                        top: 16,
                        left: 20,
                        maxWidth: overlay.titleMaxW,
                        color: palette.titleColor,
                        fontSize: overlay.titleFont,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        textShadow: palette.titleShadow,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        pointerEvents: 'none',
                        zIndex: 2,
                    }}
                >
                    {opts.titleText}
                </div>
            )}

            {/* HUD 統計行（タイトル直下）。アニメーション中は LIVE インジケータ、
                常時は総件数を出す。数字は凡例の totals と同じ集計を使う */}
            {overlay.showTitle && opts.showHudStats && (
                <div
                    style={{
                        position: 'absolute',
                        top: 16 + overlay.titleFont + 8,
                        left: 20,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        color: palette.legendText,
                        fontSize: Math.max(10, Math.round(overlay.titleFont * 0.55)),
                        letterSpacing: '0.08em',
                        opacity: 0.85,
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                        zIndex: 2,
                    }}
                >
                    {animOn && (
                        <span
                            style={{
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                background: palette.liveDot,
                                boxShadow: `0 0 6px ${palette.liveDot}`,
                                animation: 'gtm-live-blink 1.6s ease-in-out infinite',
                            }}
                        />
                    )}
                    {animOn && <span style={{ fontWeight: 700 }}>LIVE</span>}
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {`全 ${formatCount(totals.all)} ${totals.unit}`}
                    </span>
                </div>
            )}

            {/* カテゴリフィルタ（右上・地図の内側。サーチ結果から動的生成）
                狭幅パネルではタイトルとの衝突を避けるため非表示。
                他のオーバーレイと同じガラス調の板（OVERLAY_* トークン）で描く */}
            {overlay.showFilter && (
                <div
                    // data-viz-ui: この内側で押しても地図のパンを開始しない
                    data-viz-ui="1"
                    onDoubleClick={(e) => e.stopPropagation()}
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 16,
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: OVERLAY_RADIUS,
                        boxShadow: OVERLAY_SHADOW,
                        padding: 4,
                        zIndex: 5,
                    }}
                >
                    <HudSelect
                        value={effectiveFilter}
                        onChange={setCategoryFilter}
                        mode={mode}
                        options={[
                            {
                                value: 'all',
                                label: opts.categoryLabel ? `すべての${opts.categoryLabel}` : 'すべて',
                            },
                            ...categoryList.map((cat) => ({ value: cat, label: cat })),
                        ]}
                    />
                </div>
            )}

            {/* ズーム倍率の表示とリセット（常に右上＝フィルタの下）。
                右下は Splunk のホバーツールバーとテーブルの場所なので使わない。
                ズーム中だけ出し、押すと初期表示（オプションの中心・ズーム）へ戻る。
                編集モードでは iframe への入力が遮断されるため表示モードでのみ機能する。 */}
            {opts.enableZoom && Math.abs(camera.zoom - opts.initialZoom) > 0.01 && size && size.w >= 200 && (
                <div
                    data-viz-ui="1"
                    onClick={onDoubleClick}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title="初期表示に戻す"
                    style={{
                        position: 'absolute',
                        right: 16,
                        // 右上の縦積み: カテゴリフィルタ → フロー一覧ピル → ズームピル。
                        // フロー一覧を折りたたみ表示しているときはその下へずらす
                        top: overlay.zoomPillTop,
                        background: palette.panelBg,
                        border: palette.panelBorder,
                        borderRadius: OVERLAY_RADIUS,
                        boxShadow: OVERLAY_SHADOW,
                        padding: '4px 10px',
                        color: palette.legendText,
                        fontSize: 12,
                        cursor: 'pointer',
                        zIndex: 3,
                    }}
                >
                    {`×${camera.zoom.toFixed(1)}　⟲`}
                </div>
            )}

            {/* 凡例（左下・地図の内側。サーチ結果から動的生成）
                小パネルではフォント / 余白 / スウォッチを縮小し、
                さらに狭い場合は各行も横並びにして縦方向のかさばりを抑える */}
            {overlay.showLegend && (
                <div
                    data-viz-ui="1"
                    onDoubleClick={(e) => e.stopPropagation()}
                    style={{
                        position: 'absolute',
                        left: 16,
                        bottom: 14,
                        maxWidth: '80%',
                        background: palette.legendBg,
                        border: palette.legendBorder,
                        borderRadius: OVERLAY_RADIUS,
                        boxShadow: OVERLAY_SHADOW,
                        padding: overlay.legPad,
                        display: 'flex',
                        flexDirection: overlay.legDir,
                        flexWrap: overlay.legDir === 'row' ? 'wrap' : 'nowrap',
                        gap: overlay.legRowGap,
                        columnGap: overlay.legDir === 'row' ? overlay.legGap + 2 : overlay.legRowGap,
                        zIndex: 4,
                    }}
                >
                    {/* 見出し（色分けの基準列の呼び名）。categoryLabel 未設定なら出さない */}
                    {opts.categoryLabel && overlay.legDir === 'column' && (
                        <div
                            style={{
                                color: palette.legendText,
                                fontSize: overlay.legFont,
                                fontWeight: 700,
                                opacity: 0.8,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {opts.categoryLabel}
                        </div>
                    )}
                    {/* 件数サマリー（表示中 / 全体）。maxArcs や凡例フィルタで
                        描画対象が減っているとき、捨てられた分の存在を示す。
                        全件描いているときは「全 N 件」とだけ出す（冗長を避ける）。
                        横並び（狭幅）では場所が無いので出さない。 */}
                    {overlay.showTotals && overlay.legDir === 'column' && (
                        <div
                            style={{
                                color: palette.legendText,
                                fontSize: Math.max(10, overlay.legFont - 2),
                                opacity: 0.75,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {totals.truncated
                                ? `表示 ${formatCount(totals.shown)} / 全 ${formatCount(totals.all)} ${totals.unit}`
                                : `全 ${formatCount(totals.all)} ${totals.unit}`}
                        </div>
                    )}
                    {categoryList.map((cat) => {
                        // 凡例クリックで絞り込み（もう一度押すと解除）。
                        // 絞り込み中は対象外のカテゴリを薄く表示して現在の状態を示す。
                        const isActive = effectiveFilter === cat;
                        const isDimmed = effectiveFilter !== 'all' && !isActive;
                        const hint = explicit?.[cat]
                            ? ''
                            : opts.colorMode === 'count'
                              ? '（どのしきい値範囲にも入らない件数のため既定色）'
                              : `（色が未設定のため既定色。編集画面の「色分け」で「${cat}|#RRGGBB」を追加すると色が付きます）`;
                        return (
                        <div
                            key={cat}
                            onClick={() => setCategoryFilter(isActive ? 'all' : cat)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: overlay.legGap,
                                cursor: 'pointer',
                                opacity: isDimmed ? 0.4 : 1,
                            }}
                            title={`${cat}${hint}（クリックで${isActive ? '絞り込みを解除' : 'このカテゴリだけ表示'}）`}
                        >
                            <span
                                style={{
                                    width: overlay.legSwatchW,
                                    height: overlay.legSwatchH,
                                    borderRadius: 3,
                                    flexShrink: 0,
                                    // 画面上の弧（尾が透けて先端が明るい光の帯）を
                                    // そのままミニチュア化したスウォッチ
                                    background: `linear-gradient(90deg, transparent, ${derived[cat].css} 45%, ${derived[cat].core})`,
                                    boxShadow: `0 0 8px ${derived[cat].css}`,
                                    // 未設定は輪郭を破線にして「既定色である」ことを視覚的に示す
                                    outline: explicit?.[cat] ? 'none' : `1px dashed ${palette.legendText}`,
                                    outlineOffset: 1,
                                }}
                            />
                            <span
                                style={{
                                    color: palette.legendText,
                                    fontSize: overlay.legFont,
                                    whiteSpace: 'nowrap',
                                    opacity: explicit?.[cat] ? 1 : 0.75,
                                    fontWeight: isActive ? 700 : 400,
                                    textDecoration: isActive ? 'underline' : 'none',
                                }}
                            >
                                {cat}
                            </span>
                            {/* カテゴリ別の件数（実際に描いている分）。
                                縦積みのときだけ右端に寄せて数字の桁を揃える。 */}
                            {overlay.showCategoryCounts && (
                                <span
                                    style={{
                                        color: palette.legendText,
                                        fontSize: Math.max(10, overlay.legFont - 1),
                                        opacity: 0.7,
                                        whiteSpace: 'nowrap',
                                        marginLeft: overlay.legDir === 'column' ? 'auto' : 4,
                                        paddingLeft: 8,
                                        fontVariantNumeric: 'tabular-nums',
                                    }}
                                >
                                    {formatCount(totals.byCategory[cat] || 0)}
                                </span>
                            )}
                        </div>
                        );
                    })}
                </div>
            )}

            {/* フロー一覧テーブル（v2.0.0）。右下に浮かぶオーバーレイで、
                マップは常に全域へ描画される（テーブルで地図が縮まない・見切れない）。
                マップと同じ絞り込み結果を count の多い順に表示する */}
            {opts.showTable && (
                <FlowTable
                    rows={tableRows}
                    totalRows={tableRowsAll.length}
                    colorOf={tableColorOf}
                    showCategory={tableShowCategory}
                    categoryHeader={opts.categoryLabel || 'カテゴリ'}
                    countHeader={opts.countLabel === '件' ? '件数' : opts.countLabel}
                    hasCount={hasCount}
                    mode={mode}
                    heightPct={opts.tableHeight}
                    collapsed={tableCollapsed}
                    setCollapsed={setTableCollapsed}
                    filterBottom={overlay.filterBottom}
                    pos={tablePos}
                    size={tableSize}
                    dirty={tableDirty && !isEdit}
                    onSavePos={saveTablePos}
                    onSaveSize={saveTableSize}
                    onResetLayout={resetTableLayout}
                    sort={tableSort}
                    onSort={onTableSort}
                    onRowHover={onTableRowHover}
                    registerRow={registerTableRow}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// スピナー永久表示（サーチ完了通知の取りこぼし）対策
//
// 公式 useDataSources は「render 時に getDataSources() でシード → useEffect で購読」
// の構造で、シードと購読の間に届いた更新を取り逃す（ホストは購読登録時に現在値を
// 再送しない。実機確認済み）。取り逃したのがサーチ完了の最終通知だと、以後更新が
// 来ないため loading:true のまま固まり、スピナーが回り続ける。
// 対策として、公式フックが loading の間は getDataSources() を定期的に読み直し、
// ホスト側がすでに完了していればその値を採用する。完了後は何もしない（コストゼロ）。
// ---------------------------------------------------------------------------

const RESCUE_POLL_MS = 500;

function useDataSourcesWithRescue() {
    const official = useDataSources();
    const [rescue, setRescue] = useState(null);
    const officialLoading = Boolean(official?.loading);

    useEffect(() => {
        if (!officialLoading) return undefined;
        setRescue(null); // 新しいロードサイクル。前回の回収値は使わない
        let timer = 0;
        const tick = () => {
            try {
                const cur = globalThis.DashboardExtensionAPI?.getDataSources?.();
                if (cur && !cur.loading) {
                    setRescue(cur); // ホストは完了済み＝最終通知を取り逃していた。回収して終了
                    return;
                }
            } catch (e) {
                /* ホスト未応答でも落とさない。次のtickで再試行 */
            }
            timer = setTimeout(tick, RESCUE_POLL_MS);
        };
        timer = setTimeout(tick, RESCUE_POLL_MS);
        return () => clearTimeout(timer);
    }, [officialLoading]);

    return officialLoading && rescue ? rescue : official;
}

// ---------------------------------------------------------------------------
// データソース接続
// ---------------------------------------------------------------------------
function ThreatMapVisualization({ mode }) {
    const { dataSources, loading } = useDataSourcesWithRescue() || {};
    const { options } = useOptions();
    const data = dataSources?.primary?.data || null;

    const opts = useMemo(() => normalizeOptions(options), [options]);
    const rows = useMemo(() => (data ? normalizeData(data) : []), [data]);
    const fieldNames = useMemo(() => (data?.fields || []).map((f) => f.name || f), [data]);
    const { threats: parsedThreats, missingFields, hasCount } = useMemo(
        () => parseThreats(fieldNames, rows, opts),
        [fieldNames, rows, opts]
    );

    // colorMode='count' では、しきい値バンドの表示名を「擬似カテゴリ」として各行へ
    // 割り当てる。以降の凡例・フィルタ・ホットスポット・ドリルダウンは
    // カテゴリ色分けと同じ機構がそのまま働く（count 専用の分岐を増やさない）。
    // どのバンドにも入らない count は (未分類) → fallbackColor で描かれる。
    const threats = useMemo(() => {
        if (opts.colorMode !== 'count') return parsedThreats;
        return parsedThreats.map((t) => {
            const band = opts.countThresholds.find((b) => t.count >= b.from && t.count < b.to);
            return { ...t, category: band ? bandLabel(band) : UNCATEGORIZED };
        });
    }, [parsedThreats, opts.colorMode, opts.countThresholds]);

    // サーチ結果に登場したカテゴリ一覧と、オプションで設定された色の割り当て。
    // 正規化済みの opts を渡す（生の options ではなく）。
    // count モードでは一覧も色もしきい値バンドから決める
    // （categoryColors / categoryOrder はカテゴリモード専用の設定なので参照しない）。
    const { categoryList, categoryColors, explicit } = useMemo(() => {
        if (opts.colorMode !== 'count') return buildCategoryModel(threats, opts);
        const fallback = parseColor(opts.fallbackColor) || parseColor(DEFAULT_CATEGORY_COLOR);
        const list = [];
        const colors = {};
        const exp = {};
        opts.countThresholds.forEach((b) => {
            const label = bandLabel(b);
            if (list.includes(label)) return;
            list.push(label);
            colors[label] = parseColor(b.value) || fallback;
            exp[label] = true;
        });
        if (threats.some((t) => t.category === UNCATEGORIZED)) {
            list.push(UNCATEGORIZED);
            colors[UNCATEGORIZED] = fallback;
            exp[UNCATEGORIZED] = false;
        }
        return { categoryList: list, categoryColors: colors, explicit: exp };
    }, [threats, opts]);

    // カスタム背景色・陸地色（各チェックボックスON時のみ有効。OFFならテーマ配色）
    const customBg = useMemo(
        () => (options?.useBgColor ? parseColor(options?.bgColor) : null),
        [options]
    );
    const customLand = useMemo(
        () => (options?.useLandColor ? parseColor(options?.landColor) : null),
        [options]
    );

    if (loading) return <LoadingState />;
    if (!data || rows.length === 0) return <MessageState message="データがありません。サーチ結果を確認してください。" />;
    if (missingFields.length > 0) {
        return (
            <MessageState
                message={`必須フィールドが見つかりません: ${missingFields.join(', ')}（編集画面の「データフィールド」で列を指定することもできます。任意: 色分けカテゴリ, count, src_name, dst_name）`}
            />
        );
    }
    if (threats.length === 0) {
        return <MessageState message="No valid coordinates in the search results" />;
    }

    return (
        <ThreatMap
            threats={threats}
            hasCount={hasCount}
            mode={mode}
            categoryList={categoryList}
            categoryColors={categoryColors}
            explicit={explicit}
            customBg={customBg}
            customLand={customLand}
            opts={opts}
        />
    );
}

// ---------------------------------------------------------------------------
// テーマガード付きApp
// テーマは通常マウントゲートで取得済み。万一未着でも light 既定で必ず描画する
// ---------------------------------------------------------------------------
function App() {
    const themeContext = useTheme();
    const theme = themeContext?.theme || 'light'; // 通常はゲートで取得済み。万一未着でも light で必ず描画

    const colorScheme = theme === 'dark' ? 'dark' : 'light';

    return (
        <SplunkThemeProvider family="enterprise" colorScheme={colorScheme} density="comfortable">
            <ThreatMapVisualization mode={colorScheme} />
        </SplunkThemeProvider>
    );
}

// ホスト初期化完了（DashboardExtensionAPI 注入＋テーマ/データの初期 state 受信）を
// 待ってからマウントする。公式フックは購読登録時に現在値を再送しないため、
// 初期 state がマウントより後に届くと取り逃して永久に描画されないことがある。
// 最大5秒待っても揃わない場合はフォールバック描画（テーマは light 既定）に入る。
const MOUNT_START = Date.now();

function hostReady() {
    try {
        const api = globalThis.DashboardExtensionAPI;
        return Boolean(api && api.getTheme()?.theme && api.getDataSources());
    } catch (e) {
        return false;
    }
}

function mountApp() {
    const rootElement = document.getElementById('root') || document.body;
    createRoot(rootElement).render(
        <VisualizationExtensionProvider>
            <App />
        </VisualizationExtensionProvider>
    );
}

(function mountWhenReady() {
    if (hostReady() || Date.now() - MOUNT_START >= 5000) {
        mountApp();
    } else {
        setTimeout(mountWhenReady, 50);
    }
})();
