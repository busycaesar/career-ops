/**
 * upload-name.mjs — the file name an employer sees for the tailored CV the
 * apply flow attaches (#6399).
 *
 * The PDF on disk is named for career-ops, `cv-{candidate}-{report}-{company}-
 * {date}.pdf`, and the manifest and matchers (cv-match.mjs) depend on that
 * pattern, so it never changes. What changes is the name the upload carries:
 * fillSession hands Playwright a file payload (name + bytes) instead of the
 * path, so the ATS receives `First Last Resume Company Role.pdf` while the file on disk
 * keeps its own name.
 *
 * Plain .mjs (same pattern as cv-match.mjs) so the tests under web/tests/lib/
 * can import it with no build step.
 */

import fs from 'node:fs';

/**
 * `{First} {Last} Resume {Company} {Role}.pdf`, e.g. "Jane Smith Resume Acme AI
 * Engineer.pdf", dropping whichever part is unknown. Characters ATS uploads
 * reject (path separators, wildcards, quotes, emoji, control characters) are
 * removed. A name past MAX_NAME_CHARS shortens the role to its core title
 * first, then trims it.
 * @param {{ fullName?: string, company?: string, role?: string }} opts
 * @returns {string}
 */
export function cvUploadName({ fullName, company, role } = {}) {
  const head = [firstAndLast(fullName), 'Resume', cleanPart(company)].filter(Boolean).join(' ');
  const budget = MAX_NAME_CHARS - head.length - 1;
  let rolePart = cleanPart(role);
  if (rolePart.length > budget) rolePart = cleanPart(shortRole(role));
  if (rolePart.length > budget) rolePart = rolePart.slice(0, Math.max(0, budget)).trim();
  return [head, rolePart].filter(Boolean).join(' ') + '.pdf';
}

/**
 * The role, cut at its first qualifier: "Data Engineer, Data Quality &
 * Provenance" -> "Data Engineer", "Analyst (Remote)" -> "Analyst",
 * "Data Engineer - Talent Ops" -> "Data Engineer". A form title such as
 * "Data Engineer @ Acme" or "Analyst at Acme" loses the company first.
 * @param {string} role
 * @returns {string}
 */
export function shortRole(role) {
  const withoutCompany = String(role ?? '').split(/\s+@\s+|\s+at\s+(?=[A-Z])/)[0];
  return withoutCompany.split(/\s*(?:,|\(|\s[-–—|]\s)/)[0].trim();
}

/**
 * What fillSession passes to setInputFiles: the path itself when there is no
 * display name, else Playwright's file payload carrying that name and the
 * file's bytes. Reading the bytes leaves the file on disk untouched.
 * @param {string} cvPath
 * @param {string} [uploadName]
 * @returns {string | { name: string, mimeType: string, buffer: Buffer }}
 */
export function cvUploadFile(cvPath, uploadName) {
  if (!uploadName) return cvPath;
  return { name: uploadName, mimeType: 'application/pdf', buffer: fs.readFileSync(cvPath) };
}

/** "Jane A. Smith" -> "Jane Smith": a middle name or initial is left out of a file name. */
function firstAndLast(fullName) {
  const words = cleanPart(fullName).split(' ').filter(Boolean);
  return words.length <= 2 ? words.join(' ') : `${words[0]} ${words[words.length - 1]}`;
}

/** One name part with the characters ATS uploads reject removed and spaces collapsed. */
function cleanPart(value) {
  return String(value ?? '')
    .replace(REJECTED_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_NAME_CHARS = 120;
// Path separators, wildcards and quotes, then emoji (and their joiners and
// variation selectors) and control or other non-printable characters.
const REJECTED_CHARS = /[\/\\:*?"<>|]|\p{Extended_Pictographic}|[\u200D\uFE0E\uFE0F]|\p{C}/gu;
