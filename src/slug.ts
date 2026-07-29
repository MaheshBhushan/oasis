/**
 * Accept anything that identifies a repo, because in practice you paste
 * whatever is on your clipboard: a browser URL, a clone URL, an SSH remote, or
 * a bare slug.
 *
 * `owner` here is the repo's owner. Watching repos you don't own is the whole
 * point of the tracker, so nothing about this is restricted to your account.
 */
export function splitSlug(input: string): [string, string] | null {
  const cleaned = input
    .trim()
    .replace(/^<|>$/g, "") // Discord wraps suppressed links in angle brackets
    .replace(/^git@[^:]+:/, "") // git@github.com:owner/repo
    .replace(/^[a-z+]+:\/\//i, "") // strip scheme
    .replace(/^(?:www\.)?github\.com\//i, "") // strip host
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  // A pasted deep link (…/owner/repo/issues/42) still identifies the repo.
  const m = /^([\w.-]+)\/([\w.-]+)(?:\/|$)/.exec(cleaned);
  return m ? [m[1]!, m[2]!] : null;
}
