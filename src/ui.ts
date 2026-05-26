export const MANIFEST_JSON = JSON.stringify({
  name: "Health Connect Reader",
  short_name: "HC Reader",
  start_url: "/",
  display: "standalone",
  background_color: "#f8fafc",
  theme_color: "#059669",
  icons: [
    // 単色 192/512 を SVG data URI で最小同梱。専用 PNG は別 PR で差し替え可能。
    {
      src:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#059669"/><text x="96" y="120" font-family="-apple-system,system-ui,sans-serif" font-size="96" font-weight="700" text-anchor="middle" fill="white">HC</text></svg>',
        ),
      sizes: "192x192",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#059669"/><text x="256" y="320" font-family="-apple-system,system-ui,sans-serif" font-size="256" font-weight="700" text-anchor="middle" fill="white">HC</text></svg>',
        ),
      sizes: "512x512",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
});

// 最小 SW。fetch 介入なし (= 透過)、install 即 activate。PWA install 条件
// (manifest + SW 登録) を満たすためだけのスタブ。
export const SERVICE_WORKER_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
`;

// favicon.ico — ブラウザが自動で要求するので 404 を出さないために最小 ICO を返す。
// 16x16, 32bpp, 単色 #059669 (emerald-600) 塗りつぶし。手書きでバイト列を組む。
function buildSolidFavicon(): Uint8Array {
  const W = 16, H = 16;
  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + BITMAPINFOHEADER (40) +
  // pixel data (W*H*4 BGRA) + AND mask (W*H/8 bytes)
  const pixelBytes = W * H * 4;
  const andBytes = (W * H) / 8;
  const imageSize = 40 + pixelBytes + andBytes;
  const total = 6 + 16 + imageSize;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  // ICONDIR
  dv.setUint16(0, 0, true);  // reserved
  dv.setUint16(2, 1, true);  // type = icon
  dv.setUint16(4, 1, true);  // count
  // ICONDIRENTRY
  buf[6] = W;
  buf[7] = H;
  buf[8] = 0;                // palette
  buf[9] = 0;                // reserved
  dv.setUint16(10, 1, true); // planes
  dv.setUint16(12, 32, true);// bpp
  dv.setUint32(14, imageSize, true);
  dv.setUint32(18, 22, true);// offset (ICONDIR(6) + ENTRY(16))
  // BITMAPINFOHEADER (40 bytes) at offset 22
  let o = 22;
  dv.setUint32(o, 40, true); o += 4;
  dv.setInt32(o, W, true); o += 4;
  dv.setInt32(o, H * 2, true); o += 4; // height = h*2 (XOR + AND)
  dv.setUint16(o, 1, true); o += 2;
  dv.setUint16(o, 32, true); o += 2;
  dv.setUint32(o, 0, true); o += 4; // BI_RGB
  dv.setUint32(o, pixelBytes, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;
  // pixel data BGRA, bottom-up
  // #059669 = R 5, G 150, B 105
  const R = 5, G = 150, B = 105, A = 255;
  for (let i = 0; i < W * H; i++) {
    buf[o + i * 4 + 0] = B;
    buf[o + i * 4 + 1] = G;
    buf[o + i * 4 + 2] = R;
    buf[o + i * 4 + 3] = A;
  }
  o += pixelBytes;
  // AND mask = all 0 (= fully opaque), already zero-filled
  return buf;
}

export const FAVICON_ICO_BYTES = buildSolidFavicon();

export const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Health Connect Reader</title>
<link rel="manifest" href="/manifest.json" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="HC Reader" />
<meta name="theme-color" content="#059669" />
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
<div class="max-w-md mx-auto p-4 space-y-4">
  <header class="pt-2">
    <h1 class="text-xl font-semibold">Health Connect Reader</h1>
    <p id="env-badge" class="text-xs text-slate-500">loading…</p>
  </header>

  <section class="bg-white rounded-2xl shadow p-4 space-y-3">
    <button id="upload-btn"
      class="w-full bg-emerald-600 text-white font-semibold py-3 rounded-xl active:bg-emerald-700">
      今すぐ Upload
    </button>
    <button id="upload-30-btn"
      class="w-full bg-slate-700 text-white font-semibold py-3 rounded-xl active:bg-slate-800">
      過去 30 日を Upload
    </button>
    <label class="flex items-center justify-between text-sm">
      <span>1日1回 自動 Upload</span>
      <input id="auto-toggle" type="checkbox" class="h-5 w-9" />
    </label>
    <p id="status" class="text-sm text-slate-600 min-h-[1.25rem]"></p>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-3">
    <h2 class="font-semibold">Zones (iPhone) JSON を upload</h2>
    <p class="text-xs text-slate-500">
      Apple Watch の workout を Zones アプリで JSON export → ここで選択。
      iOS では「ファイル」アプリに保存してから選ぶか、ショートカット経由で直接送る。
    </p>
    <input id="zones-file" type="file" accept="application/json,.json"
      class="block w-full text-sm" />
    <button id="zones-upload-btn"
      class="w-full bg-indigo-600 text-white font-semibold py-3 rounded-xl active:bg-indigo-700">
      Zones JSON を送信
    </button>
    <p id="zones-status" class="text-sm text-slate-600 min-h-[1.25rem]"></p>
    <div>
      <h3 class="text-sm font-semibold text-slate-700 mt-2 mb-1">アップロード済み</h3>
      <ul id="zones-list" class="text-xs text-slate-600 divide-y divide-slate-100">
        <li class="py-1 text-slate-400">読込中…</li>
      </ul>
    </div>
  </section>

  <section class="bg-white rounded-2xl shadow p-4">
    <h2 class="font-semibold mb-2">履歴</h2>
    <p id="history" class="text-sm text-slate-600">—</p>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="font-semibold">日付別 + 突合状況</h2>
      <select id="workouts-days" class="text-xs border border-slate-300 rounded px-2 py-1">
        <option value="7">7 日</option>
        <option value="30" selected>30 日</option>
        <option value="90">90 日</option>
        <option value="365">1 年</option>
      </select>
    </div>
    <p id="workouts-summary" class="text-xs text-slate-500">読込中…</p>
    <div id="workouts-days-list" class="space-y-2"></div>
    <div class="border-t border-slate-100 pt-3 space-y-2">
      <button id="reindex-btn"
        class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium py-2 rounded-lg">
        🔄 R2 → D1 を再 index (突合し直す)
      </button>
      <p id="reindex-status" class="text-xs text-slate-500 min-h-[1.25rem]"></p>
      <p class="text-[10px] text-slate-400 leading-snug">
        R2 に直接置いたデータや、incremental skip で D1 に乗らなかった日を
        手動で同期する用。upsert なので何度叩いても重複しない。
      </p>
    </div>
  </section>
</div>

<script>
const hasNative = typeof window.HC !== "undefined";
const $ = (id) => document.getElementById(id);

// SW 登録 (PWA install 条件)。失敗は無視 (HTTP / 旧 Safari 環境)。
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function setStatus(msg) { $("status").textContent = msg; }
function setZonesStatus(msg) { $("zones-status").textContent = msg; }

// PWA は auth-worker JWT cookie で API が叩ける (= credentials: 'include')。
// Android native は引き続き Bearer (HCBridge から token を取る)。
function authHeaders() {
  if (hasNative) {
    return { Authorization: "Bearer " + window.HC.getUploadToken() };
  }
  return {};
}
function authFetchInit(extra) {
  // 注意: 外側で Object.assign(target, extra) すると extra.headers が
  // target.headers を**そのまま上書き**し Authorization が消える
  // (Android WebView で 401 顕在化、PWA は cookie credentials で覆われ
  // masked) (Refs #22)。headers は再 assemble して最後に設定する。
  extra = extra || {};
  const init = Object.assign({ credentials: "include" }, extra);
  init.headers = Object.assign({}, authHeaders(), extra.headers || {});
  return init;
}

async function refreshHistory() {
  const r = await fetch("/api/history", authFetchInit());
  if (!r.ok) { $("history").textContent = "history fetch failed (" + r.status + ")"; return; }
  const j = await r.json();
  // breakdown 互換: 旧 shape (hc 無し) も一応 fallback で動かす
  const hcCount = j.hc ? j.hc.count : j.count;
  const hcLatest = j.hc ? j.hc.latest : j.latest;
  const zonesCount = j.zones ? j.zones.count : 0;
  const zonesLatest = j.zones ? j.zones.latest : null;
  $("history").textContent =
    "HC " + hcCount + " 件 (最新 " + (hcLatest ?? "なし") + ")" +
    " / Zones " + zonesCount + " 件 (最新 " + (zonesLatest ?? "なし") + ")";
}

async function refreshZonesList() {
  const list = $("zones-list");
  const r = await fetch("/api/zones", authFetchInit());
  if (!r.ok) {
    list.innerHTML = '<li class="py-1 text-rose-600">zones fetch failed (' + r.status + ")</li>";
    return;
  }
  const j = await r.json();
  if (!j.items || j.items.length === 0) {
    list.innerHTML = '<li class="py-1 text-slate-400">なし</li>';
    return;
  }
  // uploaded は ISO 8601 UTC。端末ローカルの HH:MM で表示
  const fmt = (iso) => {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  };
  list.innerHTML = j.items
    .map((it) =>
      '<li class="py-1 flex justify-between gap-2"><span>' + it.date + " " + fmt(it.uploaded) +
      '</span><span class="font-mono text-slate-500">' + it.uuid.slice(0, 8) + "…</span></li>",
    )
    .join("");
}

async function uploadNow() {
  if (!hasNative) { setStatus("native bridge 不在 (browser preview)"); return; }
  setStatus("読取中…");
  let payload;
  try { payload = window.HC.readToday(); } catch (e) { setStatus("読取失敗: " + e); return; }
  setStatus("送信中…");
  const r = await fetch("/api/upload", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  }));
  if (!r.ok) { setStatus("upload 失敗: " + r.status); return; }
  const j = await r.json();
  setStatus("✓ uploaded " + j.date);
  refreshHistory();
}

async function uploadPast30() {
  if (!hasNative) { setStatus("native bridge 不在 (browser preview)"); return; }
  if (typeof window.HC.readPastDays !== "function") {
    setStatus("APK が古い (HC.readPastDays 未実装)"); return;
  }
  setStatus("過去 30 日読取中…");
  let batch;
  try { batch = window.HC.readPastDays(30); } catch (e) { setStatus("読取失敗: " + e); return; }
  // bridge が error JSON (= { error, message } shape) を返したら detect (Refs #5)
  try {
    const peek = JSON.parse(batch);
    if (peek && peek.error) {
      setStatus("bridge err: " + peek.error + " / " + (peek.message || "").slice(0, 120));
      return;
    }
  } catch {
    setStatus("bridge JSON parse 失敗: " + (batch || "").slice(0, 120));
    return;
  }
  setStatus("送信中… (" + batch.length + " bytes)");
  const r = await fetch("/api/upload-batch", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: batch,
  }));
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    setStatus("upload-batch " + r.status + ": " + errText.slice(0, 200));
    return;
  }
  const j = await r.json();
  setStatus("✓ " + j.written + " 日分 upload");
  refreshHistory();
}

async function uploadZones() {
  const file = $("zones-file").files[0];
  if (!file) { setZonesStatus("ファイル未選択"); return; }
  setZonesStatus("読込中…");
  let text;
  try { text = await file.text(); } catch (e) { setZonesStatus("ファイル読込失敗: " + e); return; }
  // parse して uuid / startDate を pre-check (= サーバ往復前に明確化)
  let parsed;
  try { parsed = JSON.parse(text); } catch { setZonesStatus("JSON parse 失敗"); return; }
  if (!parsed || typeof parsed !== "object" || !parsed.uuid || !parsed.startDate) {
    setZonesStatus("uuid / startDate が JSON に無い");
    return;
  }
  setZonesStatus("送信中…");
  const r = await fetch("/api/upload-zones", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
  }));
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    setZonesStatus("upload-zones " + r.status + ": " + errText.slice(0, 200));
    return;
  }
  const j = await r.json();
  setZonesStatus("✓ " + j.date + " / " + j.uuid.slice(0, 8) + "…");
  refreshHistory();
  refreshZonesList();
}

// 日付別 + 突合 view
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function fmtDur(sec) {
  if (sec === null || sec === undefined) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return (h > 0 ? h + "h " : "") + m + "m";
}
function fmtKm(m) {
  if (m === null || m === undefined) return "—";
  return (m / 1000).toFixed(2) + " km";
}
function badge(type) {
  if (type === "matched") return '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-emerald-100 text-emerald-800">突合</span>';
  if (type === "hc_only") return '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-sky-100 text-sky-800">HC のみ</span>';
  return '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-100 text-amber-800">Zones のみ</span>';
}
function renderItem(it) {
  if (it.type === "matched") {
    // 連結成分グループ: hcs[] と zoneses[] を全部並べ、合計サマリ + 解除 button。
    // 1 HC + 1 Zones の典型は従来通りに見えるが、複数だと「グループ」として
    // 表示される。
    const hcs = it.hcs || [];
    const zs = it.zoneses || [];
    const detailHc = hcs[0]; const detailZ = zs[0];
    const detailHref = (detailHc && detailZ)
      ? '/workout?hc=' + encodeURIComponent(detailHc.id) + '&zones=' + encodeURIComponent(detailZ.id)
      : null;
    const hcIdsJson = JSON.stringify(hcs.map((h) => h.id));
    const zIdsJson  = JSON.stringify(zs.map((z) => z.id));
    const manualBadge = it.has_manual
      ? '<span class="inline-block px-1.5 py-0.5 text-[10px] rounded bg-violet-100 text-violet-700">手動</span>'
      : '';
    const html = [];
    html.push('<div class="border-l-2 border-emerald-400 pl-2 py-1 space-y-1">');
    html.push('<div class="flex items-center justify-between">');
    html.push('<span class="text-xs font-medium">', badge("matched"), ' ', manualBadge,
              ' ', String(hcs.length), ' HC × ', String(zs.length), ' Zones</span>');
    html.push(
      '<span class="text-[10px]">',
      detailHref
        ? '<a class="text-emerald-700 hover:underline" href="' + detailHref + '">詳細 ›</a>'
        : '',
      ' <button class="ml-2 text-rose-600 hover:underline" '
        + 'data-action="unpair-group" '
        + 'data-hc-ids="' + escapeHtml(hcIdsJson) + '" '
        + 'data-zones-ids="' + escapeHtml(zIdsJson) + '">解除</button>',
      '</span>',
    );
    html.push('</div>');
    for (const hc of hcs) {
      html.push('<div class="text-[11px] text-sky-700 pl-1">');
      html.push('🏃 HC ', fmtTime(hc.start_at), '–', fmtTime(hc.end_at), ' ',
                escapeHtml(hc.activity_name || "—"),
                ' · ', fmtKm(hc.distance_m), ' / ', fmtDur(hc.duration_sec));
      html.push('</div>');
    }
    for (const z of zs) {
      html.push('<div class="text-[11px] text-amber-700 pl-1">');
      html.push('⌚ Zones ', fmtTime(z.start_at), '–', fmtTime(z.end_at), ' ',
                escapeHtml(z.activity_name || "—"),
                ' · ', fmtKm(z.distance_m), ' / ♥', (z.avg_heart_rate ?? "—"));
      html.push('</div>');
    }
    html.push('</div>');
    return html.join("");
  }
  if (it.type === "hc_only") {
    const hc = it.hc;
    return [
      '<div class="border-l-2 border-sky-300 pl-2 py-1 flex items-start justify-between">',
      '<div>',
      '<div class="text-xs font-medium">', badge("hc_only"),
      ' ', fmtTime(hc.start_at), '–', fmtTime(hc.end_at),
      ' ', escapeHtml(hc.activity_name || "—"), '</div>',
      '<div class="text-[11px] text-slate-600">HC: ', fmtKm(hc.distance_m), ' / ', fmtDur(hc.duration_sec), '</div>',
      '</div>',
      '<button class="text-[10px] text-emerald-700 hover:underline shrink-0" ',
        'data-action="link" data-side="hc" data-id="', escapeHtml(hc.id), '">Zones とリンク</button>',
      '</div>',
    ].join("");
  }
  const z = it.zones;
  return [
    '<div class="border-l-2 border-amber-300 pl-2 py-1 flex items-start justify-between">',
    '<div>',
    '<div class="text-xs font-medium">', badge("zones_only"),
    ' ', fmtTime(z.start_at), '–', fmtTime(z.end_at),
    ' ', escapeHtml(z.activity_name || "—"), '</div>',
    '<div class="text-[11px] text-slate-600">Zones: ', fmtKm(z.distance_m), ' / ♥', (z.avg_heart_rate ?? "—"), '</div>',
    '</div>',
    '<button class="text-[10px] text-emerald-700 hover:underline shrink-0" ',
      'data-action="link" data-side="zones" data-id="', escapeHtml(z.id), '">HC とリンク</button>',
    '</div>',
  ].join("");
}
function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}
async function reindexAll() {
  const btn = $("reindex-btn");
  const status = $("reindex-status");
  btn.disabled = true;
  status.textContent = "再 index 中… (R2 listing + D1 upsert)";
  const r = await fetch("/_admin/reindex", authFetchInit({ method: "POST" }));
  btn.disabled = false;
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    status.textContent = "失敗 " + r.status + ": " + err.slice(0, 200);
    return;
  }
  const j = await r.json();
  status.textContent =
    "✓ HC " + j.hc_files + " files / " + j.hc_rows + " rows、" +
    "Zones " + j.zones_files + " files / " + j.zones_rows + " rows" +
    (j.skipped_total > 0 ? "、skip " + j.skipped_total : "");
  // history と workouts 両方更新 (D1 が新しい行で埋まったので両方変わる)
  refreshHistory().catch(() => {});
  refreshWorkouts().catch(() => {});
}

// 最新の /api/workouts 結果を保持 (リンクモーダルが候補を引くため)
let workoutsCache = null;

async function refreshWorkouts() {
  const days = $("workouts-days").value;
  const summary = $("workouts-summary");
  const list = $("workouts-days-list");
  summary.textContent = "読込中…";
  list.innerHTML = "";
  const r = await fetch("/api/workouts?days=" + encodeURIComponent(days), authFetchInit());
  if (!r.ok) {
    summary.textContent = "fetch failed (" + r.status + ")";
    return;
  }
  const j = await r.json();
  workoutsCache = j;
  const matched = j.days.reduce((acc, d) => acc + d.matched_count, 0);
  summary.textContent = j.day_count + " 日 / 合計 " + j.total + " workout / 突合 " + matched + " 件";
  if (j.day_count === 0) {
    list.innerHTML = '<p class="text-xs text-slate-400">該当データなし</p>';
    return;
  }
  const html = [];
  for (const day of j.days) {
    html.push('<details class="border border-slate-200 rounded-lg" open>');
    html.push('<summary class="cursor-pointer select-none px-3 py-2 text-sm flex items-center justify-between">');
    html.push('<span class="font-medium">', day.date, '</span>');
    html.push('<span class="text-[11px] text-slate-500">HC ', day.hc_count, ' / Zones ', day.zones_count, ' / 突合 ', day.matched_count, '</span>');
    html.push('</summary>');
    html.push('<div class="px-3 pb-2 space-y-1">');
    for (const it of day.items) html.push(renderItem(it));
    html.push('</div></details>');
  }
  list.innerHTML = html.join("");
}

// =============================================================================
// 手動突合 (リンク / 解除) UI
// =============================================================================

// matched group をまるごと解除 (data-hc-ids / data-zones-ids JSON 経由)
async function unpairGroup(hcIds, zonesIds) {
  if (!confirm(hcIds.length + ' HC × ' + zonesIds.length + ' Zones の突合を解除しますか？')) return;
  const r = await fetch("/api/pair/delete", authFetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hc_ids: hcIds, zones_ids: zonesIds }),
  }));
  if (!r.ok) { alert("解除失敗 " + r.status); return; }
  refreshWorkouts().catch(() => {});
}

// 候補一覧を出して 1 つ選ばせて pair 追加
function openLinkPicker(side, id) {
  // side: "hc" (= clicked on hc_only) → 候補 = Zones (zones_only + 突合中 Zones)
  // side: "zones" (= clicked on zones_only) → 候補 = HC (hc_only + 突合中 HC)
  if (!workoutsCache) return;
  const candidates = [];
  for (const day of workoutsCache.days) {
    for (const it of day.items) {
      if (it.type === "matched") {
        const arr = side === "hc" ? it.zoneses : it.hcs;
        for (const r of arr) candidates.push({ row: r, day: day.date, label: side === "hc" ? "⌚" : "🏃", group: "突合中" });
      } else if (side === "hc" && it.type === "zones_only") {
        candidates.push({ row: it.zones, day: day.date, label: "⌚", group: "未突合" });
      } else if (side === "zones" && it.type === "hc_only") {
        candidates.push({ row: it.hc, day: day.date, label: "🏃", group: "未突合" });
      }
    }
  }
  // 同じ workout 候補が近い時刻にあるはずなので、日付 desc → 時刻 asc で sort
  candidates.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    const av = a.row.start_at ?? "";
    const bv = b.row.start_at ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  if (candidates.length === 0) { alert("リンクできる候補がありません"); return; }
  // モーダル DOM 構築
  const targetLabel = side === "hc" ? "Zones (⌚)" : "HC (🏃)";
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-2";
  wrap.innerHTML = '<div class="bg-white w-full max-w-md rounded-2xl p-4 max-h-[80vh] overflow-auto">'
    + '<div class="flex items-center justify-between mb-2">'
    + '<h3 class="font-semibold">リンク先の ' + targetLabel + ' を選択</h3>'
    + '<button id="pick-cancel" class="text-sm text-slate-500">閉じる</button>'
    + '</div>'
    + '<p class="text-[10px] text-slate-500 mb-2">候補 ' + candidates.length + ' 件。タップで即リンク。突合中を選ぶとそのグループに合流します。</p>'
    + '<ul id="pick-list" class="space-y-1"></ul>'
    + '</div>';
  document.body.appendChild(wrap);
  const ul = wrap.querySelector("#pick-list");
  for (const c of candidates) {
    const li = document.createElement("li");
    // 未突合 = slate-50 背景 / 未マッチを示す。突合中 = emerald-50 背景 + ✓ icon。
    const isMatched = c.group === "突合中";
    li.className = (isMatched
      ? "border-l-4 border-emerald-400 bg-emerald-50 "
      : "border-l-4 border-slate-300 bg-white "
    ) + "border border-slate-200 rounded p-2 text-xs hover:bg-emerald-100 cursor-pointer flex items-center justify-between gap-2";
    const badge = isMatched
      ? '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-emerald-500 text-white shrink-0">✓ 突合中</span>'
      : '<span class="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-400 text-white shrink-0">未突合</span>';
    li.innerHTML = '<span>' + c.label + ' <span class="font-medium">' + c.day + '</span> '
      + fmtTime(c.row.start_at) + '–' + fmtTime(c.row.end_at) + ' '
      + escapeHtml(c.row.activity_name || "—") + '</span>'
      + badge;
    li.addEventListener("click", async () => {
      const hcId = side === "hc" ? id : c.row.id;
      const zonesId = side === "hc" ? c.row.id : id;
      const r = await fetch("/api/pair", authFetchInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hc_id: hcId, zones_id: zonesId }),
      }));
      wrap.remove();
      if (!r.ok) { alert("リンク失敗 " + r.status); return; }
      refreshWorkouts().catch(() => {});
    });
    ul.appendChild(li);
  }
  wrap.querySelector("#pick-cancel").addEventListener("click", () => wrap.remove());
}

// event delegation: workouts-days-list 内のボタンを 1 つの listener で捌く
function onWorkoutsListClick(ev) {
  const btn = ev.target.closest && ev.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");
  if (action === "link") {
    openLinkPicker(btn.getAttribute("data-side"), btn.getAttribute("data-id"));
  } else if (action === "unpair-group") {
    try {
      const hcIds = JSON.parse(btn.getAttribute("data-hc-ids") || "[]");
      const zIds = JSON.parse(btn.getAttribute("data-zones-ids") || "[]");
      unpairGroup(hcIds, zIds);
    } catch (e) { /* ignore */ }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("env-badge").textContent = hasNative ? "native bridge: ✓" : "PWA / preview";
  $("upload-btn").addEventListener("click", uploadNow);
  $("upload-30-btn").addEventListener("click", uploadPast30);
  $("auto-toggle").addEventListener("change", (e) => {
    if (!hasNative) return;
    if (e.target.checked) window.HC.scheduleDailyUpload();
    else window.HC.cancelDailyUpload();
  });
  if (hasNative) $("auto-toggle").checked = window.HC.isDailyUploadScheduled();
  $("zones-upload-btn").addEventListener("click", uploadZones);
  $("workouts-days").addEventListener("change", () => { refreshWorkouts().catch(() => {}); });
  $("workouts-days-list").addEventListener("click", onWorkoutsListClick);
  $("reindex-btn").addEventListener("click", reindexAll);
  refreshHistory().catch(() => {});
  refreshZonesList().catch(() => {});
  refreshWorkouts().catch(() => {});
});
</script>
</body>
</html>`;


