/**
 * NomadVNC viewer bootstrap.
 *
 * Loaded as an EXTERNAL module script (see `createViewerHtml`) instead of an
 * inline `<script>` block. The Electron renderer's Content-Security-Policy
 * deliberately omits `'unsafe-inline'` and also applies to `srcdoc` iframes,
 * so an inline bootstrap would be refused and the viewer would stall at
 * "Connecting" forever. Per-session settings (WebSocket URL, credentials, …)
 * are read from the `#viewer-config` JSON block in the host document, and
 * the noVNC module is imported dynamically from `config.bootstrapModuleUrl`.
 */
const configEl = document.getElementById("viewer-config");
const config = JSON.parse(configEl && configEl.textContent ? configEl.textContent : "{}");
const { default: RFB } = await import(config.bootstrapModuleUrl);
// Touch gestures + text entry (input.mjs). Optional: without it, noVNC's
// built-in touch handling applies and `typeText` is unavailable.
let input = null;
if (config.inputModuleUrl) {
  try {
    input = await import(config.inputModuleUrl);
  } catch (error) {
    console.warn("NomadVNC: input module failed to load", error);
  }
}
const status = document.getElementById("status");
const viewer = document.getElementById("viewer");
function buildInitialCredentials(cfg) {
  const out = {};
  if (cfg.password) {
    out.password = cfg.password;
  }
  const u = typeof cfg.username === "string" ? cfg.username.trim() : "";
  if (u) {
    out.username = u;
  }
  return Object.keys(out).length ? out : undefined;
}
let lastCredentials = buildInitialCredentials(config) || {};
const rfb = new RFB(
  viewer,
  config.wsUrl,
  Object.keys(lastCredentials).length ? { credentials: { ...lastCredentials } } : undefined
);

/* ----- Initial configuration ----- */
// The viewer owns scaling and clipping (see "View" below): noVNC's own
// scaleViewport/clipViewport stay off, and its rescale hook — run after
// every container or remote-desktop resize — re-applies our view instead.
rfb._updateScale = () => applyView();
rfb.scaleViewport = false;
rfb.clipViewport = false;
rfb._screen.style.overflow = "hidden";
rfb.resizeSession = config.resizeSession ?? false;
rfb.showDotCursor = true;
rfb.background = getComputedStyle(document.documentElement)
  .getPropertyValue("--viewer-background").trim() || "#080C12";

/* ----- Status display with auto-hide ----- */
let statusTimer = null;
const setStatus = (message, autoHide = false) => {
  if (status) {
    status.textContent = message;
    status.classList.remove("hidden");
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (autoHide) {
      statusTimer = setTimeout(() => status.classList.add("hidden"), 2000);
    }
  }
};

/* ----- RFB events ----- */
rfb.addEventListener("connect", () => {
  setStatus("Connected", true);
  notifyParent({ type: "viewerState", state: "connected" });
  startLinkMonitor();
});

/* ----- Link health ----- */
// A socket can stay "open" long after the far end is gone (phone slept,
// network changed, host froze). The monitor probes after quiet spells and
// reports slow/stalled; when nothing answers for long enough it closes
// the connection so the app's reconnect runs. Lives in input.mjs, so it
// is off when that module failed to load.
let stalledOut = false;
let linkMonitor = null;
let linkTimer = null;
// noVNC opens its WebSocket in the constructor; a second listener sees
// every incoming message without touching noVNC's own handler.
const rawSocket = rfb._sock && rfb._sock._websocket;
if (rawSocket && typeof rawSocket.addEventListener === "function") {
  rawSocket.addEventListener("message", () => linkMonitor?.received());
}

function sendLinkProbe() {
  if (rfb._rfbConnectionState !== "connected" || !(rfb._fbWidth > 0)) return;
  RFB.messages.fbUpdateRequest(rfb._sock, false, 0, 0, 1, 1);
}

function sendLinkRefresh() {
  if (rfb._rfbConnectionState !== "connected" || !(rfb._fbWidth > 0)) return;
  RFB.messages.fbUpdateRequest(rfb._sock, false, 0, 0, rfb._fbWidth, rfb._fbHeight);
}

