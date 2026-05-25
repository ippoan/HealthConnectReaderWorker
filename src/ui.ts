export const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Health Connect Reader</title>
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

  <section class="bg-white rounded-2xl shadow p-4">
    <h2 class="font-semibold mb-2">履歴</h2>
    <p id="history" class="text-sm text-slate-600">—</p>
  </section>
</div>

<script>
const hasNative = typeof window.HC !== "undefined";
const $ = (id) => document.getElementById(id);

function setStatus(msg) { $("status").textContent = msg; }

async function refreshHistory() {
  const token = hasNative ? window.HC.getUploadToken() : "";
  const r = await fetch("/api/history", { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) { $("history").textContent = "history fetch failed (" + r.status + ")"; return; }
  const j = await r.json();
  $("history").textContent = j.count + " 件 / 最新: " + (j.latest ?? "なし");
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

document.addEventListener("DOMContentLoaded", () => {
  $("env-badge").textContent = hasNative ? "native bridge: ✓" : "preview (no native)";
  $("upload-btn").addEventListener("click", uploadNow);
  $("upload-30-btn").addEventListener("click", uploadPast30);
  $("auto-toggle").addEventListener("change", (e) => {
    if (!hasNative) return;
    if (e.target.checked) window.HC.scheduleDailyUpload();
    else window.HC.cancelDailyUpload();
  });
  if (hasNative) $("auto-toggle").checked = window.HC.isDailyUploadScheduled();
  refreshHistory().catch(() => {});
});
</script>
</body>
</html>`;