/**
 * 突合 detail ページ。`/workout?hc=<id>&zones=<id>` で開く。
 * `/api/workout` から D1 行 + R2 raw を取得し、Chart.js で速度推移と HR zones を描画。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
export const WORKOUT_DETAIL_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Workout 詳細 — HC Reader</title>
<link rel="icon" href="/favicon.ico" sizes="any" />
<meta name="theme-color" content="#059669" />
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
  body { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
</style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
<div class="max-w-3xl mx-auto p-4 space-y-4">
  <header class="flex items-center justify-between pt-2">
    <a href="/" class="text-sm text-emerald-700">‹ 戻る</a>
    <h1 class="text-lg font-semibold">Workout 詳細</h1>
    <span></span>
  </header>

  <section id="summary" class="bg-white rounded-2xl shadow p-4 text-sm text-slate-700">読込中…</section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-2">
    <h2 class="font-semibold">比較セッション</h2>
    <p class="text-[10px] text-slate-400">
      X 軸 = セッション開始からの経過時間。複数の日 / セッションを重ねて比較できます。
    </p>
    <div id="session-chips" class="flex flex-wrap gap-1.5"></div>
    <button id="picker-toggle" type="button"
      class="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded">
      ＋ セッション追加 / 削除
    </button>
    <div id="picker-panel" class="hidden border border-slate-200 rounded p-2 space-y-2">
      <div class="flex items-center gap-2">
        <label class="text-xs text-slate-600">過去</label>
        <select id="picker-days" class="text-xs border border-slate-300 rounded px-2 py-1">
          <option value="7">7日</option>
          <option value="14">14日</option>
          <option value="30" selected>30日</option>
          <option value="90">90日</option>
        </select>
        <button id="picker-apply" type="button"
          class="ml-auto text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded">
          適用 (URL 更新 + リロード)
        </button>
      </div>
      <p id="picker-status" class="text-[11px] text-slate-500">読込中…</p>
      <div id="picker-days-list" class="space-y-1 max-h-72 overflow-y-auto"></div>
    </div>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-2">
    <h2 class="font-semibold">速度比較</h2>
    <p id="speed-empty" class="text-xs text-slate-500 hidden">速度データ無し</p>
    <p class="text-[10px] text-slate-400">
      HC 時系列 (端末が記録した場合のみ) + HC 平均 + Zones 平均 + 推定モデルを重ねて表示。
      下のチップ or 凡例タップで個別系列の表示/非表示を切替 (設定は端末に保存)。
    </p>
    <div id="speed-toggles" class="flex flex-wrap gap-1.5"></div>
    <div class="relative h-64"><canvas id="speed-chart"></canvas></div>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-2">
    <h2 class="font-semibold">速度 + 心拍 (合成、group 別)</h2>
    <p id="combined-empty" class="text-xs text-slate-500 hidden">データ無し</p>
    <p class="text-[10px] text-slate-400">
      左軸=速度 (km/h, session 別の平均線)、右軸=心拍 (Zones 平均=下弦 / max=上弦 の塗り帯)。
      上の chip の <span class="font-semibold">G1/G2 ボタン</span>を押して
      session を group に振分け、各 group ごとに 1 グラフを縦に並べる
      (上下で比較しやすいよう Y 軸スケールは全グラフで共通)。
    </p>
    <div id="combined-charts-container" class="space-y-3"></div>
  </section>

  <section class="bg-white rounded-2xl shadow p-4 space-y-2">
    <h2 class="font-semibold">心拍時系列</h2>
    <p id="zones-empty" class="text-xs text-slate-500 hidden">心拍データ無し</p>
    <p class="text-[10px] text-slate-400">
      HC 平均心拍 + Zones 平均 / max 心拍 + 推定モデルを workout 期間に重ねて表示。
      下のチップ or 凡例タップで個別系列の表示/非表示を切替 (設定は端末に保存)。
    </p>
    <div id="zones-toggles" class="flex flex-wrap gap-1.5"></div>
    <div class="relative h-64"><canvas id="zones-chart"></canvas></div>
  </section>

  <details class="bg-white rounded-2xl shadow p-4">
    <summary class="cursor-pointer text-sm font-semibold">raw payload (debug)</summary>
    <pre id="raw-dump" class="mt-2 text-[10px] text-slate-600 overflow-x-auto whitespace-pre-wrap"></pre>
  </details>
</div>

<script>
const params = new URLSearchParams(location.search);
// 多セッション対応: hc / zones は comma-separated 配列。同一 index で 1 セッション。
function parseIds(v) { return (v || "").split(",").map((s) => s.trim()); }
const hcIds = parseIds(params.get("hc"));
const zIds = parseIds(params.get("zones"));

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function fmtDur(sec) {
  if (sec === null || sec === undefined) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return (h > 0 ? h + "h " : "") + m + "m";
}
function fmtKm(m) {
  if (m === null || m === undefined) return "—";
  return (m / 1000).toFixed(2) + " km";
}
function fmtElapsed(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}
function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

// セッションごとの色 palette
const SESSION_COLORS = [
  "#10b981", "#6366f1", "#f97316", "#dc2626", "#0ea5e9",
  "#a855f7", "#0d9488", "#eab308", "#db2777", "#64748b",
];

// 各セッションの "日付 + 開始時刻 + 名称" を短く表現
function sessionLabel(sess) {
  const row = (sess.hc && sess.hc.row) || (sess.zones && sess.zones.row);
  if (!row) return "?";
  const d = new Date(row.start_at);
  const mm = String(d.getMonth() + 1), dd = String(d.getDate());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return mm + "/" + dd + " " + hh + ":" + mi;
}
// セッション開始時刻 (HC 優先で fallback Zones)
function sessionStartMs(sess) {
  const row = (sess.hc && sess.hc.row) || (sess.zones && sess.zones.row);
  return row ? Date.parse(row.start_at) : 0;
}
function sessionEndMs(sess) {
  const row = (sess.hc && sess.hc.row) || (sess.zones && sess.zones.row);
  return row ? Date.parse(row.end_at) : 0;
}

async function load() {
  if (hcIds.every((s) => !s) && zIds.every((s) => !s)) {
    document.getElementById("summary").textContent = "?hc= / ?zones= 必須";
    return;
  }
  const qs = new URLSearchParams();
  if (hcIds.some((s) => s)) qs.set("hc", hcIds.join(","));
  if (zIds.some((s) => s)) qs.set("zones", zIds.join(","));
  const r = await workoutFetch("/api/workout?" + qs.toString());
  if (!r.ok) {
    document.getElementById("summary").textContent = "fetch failed (" + r.status + ")";
    return;
  }
  const j = await r.json();
  const sessions = Array.isArray(j.sessions) ? j.sessions : [];
  // badge handler から再描画できるよう保持
  window.__sessions = sessions;
  renderSummary(sessions);
  renderSessionChips(sessions);
  renderSpeedChart(sessions);
  renderCombinedChart(sessions);
  renderHrChart(sessions);
  document.getElementById("raw-dump").textContent = JSON.stringify(j, null, 2);
  initPicker();
}

// セッションを Gn (n=1..MAX_GROUPS) に手動アサインする state。
// 合成 chart はこの group 別に 1 グラフずつ並べる (Refs #57)。
// 端末ごとに保持 (localStorage)、key は sessionKey() で導出。
const MAX_GROUPS = 4;
const GROUP_STATE_KEY = "hcreader.workout-groups.v1";
function sessionKey(sess) {
  const hc = sess.hc && sess.hc.row && sess.hc.row.id;
  const z = sess.zones && sess.zones.row && sess.zones.row.id;
  return (hc || "") + "::" + (z || "");
}
function loadGroupState() {
  try {
    const raw = localStorage.getItem(GROUP_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveGroupState(state) {
  try { localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(state)); } catch { /* quota etc */ }
}
function getSessionGroup(sess, state) {
  const k = sessionKey(sess);
  const g = state[k];
  return (typeof g === "number" && g >= 1 && g <= MAX_GROUPS) ? g : 1;
}
function cycleSessionGroup(sess, state) {
  const k = sessionKey(sess);
  const cur = getSessionGroup(sess, state);
  const next = cur >= MAX_GROUPS ? 1 : cur + 1;
  state[k] = next;
  saveGroupState(state);
  return next;
}
const GROUP_BADGE_COLORS = ["#10b981", "#6366f1", "#f97316", "#dc2626"]; // G1..G4

