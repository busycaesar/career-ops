# career-ops — Custom Fork (`web2` & Extras)

This fork builds on top of [**career-ops**](https://github.com/career-ops-hq/career-ops) (created by [**@santifer**](https://github.com/santifer) and contributors) with a self-contained Kanban web app (`web2/`), a Chromium browser extension (`web2/extension/`), automatic backup-CLI fallback, and a GitHub project sync workflow — while keeping upstream `career-ops` core scripts and `web/` untouched for clean upstream updates.

---

## Features Added in This Fork

### 1. Kanban Job-Search Board (`web2/`)
- **Five-stage drag-and-drop workflow:** `Interested → Evaluate → Custom Resume → Application → Applied`, with per-column manual reordering persisted in `data/web2-board.json`.
- **Detached background workers (`worker/run-card.mjs`):** Evaluations, CV builds, employer-link lookups, and form fills run in detached Node processes so restarting the `web2` dev server doesn't kill in-flight jobs.
- **Minimal card UI:** Pulsing status dot while a step is running, inline evaluation score, one-click `Open CV` PDF preview, per-card notes, and referral tracking.
- **Two-section `Application` column:**
  - **Ready to submit** — forms auto-filled and handed off in a browser window so you only review and click Submit.
  - **Fill it yourself** — postings that can't be auto-filled (e.g., Workday, iCIMS, UKG, login walls, or careers-list links) stay in `Application` under a calm, non-error section with the reason and a direct link to the application page.

### 2. Automatic Employer-Link Finder
- When a job is saved from a third-party board (such as LinkedIn), `web2` checks the off-site Apply link, public ATS boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee), and web search to swap the card onto the employer's own posting.
- When a posting can't be confirmed at the employer, the card keeps the original link quietly with a muted `Not confirmed at employer` badge, the specific reason (when known), and a retry button.

### 3. Silent Primary → Backup CLI Fallback
- Tracks usage-limit cooldowns in `.career-ops-web/cli-cooldown.json`.
- When your primary CLI (e.g., `claude`) hits a rate/usage limit, `web2` automatically and silently continues on your installed backup CLI (`antigravity` / `agy`, then `gemini`) across evaluations, CV generation, form answer drafting, employer-link search, and outreach.
- Surfaces a limit notice only when **both** primary and backup models have hit their limits.
- Optional overrides in `.env`:
  ```env
  CAREER_OPS_FALLBACK_CLI=antigravity   # antigravity | gemini | none
  CAREER_OPS_FALLBACK_MODEL=            # optional --model override
  ```

### 4. Discover Browser Extension (`web2/extension/`)
- Save one or multiple job URLs (or pasted descriptions) directly to your local `web2` board, with automatic active-tab extraction when sites block headless fetching (such as LinkedIn login walls).
- Draft short hiring-manager outreach messages right from the popup using your `cv.md`, `config/profile.yml`, and writing samples.
- See [extension/README.md](extension/README.md) for load-unpacked install steps.

### 5. Google Drive Workspace Settings
- Connect Google Drive from `web2`'s **Settings** page (`GOOGLE_API_KEY` + local OAuth credentials in `data/`, all gitignored) to pick and link your Drive workspace folder.

### 6. GitHub Project Sync (`/sync-projects`)
- [`github-projects.mjs`](../github-projects.mjs) + [`.claude/skills/sync-projects/SKILL.md`](../.claude/skills/sync-projects/SKILL.md) list your new public (non-fork) GitHub repositories, match or draft entries for `cv.md`'s `## Projects` section, and track handled repos in `data/github-projects.json`.

---

## Quick Start (`web2`)

Make sure you've completed the base `career-ops` setup (`cv.md`, `config/profile.yml`, and root dependencies) first.

```bash
cd web2
npm install
npm run dev
```

Open [http://localhost:3001](http://localhost:3001).

To install the browser extension, follow [web2/extension/README.md](extension/README.md).

---

## Credits

Built on top of [**career-ops**](https://github.com/career-ops-hq/career-ops) by [**@santifer**](https://github.com/santifer) and its open-source community. Licensed under the same [MIT License](../LICENSE).
