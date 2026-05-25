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

export const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Health Connect Reader</title>
<link rel="manifest" href="/manifest.json" />
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
    <label class="block text-sm">
      Upload token (初回のみ入力 / localStorage 保存)
      <input id="zones-token" type="password" autocomplete="off"
        class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
        placeholder="UPLOAD_TOKEN" />
    </label>
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

function getZonesToken() {
  // native bridge があればそちらを優先、無ければ手入力 / localStorage
  if (hasNative) return window.HC.getUploadToken();
  const fromInput = $("zones-token").value.trim();
  if (fromInput) {
    try { localStorage.setItem("hcreader.upload-token", fromInput); } catch {}
    return fromInput;
  }
  try { return localStorage.getItem("hcreader.upload-token") || ""; } catch { return ""; }
}

async function refreshHistory() {
  const token = getZonesToken();
  const r = await fetch("/api/history", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) { $("history").textContent = "history fetch failed (" + r.status + ")"; return; }
  const j = await r.json();
  $("history").textContent = j.count + " 件 / 最新: " + (j.latest ?? "なし");
}

async function refreshZonesList() {
  const token = getZonesToken();
  const list = $("zones-list");
  if (!token) {
    list.innerHTML = '<li class="py-1 text-slate-400">token 未入力</li>';
    return;
  }
  const r = await fetch("/api/zones", { headers: { Authorization: "Bearer " + token } });
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
  const r = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + window.HC.getUploadToken(),
    },
    body: payload,
  });
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
  const r = await fetch("/api/upload-batch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + window.HC.getUploadToken(),
    },
    body: batch,
  });
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
  const token = getZonesToken();
  if (!token) { setZonesStatus("Upload token を入力"); return; }
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
  const r = await fetch("/api/upload-zones", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: text,
  });
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
  // 既存 token を input に復元 (UX: 毎回貼り直し不要)
  try {
    const saved = localStorage.getItem("hcreader.upload-token");
    if (saved) $("zones-token").value = saved;
  } catch {}
  $("zones-upload-btn").addEventListener("click", uploadZones);
  refreshHistory().catch(() => {});
  refreshZonesList().catch(() => {});
});
</script>
</body>
</html>`;