function renderSessionChips(sessions) {
  const el = document.getElementById("session-chips");
  el.innerHTML = "";
  if (sessions.length === 0) {
    el.innerHTML = '<span class="text-xs text-slate-500">セッション無し</span>';
    return;
  }
  const state = loadGroupState();
  sessions.forEach((sess, idx) => {
    const color = SESSION_COLORS[idx % SESSION_COLORS.length];
    const span = document.createElement("span");
    span.className = "inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full border";
    span.style.borderColor = color;
    span.style.color = color;
    // chip label
    const label = document.createElement("span");
    label.textContent = sessionLabel(sess);
    span.appendChild(label);
    // G1..G4 toggle ボタン (click で cycle、合成 chart を再描画)
    const grp = getSessionGroup(sess, state);
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "ml-1 px-1.5 py-0.5 rounded text-white text-[10px] font-semibold";
    badge.style.backgroundColor = GROUP_BADGE_COLORS[grp - 1];
    badge.textContent = "G" + grp;
    badge.title = "クリックで group 切替 (G1→G2→...→G" + MAX_GROUPS + "→G1)";
    badge.addEventListener("click", () => {
      const next = cycleSessionGroup(sess, state);
      badge.textContent = "G" + next;
      badge.style.backgroundColor = GROUP_BADGE_COLORS[next - 1];
      renderCombinedChart(window.__sessions || []);
    });
    span.appendChild(badge);
    el.appendChild(span);
  });
}