function startLinkMonitor() {
  if (!input || typeof input.createLinkMonitor !== "function" || linkMonitor) return;
  linkMonitor = input.createLinkMonitor({
    sendProbe: sendLinkProbe,
    sendRefresh: sendLinkRefresh,
    onHealth(health) {
      if (health.state === "stalled") {
        setStatus("Not responding", false);
      } else if (status && status.textContent === "Not responding") {
        setStatus("Connected", true);
      }
      notifyParent({ type: "viewerHealth", ...health });
    },
    onDead() {
      stalledOut = true;
      rfb.disconnect();
    },
  });
  linkTimer = setInterval(() => linkMonitor?.tick(), 1000);
}

function stopLinkMonitor() {
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = null;
  linkMonitor = null;
}

// A rejected password ends the connection with a security failure followed
// by a disconnect. Report it once as authFailed and swallow that disconnect,
// so the parent prompts for a new password instead of retrying a bad one.
let authFailed = false;
rfb.addEventListener("securityfailure", (event) => {
  authFailed = true;
  setStatus("Wrong password", false);
  notifyParent({ type: "viewerState", state: "authFailed", reason: event.detail?.reason || undefined });
});

rfb.addEventListener("disconnect", (event) => {
  stopLinkMonitor();
  if (authFailed) return;
  if (stalledOut) {
    setStatus("Not responding", false);
    notifyParent({ type: "viewerState", state: "disconnected", reason: "stalled" });
    return;
  }
  const clean = event.detail?.clean ? "Disconnected" : "Connection lost";
  setStatus(clean, false);
  notifyParent({ type: "viewerState", state: "disconnected" });
});

rfb.addEventListener("credentialsrequired", () => {
  setStatus("Credentials required");
  notifyParent({ type: "viewerState", state: "credentialsRequired" });
});

rfb.addEventListener("clipboard", (event) => {
  notifyParent({ type: "viewerClipboard", text: event.detail?.text ?? "" });
});


/* ----- Relay resize to parent when viewer container changes ----- */
const resizeObserver = new ResizeObserver((entries) => {
  if (!rfb._display) return;

  applyView();

  // If auto-resize is on, sync the remote desktop resolution to the container
  if (rfb.resizeSession) {
    const entry = entries[0];
    if (entry) {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0 && RFB.messages && RFB.messages.setDesktopSize) {
        // Throttle resolution requests slightly if needed, but for fullscreen 
        // we want it immediate to avoid clipping
        RFB.messages.setDesktopSize(
          rfb._sock,
          Math.floor(width),
          Math.floor(height),
          rfb._screenID || 0,
          rfb._screenFlags || 0
        );
      }
    }
  }
});
resizeObserver.observe(viewer);

const stickyKeys = new Set();

