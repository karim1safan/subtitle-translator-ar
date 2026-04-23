const toggle = document.getElementById("toggle");
const hasVideoEl = document.getElementById("hasVideo");
const cacheSizeEl = document.getElementById("cacheSize");

// Load current state
chrome.storage.local.get(["st_enabled"], (data) => {
  toggle.checked = data.st_enabled !== false;
});

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ st_enabled: toggle.checked });
});

// Query active tab for video presence
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) return;
  try {
    chrome.tabs.sendMessage(tab.id, { type: "getStatus" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        hasVideoEl.textContent = "no";
      } else {
        hasVideoEl.textContent = resp.hasVideo ? "yes" : "no";
      }
    });
  } catch {
    hasVideoEl.textContent = "no";
  }
});

// Cache size
chrome.runtime.sendMessage({ type: "getCacheSize" }, (resp) => {
  if (chrome.runtime.lastError || !resp) {
    cacheSizeEl.textContent = "0";
  } else {
    cacheSizeEl.textContent = String(resp.cacheSize || 0);
  }
});