function renderSummary(sessions) {
  if (sessions.length === 0) {
    document.getElementById("summary").textContent = "(データ無し)";
    return;
  }
  const html = [];
  sessions.forEach((sess, idx) => {
    const color = SESSION_COLORS[idx % SESSION_COLORS.length];
    const hc = sess.hc && sess.hc.row;
    const z = sess.zones && sess.zones.row;
    html.push('<div class="border-l-4 pl-2 mb-2" style="border-color:', color, '">');
    html.push('<div class="text-xs font-semibold" style="color:', color, '">',
              escapeHtml(sessionLabel(sess)), '</div>');
    if (hc) {
      html.push('<div class="text-[11px] text-slate-700">HC: ',
                escapeHtml(hc.activity_name || "—"), ' ',
                fmtTime(hc.start_at), '–', fmtTime(hc.end_at),
                ' / ', fmtKm(hc.distance_m), ' / ', fmtDur(hc.duration_sec),
                (hc.avg_heart_rate !== null && hc.avg_heart_rate !== undefined
                  ? ' / ♥' + hc.avg_heart_rate : ''), '</div>');
    }
    if (z) {
      html.push('<div class="text-[11px] text-slate-700">Zones: ',
                escapeHtml(z.activity_name || "—"), ' ',
                fmtTime(z.start_at), '–', fmtTime(z.end_at),
                ' / ', fmtKm(z.distance_m),
                ' / ♥', (z.avg_heart_rate ?? "—"),
                ' / kcal ', (z.active_calories ?? "—"), '</div>');
    }
    html.push('</div>');
  });
  document.getElementById("summary").innerHTML = html.join("");
}