/* ----- Parent → Viewer command channel ----- */
window.addEventListener("message", (event) => {
  // Commands come from the embedding app only: the parent frame (desktop
  // iframe) or a synthetic same-document event (mobile WebView injection,
  // source === null). Never from other windows.
  if (event.source !== null && event.source !== window.parent) return;
  const cmd = event.data;
  if (!cmd || typeof cmd.type !== "string") return;

  switch (cmd.type) {
    case "sendKeys":
      if (Array.isArray(cmd.keysyms)) {
        for (const ksym of cmd.keysyms) {
          rfb.sendKey(ksym, undefined, true);  // press
          rfb.sendKey(ksym, undefined, false);  // release
        }
      }
      break;

    case "sendKeyCombo":
      if (Array.isArray(cmd.modifiers) && typeof cmd.key === "number") {
        for (const mod of cmd.modifiers) {
          rfb.sendKey(mod, undefined, true);
        }
        rfb.sendKey(cmd.key, undefined, true);
        rfb.sendKey(cmd.key, undefined, false);
        for (const mod of [...cmd.modifiers].reverse()) {
          rfb.sendKey(mod, undefined, false);
        }
      }
      break;

    case "setKeyStates":
      if (Array.isArray(cmd.keys)) {
        for (const entry of cmd.keys) {
          if (entry.down) {
            stickyKeys.add(entry.keysym);
          } else {
            stickyKeys.delete(entry.keysym);
          }
          rfb.sendKey(entry.keysym, undefined, entry.down);
        }
      }
      break;

    case "setResizeSession":
      if (typeof cmd.enabled === "boolean") {
        rfb.resizeSession = cmd.enabled;
      }
      break;

    case "setResolution":
      if (typeof cmd.width === "number" && typeof cmd.height === "number") {
        // noVNC requests a resize by calling messages.setDesktopSize
        // We use the internal properties because the high-level API is missing in this version
        if (RFB.messages && RFB.messages.setDesktopSize) {
          RFB.messages.setDesktopSize(
            rfb._sock,
            cmd.width,
            cmd.height,
            rfb._screenID || 0,
            rfb._screenFlags || 0
          );
        }
      }
      break;

    case "setScaleMode":
      if (cmd.mode === "fit" || cmd.mode === "actual" || cmd.mode === "zoom") {
        view.scaleMode = cmd.mode;
        if (cmd.mode === "zoom" && typeof cmd.zoomLevel === "number" && cmd.zoomLevel > 0) {
          view.zoomLevel = Math.min(8, Math.max(0.1, cmd.zoomLevel));
        }
        view.region = "full";
        resetTouchView();
        applyView();
      }
      break;

    case "setDisplayRegion":
      // Zoom to one half of the framebuffer (multi-monitor hosts).
      if (["full", "left", "right", "top", "bottom"].includes(cmd.region)) {
        view.region = cmd.region;
        resetTouchView();
        applyView();
      }
      break;

    case "resetView":
      resetTouchView();
      applyView();
      break;

    case "queryConnection": {
      // Used when the phone app returns from the background. A still-open
      // socket stays up; a dead one is reported so the app can reconnect
      // without leaving the session. `refresh` asks the server for a full
      // frame, because updates can be missed while the WebView was frozen.
      let live = rfb._rfbConnectionState === "connected"
        && !!rfb._sock
        && rfb._sock.readyState === "open";
      if (live && cmd.refresh && RFB.messages && typeof RFB.messages.fbUpdateRequest === "function"
          && rfb._fbWidth > 0 && rfb._fbHeight > 0) {
        try {
          RFB.messages.fbUpdateRequest(rfb._sock, false, 0, 0, rfb._fbWidth, rfb._fbHeight);
        } catch {
          live = false;
        }
      }
      // "Open" can be a half-open socket after sleep or a network change.
      // Time a probe; the link monitor drops the session if nothing answers.
      if (live) linkMonitor?.probe();
      notifyParent({ type: "viewerAlive", live });
      break;
    }

    case "setPointerMode":
      if (touchController && (cmd.mode === "touch" || cmd.mode === "trackpad")) {
        touchController.setMode(cmd.mode);
        if (cmd.mode === "trackpad") {
          placePointerIfNeeded();
          showPointer();
        }
      }
      break;

    case "typeText":
      if (input && typeof cmd.text === "string") {
        for (const keysym of input.keysymsForText(cmd.text)) {
          rfb.sendKey(keysym, undefined, true);
          rfb.sendKey(keysym, undefined, false);
        }
      }
      break;

    case "setQuality":
      if (typeof cmd.quality === "number") {
        rfb.qualityLevel = Math.max(0, Math.min(9, cmd.quality));
        rfb.compressionLevel = cmd.quality >= 7 ? 0 : (9 - cmd.quality);
      }
      break;

    case "clipboardPaste":
      if (typeof cmd.text === "string") {
        rfb.clipboardPasteFrom(cmd.text);
      }
      break;

    case "clipboardRequest":
      // noVNC fires clipboard events automatically — this is a no-op prompt
      break;

    case "focus":
      rfb.focus();
      break;

    case "sendCredentials":
      lastCredentials = { ...lastCredentials };
      if (typeof cmd.username === "string") {
        const t = cmd.username.trim();
        if (t) {
          lastCredentials.username = t;
        } else {
          delete lastCredentials.username;
        }
      }
      if (typeof cmd.password === "string" && cmd.password) {
        lastCredentials.password = cmd.password;
      }
      rfb.sendCredentials(lastCredentials);
      break;
  }
});

/* ----- Hardware Keyboard Sync Guard ----- */
// We listen for hardware keydown to re-assert our sticky modifiers.
// This prevents noVNC from clearing them when physical mods are up.
window.addEventListener("keydown", (e) => {
  if (stickyKeys.size > 0) {
    stickyKeys.forEach((ksym) => {
      rfb.sendKey(ksym, undefined, true);
    });
  }
  noteViewerInput();
}, { capture: true });

