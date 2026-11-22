# career-ops Discover Browser Extension

Send job posting links (or pasted descriptions) straight to your local `web2` Discover pipeline (`POST http://localhost:3001/api/pipeline`), or draft a short hiring-manager outreach message (`POST http://localhost:3001/api/outreach`).

## Install (Chrome, Brave, Edge, Arc, Chromium)

1. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`web2/extension`).
4. Pin **career-ops Discover** to your toolbar.

## Usage

- **Save job posting:** tries saving by link first, and automatically falls back to reading the job description from your open tab if the site blocks headless reads (e.g. LinkedIn login walls).
- **Message hiring manager:** drafts a short, metric-backed outreach message starting with `Hi [Name],` using your `cv.md`, `config/profile.yml`, and `writing-samples/hiring-manager-outreach.md`, ready to tweak and copy.
- **Multiple links / pasted JD:** paste one or more job URLs (one per line) or a job description into the box and press `Ctrl+Enter` / `Cmd+Enter`.
- **Right-click menu:** right-click any job link or posting → **Save link to career-ops** / **Save job posting to career-ops**.