// 速度比較 chart: 複数セッションを「セッション開始からの経過時間」X 軸で重ねる。
// セッションごとに色を割当 (SESSION_COLORS)、線種で系列を区別:
//   HC 時系列 source 別 = solid 細線
//   HC 平均             = solid 太線 (一番目立たせる、default 表示)
//   Zones 平均          = dashed 細線 (目立たなく)
//   推定モデル ramp→cruise = dotted 細線 (default 非表示)
function renderSpeedChart(sessions) {
  const canvas = document.getElementById("speed-chart");
  const empty = document.getElementById("speed-empty");

  function avg(row) {
    if (!row || typeof row.distance_m !== "number" || typeof row.duration_sec !== "number" || row.duration_sec <= 0) return null;
    return (row.distance_m / 1000) / (row.duration_sec / 3600);
  }
  function shortSource(src) {
    if (src.includes("fitbit")) return "Fitbit";
    if (src.includes("google.android.apps.fitness") || src.includes("google.android.gms.fitness")) return "Google Fit";
    if (src.includes("samsung.health")) return "Samsung Health";
    if (src.includes("healthconnect")) return "Health Connect";
    if (src === "unknown") return "(source 不明)";
    const parts = src.split(".");
    return parts[parts.length - 1] || src;
  }

  const datasets = [];
  const multi = sessions.length > 1;

  // 多 session を X 軸方向に連結する。HC が背中合わせ session に分割記録された
  // 日 (= 1 実 workout が 4 session として保存) で、4 session を 1 本の経過時間
  // 軸に並べたい (Refs #52)。
  const sessDurations = sessions.map((sess) => {
    const sMs = sessionStartMs(sess);
    const eMs = sessionEndMs(sess);
    return sMs ? Math.max(0, eMs - sMs) : 0;
  });
  const sessOffsets = [];
  let cum = 0;
  for (const d of sessDurations) { sessOffsets.push(cum); cum += d; }
  const xMaxMs = cum;

  sessions.forEach((sess, sIdx) => {
    const color = SESSION_COLORS[sIdx % SESSION_COLORS.length];
    const prefix = multi ? "[" + sessionLabel(sess) + "] " : "";
    const startMs = sessionStartMs(sess);
    if (!startMs) return;
    const durMs = sessDurations[sIdx];
    const off = sessOffsets[sIdx];

    const hcRaw = sess.hc && sess.hc.raw;
    const hcRow = sess.hc && sess.hc.row;
    const zRow = sess.zones && sess.zones.row;

    // HC 時系列 samples (source 別)
    const hcSeriesBySource = new Map();
    const speeds = hcRaw && Array.isArray(hcRaw.speeds) ? hcRaw.speeds : [];
    for (const s of speeds) {
      if (!s || !Array.isArray(s.samples)) continue;
      const src = typeof s.source === "string" && s.source ? s.source : "unknown";
      let arr = hcSeriesBySource.get(src);
      if (!arr) { arr = []; hcSeriesBySource.set(src, arr); }
      for (const sa of s.samples) {
        if (sa && typeof sa.time === "string" && typeof sa.kmh === "number") {
          arr.push({ x: off + (new Date(sa.time).getTime() - startMs), y: sa.kmh });
        }
      }
    }
    for (const arr of hcSeriesBySource.values()) arr.sort((a, b) => a.x - b.x);

    for (const [src, pts] of hcSeriesBySource) {
      if (pts.length === 0) continue;
      datasets.push({
        label: prefix + "HC 速度 [" + shortSource(src) + "] " + pts.length + "点",
        data: pts,
        borderColor: color,
        backgroundColor: color + "22",
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 1.2,
      });
    }

    const hcAvg = avg(hcRow);
    const zAvg = avg(zRow);
    if (hcAvg !== null) {
      datasets.push({
        label: prefix + "HC 平均 " + hcAvg.toFixed(2) + " km/h",
        data: [{ x: off, y: hcAvg }, { x: off + durMs, y: hcAvg }],
        borderColor: color,
        pointRadius: 0,
        borderWidth: 2.5,
      });
    }
    if (zAvg !== null) {
      datasets.push({
        label: prefix + "Zones 平均 " + zAvg.toFixed(2) + " km/h",
        data: [{ x: off, y: zAvg }, { x: off + durMs, y: zAvg }],
        borderColor: color,
        borderDash: [6, 4],
        pointRadius: 0,
        borderWidth: 1.5,
      });
    }
    // 推定モデル: ramp(0→avg) → cruise(avg)
    if (hcAvg !== null) {
      const totalSec = durMs / 1000;
      const tRamp = Math.min(60, totalSec * 0.1);
      if (totalSec > 120) {
        datasets.push({
          label: prefix + "推定モデル (ramp " + Math.round(tRamp) + "s → 平均で cruise)",
          data: [
            { x: off, y: 0 },
            { x: off + tRamp * 1000, y: hcAvg },
            { x: off + durMs, y: hcAvg },
          ],
          borderColor: color,
          borderDash: [2, 3],
          pointRadius: 0,
          borderWidth: 1,
          hidden: true,
        });
      }
    }
  });

  if (datasets.length === 0) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  canvas.classList.remove("hidden");

  const savedSpeed = loadToggleState("speed");
  for (const ds of datasets) {
    if (savedSpeed && Object.prototype.hasOwnProperty.call(savedSpeed, ds.label)) {
      ds.hidden = !savedSpeed[ds.label];
    }
  }

  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: { legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "km/h" } },
        x: {
          type: "linear",
          min: 0, max: xMaxMs || undefined,
          title: { display: true, text: "経過時間" },
          ticks: { maxTicksLimit: 8, callback: (v) => fmtElapsed(v) },
        },
      },
    },
  });

  installToggleChips("speed-toggles", "speed", chart, datasets);
}

