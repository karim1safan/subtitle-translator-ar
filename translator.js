// Pluggable translation layer.
// Swap the provider here later (e.g. DeepL, Google Cloud) without touching content.js.

(function () {
  class BackgroundProvider {
    constructor({ source = "en", target = "ar" } = {}) {
      this.source = source;
      this.target = target;
    }
    async translate(text) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: "translate", text, source: this.source, target: this.target },
            (resp) => {
              if (chrome.runtime.lastError || !resp || !resp.ok) {
                resolve(null);
              } else {
                resolve(resp.translation);
              }
            },
          );
        } catch (e) {
          resolve(null);
        }
      });
    }
  }

  window.__SubtitleTranslator = {
    createProvider(opts) {
      return new BackgroundProvider(opts);
    },
  };
})();
