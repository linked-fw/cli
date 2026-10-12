/**
 * Every refusal in localize throws a LocalizeError carrying an exit code, so
 * callers can branch on `.code` rather than matching on a message.
 *
 * The codes are a public contract: scripts depend on them. 3 (unusable
 * manifest file) and 8 (manifests changed) belonged to the retired record
 * file and the hand-written links, and are not reused.
 */

/** `--list --check` found drift. */
export const EXIT_DRIFT = 1;
/** The command line asks for something that cannot be done as given. */
export const EXIT_USAGE = 2;
/** No git repository could be resolved for the package name. */
export const EXIT_NOT_FOUND = 4;
/** Something was warned about and skipped; the command otherwise worked. */
export const EXIT_WARNED = 5;
/** A guard refused to act (an existing directory, a conflicting override, unpushed work). */
export const EXIT_REFUSED = 6;
/** `npm install` (or `npm ci`) at the app root failed. */
export const EXIT_INSTALL_FAILED = 7;

export class LocalizeError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'LocalizeError';
    this.code = code;
  }
}