// 心拍時系列 chart: 速度比較と同じ多セッション・経過時間 X 軸構造。
// 各セッションで HC 平均 (solid 太線) + Zones 平均 (dashed) + 推定モデル (dotted, 非表示) を描く。
// 速度 + 心拍 合成チャート (Refs #52): JST 日付ごとに 1 グラフを縦に並べる。
// 同日内の session は X 軸方向に連結 (session 切り替えで step 状)。
// 全グラフで Y 軸スケールを共通化 (上下で目視比較するため)。
//   - 左 Y 軸: 速度 (km/h, session 別フラット平均線、赤)
//   - 右 Y 軸: 心拍 (Zones avg=下弦 / max=上弦 の塗り帯、青)
// HR samples が無い (Zones raw は集約値のみ) ため心拍は session ごとフラット帯。
function renderCombinedChart(sessions) {
  const container = document.getElementById("combined-charts-container");
  const empty = document.getElementById("combined-empty");
  container.innerHTML = "";

  function avg(row) {
    if (!row || typeof row.distance_m !== "number" || typeof row.duration_sec !== "number" || row.duration_sec <= 0) return null;
    return (row.distance_m / 1000) / (row.duration_sec / 3600);
  }
  // 1. 手動 group 番号 (G1..GMAX_GROUPS) で sessions をグルーピング (Refs #57)
  //    chip の G ボタンで切替えた割当を localStorage から読む。
  const state = loadGroupState();
  const groupByG = new Map();
  for (const sess of sessions) {
    const ms = sessionStartMs(sess);
    if (!ms) continue;
    const g = getSessionGroup(sess, state);
    if (!groupByG.has(g)) groupByG.set(g, []);
    groupByG.get(g).push(sess);
  }
  // group 番号 asc (G1 が上)
  const dates = [...groupByG.keys()].sort((a, b) => a - b);

  if (dates.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // 2. 全グラフ共通の Y 軸スケールを事前計算 (上下比較の視認性のため)。
  //    速度: max は全 session の平均 km/h の最大、0 を含める。
  //    心拍: min/max は全 session の Zones min/max を 5 bpm 単位で padding。
  let speedMax = 0;
  let hrMin = Infinity, hrMax = -Infinity;
  for (const sess of sessions) {
    const hcRow = sess.hc && sess.hc.row;
    const zRow = sess.zones && sess.zones.row;
    const v = avg(hcRow) ?? avg(zRow);
    if (v !== null) speedMax = Math.max(speedMax, v);
    if (zRow && typeof zRow.avg_heart_rate === "number") hrMin = Math.min(hrMin, zRow.avg_heart_rate);
    if (zRow && typeof zRow.max_heart_rate === "number") hrMax = Math.max(hrMax, zRow.max_heart_rate);
    // min HR があれば下限にも反映
    if (zRow && typeof zRow.min_heart_rate === "number") hrMin = Math.min(hrMin, zRow.min_heart_rate);
  }
  if (!Number.isFinite(hrMin)) hrMin = 60;
  if (!Number.isFinite(hrMax)) hrMax = 180;
  speedMax = Math.ceil((speedMax * 1.15) || 1); // 15% headroom
  hrMin = Math.max(0, Math.floor((hrMin - 5) / 5) * 5);
  hrMax = Math.ceil((hrMax + 5) / 5) * 5;

  // 3. group 番号ごとにチャート 1 個ずつ生成
  for (const date of dates) {
    const daySessions = groupByG.get(date);

    // session を X 連結
    const sessDurations = daySessions.map((sess) => {
      const sMs = sessionStartMs(sess);
      const eMs = sessionEndMs(sess);
      return sMs ? Math.max(0, eMs - sMs) : 0;
    });
    const sessOffsets = [];
    let cum = 0;
    for (const d of sessDurations) { sessOffsets.push(cum); cum += d; }
    const xMaxMs = cum;

    const datasets = [];
    daySessions.forEach((sess, sIdx) => {
      if (!sessionStartMs(sess)) return;
      const durMs = sessDurations[sIdx];
      const off = sessOffsets[sIdx];

      const hcRow = sess.hc && sess.hc.row;
      const zRow = sess.zones && sess.zones.row;

      // 速度 — session 平均フラット線
      const v = avg(hcRow) ?? avg(zRow);
      if (v !== null) {
        datasets.push({
          label: "速度 (km/h)",
          data: [{ x: off, y: v }, { x: off + durMs, y: v }],
          borderColor: "#dc2626",
          borderDash: [6, 3],
          borderWidth: 1.8,
          pointRadius: 0,
          yAxisID: "ySpeed",
          order: 1,
          spanGaps: false,
        });
      }

      // 心拍 帯 (avg 下弦 + max 上弦の塗り)
      const zAvgHr = zRow && typeof zRow.avg_heart_rate === "number" ? zRow.avg_heart_rate : null;
      const zMaxHr = zRow && typeof zRow.max_heart_rate === "number" ? zRow.max_heart_rate : null;
      if (zAvgHr !== null && zMaxHr !== null) {
        datasets.push({
          label: "♥ max (上弦)",
          data: [{ x: off, y: zMaxHr }, { x: off + durMs, y: zMaxHr }],
          borderColor: "#3b82f6",
          borderWidth: 2,
          pointRadius: 0,
          yAxisID: "yHr",
          order: 2,
          fill: false,
        });
        datasets.push({
          label: "♥ 平均 (下弦)",
          data: [{ x: off, y: zAvgHr }, { x: off + durMs, y: zAvgHr }],
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.25)",
          borderWidth: 2,
          pointRadius: 0,
          yAxisID: "yHr",
          order: 2,
          fill: "-1",
        });
      } else if (zAvgHr !== null) {
        datasets.push({
          label: "♥ 平均",
          data: [{ x: off, y: zAvgHr }, { x: off + durMs, y: zAvgHr }],
          borderColor: "#3b82f6",
          borderWidth: 2,
          pointRadius: 0,
          yAxisID: "yHr",
          order: 2,
        });
      }
    });

    // 1 group 分の wrapper を生成して container に追加
    const groupColor = GROUP_BADGE_COLORS[(date - 1) % GROUP_BADGE_COLORS.length];
    const wrap = document.createElement("div");
    wrap.innerHTML = '<div class="text-xs font-medium mb-1" style="color:'
      + groupColor + '">G' + date
      + ' (' + daySessions.length + ' session)</div>'
      + '<div class="relative h-56"><canvas></canvas></div>';
    container.appendChild(wrap);
    const canvas = wrap.querySelector("canvas");

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        plugins: {
          legend: {
            display: true,
            labels: {
              boxWidth: 12, font: { size: 10 },
              // session 別に同じ label が重複するので uniq filter
              filter: (item, data) => {
                const seen = data._seen || (data._seen = new Set());
                if (seen.has(item.text)) return false;
                seen.add(item.text);
                return true;
              },
            },
          },
        },
        scales: {
          ySpeed: {
            type: "linear", position: "left",
            min: 0, max: speedMax,
            title: { display: true, text: "速度 (km/h)", color: "#dc2626" },
            ticks: { color: "#dc2626" },
          },
          yHr: {
            type: "linear", position: "right",
            min: hrMin, max: hrMax,
            title: { display: true, text: "心拍 (bpm)", color: "#3b82f6" },
            ticks: { color: "#3b82f6" },
            grid: { drawOnChartArea: false },
          },
          x: {
            type: "linear",
            min: 0, max: xMaxMs || undefined,
            title: { display: true, text: "経過時間" },
            ticks: { maxTicksLimit: 8, callback: (v) => fmtElapsed(v) },
          },
        },
      },
    });
  }
}

