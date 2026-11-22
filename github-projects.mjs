#!/usr/bin/env node
/**
 * github-projects.mjs: the zero-LLM half of the /sync-projects skill.
 *
 * Lists the user's own public GitHub repositories and prints only the ones no
 * earlier run has handled, so each later run looks at new repos only and never
 * rewrites projects already in cv.md. The skill reads the output, writes the
 * cv.md entries with the user's confirmation, then records each repo here with
 * `mark`, so it is never offered again.
 *
 * Commands:
 *   node github-projects.mjs fetch [--user <login>] [--all]
 *     Prints JSON: { user, total, alreadyHandled, newRepos: [...] }. Each new
 *     repo carries its metadata, README text (truncated) and `likelyProject`,
 *     the cv.md project whose name matches it, if any. --all ignores the state.
 *   node github-projects.mjs mark <repo...> --as added|matched:<project>|skipped:<reason>
 *     Records the outcome in data/github-projects.json.
 *   node github-projects.mjs status
 *     Prints the state file's counts.
 *
 * Forks are excluded: a fork is someone else's project (AGENTS.md authorship
 * rule). Archived repos are kept and flagged. Read-only towards GitHub; the
 * only file it writes is the state file, and only on `mark`.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot, getProfilePath } from './path-resolver.mjs';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const PAGE_SIZE = 100;
const README_MAX_CHARS = 4000;
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README', 'README.rst', 'README.txt'];
const MARK_KINDS = ['added', 'matched', 'skipped'];
const MIN_SHARED_WORDS = 2;

async function main(argv) {
  const [command, ...rest] = argv;
  const root = getCareerOpsRoot();
  if (command === 'fetch') return printJson(await fetchNew(root, rest));
  if (command === 'mark') return printJson(markRepos(root, rest));
  if (command === 'status') return printJson(stateSummary(readState(root)));
  throw new UsageError(`Unknown command "${command ?? ''}". Use fetch, mark or status.`);
}

async function fetchNew(root, args) {
  const user = flagValue(args, '--user') ?? githubUserFromProfile(root);
  const state = readState(root);
  const repos = (await listOwnRepos(user)).filter((repo) => !repo.fork);
  const handled = args.includes('--all') ? {} : state.repos;
  const fresh = repos.filter((repo) => !handled[repo.name]);
  const projectNames = cvProjectNames(root);
  const newRepos = [];
  for (const repo of fresh) {
    newRepos.push({
      name: repo.name,
      url: repo.html_url,
      description: repo.description ?? '',
      language: repo.language ?? '',
      topics: repo.topics ?? [],
      homepage: repo.homepage ?? '',
      archived: repo.archived,
      createdAt: repo.created_at,
      pushedAt: repo.pushed_at,
      likelyProject: likelyProject(repo.name, projectNames),
      readme: await readReadme(user, repo),
    });
  }
  return { user, total: repos.length, alreadyHandled: repos.length - fresh.length, newRepos };
}

function markRepos(root, args) {
  const asIndex = args.indexOf('--as');
  if (asIndex < 1 || !args[asIndex + 1]) throw new UsageError('Usage: mark <repo...> --as added|matched:<project>|skipped:<reason>');
  const names = args.slice(0, asIndex);
  const outcome = parseOutcome(args.slice(asIndex + 1).join(' '));
  const state = readState(root);
  const at = new Date().toISOString();
  for (const name of names) state.repos[name] = { ...outcome, at };
  writeState(root, state);
  return { marked: names, ...outcome };
}

function parseOutcome(text) {
  const [kind, ...detail] = text.split(':');
  if (!MARK_KINDS.includes(kind)) throw new UsageError(`--as must start with ${MARK_KINDS.join(', ')}; got "${text}".`);
  const value = detail.join(':').trim();
  if (kind === 'matched' && !value) throw new UsageError('matched needs the cv.md project name: --as matched:<project>');
  if (kind === 'skipped' && !value) throw new UsageError('skipped needs a reason: --as skipped:<reason>');
  if (kind === 'matched') return { status: kind, project: value };
  if (kind === 'skipped') return { status: kind, reason: value };
  return { status: kind };
}

async function listOwnRepos(user) {
  const repos = [];
  for (let page = 1; ; page += 1) {
    const batch = await getJson(`${API}/users/${encodeURIComponent(user)}/repos?type=owner&per_page=${PAGE_SIZE}&page=${page}`);
    repos.push(...batch);
    if (batch.length < PAGE_SIZE) return repos;
  }
}

async function readReadme(user, repo) {
  for (const file of README_NAMES) {
    const response = await fetch(`${RAW}/${encodeURIComponent(user)}/${encodeURIComponent(repo.name)}/HEAD/${file}`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`README fetch for ${repo.name} failed: HTTP ${response.status}`);
    const text = (await response.text()).trim();
    return text.length > README_MAX_CHARS ? `${text.slice(0, README_MAX_CHARS)}\n[truncated]` : text;
  }
  return '';
}

async function getJson(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'career-ops-github-projects' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const hint = response.status === 403 ? ' (rate limit: wait an hour or set GITHUB_TOKEN)' : '';
    throw new Error(`GitHub API ${url} returned HTTP ${response.status}${hint}`);
  }
  return response.json();
}

function githubUserFromProfile(root) {
  const profile = yaml.load(readFileSync(getProfilePath(root), 'utf8')) ?? {};
  const link = profile?.candidate?.github ?? profile?.github ?? '';
  const login = String(link).replace(/^https?:\/\//, '').replace(/^(www\.)?github\.com\//, '').split(/[/?#]/)[0];
  if (!login) throw new UsageError('No GitHub link in config/profile.yml (candidate.github). Pass --user <login>.');
  return login;
}

/** Project names under cv.md's "## Projects": its #### headings. */
function cvProjectNames(root) {
  const cvPath = path.join(root, 'cv.md');
  if (!existsSync(cvPath)) return [];
  const names = [];
  let inProjects = false;
  for (const line of readFileSync(cvPath, 'utf8').split('\n')) {
    if (/^## /.test(line)) inProjects = /^## Projects\s*$/i.test(line);
    const heading = inProjects && line.match(/^#### (.+)$/);
    if (heading) names.push(heading[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim());
  }
  return names;
}

/**
 * A hint for the skill, not a decision: the cv.md project whose name shares
 * the most words with the repo's. An identical word set wins outright;
 * otherwise a candidate needs all of the shorter name's words, or at least
 * MIN_SHARED_WORDS, and a tie between candidates gives no hint at all.
 */
function likelyProject(repoName, projectNames) {
  const repoWords = nameWords(repoName);
  let best = null;
  let bestShared = 0;
  let tied = false;
  for (const name of projectNames) {
    const words = nameWords(name);
    const shared = [...words].filter((word) => repoWords.has(word)).length;
    if (shared === words.size && shared === repoWords.size) return name;
    const contained = shared === Math.min(words.size, repoWords.size);
    if (!contained && shared < MIN_SHARED_WORDS) continue;
    if (shared > bestShared) [best, bestShared, tied] = [name, shared, false];
    else if (shared === bestShared) tied = true;
  }
  return tied ? null : best;
}

/** Lowercase words of a name: split on separators and camelCase. */
function nameWords(text) {
  const spaced = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/([a-z])([A-Z0-9])/g, '$1 $2');
  return new Set(spaced.toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean));
}

function statePath(root) {
  return path.join(root, 'data', 'github-projects.json');
}

function readState(root) {
  const file = statePath(root);
  if (!existsSync(file)) return { repos: {} };
  const state = JSON.parse(readFileSync(file, 'utf8'));
  return { ...state, repos: state.repos ?? {} };
}

function writeState(root, state) {
  const file = statePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

function stateSummary(state) {
  const counts = Object.fromEntries(MARK_KINDS.map((kind) => [kind, 0]));
  for (const entry of Object.values(state.repos)) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return { handled: Object.keys(state.repos).length, ...counts };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(error instanceof UsageError ? 2 : 1);
});
