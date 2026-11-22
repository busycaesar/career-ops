---
name: sync-projects
description: Add the user's new GitHub repositories to cv.md's Projects section, each under a domain, with its link and 1-3 bullets in the user's own format. Only repos no earlier run handled are looked at. Use when the user asks to sync, import or update their projects from GitHub.
---

# Sync projects from GitHub

Adds the user's GitHub repos that are not yet in cv.md `## Projects`. Later runs see only repos created since the last run; projects already in cv.md are never rewritten.

Files:
- `cv.md` `## Projects`: the projects, grouped by `### Domain`, each a `#### Name`.
- `data/project-format.md`: how an entry is written. Read it in full before drafting.
- `data/github-projects.json`: which repos were already handled. Written only by `github-projects.mjs mark`.

## Steps

1. Run `node github-projects.mjs fetch` from the career-ops root. It prints JSON with `newRepos`, each with name, url, description, language, topics, homepage, archived, README text and `likelyProject` (a cv.md project whose name matches). Forks are already excluded: a fork is someone else's work, never the user's project (AGENTS.md authorship rule). If `newRepos` is empty, say so and stop.
2. Sort every new repo into one of three groups.
   - **Already listed:** the repo is a project cv.md already has. Use `likelyProject` as a hint and confirm it from the README; also check projects whose names differ (e.g. `terminal-resume` may be "Interactive Shell Resume", `portfolio-site` may be "Personal Website"). Only that project's missing GitHub link is filled in (`Links: [GitHub](url)`, or replacing `GitHub (link needed)`). Its bullets are never touched.
   - **Skip:** nothing real to say. This covers a profile README repo (named after the user), templates and boilerplates, certification study notes, course exercises with no project of their own, near-empty READMEs, and archived toy repos. Give a one-line reason for each.
   - **Add:** a real project. Draft the entry per `data/project-format.md`: pick the domain (an existing one verbatim, or a new one when none fits), the human name, the `Links:` line, and 1–3 bullets.
3. **Facts come only from the repo.** Every claim in a bullet must be supported by that repo's README, description, language or topics. Never invent a feature, metric, user count or outcome. Use the past tense for finished work and the present continuous for active work (pushed in the last few months and described as in progress). When a repo has too little to support even one bullet, it goes to Skip.
4. **Show the user before writing.** List the three groups: the full drafted entries for Add, the link fills for Already listed, and the reasons for Skip. Write nothing to cv.md until the user confirms; apply their edits and drop anything they reject.
5. **Write.** Re-read cv.md right before writing, since the user edits it in their own editor, and change only the `## Projects` section:
   - add each entry at the end of its `### Domain`;
   - create a new domain just before `## Education`;
   - fill links in place.
6. **Record.** Run `node github-projects.mjs mark`:
   - `<repos> --as added` for those written;
   - `<repo> --as matched:<cv.md project name>` for Already listed;
   - `<repos> --as skipped:<reason>` for Skip.

   A repo the user rejected from Add is marked `skipped:user declined`, so it is not offered again. Then run `node doctor.mjs` and confirm it still recognises the Experience section.

To revisit a skipped repo later, the user removes it from `data/github-projects.json`, or runs `node github-projects.mjs fetch --all` to see every repo again.