function renderHrChart(sessions) {
  const canvas = document.getElementById("zones-chart");
  const empty = document.getElementById("zones-empty");

  const datasets = [];
  const multi = sessions.length > 1;

  // X 軸方向 連結 (Refs #52)。renderSpeedChart と同じロジック。
  const sessDurations = sessions.map((sess) => {
    const sMs = sessionStartMs(sess);
    const eMs = sessionEndMs(sess);
    return sMs ? Math.max(0, eMs - sMs) : 0;
  });
  const sessOffsets = [];
  let cum = 0;
  for (const d of sessDurations) { sessOffsets.push(cum); cum += d; }
  const xMaxMs = cum;

  sessions.forEach((sess, sIdx) => {
    const color = SESSION_COLORS[sIdx % SESSION_COLORS.length];
    const prefix = multi ? "[" + sessionLabel(sess) + "] " : "";
    if (!sessionStartMs(sess)) return;
    const durMs = sessDurations[sIdx];
    const off = sessOffsets[sIdx];

    const hcRow = sess.hc && sess.hc.row;
    const zRow = sess.zones && sess.zones.row;
    const hcHr = hcRow && typeof hcRow.avg_heart_rate === "number" ? hcRow.avg_heart_rate : null;
    const zHr = zRow && typeof zRow.avg_heart_rate === "number" ? zRow.avg_heart_rate : null;
    const zMax = zRow && typeof zRow.max_heart_rate === "number" ? zRow.max_heart_rate : null;

    if (hcHr !== null) {
      datasets.push({
        label: prefix + "HC 平均 ♥" + hcHr + " bpm",
        data: [{ x: off, y: hcHr }, { x: off + durMs, y: hcHr }],
        borderColor: color,
        pointRadius: 0,
        borderWidth: 2.5,
      });
    }
    if (zHr !== null) {
      datasets.push({
        label: prefix + "Zones 平均 ♥" + zHr + " bpm",
        data: [{ x: off, y: zHr }, { x: off + durMs, y: zHr }],
        borderColor: color,
        borderDash: [6, 4],
        pointRadius: 0,
        borderWidth: 1.5,
      });
    }
    if (zMax !== null) {
      datasets.push({
        label: prefix + "Zones max ♥" + zMax + " bpm",
        data: [{ x: off, y: zMax }, { x: off + durMs, y: zMax }],
        borderColor: color,
        borderDash: [1, 3],
        pointRadius: 0,
        borderWidth: 2,
      });
    }
    // 推定モデル: resting (60) → avg ramp → cruise
    const baseHr = hcHr !== null ? hcHr : zHr;
    if (baseHr !== null) {
      const totalSec = durMs / 1000;
      const tRamp = Math.min(60, totalSec * 0.1);
      if (totalSec > 120) {
        datasets.push({
          label: prefix + "推定モデル (ramp " + Math.round(tRamp) + "s → 平均で cruise)",
          data: [
            { x: off, y: 60 },
            { x: off + tRamp * 1000, y: baseHr },
            { x: off + durMs, y: baseHr },
          ],
          borderColor: color,
          borderDash: [2, 3],
          pointRadius: 0,
          borderWidth: 1,
          hidden: true,
        });
      }
    }
  });

  if (datasets.length === 0) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  canvas.classList.remove("hidden");

  const savedHr = loadToggleState("hr");
  for (const ds of datasets) {
    if (savedHr && Object.prototype.hasOwnProperty.call(savedHr, ds.label)) {
      ds.hidden = !savedHr[ds.label];
    }
  }

  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      plugins: { legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: {
        y: { beginAtZero: false, title: { display: true, text: "bpm" } },
        x: {
          type: "linear",
          min: 0, max: xMaxMs || undefined,
          title: { display: true, text: "経過時間" },
          ticks: { maxTicksLimit: 8, callback: (v) => fmtElapsed(v) },
        },
      },
    },
  });

  installToggleChips("zones-toggles", "hr", chart, datasets);
}

