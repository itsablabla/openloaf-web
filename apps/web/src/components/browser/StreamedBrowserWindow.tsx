/**
 * Copyright (c) OpenLoaf. All rights reserved.
 *
 * This source code is licensed under the AGPLv3 license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Web-mode embedded-browser component.
 *
 * The Electron build embeds arbitrary URLs via WebContentsView. Browsers
 * refuse to <iframe> most real apps (X-Frame-Options, frame-ancestors), so
 * in web mode we render a JPEG screencast from a server-side Chromium and
 * pipe every input event back over the same WebSocket.
 *
 * All state stays in the streaming service; this component is a canvas.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@openloaf/ui/button";
import { ArrowLeft, ArrowRight, Home, RotateCw } from "lucide-react";

type Props = {
  /** Panel key from the layout system. Doubles as the session key. */
  panelKey?: string;
  /** Optional pinned tab id */
  tabId?: string;
  /** Tabs list — we honor the active one's URL as initialUrl */
  browserTabs?: Array<{ id: string; url?: string; title?: string }>;
  activeBrowserTabId?: string;
  className?: string;
  /** Explicit override */
  sessionKey?: string;
  initialUrl?: string;
};

/** Build the ws:// or wss:// URL the same origin serves the frontend on. */
function wsUrl(sessionKey: string): string {
  const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = typeof window !== "undefined" ? window.location.host : "localhost";
  return `${proto}//${host}/ws/browser?session=${encodeURIComponent(sessionKey)}`;
}

export function StreamedBrowserWindow(props: Props) {
  const sessionKey =
    props.sessionKey ?? [props.panelKey, props.activeBrowserTabId ?? props.tabId ?? "main"].filter(Boolean).join(":");
  const activeTab = props.browserTabs?.find((t) => t.id === props.activeBrowserTabId) ?? props.browserTabs?.[0];
  const initialUrl = props.initialUrl ?? activeTab?.url;
  const { className } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [title, setTitle] = useState("");

  // Persistent decode target — one Image reused for every frame is much
  // cheaper than createImageBitmap + revokeObjectURL per frame.
  useEffect(() => {
    imgRef.current = new Image();
  }, []);

  // Establish and manage the WS
  useEffect(() => {
    const ws = new WebSocket(wsUrl(sessionKey));
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus("open");
      if (initialUrl) ws.send(JSON.stringify({ type: "open", url: initialUrl }));
    };
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("error");
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "frame") {
        drawFrame(msg.data, msg.w, msg.h);
      } else if (msg.type === "navigation") {
        setUrl(msg.url || "");
        setTitle(msg.title || "");
      }
    };
    return () => { try { ws.close(); } catch {} };
  }, [sessionKey, initialUrl]);

  const drawFrame = useCallback((b64: string, w: number, h: number) => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    img.onload = () => {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(img, 0, 0, w, h);
    };
    img.src = `data:image/jpeg;base64,${b64}`;
  }, []);

  // Map DOM events to the wire protocol handled by services/browser-stream
  const send = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  }, []);

  const localToRemote = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }, []);

  // Focus tracking so we can attach keyboard listeners while the canvas has focus
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      send({
        type: "input",
        event: e.type,
        key: e.key,
        code: e.code,
        text: e.key.length === 1 ? e.key : undefined,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [focused, send]);

  const navigate = (u: string) => send({ type: "navigate", url: normalizeInput(u) });

  return (
    <div className={cn("flex flex-col h-full w-full bg-neutral-50", className)}>
      {/* Nav bar */}
      <div className="flex items-center gap-1 border-b px-2 py-1 bg-white">
        <Button size="icon" variant="ghost" onClick={() => send({ type: "back" })} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => send({ type: "forward" })} aria-label="Forward">
          <ArrowRight className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => send({ type: "reload" })} aria-label="Reload">
          <RotateCw className="size-4" />
        </Button>
        <form
          className="flex-1"
          onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem("url") as HTMLInputElement).value; navigate(v); }}
        >
          <input
            name="url"
            defaultValue={url}
            key={url}
            className="w-full rounded-md border px-2 py-1 text-sm outline-none focus:ring-1"
            placeholder="Enter a URL and press Enter"
          />
        </form>
        <span className="text-xs text-neutral-500 mx-2">
          {status === "connecting" ? "Connecting…" : status === "open" ? "Live" : status === "closed" ? "Disconnected" : "Error"}
        </span>
      </div>

      {/* Streamed canvas */}
      <div className="flex-1 relative bg-neutral-900">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full outline-none cursor-crosshair"
          tabIndex={0}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onMouseDown={(e) => { const p = localToRemote(e); send({ type: "input", event: "mousedown", ...p, button: e.button }); }}
          onMouseUp={(e) => { const p = localToRemote(e); send({ type: "input", event: "mouseup", ...p, button: e.button }); }}
          onMouseMove={(e) => { const p = localToRemote(e); send({ type: "input", event: "mousemove", ...p }); }}
          onWheel={(e) => { send({ type: "input", event: "wheel", deltaX: e.deltaX, deltaY: e.deltaY }); }}
          onContextMenu={(e) => e.preventDefault()}
        />
        {status !== "open" && (
          <div className="absolute inset-0 grid place-items-center text-neutral-300 text-sm select-none pointer-events-none">
            {status === "connecting" ? "Starting a browser session…" : "Disconnected — reload the tab to reconnect."}
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeInput(v: string): string {
  const t = v.trim();
  if (!t) return "about:blank";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.includes(".") && !t.includes(" ")) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export default StreamedBrowserWindow;
