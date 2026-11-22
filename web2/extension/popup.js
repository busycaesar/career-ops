const { SERVER_URL, submitToPipeline, draftOutreach } = self.CareerOpsApi;
const SAVE_STATE_TTL_MS = 60_000;

const tabCardEl = document.getElementById("tab-card");
const tabTitleEl = document.getElementById("tab-title");
const tabUrlEl = document.getElementById("tab-url");
const saveTabBtn = document.getElementById("save-tab");
const messageTabBtn = document.getElementById("message-tab");
const formEl = document.getElementById("discover-form");
const inputEl = document.getElementById("posting-input");
const saveInputBtn = document.getElementById("save-input");
const messageInputBtn = document.getElementById("message-input");
const feedbackEl = document.getElementById("feedback");
const messageCardEl = document.getElementById("message-card");
const messageOutputEl = document.getElementById("message-output");
const copyMessageBtn = document.getElementById("copy-message");
const regenMessageBtn = document.getElementById("regen-message");
const closeMessageBtn = document.getElementById("close-message");

let activeTab = null;
let lastDraftRequest = null;
let busy = false;
let copyTimer = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:\/\//i.test(tab.url) && !isLocalBoardUrl(tab.url)) {
    const isJob = await isJobPostingTab(tab);
    if (isJob) {
      activeTab = tab;
      tabTitleEl.textContent = tab.title || tab.url;
      tabUrlEl.textContent = tab.url;
      tabCardEl.classList.remove("hidden");
    }
  }

  const state = await chrome.storage.local.get({ lastSaveState: null, outreachDraft: null });
  const currentKey = activeTab?.url ? canonicalKeyForTab(activeTab.url) : "";
  if (currentKey && state.lastSaveState && state.lastSaveState.key === currentKey && Date.now() - (state.lastSaveState.at || 0) < SAVE_STATE_TTL_MS) {
    applySaveState(state.lastSaveState);
  }
  if (state.outreachDraft) {
    applyDraftState(state.outreachDraft);
  }

  updateButtonState();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.outreachDraft && !busy) applyDraftState(changes.outreachDraft.newValue);
  if (changes.lastSaveState?.newValue && !busy) {
    const currentKey = activeTab?.url ? canonicalKeyForTab(activeTab.url) : "";
    if (changes.lastSaveState.newValue.key === currentKey) {
      applySaveState(changes.lastSaveState.newValue);
    }
  }
});

inputEl.addEventListener("input", updateButtonState);

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void handleManualSubmit();
  }
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleManualSubmit();
});

saveTabBtn.addEventListener("click", () => {
  if (!activeTab?.url || busy) return;
  void runSaveTab(activeTab);
});

messageTabBtn.addEventListener("click", () => {
  if (!activeTab?.url || busy) return;
  void runDraftOutreach({ url: activeTab.url, tabId: activeTab.id });
});

messageInputBtn.addEventListener("click", () => {
  const value = inputEl.value.trim();
  if (!value || busy) return;
  void runDraftOutreach({ input: value });
});

copyMessageBtn.addEventListener("click", async () => {
  const text = messageOutputEl.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyMessageBtn.textContent = "Copied ✓";
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyMessageBtn.textContent = "Copy";
    }, 2000);
  } catch {
    messageOutputEl.select();
    document.execCommand("copy");
    copyMessageBtn.textContent = "Copied ✓";
  }
});

regenMessageBtn.addEventListener("click", () => {
  if (busy) return;
  if (lastDraftRequest) {
    void runDraftOutreach(lastDraftRequest);
  } else if (activeTab?.url) {
    void runDraftOutreach({ url: activeTab.url, tabId: activeTab.id });
  }
});

closeMessageBtn.addEventListener("click", async () => {
  messageCardEl.classList.add("hidden");
  messageOutputEl.value = "";
  lastDraftRequest = null;
  await chrome.storage.local.remove("outreachDraft");
});

async function handleManualSubmit() {
  const value = inputEl.value;
  if (busy || !value.trim()) return;
  const links = extractLinkLines(value);
  const busyLabel =
    links.length > 1
      ? `Reading ${links.length} job postings…`
      : links.length === 1
        ? "Reading the job posting…"
        : "Saving…";
  await runSave(value, { busyLabel, source: "form" });
}