// localStorage I/O: 各 chart の dataset 表示状態を { label: boolean } で保存。
// key: "hcreader.chart-toggles.v1.<chartKey>" (chartKey = "speed" or "hr")
const TOGGLE_KEY_PREFIX = "hcreader.chart-toggles.v1.";
function loadToggleState(chartKey) {
  try {
    const raw = localStorage.getItem(TOGGLE_KEY_PREFIX + chartKey);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch { return null; }
}
function saveToggleState(chartKey, label, visible) {
  try {
    const cur = loadToggleState(chartKey) || {};
    cur[label] = visible;
    localStorage.setItem(TOGGLE_KEY_PREFIX + chartKey, JSON.stringify(cur));
  } catch {}
}

// 系列トグル chip を設置。click で chart 反映 + localStorage 保存。
function installToggleChips(containerId, chartKey, chart, datasets) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";
  datasets.forEach((ds, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "px-2 py-1 text-[11px] rounded-full border transition";
    const setStyle = (visible) => {
      btn.style.borderColor = ds.borderColor;
      btn.style.color = visible ? "#fff" : ds.borderColor;
      btn.style.backgroundColor = visible ? ds.borderColor : "#fff";
      btn.style.opacity = visible ? "1" : "0.55";
    };
    setStyle(!ds.hidden);
    btn.textContent = ds.label;
    btn.addEventListener("click", () => {
      const meta = chart.getDatasetMeta(idx);
      meta.hidden = !meta.hidden;
      const visible = !meta.hidden;
      setStyle(visible);
      saveToggleState(chartKey, ds.label, visible);
      chart.update();
    });
    el.appendChild(btn);
  });
}

// ----- セッション picker: /api/workouts から候補を取得し、 -----
// **グループ単位** で checkbox 表示し、「適用」で /workout?hc=...&zones=... を更新 + reload。
// matched group は内部の hcs[] / zoneses[] を全部展開する (3 HC × 1 Zones なら 3 セッション)。
let pickerInitialized = false;

// /workout ページ向け auth fetch: Android WebView は Bearer / browser は cookie。
function workoutAuthHeaders() {
  if (typeof window !== "undefined" && window.HC && typeof window.HC.getUploadToken === "function") {
    return { Authorization: "Bearer " + window.HC.getUploadToken() };
  }
  return {};
}
function workoutFetch(url) {
  return fetch(url, { credentials: "include", headers: workoutAuthHeaders() });
}

function initPicker() {
  if (pickerInitialized) return;
  pickerInitialized = true;
  const toggleBtn = document.getElementById("picker-toggle");
  const panel = document.getElementById("picker-panel");
  const daysSel = document.getElementById("picker-days");
  const applyBtn = document.getElementById("picker-apply");
  toggleBtn.addEventListener("click", () => {
    const willOpen = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (willOpen) refreshPicker();
  });
  daysSel.addEventListener("change", refreshPicker);
  applyBtn.addEventListener("click", applyPicker);
}

// 各 group を一意 key で識別: matched=hcs/zoneses の全 id を join、hc_only/zones_only=単独 id
function groupKey(it) {
  if (it.type === "matched") {
    const hcIds = (it.hcs || []).map((h) => h.id).sort().join("|");
    const zIds = (it.zoneses || []).map((z) => z.id).sort().join("|");
    return "m:" + hcIds + "::" + zIds;
  }
  if (it.type === "hc_only") return "h:" + it.hc.id;
  if (it.type === "zones_only") return "z:" + it.zones.id;
  return "?";
}

// group から (hcArr, zArr) を生成 (positional pair、長い方に合わせて pad)
function expandGroup(it) {
  const hcArr = [], zArr = [];
  if (it.type === "matched") {
    const hcs = (it.hcs || []).map((h) => h.id);
    const zs = (it.zoneses || []).map((z) => z.id);
    const n = Math.max(hcs.length, zs.length);
    for (let i = 0; i < n; i++) { hcArr.push(hcs[i] || ""); zArr.push(zs[i] || ""); }
  } else if (it.type === "hc_only") {
    hcArr.push(it.hc.id); zArr.push("");
  } else if (it.type === "zones_only") {
    hcArr.push(""); zArr.push(it.zones.id);
  }
  return { hcArr, zArr };
}

// 現在 URL の hcIds / zIds から「最初に当たる group」を逆引き
function isGroupCurrentlySelected(it) {
  const { hcArr, zArr } = expandGroup(it);
  const curHc = new Set(hcIds.filter((s) => s));
  const curZ = new Set(zIds.filter((s) => s));
  for (const id of hcArr) if (id && curHc.has(id)) return true;
  for (const id of zArr) if (id && curZ.has(id)) return true;
  return false;
}

async function refreshPicker() {
  const status = document.getElementById("picker-status");
  const list = document.getElementById("picker-days-list");
  const days = document.getElementById("picker-days").value;
  status.textContent = "読込中…";
  list.innerHTML = "";
  let j;
  try {
    const r = await workoutFetch("/api/workouts?days=" + encodeURIComponent(days));
    if (!r.ok) { status.textContent = "fetch failed (" + r.status + ")"; return; }
    j = await r.json();
  } catch (e) { status.textContent = "fetch error: " + e; return; }

  const daysArr = Array.isArray(j.days) ? j.days : [];
  status.textContent = daysArr.length + " 日 / " + j.total + " workouts (グループ単位)";

  for (const day of daysArr) {
    const dayHdr = document.createElement("div");
    dayHdr.className = "text-xs font-semibold text-slate-700 mt-2";
    dayHdr.textContent = day.date + " (" + day.items.length + " グループ)";
    list.appendChild(dayHdr);
    for (const it of day.items) {
      const row = document.createElement("label");
      row.className = "flex items-start gap-2 text-[11px] text-slate-700 pl-2 cursor-pointer hover:bg-slate-50 rounded px-1";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "mt-0.5";
      cb.dataset.groupJson = JSON.stringify(it);
      if (isGroupCurrentlySelected(it)) cb.checked = true;

      const txt = document.createElement("span");
      txt.innerHTML = renderGroupLabel(it);
      row.appendChild(cb);
      row.appendChild(txt);
      list.appendChild(row);
    }
  }
}

function renderGroupLabel(it) {
  if (it.type === "matched") {
    const hcs = it.hcs || [], zs = it.zoneses || [];
    const first = hcs[0] || zs[0];
    const tag = '<span class="text-emerald-700">matched ' + hcs.length + 'HC × ' + zs.length + 'Zones</span>';
    const time = first ? fmtTime(first.start_at) + "–" + fmtTime(first.end_at) : "";
    const name = first ? escapeHtml(first.activity_name || "") : "";
    return tag + " " + time + " " + name;
  }
  if (it.type === "hc_only") {
    return '<span class="text-sky-700">HC only</span> ' +
      fmtTime(it.hc.start_at) + "–" + fmtTime(it.hc.end_at) + " " +
      escapeHtml(it.hc.activity_name || "");
  }
  if (it.type === "zones_only") {
    return '<span class="text-amber-700">Zones only</span> ' +
      fmtTime(it.zones.start_at) + "–" + fmtTime(it.zones.end_at) + " " +
      escapeHtml(it.zones.activity_name || "");
  }
  return "?";
}

function applyPicker() {
  const list = document.getElementById("picker-days-list");
  const cbs = list.querySelectorAll('input[type="checkbox"]');
  const hcArr = [], zArr = [];
  cbs.forEach((cb) => {
    if (!cb.checked) return;
    let it;
    try { it = JSON.parse(cb.dataset.groupJson); } catch { return; }
    const ex = expandGroup(it);
    for (let i = 0; i < ex.hcArr.length; i++) {
      hcArr.push(ex.hcArr[i]); zArr.push(ex.zArr[i]);
    }
  });
  if (hcArr.length === 0) { alert("グループ未選択"); return; }
  const qs = new URLSearchParams();
  if (hcArr.some((s) => s)) qs.set("hc", hcArr.join(","));
  if (zArr.some((s) => s)) qs.set("zones", zArr.join(","));
  location.search = "?" + qs.toString();
}

load();
</script>
</body>
</html>`;
