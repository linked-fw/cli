/**
 * Whether a string is a branch name git accepts, without running git: the rules of
 * `git check-ref-format --branch <name>` (git-check-ref-format(1)), applied to `refs/heads/<name>`.
 * Pure, so the `linked.unpublishedPackages` reader can call it.
 */
export function isBranchName(name: string): boolean {
  if (!name || name === 'HEAD' || name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  // Control characters, space, DEL and ~ ^ : ? * [ \
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}
