/**
 * Copyright (c) OpenLoaf. All rights reserved.
 *
 * Web-mode shim for `window.openloafElectron`.
 *
 * The Electron preload script exposes a handful of native-only helpers on
 * `window.openloafElectron`. The renderer is already defensively coded
 * against missing methods (`api?.foo?.(...)`), but a few call sites assume
 * the return value follows a specific shape. This shim provides safe
 * browser-friendly fallbacks so nothing crashes when we run under a real
 * browser at loaf.garzalabs.com.
 *
 * Only install when running outside Electron.
 */

// The shim's shape mirrors window.openloafElectron loosely — the renderer
// already treats every call as optional (`api?.foo?.()`) so we don't need to
// match the desktop preload signatures exactly. Using `any` keeps the callsite
// types happy without pulling in the whole electron.d.ts.
type Shim = Record<string, any>;

export function installWebModeShim(): void {
  if (typeof window === "undefined") return;
  if ((window as any).openloafElectron) return; // real preload wins

  const shim: Shim = {
    // --- URLs / navigation ------------------------------------------------
    openExternal: async (url: string) => {
      try { window.open(url, "_blank", "noopener,noreferrer"); return true; }
      catch { return false; }
    },
    openPath: async (path: string) => {
      // In the browser we can't reveal a filesystem path. Best effort: if the
      // path came in as an http(s) URL, open it; otherwise fail quietly.
      if (typeof path === "string" && /^https?:\/\//.test(path)) window.open(path, "_blank");
      return { success: false, reason: "web-mode" };
    },

    // --- Files ------------------------------------------------------------
    getPathForFile: async (file: File | Blob) => {
      // Electron returns an absolute path; browsers only have a File name.
      return (file as File)?.name ?? "";
    },
    saveFile: async (data: ArrayBuffer | Uint8Array | string, filename?: string) => {
      const blob = data instanceof Blob
        ? data
        : new Blob([typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer)]);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      return { path: a.download, ok: true };
    },
    trashItem: async () => ({ ok: false, reason: "web-mode" }),
    startTransfer: async () => ({ ok: false, reason: "web-mode" }),

    // --- Locale / theme ---------------------------------------------------
    getSystemLocale: () => (typeof navigator !== "undefined" ? navigator.language : "en"),

    // --- Web meta / previews ---------------------------------------------
    fetchWebMeta: async (url: string) => {
      // Route through the server, which has an unfurl endpoint (or we add one).
      try {
        const r = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`);
        if (!r.ok) throw new Error(`unfurl ${r.status}`);
        return await r.json();
      } catch {
        return { title: url, description: "", image: "" };
      }
    },

    // --- Speech ----------------------------------------------------------
    startSpeechRecognition: async (opts: Record<string, unknown>) => {
      const SR: typeof SpeechRecognition | undefined =
        (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
      if (!SR) return { supported: false };
      const rec = new SR();
      rec.continuous = !!(opts as any)?.continuous;
      rec.interimResults = true;
      rec.lang = (opts as any)?.lang || navigator.language || "en-US";
      (window as any).__openloafSR = rec;
      rec.start();
      return { supported: true };
    },
    stopSpeechRecognition: async () => {
      const rec = (window as any).__openloafSR as SpeechRecognition | undefined;
      try { rec?.stop(); } catch {}
      delete (window as any).__openloafSR;
      return { ok: true };
    },

    // --- App lifecycle ---------------------------------------------------
    relaunchApp: async () => { location.reload(); },
    restartServer: async () => ({ ok: false, reason: "server-managed" }),
  };

  Object.defineProperty(window, "openloafElectron", { value: shim, writable: false });
}
