(() => {
  const OTHER_IDS = new Set(["other", "something_else", "something-else"]);
  const MAX_PASTED = 4;
  // Keep clipboard stills small — huge data-URLs blank/freeze WebView2 under Cursor.
  const PASTE_MAX_EDGE = 1280;
  const PASTE_JPEG_QUALITY = 0.82;
  const PASTE_MAX_B64_CHARS = 1_800_000; // ~1.3 MiB decoded
  const state = {
    payload: null,
    selected: new Set(),
    armed: false,
    typing: false,
    pasted: [],
    timeoutId: null,
    engaged: false,
  };

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function stripHotkeyPrefix(label) {
    return String(label || "").replace(/^\d+\s*[·.]\s*/, "").trim();
  }

  async function apiCall(name, ...args) {
    // Edge --app / localhost bridge (no pywebview — killable, no destroy hang).
    const bridge = window.__ASK_BRIDGE__;
    if (bridge && typeof bridge === "string") {
      if (name === "content_ready" || name === "resize_to" || name === "hold_timeout") {
        try {
          await fetch(`${bridge}/event`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, args }),
          });
        } catch (_) {
          /* ignore */
        }
        return null;
      }
      const res = await fetch(`${bridge}/api`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args }),
      });
      if (!res.ok) {
        throw new Error(`bridge api.${name} HTTP ${res.status}`);
      }
      const data = await res.json();
      return data.result;
    }

    const api = window.pywebview && window.pywebview.api;
    if (!api || typeof api[name] !== "function") {
      throw new Error(`pywebview api.${name} unavailable`);
    }
    return api[name](...args);
  }

  function setArmed(armed) {
    state.armed = armed;
    const ok = $("#ok-btn");
    if (!ok) return;
    ok.disabled = !armed;
    ok.classList.toggle("is-arming", !armed);
    const danger = ok.classList.contains("is-danger");
    if (armed) {
      const fill = ok.querySelector(".arm-fill");
      if (fill) fill.style.width = "100%";
      ok.innerHTML = `
        <span class="arm-fill" style="width:100%"></span>
        <span class="btn-label">OK</span>
        <span class="btn-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M17 7H9M17 7v8"/></svg></span>
      `;
      if (danger) ok.classList.add("is-danger");
    }
  }

  function armCountdown(ms) {
    const ok = $("#ok-btn");
    if (ms <= 0) {
      setArmed(true);
      return;
    }
    setArmed(false);
    ok.innerHTML = `
      <span class="arm-fill" style="width:0%"></span>
      <span class="btn-label">OK</span>
      <span class="btn-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M17 7H9M17 7v8"/></svg></span>
    `;
    const fill = ok.querySelector(".arm-fill");
    const started = performance.now();
    const tick = (now) => {
      if (state.armed) return;
      const t = Math.min(1, (now - started) / ms);
      if (fill) fill.style.width = `${(t * 100).toFixed(1)}%`;
      if (t >= 1) {
        setArmed(true);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function spawnDots() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const layers = [
      { sel: "#stars-near", n: 48, cls: "star-dot is-near" },
      { sel: "#stars-far", n: 36, cls: "star-dot is-far" },
    ];
    layers.forEach(({ sel, n, cls }) => {
      const el = $(sel);
      if (!el) {
        apiCall("debug", `stars missing ${sel}`).catch(() => {});
        return;
      }
      el.innerHTML = "";
      for (let i = 0; i < n; i += 1) {
        const d = document.createElement("span");
        d.className = cls;
        if (i % 9 === 0) d.classList.add("is-bright");
        d.style.left = `${(Math.random() * 100).toFixed(2)}%`;
        d.style.top = `${(Math.random() * 100).toFixed(2)}%`;
        el.appendChild(d);
      }
      apiCall("debug", `stars baked ${sel} n=${n}`).catch(() => {});
    });
  }

  function renderOptions() {
    const p = state.payload;
    const box = $("#options");
    box.innerHTML = "";
    const dangerIds = new Set(p.danger_ids || []);
    const recommended = new Set(p.recommended_ids || []);

    (p.ids || []).forEach((id, i) => {
      const shell = document.createElement("div");
      shell.className = "option-shell";
      shell.dataset.id = id;
      shell.style.transitionDelay = `${100 + i * 70}ms`;
      if (dangerIds.has(id)) shell.classList.add("is-danger");
      if (state.selected.has(id)) shell.classList.add("is-selected");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option";
      btn.dataset.id = id;
      if (dangerIds.has(id)) btn.classList.add("is-danger");

      const rawLabel = stripHotkeyPrefix(p.labels?.[id] || id);
      const raw = rawLabel.replace(/\s*\(recommended\)\s*/gi, " ").trim() || rawLabel;
      const mark = dangerIds.has(id) ? '<span class="mark">⛔</span>' : "";
      const rec = recommended.has(id)
        ? '<span class="rec-pill">Recommended</span>'
        : "";
      btn.innerHTML = `
        <span class="hotkey">${i + 1}</span>
        <span class="option-label">${esc(raw)}</span>
        ${rec}
        ${mark}
        <span class="option-check" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
        </span>
      `;
      btn.addEventListener("click", () => onPick(id));
      shell.appendChild(btn);
      box.appendChild(shell);
    });
  }

  function syncSelectionUi() {
    document.querySelectorAll(".option-shell").forEach((el) => {
      el.classList.toggle("is-selected", state.selected.has(el.dataset.id));
    });
  }

  function onPick(id) {
    const multi = !!state.payload.allow_multiple;
    if (multi) {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
    } else {
      state.selected = new Set([id]);
    }
    syncSelectionUi();
  }

  function freeformText() {
    return ($("#freeform-input")?.value || "").trim();
  }

  function markEngaged() {
    if (state.engaged) return;
    state.engaged = true;
    if (state.timeoutId != null) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }
    apiCall("hold_timeout").catch(() => {});
  }

  function dataUrlToPayload(dataUrl) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || "");
    if (!m) return null;
    let mime = m[1].toLowerCase();
    if (mime === "image/jpg") mime = "image/jpeg";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
      return null;
    }
    const data = m[2];
    if (data.length > PASTE_MAX_B64_CHARS) return null;
    return { mime, data };
  }

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
  }

  async function compactFileToDataUrl(file) {
    // Decode via blob URL (not a giant data: string) then JPEG-downscale.
    const blobUrl = URL.createObjectURL(file);
    try {
      const img = await loadImageFromUrl(blobUrl);
      let w = img.naturalWidth || img.width || 0;
      let h = img.naturalHeight || img.height || 0;
      if (w < 1 || h < 1) return null;
      const scale = Math.min(1, PASTE_MAX_EDGE / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      let out = canvas.toDataURL("image/jpeg", PASTE_JPEG_QUALITY);
      let q = PASTE_JPEG_QUALITY;
      while (out.length > PASTE_MAX_B64_CHARS && q > 0.45) {
        q -= 0.12;
        out = canvas.toDataURL("image/jpeg", q);
      }
      if (out.length > PASTE_MAX_B64_CHARS) return null;
      return out;
    } catch (_) {
      return null;
    } finally {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function renderRefs() {
    const box = $("#refs");
    const strip = $("#refs-strip");
    if (!box || !strip) return;
    strip.innerHTML = "";
    if (!state.pasted.length) {
      box.hidden = true;
      requestAnimationFrame(() => fitWindow());
      return;
    }
    box.hidden = false;
    state.pasted.forEach((item, i) => {
      const tile = document.createElement("div");
      tile.className = "ref-tile";
      tile.setAttribute("role", "listitem");
      const img = document.createElement("img");
      img.src = item.dataUrl;
      img.alt = `Reference ${i + 1}`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "ref-remove";
      rm.setAttribute("aria-label", `Remove reference ${i + 1}`);
      rm.textContent = "×";
      rm.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.pasted.splice(i, 1);
        renderRefs();
      });
      tile.appendChild(img);
      tile.appendChild(rm);
      strip.appendChild(tile);
    });
    // Options area flex-shrinks; footer stays. Still ask host to grow when possible (Edge).
    requestAnimationFrame(() => fitWindow());
  }

  function addPastedDataUrl(dataUrl) {
    if (state.pasted.length >= MAX_PASTED) return false;
    const payload = dataUrlToPayload(dataUrl);
    if (!payload) return false;
    state.pasted.push({ ...payload, dataUrl });
    markEngaged();
    renderRefs();
    return true;
  }

  async function onPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [];
    if (cd.files && cd.files.length) {
      for (const f of cd.files) {
        if (f && String(f.type || "").startsWith("image/")) files.push(f);
      }
    }
    if (!files.length && cd.items) {
      for (const item of cd.items) {
        if (item.kind === "file" && String(item.type || "").startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      if (state.pasted.length >= MAX_PASTED) break;
      try {
        const compact = await compactFileToDataUrl(file);
        if (!compact) continue;
        addPastedDataUrl(compact);
      } catch (_) {
        /* skip unreadable clipboard items */
      }
    }
  }

  async function leaveGently() {
    const app = $("#app");
    if (!app || app.classList.contains("is-leaving")) return;
    app.classList.add("is-leaving");
    await new Promise((r) => setTimeout(r, 280));
  }

  function pastedPayload() {
    return state.pasted.map(({ mime, data }) => ({ mime, data }));
  }

  async function submit() {
    if (!state.armed) return;
    const typed = freeformText();
    let ids = [...state.selected];
    if (typed) {
      const other = (state.payload.ids || []).find((id) => OTHER_IDS.has(id));
      if (other && !ids.includes(other)) ids = [other];
      if (!other) ids = ids.length ? ids : ["other"];
    }
    if (!ids.length) return;
    await leaveGently();
    try {
      await apiCall("submit", ids, typed || null, pastedPayload());
    } catch (err) {
      console.error(err);
    }
    try {
      window.close();
    } catch (_) {
      /* Edge --app may ignore */
    }
  }

  async function cancel(reason = "user cancelled") {
    await leaveGently();
    try {
      await apiCall("cancel", reason);
    } catch (err) {
      console.error(err);
    }
    try {
      window.close();
    } catch (_) {
      /* ignore */
    }
  }

  function onKey(e) {
    const typing =
      document.activeElement &&
      document.activeElement.id === "freeform-input";
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (typing) {
        // Enter submits; Shift+Enter inserts a newline in the textarea.
        e.preventDefault();
        const other = (state.payload.ids || []).find((id) => OTHER_IDS.has(id));
        if (freeformText() && other) state.selected = new Set([other]);
        submit();
        return;
      }
      e.preventDefault();
      submit();
      return;
    }
    if (typing) return;
    if (/^[1-8]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      const id = state.payload.ids?.[idx];
      if (id) {
        e.preventDefault();
        onPick(id);
      }
    }
  }

  function updateHint() {
    const n = Math.min(8, (state.payload.ids || []).length);
    const hint = $("#hint");
    if (!hint) return;
    const base =
      n <= 1
        ? "Enter OK · Esc cancel"
        : `1–${n} select · Enter OK · Esc cancel · Shift+Enter newline`;
    hint.textContent = `${base} · Ctrl+V image`;
  }

  function mount(payload) {
    state.payload = payload;
    spawnDots();
    const theme = String(payload.theme || "glass").toLowerCase();
    const app = $("#app");
    if (app) {
      app.dataset.theme = ["glass", "ink", "signal", "hybrid"].includes(theme)
        ? theme
        : "glass";
    }
    const pre = payload.preselect || payload.recommended_ids || [];
    state.selected = new Set(
      pre.length ? pre.map(String) : payload.ids?.[0] ? [payload.ids[0]] : [],
    );

    const dangerous = !!(payload.dangerous || (payload.danger_ids || []).length);
    $("#eyebrow").textContent = dangerous ? "Confirm" : "Decide";
    $("#eyebrow").classList.toggle("is-danger", dangerous);
    $("#title-agent").textContent = payload.agent_hint || payload.title || "";
    $("#question").textContent = payload.question || "";

    const banner = $("#banner");
    banner.classList.toggle("is-on", dangerous);
    $("#banner-copy").textContent = dangerous
      ? `⛔ Confirm — ${payload.question || ""}`
      : "";

    const ok = $("#ok-btn");
    ok.classList.toggle("is-danger", dangerous);

    const showOther = payload.allow_other !== false;
    $("#freeform").hidden = !showOther;
    if (showOther) {
      $("#freeform-input").addEventListener("input", () => {
        markEngaged();
        const typed = freeformText();
        if (!typed) return;
        const other = (payload.ids || []).find((id) => OTHER_IDS.has(id));
        if (other) {
          state.selected = new Set([other]);
          syncSelectionUi();
        }
      });
    }

    renderOptions();
    updateHint();

    document.addEventListener("keydown", onKey);
    document.addEventListener("paste", (e) => {
      onPaste(e).catch(() => {});
    });
    $("#cancel-btn").addEventListener("click", () => cancel());
    $("#close-btn").addEventListener("click", () => cancel());
    $("#ok-btn").addEventListener("click", () => submit());

    const armMs =
      typeof payload.arm_ms === "number"
        ? payload.arm_ms
        : dangerous
          ? 4000
          : 1000;
    armCountdown(armMs);
    apiCall("debug", `mount:arm_ms=${armMs}`).catch(() => {});

    // Visible before raise — opacity:0 + raise looked like a black void,
    // and Edge --app throttles rAF when unfocused.
    $("#app").classList.add("is-ready");
    apiCall("content_ready").catch(() => {});
    apiCall("debug", "mount:content_ready_sent").catch(() => {});
    requestAnimationFrame(() => fitWindow());

    if (payload.timeout_sec > 0) {
      state.timeoutId = setTimeout(
        () => cancel("timeout"),
        payload.timeout_sec * 1000,
      );
    }
  }

  function fitWindow() {
    const chrome = document.querySelector(".chrome");
    const banner = document.getElementById("banner");
    const question = document.getElementById("question");
    const options = document.getElementById("options");
    const refs = document.getElementById("refs");
    const freeform = document.getElementById("freeform");
    const footer = document.querySelector(".footer");
    let h = 28;
    [chrome, question, refs, freeform, footer].forEach((el) => {
      if (el && !el.hidden) h += el.offsetHeight;
    });
    if (banner && banner.classList.contains("is-on")) {
      h += banner.offsetHeight + 8;
    }
    // Gaps in .body
    h += 42;
    let optsH = 0;
    if (options) {
      options.querySelectorAll(".option").forEach((o) => {
        optsH += o.offsetHeight + 8;
      });
      // Scroll options beyond this — keep freeform + footer on screen.
      h += Math.min(optsH, 420);
    }
    const w = Math.max(520, Math.min(760, window.outerWidth || 560));
    apiCall("resize_to", w, Math.ceil(h)).catch(() => {});
  }

  async function boot() {
    const waitApi = () =>
      new Promise((resolve, reject) => {
        const tryNow = () => {
          if (window.__ASK_BRIDGE__) {
            resolve();
            return true;
          }
          if (window.pywebview && window.pywebview.api) {
            resolve();
            return true;
          }
          return false;
        };
        if (tryNow()) return;
        window.addEventListener("pywebviewready", () => tryNow());
        let n = 0;
        const iv = setInterval(() => {
          n += 1;
          if (tryNow()) {
            clearInterval(iv);
            return;
          }
          if (n > 100) {
            clearInterval(iv);
            reject(new Error("dialog bridge unavailable (pywebview / Edge)"));
          }
        }, 50);
      });

    await waitApi();
    apiCall("debug", "boot:api_ready").catch(() => {});
    const payload = await apiCall("get_payload");
    apiCall("debug", `boot:payload n=${(payload && payload.ids || []).length}`).catch(
      () => {},
    );
    mount(payload || {});
    apiCall("debug", "boot:mounted").catch(() => {});
  }

  boot().catch((err) => {
    console.error(err);
    document.body.innerHTML = `<pre style="color:#ff5c7a;padding:16px">${esc(
      String(err),
    )}</pre>`;
  });
})();
