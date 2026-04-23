// content.js — detects videos & subtitle containers, captures English text,
// requests translation via background, renders Arabic overlay.

(function () {
  const STATE = {
    enabled: true,
    provider: null,
    overlays: new WeakMap(), // video -> overlay element
    seenVideos: new WeakSet(),
    seenContainers: new WeakSet(),
    lastTextPerOverlay: new WeakMap(),
  };

  // --- Settings ---
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["st_enabled"], (data) => {
          STATE.enabled = data.st_enabled !== false; // default ON
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  // React to toggle from popup
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.st_enabled) {
        STATE.enabled = changes.st_enabled.newValue !== false;
        if (!STATE.enabled) hideAllOverlays();
        else showAllOverlays();
      }
    });
  } catch {}

  try {
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg && msg.type === "getStatus") {
        sendResponse({ ok: true, hasVideo: !!document.querySelector("video") });
        return true;
      }
      return false;
    });
  } catch {}

  // --- Overlay management ---
  function ensureOverlay(video) {
    let overlay = STATE.overlays.get(video);
    if (overlay && document.body.contains(overlay)) return overlay;

    overlay = document.createElement("div");
    overlay.className = "st-subtitle-overlay";
    overlay.setAttribute("dir", "rtl");
    overlay.style.display = "none";
    positionOverlay(overlay, video);

    // Append to a sensible parent (video's offsetParent or body)
    const parent = video.parentElement || document.body;
    parent.appendChild(overlay);

    STATE.overlays.set(video, overlay);

    // Reposition on resize / scroll / fullscreen
    const reposition = () => positionOverlay(overlay, video);
    window.addEventListener("resize", reposition, { passive: true });
    window.addEventListener("scroll", reposition, { passive: true });
    document.addEventListener("fullscreenchange", () => {
      const fs = document.fullscreenElement;
      if (fs && (fs === video || fs.contains(video))) {
        fs.appendChild(overlay);
      } else {
        (video.parentElement || document.body).appendChild(overlay);
      }
      reposition();
    });

    return overlay;
  }

  function positionOverlay(overlay, video) {
    const rect = video.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.position = "fixed";
    overlay.style.left = rect.left + rect.width / 2 + "px";
    overlay.style.top = rect.top + rect.height - 12 + "px";
    overlay.style.transform = "translate(-50%, -100%)";
    overlay.style.maxWidth = Math.min(rect.width - 24, 900) + "px";
    overlay.style.zIndex = "2147483647";
  }

  function hideAllOverlays() {
    document.querySelectorAll(".st-subtitle-overlay").forEach((el) => {
      el.style.display = "none";
    });
  }
  function showAllOverlays() {
    document.querySelectorAll(".st-subtitle-overlay").forEach((el) => {
      if (el.textContent.trim()) el.style.display = "";
    });
  }

  // --- Translation pipeline ---
  const inflight = new Map(); // text -> Promise

  async function translateAndRender(video, englishText) {
    if (!STATE.enabled) return;
    const text = (englishText || "").replace(/\s+/g, " ").trim();
    if (!text) {
      const ov = STATE.overlays.get(video);
      if (ov) {
        ov.textContent = "";
        ov.style.display = "none";
      }
      return;
    }

    const overlay = ensureOverlay(video);
    const last = STATE.lastTextPerOverlay.get(overlay);
    if (last === text) {
      // Already showing translation for this exact text
      positionOverlay(overlay, video);
      return;
    }
    STATE.lastTextPerOverlay.set(overlay, text);

    let p = inflight.get(text);
    if (!p) {
      p = STATE.provider.translate(text);
      inflight.set(text, p);
      p.finally(() => inflight.delete(text));
    }

    const translation = await p;
    // If a newer text arrived in the meantime, drop this result
    if (STATE.lastTextPerOverlay.get(overlay) !== text) return;

    if (translation) {
      overlay.textContent = translation;
      overlay.style.display = STATE.enabled ? "" : "none";
      positionOverlay(overlay, video);
    }
  }

  // --- Video & track detection ---
  function attachToVideo(video) {
    if (STATE.seenVideos.has(video)) return;
    STATE.seenVideos.add(video);

    // Listen to native text tracks
    const hookTracks = () => {
      const tracks = video.textTracks;
      if (!tracks) return;
      for (let i = 0; i < tracks.length; i++) {
        const tt = tracks[i];
        try {
          // Force showing in hidden mode so we receive cuechange without visible native captions
          if (tt.mode === "disabled") tt.mode = "hidden";
        } catch {}
        if (tt.__stHooked) continue;
        tt.__stHooked = true;
        tt.addEventListener("cuechange", () => {
          const active = tt.activeCues;
          if (!active || active.length === 0) {
            translateAndRender(video, "");
            return;
          }
          let txt = "";
          for (let j = 0; j < active.length; j++) {
            txt += (active[j].text || "") + " ";
          }
          translateAndRender(video, txt);
        });
      }
    };
    hookTracks();
    video.textTracks &&
      video.textTracks.addEventListener &&
      video.textTracks.addEventListener("addtrack", hookTracks);

    // Reposition on play/seek
    ["play", "playing", "seeked", "loadedmetadata"].forEach((ev) => {
      video.addEventListener(ev, () => {
        const ov = STATE.overlays.get(video);
        if (ov) positionOverlay(ov, video);
      });
    });
  }

  // DOM-rendered caption containers (Video.js, YouTube, AWS/Kaltura, JW, generic)
  const CAPTION_SELECTORS = [
    ".vjs-text-track-cue",
    ".vjs-text-track-display",
    ".ytp-caption-segment",
    ".ytp-caption-window-container",
    ".captions-text",
    ".caption-visual-line",
    ".jw-text-track-cue",
    ".jw-captions",
    ".kaltura-captions",
    ".mejs__captions-text",
    "[class*='caption']",
    "[class*='subtitle']",
    "[class*='Subtitle']",
    "[class*='Caption']",
  ];

  function findNearestVideo(node) {
    // Walk up to find a containing element that has a <video> descendant or sibling
    let el = node;
    while (el && el !== document.body) {
      if (el.tagName === "VIDEO") return el;
      const v = el.querySelector && el.querySelector("video");
      if (v) return v;
      el = el.parentElement;
    }
    return document.querySelector("video");
  }

  const containerDebounce = new WeakMap();
  function handleCaptionContainer(container) {
    if (STATE.seenContainers.has(container)) return;
    STATE.seenContainers.add(container);

    const process = () => {
      const txt = (container.innerText || container.textContent || "").trim();
      const video = findNearestVideo(container);
      if (!video) return;
      attachToVideo(video);
      translateAndRender(video, txt);
    };

    const obs = new MutationObserver(() => {
      clearTimeout(containerDebounce.get(container));
      containerDebounce.set(container, setTimeout(process, 80));
    });
    obs.observe(container, { childList: true, characterData: true, subtree: true });
    process();
  }

  function scan(root = document) {
    // Videos
    root.querySelectorAll && root.querySelectorAll("video").forEach(attachToVideo);
    // Caption containers
    CAPTION_SELECTORS.forEach((sel) => {
      try {
        root.querySelectorAll &&
          root.querySelectorAll(sel).forEach((el) => {
            // Skip tiny / hidden / our own overlay
            if (el.classList && el.classList.contains("st-subtitle-overlay")) return;
            handleCaptionContainer(el);
          });
      } catch {}
    });
  }

  // Global observer for late-loaded players & SPA route changes
  const globalObs = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes &&
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.tagName === "VIDEO") attachToVideo(n);
          scan(n);
        });
    }
  });

  // SPA route change detection
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => scan(document), 800);
    }
  }, 1000);

  // --- Init ---
  loadSettings().then(() => {
    STATE.provider = window.__SubtitleTranslator.createProvider({ source: "en", target: "ar" });
    scan(document);
    globalObs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  });
})();
