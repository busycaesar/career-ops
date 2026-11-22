importScripts("api.js");

const { canonicalizePostingUrl, errorOutcome, submitToPipeline, draftOutreach } = self.CareerOpsApi;

const MENU_SAVE_PAGE = "career-ops-save-page";
const MENU_SAVE_LINK = "career-ops-save-link";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_PAGE,
      title: "Save job posting to career-ops",
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_LINK,
      title: "Save link to career-ops",
      contexts: ["link"],
      targetUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SAVE_LINK) {
    const url = info.linkUrl;
    if (!url || !/^https?:\/\//i.test(url)) return;
    void submitToPipeline(url, { labelHint: url });
    return;
  }
  const url = info.pageUrl || tab?.url;
  if (!url || !/^https?:\/\//i.test(url)) return;
  void saveTabPosting(url, tab?.id, { labelHint: tab?.title || url });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "save-tab" && typeof message.url === "string") {
    const run = saveTabPosting(message.url, message.tabId, {
      labelHint: message.labelHint,
      fallbackInput: typeof message.fallbackInput === "string" ? message.fallbackInput : undefined,
      fallbackError: typeof message.fallbackError === "string" ? message.fallbackError : undefined,
    });
    if (message.async) {
      void run;
      sendResponse({ ok: true, accepted: true });
      return false;
    }
    run
      .then((outcome) => sendResponse(outcome))
      .catch((err) => sendResponse(errorOutcome(err instanceof Error ? err.message : String(err))));
    return true;
  }

  if (message?.type === "save" && typeof message.input === "string") {
    const run = submitToPipeline(message.input, {
      labelHint: message.labelHint,
      fallbackInput: typeof message.fallbackInput === "string" ? message.fallbackInput : undefined,
      fallbackError: typeof message.fallbackError === "string" ? message.fallbackError : undefined,
      tabKey: typeof message.tabKey === "string" ? message.tabKey : undefined,
    });
    if (message.async) {
      void run;
      sendResponse({ ok: true, accepted: true });
      return false;
    }
    run
      .then((outcome) => sendResponse(outcome))
      .catch((err) => sendResponse(errorOutcome(err instanceof Error ? err.message : String(err))));
    return true;
  }

  if (message?.type === "draft-outreach") {
    const run = draftHiringManagerMessage(message);
    if (message.async) {
      // Reply immediately so Chrome MV3 never drops a 30s+ message channel;
      // the popup receives progress and the final draft via chrome.storage.local.
      void run;
      sendResponse({ ok: true, accepted: true });
      return false;
    }
    run
      .then((outcome) => sendResponse(outcome))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  return false;
});

async function saveTabPosting(url, tabId, opts = {}) {
  const cleanUrl = canonicalizePostingUrl(url);
  let fallbackInput = opts.fallbackInput ?? "";
  let fallbackError = opts.fallbackError ?? "";
  if (!fallbackInput && !fallbackError && typeof tabId === "number") {
    const captured = await captureTabJobText(tabId, 300);
    if (captured.text) fallbackInput = `${cleanUrl}\n${captured.text}`;
    else fallbackError = captured.reason;
  }
  return submitToPipeline(cleanUrl, {
    labelHint: opts.labelHint || cleanUrl,
    fallbackInput,
    fallbackError,
    tabKey: cleanUrl,
  });
}

async function draftHiringManagerMessage(req) {
  let tabText = typeof req.tabText === "string" ? req.tabText.trim() : "";
  const input = typeof req.input === "string" ? req.input.trim() : "";
  if (!input && !tabText && typeof req.tabId === "number") {
    tabText = (await captureTabJobText(req.tabId, 80)).text;
  }
  return draftOutreach({ ...req, tabText });
}

async function captureTabJobText(tabId, minChars) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageJobTextFromDom,
      args: [minChars],
    });
    const text = typeof res?.result === "string" ? res.result.trim() : "";
    if (text.length >= minChars) return { text, reason: "" };
    return { text: "", reason: `Tab text was too short (${text.length} chars; need ${minChars}+)` };
  } catch (err) {
    return { text: "", reason: `Could not read tab text (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Runs inside the open job/post tab to snapshot posting text. */
function extractPageJobTextFromDom(minChars) {
  const pick = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      if (text) return text;
    }
    return "";
  };
  const host = location.hostname.toLowerCase();
  const isLinkedIn = host === "linkedin.com" || host.endsWith(".linkedin.com");

  let role = "";
  let company = "";
  if (isLinkedIn) {
    role = pick([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".top-card-layout__title",
    ]);
    company = pick([
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".topcard__org-name-link",
    ]);
    if (!role || !company) {
      const cleanTitle = document.title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
      const parts = cleanTitle.split(/\s*\|\s*/).filter(Boolean);
      if (parts.length >= 2) {
        role = role || parts[0];
        company = company || parts[1];
      }
    }
  } else {
    const genericHeading = /^(?:careers?|jobs?|search\s+jobs|job\s+details?|job\s+description|job\s+application|application|apply(?:\s+now)?)$/i;
    for (const el of document.querySelectorAll("main h1, [role=main] h1, article h1, h1")) {
      const text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (text.length >= 2 && text.length <= 120 && !genericHeading.test(text)) {
        role = text;
        break;
      }
    }
    company = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() ?? "";
  }

  const bodySelectors = isLinkedIn
    ? [
        ".jobs-description-content__text--stretch",
        ".jobs-description-content__text",
        ".jobs-description__content",
        ".jobs-box__html-content",
        ".show-more-less-html__markup",
        ".description__text",
        "#job-details",
        ".feed-shared-update-v2__description",
        ".update-components-text",
      ]
    : ["main", "[role=main]", "article"];

  let body = "";
  for (const selector of bodySelectors) {
    const el = document.querySelector(selector);
    const text = el?.innerText?.trim() ?? "";
    if (text.length >= minChars) {
      body = text;
      break;
    }
  }
  if (!body) body = document.body?.innerText?.trim() ?? "";
  if (body.length < minChars) return "";

  const headerLines = [];
  if (role) headerLines.push(`Title: ${role}`);
  if (company) headerLines.push(`Company: ${company}`);
  return headerLines.length ? `${headerLines.join("\n")}\n\n${body}` : body;
}
