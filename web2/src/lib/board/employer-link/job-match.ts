/**
 * Whether two job titles name the same role. Compared on letters and digits
 * only, so "Dev Ops I" and "DevOps I", or "Engineer - AI" and "Engineer, AI",
 * match; a different word ("Senior", "II", another team) does not.
 */
export function titleMatches(candidate: string, role: string): boolean {
  const wanted = compactTitle(role);
  return wanted.length > 0 && compactTitle(candidate) === wanted;
}

/** Whether a page's text names the role, for checking a found link is this job. */
export function pageNamesRole(pageText: string, role: string): boolean {
  const wanted = compactTitle(role);
  return wanted.length > 0 && compactTitle(pageText).includes(wanted);
}

function compactTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, "");
}
