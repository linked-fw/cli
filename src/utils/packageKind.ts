/**
 * What `linked create-package` scaffolds, decided without touching anything.
 *
 * A linked package is one of two kinds (create-now arch-03 §Package types):
 *
 * - an **ontology package**, `<name>-ont`: exactly one ontology and nothing
 *   else. Its ontology slug is `<name>` (no `-ont`), so its terms mint
 *   `{root}ont/<name>/{Term}` while the package itself is `<name>-ont`.
 * - an **asset package**, `<name>-assets`: shapes, components and a backend,
 *   and no ontology.
 *
 * `both` scaffolds the pair. The suffix is applied to the name given, unless
 * the name already carries it.
 */
import {bareName} from './createPackageLocation.js';

export const PACKAGE_KINDS = ['ontology', 'assets', 'both'] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

/** The kinds a single package can be: `both` expands to these two. */
export type ScaffoldKind = Exclude<PackageKind, 'both'>;

export const KIND_SUFFIX: Record<ScaffoldKind, string> = {
  ontology: '-ont',
  assets: '-assets',
};

export type KindDecision =
  | {kind: 'resolved'; packageKind: PackageKind}
  | {kind: 'ask'}
  | {kind: 'refuse'; message: string};

export function isPackageKind(value: string): value is PackageKind {
  return (PACKAGE_KINDS as readonly string[]).includes(value);
}

/**
 * `--kind` decides it. Without it a terminal is asked; anything else is
 * refused, so a scripted call never meets a prompt. `--remote` names one
 * repository, which cannot hold both packages.
 */
export function decidePackageKind({
  kind,
  remote,
  isTTY,
}: {
  kind?: string;
  remote?: string;
  isTTY: boolean;
}): KindDecision {
  if (kind !== undefined) {
    if (!isPackageKind(kind)) {
      return refuse(`--kind must be one of ${PACKAGE_KINDS.join(', ')}, not "${kind}".`);
    }
    if (kind === 'both' && remote) {
      return refuse(
        `--kind both creates two packages, and --remote names one repository. Create them ` +
          `separately: linked create-ont-package and linked create-asset-package.`,
      );
    }
    return {kind: 'resolved', packageKind: kind};
  }
  if (isTTY) return {kind: 'ask'};
  return refuse(
    `What kind of package? Pass --kind ontology (one ontology, no shapes: <name>-ont), ` +
      `--kind assets (shapes, components and a backend: <name>-assets) or --kind both.`,
  );
}

/** `both` → `['ontology', 'assets']`, in the order they are created. */
export function scaffoldKinds(kind: PackageKind): ScaffoldKind[] {
  return kind === 'both' ? ['ontology', 'assets'] : [kind];
}

/**
 * The package name a kind gives: `foo` → `foo-ont` / `foo-assets`, keeping an
 * npm scope (`@acme/foo` → `@acme/foo-ont`). A name that already ends in the
 * suffix is kept as it is, so `foo-ont` never becomes `foo-ont-ont`.
 */
export function packageNameFor(name: string, kind: ScaffoldKind): string {
  const suffix = KIND_SUFFIX[kind];
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

/**
 * The ontology slug of an ontology package: the bare name without `-ont`.
 * `@acme/foo-ont` → `foo`. It is the `{ontologySlug}` in
 * `{root}ont/{ontologySlug}/{Term}` and the ontology's file name and prefix.
 */
export function ontologySlugFor(packageName: string): string {
  const bare = bareName(packageName);
  const suffix = KIND_SUFFIX.ontology;
  const slug = bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : bare;
  if (!slug) {
    throw new Error(`Cannot derive an ontology slug from '${packageName}'`);
  }
  return slug;
}

/**
 * The template files of a kind, relative to the package root. The files every
 * package has come from `defaults/package`; an asset package is that whole
 * folder, an ontology package adds `defaults/package-ontology` on top of the
 * shared files only.
 */
export const PACKAGE_TEMPLATE_DIRS: Record<ScaffoldKind, string[]> = {
  assets: ['package'],
  ontology: ['package', 'package-ontology'],
};

/** The files of `defaults/package` every kind gets. The rest is asset-only. */
export const SHARED_TEMPLATE_FILES = [
  'gitignore.template',
  'npmignore.template',
  'package.json',
  'tsconfig.json',
  'tsconfig-esm.json',
  'src/package.ts',
] as const;

function refuse(message: string): KindDecision {
  return {kind: 'refuse', message};
}