/* ----- Input-activity tracking for adaptive quality ----- */
// The parent lowers JPEG quality on slow links while the user is
// interacting, then sharpens the static image once input stops.
// viewerActive is throttled; viewerIdle fires once per idle window.
let idleTimer = null;
let lastActiveSent = 0;
function noteViewerInput() {
  const now = Date.now();
  if (now - lastActiveSent > 2000) {
    lastActiveSent = now;
    notifyParent({ type: "viewerActive" });
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  idleTimer = setTimeout(() => notifyParent({ type: "viewerIdle" }), 1500);
}
window.addEventListener("pointerdown", noteViewerInput, { capture: true });
window.addEventListener("pointermove", noteViewerInput, { capture: true });
window.addEventListener("wheel", noteViewerInput, { capture: true });

/* ----- View: scale mode, display region, pinch-zoom and panning ----- */
// Implemented with noVNC's own display viewport (scale + clipped viewport),
// not CSS transforms, so mouse and touch coordinates stay exact at every
// zoom level. When the view is larger than the window it is clipped and
// pans (touch drag, pinch, or the mouse at the window edge).
const MAX_PINCH_ZOOM = 8; // relative to the fitted size
const view = {
  scaleMode: config.fitToScreen === false ? "actual" : "fit",
  zoomLevel: 1,
  region: "full",
  /** Pinch-zoom on top of the scale mode (1 = none). */
  touchZoom: 1,
  /** Viewport origin in framebuffer pixels (fractional while panning). */
  x: 0,
  y: 0,
  /** The user has panned or zoomed: keep their position across re-layouts. */
  anchored: false,
  reportedZoom: 1,
  /** Last framebuffer size reported to the app. */
  fbWidth: 0,
  fbHeight: 0,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function regionRect(region, fbW, fbH) {
  if (region === "left") return { x: 0, y: 0, w: fbW / 2, h: fbH };
  if (region === "right") return { x: fbW / 2, y: 0, w: fbW - fbW / 2, h: fbH };
  if (region === "top") return { x: 0, y: 0, w: fbW, h: fbH / 2 };
  if (region === "bottom") return { x: 0, y: fbH / 2, w: fbW, h: fbH - fbH / 2 };
  return null;
}

/** Scale for the selected mode (before pinch-zoom) and where it starts. */
function baseLayout(fbW, fbH, cw, ch) {
  const fit = Math.min(cw / fbW, ch / fbH);
  const rect = regionRect(view.region, fbW, fbH);
  if (rect) {
    return { fit, base: clamp(Math.min(cw / rect.w, ch / rect.h), 0.25, 4), origin: rect };
  }
  if (view.scaleMode === "actual") return { fit, base: 1, origin: null };
  if (view.scaleMode === "zoom") return { fit, base: view.zoomLevel, origin: null };
  return { fit, base: fit, origin: null };
}

function resetTouchView() {
  view.touchZoom = 1;
  view.anchored = false;
}

function applyView() {
  const d = rfb._display;
  if (!d) return;
  const fbW = d.width;
  const fbH = d.height;
  // noVNC has no "desktop size changed" event; this hook runs after every
  // framebuffer resize, so report remote resolution changes from here.
  if (fbW && fbH && (fbW !== view.fbWidth || fbH !== view.fbHeight)) {
    view.fbWidth = fbW;
    view.fbHeight = fbH;
    notifyParent({ type: "viewerResize", width: fbW, height: fbH });
  }
  const cw = viewer.clientWidth;
  const ch = viewer.clientHeight;
  if (!fbW || !fbH || !cw || !ch) return;
  const { base, origin } = baseLayout(fbW, fbH, cw, ch);
  const scale = base * view.touchZoom;
  // The epsilon absorbs float error (fit: cw / (cw / fbW) = 1599.9999…).
  const vw = Math.min(fbW, Math.floor(cw / scale + 1e-6));
  const vh = Math.min(fbH, Math.floor(ch / scale + 1e-6));
  const clip = vw < fbW || vh < fbH;
  if (d.clipViewport !== clip) d.clipViewport = clip;
  if (clip) d.viewportChangeSize(vw, vh);
  d.scale = scale;
  if (clip) {
    if (!view.anchored) {
      view.x = origin ? origin.x : 0;
      view.y = origin ? origin.y : 0;
    }
    applyViewportPos();
  } else {
    view.x = 0;
    view.y = 0;
  }
  if (Math.abs(view.touchZoom - view.reportedZoom) > 0.01) {
    view.reportedZoom = view.touchZoom;
    notifyParent({ type: "viewerZoom", level: Math.round(view.touchZoom * 100) / 100 });
  }
  showPointer();
}

/** Moves the clipped viewport to `view.x/y` (clamped). */
function applyViewportPos() {
  const d = rfb._display;
  if (!d || !d.clipViewport) return;
  const vp = d._viewportLoc;
  view.x = clamp(view.x, 0, Math.max(0, d.width - vp.w));
  view.y = clamp(view.y, 0, Math.max(0, d.height - vp.h));
  d.viewportChangePos(Math.round(view.x) - vp.x, Math.round(view.y) - vp.y);
}

function isViewClipped() {
  return Boolean(rfb._display && rfb._display.clipViewport);
}

/** Moves the view's content by client pixels (finger direction). */
function panBy(dx, dy) {
  const d = rfb._display;
  if (!d || !d.clipViewport) return;
  const s = d.scale || 1;
  view.x -= dx / s;
  view.y -= dy / s;
  view.anchored = true;
  applyViewportPos();
  showPointer();
}

/** Pinch-zoom by `factor`, keeping the framebuffer point under (cx, cy) in place. */
function zoomAt(factor, cx, cy) {
  const d = rfb._display;
  if (!d || !d.width || !d.height) return;
  const cw = viewer.clientWidth;
  const ch = viewer.clientHeight;
  if (!cw || !ch) return;
  const { fit, base } = baseLayout(d.width, d.height, cw, ch);
  const before = rfb._canvas.getBoundingClientRect();
  const oldScale = d.scale || 1;
  const fx = d._viewportLoc.x + (cx - before.left) / oldScale;
  const fy = d._viewportLoc.y + (cy - before.top) / oldScale;
  const minZoom = Math.min(1, fit / base);
  const maxZoom = Math.max(1, (fit * MAX_PINCH_ZOOM) / base);
  view.touchZoom = clamp(view.touchZoom * factor, minZoom, maxZoom);
  view.anchored = true;
  applyView();
  const after = rfb._canvas.getBoundingClientRect();
  const newScale = d.scale || 1;
  view.x = fx - (cx - after.left) / newScale;
  view.y = fy - (cy - after.top) / newScale;
  applyViewportPos();
  showPointer();
}

/* ----- Remote pointer (touch input) ----- */
// Touch gestures drive the remote pointer directly in framebuffer
// coordinates; real mice keep using noVNC's own handling.
const pointer = { x: 0, y: 0, buttons: 0, placed: false };
const BUTTON_MASKS = [1, 2, 4]; // left, middle, right

function clientToFramebuffer(x, y) {
  const d = rfb._display;
  const r = rfb._canvas.getBoundingClientRect();
  const s = d.scale || 1;
  return {
    x: clamp(d._viewportLoc.x + (x - r.left) / s, 0, Math.max(0, d.width - 1)),
    y: clamp(d._viewportLoc.y + (y - r.top) / s, 0, Math.max(0, d.height - 1)),
  };
}

function placePointerIfNeeded() {
  const d = rfb._display;
  if (pointer.placed || !d || !d.width) return;
  const vp = d._viewportLoc;
  pointer.x = vp.x + vp.w / 2;
  pointer.y = vp.y + vp.h / 2;
  pointer.placed = true;
}

function sendPointer() {
  if (rfb._rfbConnectionState !== "connected" || rfb.viewOnly) return;
  RFB.messages.pointerEvent(rfb._sock, Math.round(pointer.x), Math.round(pointer.y), pointer.buttons);
}

/** Draws noVNC's touch cursor where the remote pointer is. */
function showPointer() {
  const d = rfb._display;
  if (!pointer.placed || !d || !rfb._cursor) return;
  const r = rfb._canvas.getBoundingClientRect();
  const s = d.scale || 1;
  rfb._cursor.move(
    r.left + (pointer.x - d._viewportLoc.x) * s,
    r.top + (pointer.y - d._viewportLoc.y) * s,
  );
}

/** Trackpad mode: keep the pointer inside the visible part of a zoomed view. */
function followPointer() {
  const d = rfb._display;
  if (!d || !d.clipViewport) return;
  const vp = d._viewportLoc;
  const margin = Math.min(vp.w, vp.h) * 0.08;
  if (pointer.x < view.x + margin) view.x = pointer.x - margin;
  else if (pointer.x > view.x + vp.w - margin) view.x = pointer.x - vp.w + margin;
  if (pointer.y < view.y + margin) view.y = pointer.y - margin;
  else if (pointer.y > view.y + vp.h - margin) view.y = pointer.y - vp.h + margin;
  view.anchored = true;
  applyViewportPos();
}

let touchController = null;
if (input) {
  touchController = input.createTouchController({
    mode: config.pointerMode,
    actions: {
      pointTo(x, y) {
        const p = clientToFramebuffer(x, y);
        pointer.x = p.x;
        pointer.y = p.y;
        pointer.placed = true;
        sendPointer();
        showPointer();
      },
      moveBy(dx, dy) {
        const d = rfb._display;
        if (!d || !d.width) return;
        placePointerIfNeeded();
        const s = d.scale || 1;
        pointer.x = clamp(pointer.x + dx / s, 0, d.width - 1);
        pointer.y = clamp(pointer.y + dy / s, 0, d.height - 1);
        followPointer();
        sendPointer();
        showPointer();
      },
      button(button, down) {
        placePointerIfNeeded();
        const mask = BUTTON_MASKS[button] ?? 1;
        pointer.buttons = down ? pointer.buttons | mask : pointer.buttons & ~mask;
        sendPointer();
      },
      scroll(stepsX, stepsY) {
        placePointerIfNeeded();
        const wheel = (mask, count) => {
          for (let i = 0; i < count; i += 1) {
            pointer.buttons |= mask;
            sendPointer();
            pointer.buttons &= ~mask;
            sendPointer();
          }
        };
        wheel(stepsY > 0 ? 16 : 8, Math.abs(stepsY));
        wheel(stepsX > 0 ? 64 : 32, Math.abs(stepsX));
      },
      zoom: zoomAt,
      pan: panBy,
      canPan: isViewClipped,
      longPress() {
        notifyParent({ type: "viewerLongPress" });
      },
    },
  });

  const toPoints = (list) =>
    Array.from(list, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
  // Capture phase on the container, so noVNC's own gesture handler on the
  // canvas never sees these touches; preventDefault stops the emulated
  // mouse events and browser scrolling/zooming.
  const onTouch = (event) => {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    noteViewerInput();
    switch (event.type) {
      case "touchstart":
        // Desktop touchscreens: keyboard focus follows the touch. Mobile
        // keeps focus in the app's own text field (its soft keyboard).
        if (config.desktop) rfb.focus();
        touchController.touchStart(toPoints(event.changedTouches));
        break;
      case "touchmove":
        touchController.touchMove(toPoints(event.changedTouches));
        break;
      case "touchend":
        touchController.touchEnd(toPoints(event.changedTouches));
        break;
      default:
        touchController.touchCancel();
    }
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    viewer.addEventListener(type, onTouch, { capture: true, passive: false });
  }
}

/* ----- Mouse: pan a zoomed view by holding the pointer at the window edge ----- */
const EDGE_PX = 32;
const EDGE_SPEED = 16; // px per frame at the very edge
let edgeVector = { x: 0, y: 0 };
let edgeFrame = null;

function edgePanStep() {
  edgeFrame = null;
  if (!edgeVector.x && !edgeVector.y) return;
  panBy(-edgeVector.x * EDGE_SPEED, -edgeVector.y * EDGE_SPEED);
  edgeFrame = requestAnimationFrame(edgePanStep);
}

viewer.addEventListener(
  "mousemove",
  (event) => {
    if (!isViewClipped()) {
      edgeVector = { x: 0, y: 0 };
      return;
    }
    const r = viewer.getBoundingClientRect();
    const along = (pos, start, end) => {
      if (pos < start + EDGE_PX) return -clamp((start + EDGE_PX - pos) / EDGE_PX, 0, 1);
      if (pos > end - EDGE_PX) return clamp((pos - (end - EDGE_PX)) / EDGE_PX, 0, 1);
      return 0;
    };
    edgeVector = {
      x: along(event.clientX, r.left, r.right),
      y: along(event.clientY, r.top, r.bottom),
    };
    if ((edgeVector.x || edgeVector.y) && edgeFrame === null) {
      edgeFrame = requestAnimationFrame(edgePanStep);
    }
  },
  { capture: true, passive: true },
);
viewer.addEventListener("mouseleave", () => {
  edgeVector = { x: 0, y: 0 };
});

/* ----- Helper: send event to parent window ----- */
function notifyParent(event) {
  try {
    window.parent.postMessage(event, "*");
  } catch (e) {
    // silently ignore if parent is not reachable
  }
}

/* ----- Signal ready ----- */
notifyParent({ type: "viewerReady" });

/* ----- Focus the canvas once the viewer mounts ----- */
requestAnimationFrame(() => rfb.focus());
