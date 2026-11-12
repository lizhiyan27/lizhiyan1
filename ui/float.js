(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const bridge = window.lilac;
  const params = new URLSearchParams(location.search);
  const isOcrMode = params.get("mode") === "ocr";
  const state = {
    opacity: 0.96,
    font: 1,
    pinned: true,
    translated: "",
    original: "",
    mode: isOcrMode ? "ocr" : "subtitle",
  };

  if (!bridge) {
    document.body.innerHTML = "<div style='color:#fff;font:14px sans-serif;padding:20px'>浮窗需要在紫语星枢桌面应用中运行。</div>";
    return;
  }

  if (isOcrMode) {
    $("#brandTitle").textContent = "紫语识屏";
    $("#brandSub").textContent = "SCREEN OCR OVERLAY";
    $("#featureTag").textContent = "识屏翻译";
    const ocrBtn = $("#ocrCaptureBtn");
    if (ocrBtn) {
      ocrBtn.style.display = "inline-flex";
      ocrBtn.addEventListener("click", async () => {
        ocrBtn.textContent = "识别中…";
        ocrBtn.disabled = true;
        try {
          await bridge.ocrFloating.capture({ hideMain: true, notifyMain: true });
        } finally {
          setTimeout(() => {
            ocrBtn.textContent = "⚡ 立即识屏";
            ocrBtn.disabled = false;
          }, 600);
        }
      });
    }
  }

  function applyAppearance() {
    document.documentElement.style.setProperty("--opacity", String(state.opacity));
    document.documentElement.style.setProperty("--scale", String(state.font));
  }

  function setContent(content) {
    if (!content) return;
    const nextOriginal = content.original || "";
    const nextTranslated = content.translated || "";
    const origEl = $("#originalText");
    const transEl = $("#translatedText");

    if (origEl.textContent !== (nextOriginal || "等待原文…")) {
      origEl.textContent = nextOriginal || "等待原文…";
    }
    if (transEl.textContent !== (nextTranslated || "等待译文…")) {
      transEl.textContent = nextTranslated || "等待译文…";
    }
    state.original = nextOriginal;
    state.translated = nextTranslated;

    if (content.source) $("#sourceLang").textContent = content.source;
    if (content.target) $("#targetLang").textContent = content.target;
    if (content.feature) $("#featureTag").textContent = content.feature;
    $("#shell").classList.toggle("live", Boolean(content.live));
  }

  function updatePinned(pinned) {
    state.pinned = pinned;
    $("#pinBtn").classList.toggle("active", pinned);
    $("#pinBtn").title = pinned ? "取消置顶" : "置顶";
  }

  function updateFont(delta) {
    state.font = Math.min(1.6, Math.max(0.75, Math.round((state.font + delta) * 100) / 100));
    applyAppearance();
    bridge.floating.setFont(state.font);
  }

  $("#pinBtn").addEventListener("click", async () => {
    updatePinned(!state.pinned);
    await bridge.floating.setPinned(state.pinned);
  });

  $("#closeBtn").addEventListener("click", () => bridge.floating.close());
  $("#copyBtn").addEventListener("click", async () => {
    if (!state.translated) return;
    try {
      await navigator.clipboard.writeText(state.translated);
      $("#copyBtn").classList.add("active");
      setTimeout(() => $("#copyBtn").classList.remove("active"), 800);
    } catch {}
  });
  $("#fontUp").addEventListener("click", () => updateFont(0.08));
  $("#fontDown").addEventListener("click", () => updateFont(-0.08));

  $("#speakOriginal").addEventListener("click", () => speak(state.original, $("#sourceLang").textContent));
  $("#speakTranslation").addEventListener("click", () => speak(state.translated, $("#targetLang").textContent));

  function speak(text, langName) {
    if (!text || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 800));
    const map = { 中文: "zh-CN", 英语: "en-US", 日语: "ja-JP", 韩语: "ko-KR", 法语: "fr-FR", 德语: "de-DE", 西班牙语: "es-ES", 俄语: "ru-RU", 阿拉伯语: "ar-SA", 葡萄牙语: "pt-PT", 意大利语: "it-IT", 泰语: "th-TH" };
    utterance.lang = map[langName] || "zh-CN";
    speechSynthesis.speak(utterance);
  }

  const grip = $("#resizeGrip");
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startBounds = null;
  let raf = 0;
  let nextBounds = null;

  grip.addEventListener("pointerdown", async (event) => {
    event.preventDefault();
    resizing = true;
    startX = event.screenX;
    startY = event.screenY;
    startBounds = await bridge.floating.getBounds();
    if (!startBounds) {
      resizing = false;
      return;
    }
    grip.setPointerCapture(event.pointerId);
  });

  grip.addEventListener("pointermove", (event) => {
    if (!resizing || !startBounds) return;
    nextBounds = {
      width: Math.max(340, startBounds.width + event.screenX - startX),
      height: Math.max(150, startBounds.height + event.screenY - startY),
    };
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (nextBounds) bridge.floating.setSize(nextBounds);
      });
    }
  });

  function endResize() {
    resizing = false;
    startBounds = null;
    nextBounds = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  grip.addEventListener("pointerup", endResize);
  grip.addEventListener("pointercancel", endResize);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") bridge.floating.close();
    if ((event.ctrlKey || event.metaKey) && (event.key === "+" || event.key === "=")) updateFont(0.08);
    if ((event.ctrlKey || event.metaKey) && event.key === "-") updateFont(-0.08);
  });

  bridge.floating.onContent(setContent);
  bridge.floating.onState((payload) => {
    if (!payload) return;
    if (payload.pinned != null) updatePinned(payload.pinned);
    if (payload.opacity != null) state.opacity = payload.opacity;
    if (payload.font != null) state.font = payload.font;
    applyAppearance();
  });
  bridge.floating.onAppearance((payload) => {
    if (payload.opacity != null) state.opacity = payload.opacity;
    if (payload.font != null) state.font = payload.font;
    applyAppearance();
  });

  applyAppearance();
  updatePinned(true);
  if (isOcrMode) {
    $("#originalText").textContent = "识屏浮窗已就绪，点击上方“⚡ 立即识屏”或主界面“识屏翻译”抓取屏幕文字。";
    $("#translatedText").textContent = "识别到的屏幕文字与译文将实时展示在此浮窗中。";
  } else {
    $("#originalText").textContent = "浮窗已就绪。";
    $("#translatedText").textContent = "在紫语星枢中翻译文本，或开始游戏 / 视频识别，这里会实时显示原文与译文。";
  }
})();
