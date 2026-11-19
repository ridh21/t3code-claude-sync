/* claude-sync: a small sync icon in the T3 Code sidebar header.
 *
 * Claude Code -> T3: calls T3's own `agentSessions.scan` / `agentSessions.import`
 * RPCs (the importer the welcome screen uses) over the app's existing,
 * authenticated WebSocket, for every T3 project that has Claude Code sessions.
 * T3 -> Claude Code: every Claude thread in T3 is already a Claude Code
 * session; "Copy resume command" puts `t3cc <threadId>` on the clipboard.
 */
(() => {
  if (window.__t3ClaudeSync) return;
  const LOG = (...a) => console.debug("[claude-sync]", ...a);
  const STORE = "t3-claude-sync:v1";
  const AUTO_INTERVAL_MS = 2 * 60 * 1000;

  // ---------- RPC over the app's own socket ----------
  const NativeWS = window.WebSocket;
  let rpcSocket = null;
  const pending = new Map(); // requestId -> {resolve, reject, timer}
  let nextId = 9_007_000_000_000;

  function ourIdsIn(data) {
    if (typeof data !== "string" || !data.includes("requestId")) return null;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return null; }
    const msgs = Array.isArray(parsed) ? parsed : [parsed];
    const ours = msgs.filter((m) => m && pending.has(String(m.requestId)));
    return ours.length ? { ours, all: msgs.length === ours.length } : null;
  }

  function settle(msg) {
    const id = String(msg.requestId);
    const p = pending.get(id);
    if (!p) return;
    if (msg._tag === "Exit") {
      pending.delete(id);
      clearTimeout(p.timer);
      const exit = msg.exit || {};
      if (exit._tag === "Success") p.resolve(exit.value);
      else p.reject(new Error(describeCause(exit.cause) || "Request failed"));
    } else if (msg._tag === "Defect") {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(String(msg.defect?.message || msg.defect || "Server defect")));
    }
  }

  function describeCause(cause) {
    const parts = Array.isArray(cause) ? cause : cause ? [cause] : [];
    for (const c of parts) {
      const e = c?.error ?? c?.defect ?? c;
      if (e?.message) return e.message;
      if (e?._tag) return e._tag;
    }
    return "";
  }

  function watch(ws, url) {
    let isLocal = false;
    try {
      const u = new URL(url, location.href);
      isLocal = u.pathname === "/ws" && !u.searchParams.has("device") && !u.searchParams.has("threadId");
    } catch {}
    if (!isLocal) return;
    ws.addEventListener("message", (ev) => {
      const hit = ourIdsIn(ev.data);
      if (!hit) return;
      hit.ours.forEach(settle);
      if (hit.all) ev.stopImmediatePropagation();
    });
    const send = ws.send;
    ws.send = function (data) {
      if (rpcSocket !== ws && typeof data === "string" && data.includes('"_tag":"Request"')) {
        rpcSocket = ws;
        LOG("attached to RPC socket");
        render();
      }
      return send.apply(this, arguments);
    };
    ws.addEventListener("close", () => {
      if (rpcSocket === ws) rpcSocket = null;
      render();
    });
  }

  function PatchedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    try { watch(ws, String(url)); } catch (e) { LOG(e); }
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) PatchedWS[k] = NativeWS[k];
  window.WebSocket = PatchedWS;

  function rpc(tag, payload, timeoutMs = 5 * 60 * 1000) {
    const ws = rpcSocket;
    if (!ws || ws.readyState !== NativeWS.OPEN) return Promise.reject(new Error("Not connected to the T3 server yet"));
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tag} timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  // ---------- sync ----------
  const state = load();
  let running = false;
  let lastError = null;

  function load() {
    try { return { auto: true, lastSyncAt: null, lastImported: 0, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; }
    catch { return { auto: true, lastSyncAt: null, lastImported: 0 }; }
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }

  async function syncNow({ quiet = false } = {}) {
    if (running) return;
    running = true; lastError = null; render();
    try {
      const scan = await rpc("agentSessions.scan", {});
      const targets = (scan?.candidates || []).filter(
        (c) => c.projectId && Array.isArray(c.sources) && c.sources.includes("claudeAgent"),
      );
      let imported = 0, skipped = 0, failed = 0;
      for (const c of targets) {
        try {
          const r = await rpc("agentSessions.import", { projectId: c.projectId, expectedWorkspaceRoot: c.path });
          imported += r?.importedCount || 0;
          skipped += r?.skippedCount || 0;
        } catch (e) { failed += 1; LOG("import failed", c.path, e); }
      }
      state.lastSyncAt = new Date().toISOString();
      state.lastImported = imported;
      save();
      if (!quiet || imported > 0) {
        toast(imported > 0 ? `Synced ${imported} new Claude Code chat${imported === 1 ? "" : "s"}` : "Claude Code chats are up to date");
      }
      if (failed) toast(`${failed} project${failed === 1 ? "" : "s"} could not be synced. See the console.`);
    } catch (e) {
      lastError = e.message || String(e);
      if (!quiet) toast(`Sync failed: ${lastError}`);
    } finally {
      running = false; render();
    }
  }

  function currentThreadId() {
    const raw = (location.hash.startsWith("#/") ? location.hash.slice(1) : location.pathname).split("?")[0];
    const seg = raw.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    if (seg[0] === "threads" && seg.length >= 3) return seg[2];
    if (seg.length === 2 && !["settings", "projects", "welcome"].includes(seg[0])) return seg[1];
    return null;
  }

  async function copyResume() {
    const id = currentThreadId();
    if (!id) return toast("Open a thread first");
    const cmd = `t3cc '${id.replace(/'/g, "'\\''")}'`;
    try { await navigator.clipboard.writeText(cmd); toast("Copied. Paste in a terminal to open in Claude Code"); }
    catch { prompt("Run this in a terminal:", cmd); }
  }

  // ---------- UI: one small icon next to "New thread" in the sidebar header ----------
  const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`;
  const css = `
  #t3cc-sync svg{width:16px;height:16px;flex-shrink:0;color:var(--sidebar-icon-color,currentColor)}
  #t3cc-sync[data-running] svg{animation:t3cc-spin .9s linear infinite}
  #t3cc-sync[data-state=error] svg{color:#ef4444}
  #t3cc-sync[data-state=offline]{opacity:.45}
  @keyframes t3cc-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){#t3cc-sync[data-running] svg{animation-duration:2.5s}}
  #t3cc-toast{position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:300px;padding:7px 10px;border-radius:8px;
    font:12px/1.4 system-ui,sans-serif;color:#f5f5f5;background:#1f1f23;border:1px solid #3a3a40;box-shadow:0 6px 20px rgba(0,0,0,.3);
    opacity:0;transform:translateY(4px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}
  #t3cc-toast.show{opacity:1;transform:none}`;

  let btn = null, toastEl = null, toastTimer = 0;

  function toast(text) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.id = "t3cc-toast"; toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl); }
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  function ago(iso) {
    if (!iso) return "never";
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  function render() {
    if (!btn) return;
    const connected = !!rpcSocket;
    running ? btn.setAttribute("data-running", "") : btn.removeAttribute("data-running");
    btn.dataset.state = lastError ? "error" : connected ? "ok" : "offline";
    const status = lastError ? `Last sync failed: ${lastError}` : !connected ? "Connecting…" : running ? "Syncing…" : `Last synced ${ago(state.lastSyncAt)}`;
    const label = `Sync Claude Code chats (${status}). Option-click: copy command to open this thread in the Claude Code CLI`;
    btn.title = label;
    btn.setAttribute("aria-label", "Sync Claude Code chats");
  }

  function findNewThreadButton() {
    const side = document.querySelector('[data-slot="sidebar"]') || document;
    return side.querySelector('button[aria-label^="New thread"]');
  }

  function mount() {
    const anchor = findNewThreadButton();
    if (!anchor) return;
    if (btn && btn.isConnected && btn.nextElementSibling === anchor) return;
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "t3cc-sync";
      btn.type = "button";
      btn.innerHTML = ICON;
      btn.addEventListener("click", (e) => (e.altKey ? copyResume() : syncNow()));
    }
    btn.className = anchor.className; // same size, hover and focus styles as the app's own icon buttons
    anchor.parentElement.insertBefore(btn, anchor);
    render();
  }

  function boot() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; mount(); }); } })
      .observe(document.body, { childList: true, subtree: true });
    mount();
    setInterval(() => { render(); if (state.auto && rpcSocket && document.visibilityState === "visible") syncNow({ quiet: true }); }, AUTO_INTERVAL_MS);
    window.addEventListener("focus", () => { if (state.auto && rpcSocket) syncNow({ quiet: true }); });
    const first = setInterval(() => { if (rpcSocket) { clearInterval(first); if (state.auto) setTimeout(() => syncNow({ quiet: true }), 4000); } }, 1000);
  }

  window.__t3ClaudeSync = { syncNow, rpc, currentThreadId };
  if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