async function runSaveTab(tab) {
  setBusy(true, "Saving job posting…");
  renderFeedback({ tone: "warn", text: "Saving job posting…" });
  try {
    const cleanUrl = canonicalKeyForTab(tab.url);
    // Snapshot tab text directly inside the active click handler so activeTab
    // access is guaranteed and navigating away mid-request cannot mix jobs.
    const captured = typeof tab.id === "number" ? await captureTabTextInPopup(tab.id, 300) : { text: "", reason: "" };
    const fallbackInput = captured.text ? `${cleanUrl}\n${captured.text}` : "";

    // Call web2 directly from the popup so saving never fails due to a sleeping
    // or not-yet-reloaded MV3 service worker.
    const outcome = await submitToPipeline(cleanUrl, {
      labelHint: tab.title || cleanUrl,
      fallbackInput,
      fallbackError: captured.reason,
      tabKey: cleanUrl,
    });
    renderFeedback(outcome);
  } catch (err) {
    renderFeedback({
      tone: "bad",
      text: `Could not save job posting: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    setBusy(false);
  }
}

async function runSave(input, opts) {
  setBusy(true, opts.busyLabel);
  renderFeedback({ tone: "warn", text: opts.busyLabel });
  try {
    const outcome = await submitToPipeline(input, {
      labelHint: opts.labelHint,
    });
    renderFeedback(outcome);
    if (opts.source === "form") {
      if (Array.isArray(outcome.failedUrls)) {
        inputEl.value = outcome.failedUrls.join("\n");
      } else if (outcome.ok) {
        inputEl.value = "";
      }
    }
  } catch (err) {
    renderFeedback({
      tone: "bad",
      text: `Could not save: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    setBusy(false);
  }
}

async function runDraftOutreach(req) {
  lastDraftRequest = req;
  const startedAt = Date.now();
  setBusy(true, "Drafting…");
  renderFeedback({ tone: "warn", text: "Drafting hiring manager message… (0s)" });
  const ticker = setInterval(() => {
    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    renderFeedback({ tone: "warn", text: `Drafting hiring manager message… (${secs}s)` });
  }, 1000);
  try {
    const tabText = !req.input && typeof req.tabId === "number" ? (await captureTabTextInPopup(req.tabId, 80)).text : "";
    const payload = {
      ...req,
      ...(tabText ? { tabText } : {}),
    };

    // Call /api/outreach directly from the popup so Chrome MV3 service-worker
    // suspension or storage-key mismatches can never leave the popup stuck.
    const outcome = await draftOutreach(payload);
    if (!outcome.ok) {
      renderFeedback({ tone: "bad", text: outcome.error || "Could not draft message." });
      return;
    }
    renderFeedback(null);
    showDraftMessage(outcome.message);
  } catch (err) {
    renderFeedback({
      tone: "bad",
      text: `Could not draft message: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    clearInterval(ticker);
    setBusy(false);
  }
}

async function captureTabTextInPopup(tabId, minChars) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageJobTextInTab,
      args: [minChars],
    });
    const text = typeof res?.result === "string" ? res.result.trim() : "";
    if (text.length >= minChars) return { text, reason: "" };
    return { text: "", reason: `Tab text was too short (${text.length} chars; need ${minChars}+)` };
  } catch (err) {
    return { text: "", reason: `Could not read tab text (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Runs inside the active job/post tab to snapshot posting text. */
function extractPageJobTextInTab(minChars) {
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

function applySaveState(saveState) {
  if (saveState.status === "saving") {
    setBusy(true, "Saving job posting…");
    renderFeedback({ tone: "warn", text: "Saving job posting…" });
  } else if (saveState.status === "done" && saveState.outcome) {
    setBusy(false);
    renderFeedback(saveState.outcome);
  }
}

function applyDraftState(draft) {
  if (!draft) return;
  const currentKey = activeTab?.url ? canonicalKeyForTab(activeTab.url) : "manual";
  if (draft.key !== currentKey && draft.key !== "manual") return;
  if (draft.request) lastDraftRequest = draft.request;

  if (draft.status === "drafting") {
    // Only show "drafting" when actively running in this popup; ignore orphaned storage state.
    return;
  } else if (draft.status === "ready" && draft.message) {
    setBusy(false);
    renderFeedback(null);
    showDraftMessage(draft.message);
  } else if (draft.status === "error" && draft.error) {
    setBusy(false);
    renderFeedback({ tone: "bad", text: draft.error });
  }
}

function showDraftMessage(text) {
  messageOutputEl.value = text;
  messageCardEl.classList.remove("hidden");
  copyMessageBtn.textContent = "Copy";
}

function setBusy(nextBusy, label) {
  busy = nextBusy;
  saveTabBtn.disabled = busy;
  messageTabBtn.disabled = busy;
  regenMessageBtn.disabled = busy;
  if (busy && label) {
    saveInputBtn.disabled = true;
    messageInputBtn.disabled = true;
    saveInputBtn.textContent = label;
  } else {
    updateButtonState();
  }
}

function updateButtonState() {
  if (busy) return;
  const value = inputEl.value;
  const links = extractLinkLines(value);
  const hasText = Boolean(value.trim());
  saveInputBtn.disabled = !hasText;
  saveInputBtn.textContent = links.length > 1 ? `Save ${links.length} links` : "Save to pipeline";
  messageInputBtn.disabled = !hasText || links.length > 1;
}

function renderFeedback(outcome) {
  if (!outcome) {
    feedbackEl.classList.add("hidden");
    feedbackEl.classList.remove("feedback-bad");
    return;
  }
  feedbackEl.classList.remove("hidden");
  feedbackEl.classList.toggle("feedback-bad", outcome.tone === "bad");
  feedbackEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = `tone-${outcome.tone || "warn"}`;
  p.textContent = outcome.text || "Unknown error.";
  feedbackEl.appendChild(p);

  if (Array.isArray(outcome.items) && outcome.items.length > 0) {
    const ul = document.createElement("ul");
    for (const item of outcome.items) {
      const li = document.createElement("li");
      li.className = `tone-${item.tone || "warn"}`;
      li.textContent = item.text;
      ul.appendChild(li);
    }
    feedbackEl.appendChild(ul);
  }
}

function extractLinkLines(value) {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return lines.every((line) => /^https?:\/\/\S+$/i.test(line)) ? lines : [];
}

function canonicalKeyForTab(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      const jobId = u.searchParams.get("currentJobId");
      if (jobId && /^\d+$/.test(jobId)) return `https://www.linkedin.com/jobs/view/${jobId}/`;
    }
  } catch {
    /* keep rawUrl */
  }
  return rawUrl;
}

function isLocalBoardUrl(tabUrl) {
  try {
    return new URL(tabUrl).origin === new URL(SERVER_URL).origin;
  } catch {
    return false;
  }
}

const NON_JOB_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "youtube.com",
  "google.com",
  "mail.google.com",
  "docs.google.com",
  "drive.google.com",
  "calendar.google.com",
  "github.com",
  "gitlab.com",
  "reddit.com",
  "news.ycombinator.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "netflix.com",
  "amazon.com",
  "amazon.ca",
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "slack.com",
  "discord.com",
  "notion.so",
  "wikipedia.org",
]);

function isExcludedNonJobHost(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  for (const blocked of NON_JOB_HOSTS) {
    if (h === blocked || h.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function looksLikeJobPostingUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const params = u.searchParams;

  if (isExcludedNonJobHost(host)) return false;

  // LinkedIn: only actual job postings, never feed/profile/messages.
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    return /^\/(?:comm\/)?jobs\/view\//i.test(path) || /^\d+$/.test(params.get("currentJobId") || "");
  }

  // Known ATS / job board hosts.
  if (
    /(^|\.)(greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|bamboohr\.com|icims\.com|jobvite\.com|dayforcehcm\.com|eightfold\.ai|breezy\.hr|recruitee\.com|pinpointhq\.com|rippling\.com)$/i.test(host)
  ) {
    return path.split("/").filter(Boolean).length >= 2 || params.has("gh_jid") || params.has("ashby_jid");
  }

  if (/(^|\.)indeed\.com$/i.test(host)) {
    return /^\/viewjob/i.test(path) || params.has("jk") || params.has("vjk");
  }

  if (/(^|\.)(wellfound\.com|workatastartup\.com|joblet\.ai|glassdoor\.[a-z.]+)$/i.test(host)) {
    return /\/(jobs?|job-listing|companies\/[^/]+\/jobs)\//i.test(path);
  }

  // Embedded ATS / explicit job-ID query params on any employer domain.
  if (
    params.has("gh_jid") ||
    params.has("ashby_jid") ||
    params.has("career_jobid") ||
    params.has("jobId") ||
    params.has("job_id") ||
    params.has("requisitionId") ||
    (/(^|\.)(careers|jobs)\./i.test(host) && params.has("pid"))
  ) {
    return true;
  }

  // Employer careers/jobs subdomains or explicit job-detail paths.
  if (/\/(?:job|jobs|jobdetail|position|opening|openings|requisition)\/[^/]+/i.test(path)) return true;
  if (/\/careers\/(?:listing\/[^/]+|[^/]*\d{4,}[^/]*)/i.test(path)) return true;
  if (/^(?:jobs|careers|apply)\./i.test(host) && /\/(?:job|jobs|jobdetail|position|opening|posting|vacancy|role)\b/i.test(path)) {
    return true;
  }

  return false;
}

async function isJobPostingTab(tab) {
  if (looksLikeJobPostingUrl(tab.url)) return true;
  try {
    const host = new URL(tab.url).hostname.toLowerCase();
    if (isExcludedNonJobHost(host) || host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      return false;
    }
  } catch {
    return false;
  }
  if (typeof tab.id !== "number") return false;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectJobPostingInDom,
    });
    return Boolean(res?.result);
  } catch {
    return false;
  }
}

/** Fast DOM check for custom company career URLs without standard job path patterns. */
function detectJobPostingInDom() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent || "";
    if (/"@type"\s*:\s*(?:"JobPosting"|\[[^\]]*"JobPosting")/i.test(raw)) return true;
  }
  if (document.querySelector('iframe[src*="greenhouse.io"], iframe[src*="ashbyhq.com"], iframe[src*="lever.co"]')) {
    return true;
  }
  const hasApply = Array.from(document.querySelectorAll("a, button")).some((el) =>
    /^\s*apply(?:\s+now|\s+for\s+this\s+(?:job|role|position))?\s*$/i.test(el.textContent || ""),
  );
  if (!hasApply) return false;
  const text = (document.querySelector("main, [role=main], article") || document.body)?.innerText || "";
  const cues = [
    /\bresponsibilities\b/i,
    /\bqualifications\b/i,
    /\brequirements\b/i,
    /\bwhat you['’]ll (?:do|build|bring)\b/i,
    /\babout the role\b/i,
    /\bjob description\b/i,
  ];
  return cues.filter((re) => re.test(text)).length >= 2;
}
