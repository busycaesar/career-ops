(() => {
  const SERVER_URL = "http://localhost:3001";
  const BADGE_CLEAR_MS = 6000;

  let inFlight = 0;
  let badgeClearTimer = null;
  let keepaliveTimer = null;

  function startKeepalive() {
    if (keepaliveTimer) return;
    // Chrome MV3 terminates idle service workers after ~30s even while a fetch() is pending.
    // Calling a lightweight chrome API every 20s keeps long AI/Playwright requests alive.
    keepaliveTimer = setInterval(() => {
      if (inFlight <= 0) {
        stopKeepalive();
        return;
      }
      try {
        chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
      } catch {
        /* ignore */
      }
    }, 20_000);
  }

  function stopKeepalive() {
    if (!keepaliveTimer) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }

  function beginWork() {
    inFlight += 1;
    startKeepalive();
  }

  function endWork() {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) stopKeepalive();
  }

  function setBadge(text, color, autoClear) {
    if (badgeClearTimer) {
      clearTimeout(badgeClearTimer);
      badgeClearTimer = null;
    }
    try {
      chrome.action.setBadgeText({ text });
      if (color) chrome.action.setBadgeBackgroundColor({ color });
      if (autoClear) {
        badgeClearTimer = setTimeout(() => {
          if (inFlight === 0) chrome.action.setBadgeText({ text: "" });
        }, BADGE_CLEAR_MS);
      }
    } catch {
      /* ignore if action API unavailable */
    }
  }

  function errorOutcome(text) {
    return { ok: false, tone: "bad", text, badge: "!", badgeColor: "#dc2626" };
  }

  function shorten(value) {
    return value.length > 72 ? `${value.slice(0, 69)}...` : value;
  }

  function canonicalizePostingUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.toLowerCase();
      if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
        const jobId = u.searchParams.get("currentJobId");
        if (jobId && /^\d+$/.test(jobId)) {
          return `https://www.linkedin.com/jobs/view/${jobId}/`;
        }
      }
    } catch {
      /* keep rawUrl */
    }
    return rawUrl;
  }

  async function postJson(url, payload, timeoutMs = 75_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return {
        ok: response.ok,
        status: response.status,
        body,
        rawText: body ? "" : text.replace(/\s+/g, " ").trim().slice(0, 180),
      };
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function formatOutcome(res, labelHint, usedFallback = false, fallbackNote = "") {
    const { ok, status, body: result, rawText } = res;
    if (!ok || !result) {
      const base = result?.error || (rawText ? `Server error (HTTP ${status}): ${rawText}` : `Server returned HTTP ${status}.`);
      const text = fallbackNote ? `${base} (${fallbackNote})` : base;
      return errorOutcome(text);
    }

    if (result.batch && Array.isArray(result.results)) {
      const items = result.results;
      const savedCount = result.savedCount ?? 0;
      const duplicateCount = result.duplicateCount ?? 0;
      const failedCount = result.failedCount ?? 0;
      const parts = [];
      if (savedCount > 0) parts.push(`Saved ${savedCount} of ${items.length} links`);
      if (duplicateCount > 0) parts.push(`${duplicateCount} already in pipeline`);
      if (failedCount > 0) parts.push(`${failedCount} could not be read`);
      const tone = failedCount === 0 && savedCount > 0 ? "ok" : savedCount === 0 && duplicateCount === 0 ? "bad" : "warn";
      const detailItems = items.map((item) => {
        const label = [item.role, item.company].filter(Boolean).join(" at ");
        if (item.status === "saved") return { tone: "ok", text: label ? `Saved ${label}` : `Saved ${item.url}` };
        if (item.status === "duplicate") return { tone: "warn", text: label ? `Already in pipeline: ${label}` : `Already in pipeline: ${item.url}` };
        return { tone: "bad", text: `${item.url} — ${item.error || "Could not read posting."}` };
      });
      const failedUrls = items.filter((item) => item.status === "error").map((item) => item.url);
      return {
        ok: tone !== "bad",
        tone,
        text: `${parts.join(" · ")}.`,
        items: detailItems,
        failedUrls,
        badge: failedCount > 0 && savedCount === 0 ? "!" : savedCount > 0 ? String(savedCount) : "•",
        badgeColor: tone === "ok" ? "#059669" : tone === "warn" ? "#d97706" : "#dc2626",
      };
    }

    if (result.duplicate) {
      return {
        ok: true,
        tone: "warn",
        text: labelHint ? `Already in pipeline: ${shorten(labelHint)}` : "Already in your pipeline (or seen before), so nothing was added.",
        badge: "•",
        badgeColor: "#d97706",
      };
    }

    const label = [result.role, result.company].filter(Boolean).join(" at ");
    const suffix = usedFallback ? " (from tab text)" : "";
    return {
      ok: true,
      tone: "ok",
      text: label ? `Saved ${label} to your pipeline${suffix}.` : `Saved to your pipeline${suffix}.`,
      badge: "✓",
      badgeColor: "#059669",
    };
  }

  async function submitToPipeline(input, opts = {}) {
    beginWork();
    setBadge("...", "#d97706", false);
    if (opts.tabKey) {
      await chrome.storage.local.set({
        lastSaveState: { key: opts.tabKey, status: "saving", outcome: null, at: Date.now() },
      });
    }

    try {
      let res = await postJson(`${SERVER_URL}/api/pipeline`, { input });
      let usedFallback = false;
      let fallbackNote = "";

      // If reading by link failed (HTTP 422), automatically retry with the open tab's job text.
      if (!res.ok && res.status === 422) {
        if (opts.fallbackInput) {
          const firstError = res.body?.error || `HTTP ${res.status}`;
          res = await postJson(`${SERVER_URL}/api/pipeline`, { input: opts.fallbackInput });
          usedFallback = true;
          if (!res.ok) {
            fallbackNote = `Link failed (${firstError}); tab-text fallback also failed`;
          }
        } else if (opts.fallbackError) {
          fallbackNote = opts.fallbackError;
        }
      }

      const outcome = formatOutcome(res, opts.labelHint, usedFallback, fallbackNote);
      if (opts.tabKey) {
        await chrome.storage.local.set({
          lastSaveState: { key: opts.tabKey, status: "done", outcome, at: Date.now() },
        });
      }
      setBadge(outcome.badge, outcome.badgeColor, true);
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = errorOutcome(`Could not reach career-ops (${message}). Make sure web2 is running on ${SERVER_URL}.`);
      if (opts.tabKey) {
        await chrome.storage.local.set({
          lastSaveState: { key: opts.tabKey, status: "done", outcome, at: Date.now() },
        });
      }
      setBadge(outcome.badge, outcome.badgeColor, true);
      return outcome;
    } finally {
      endWork();
    }
  }

  async function draftOutreach(req, opts = {}) {
    const cleanUrl = typeof req.url === "string" && req.url ? canonicalizePostingUrl(req.url) : "";
    const input = typeof req.input === "string" ? req.input.trim() : "";
    const tabText = typeof req.tabText === "string" ? req.tabText.trim() : "";
    const draftKey = cleanUrl || "manual";
    const savedRequest = { url: cleanUrl, tabId: req.tabId, input };

    if (opts.persistDrafting) {
      await chrome.storage.local.set({
        outreachDraft: {
          status: "drafting",
          key: draftKey,
          message: "",
          error: "",
          request: savedRequest,
          at: Date.now(),
        },
      });
    }

    beginWork();
    setBadge("...", "#d97706", false);

    try {
      const payload = input
        ? { input }
        : { url: cleanUrl, ...(tabText ? { text: tabText } : {}) };

      const { ok, status, body, rawText } = await postJson(`${SERVER_URL}/api/outreach`, payload);
      if (!ok || !body?.message) {
        const error = body?.error || (rawText ? `HTTP ${status}: ${rawText}` : `Server returned HTTP ${status}.`);
        await chrome.storage.local.set({
          outreachDraft: {
            status: "error",
            key: draftKey,
            message: "",
            error,
            request: savedRequest,
            at: Date.now(),
          },
        });
        setBadge("!", "#dc2626", true);
        return { ok: false, error };
      }

      await chrome.storage.local.set({
        outreachDraft: {
          status: "ready",
          key: draftKey,
          message: body.message,
          error: "",
          request: savedRequest,
          at: Date.now(),
        },
      });
      setBadge("✓", "#059669", true);
      return { ok: true, message: body.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = `Could not reach career-ops (${message}). Make sure web2 is running on ${SERVER_URL}.`;
      await chrome.storage.local.set({
        outreachDraft: {
          status: "error",
          key: draftKey,
          message: "",
          error,
          request: savedRequest,
          at: Date.now(),
        },
      });
      setBadge("!", "#dc2626", true);
      return { ok: false, error };
    } finally {
      endWork();
    }
  }

  self.CareerOpsApi = {
    SERVER_URL,
    canonicalizePostingUrl,
    errorOutcome,
    submitToPipeline,
    draftOutreach,
  };
})();
