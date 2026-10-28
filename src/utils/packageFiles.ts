/**
 * The files `linked create-package --kind ontology|assets` produces, as data:
 * package-relative path → content. `createPackage` writes them; a host that
 * commits a package elsewhere (Create Now, through the GitHub API) uses the
 * same function, so there is one definition of what a new package holds.
 *
 * Pure apart from reading the templates in this package's own `defaults/`:
 * nothing is written, nothing is asked and nothing is installed.
 *
 * What a kind gets (`PACKAGE_TEMPLATE_DIRS`): every kind gets the shared files
 * of `defaults/package` (manifest, tsconfigs, dotfiles, `src/package.ts`); an
 * asset package gets the rest of that folder, an ontology package gets
 * `defaults/package-ontology` on top, with the example ontology named after its
 * ontology slug. Dotfiles ship under neutral names (`gitignore.template`) and
 * are returned under their real ones (`.gitignore`).
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {bareName} from './createPackageLocation.js';
import {asNamespace, defaultOntologyNamespace} from './ontologyNamespace.js';
import {
  ontologySlugFor,
  PACKAGE_TEMPLATE_DIRS,
  SHARED_TEMPLATE_FILES,
  type ScaffoldKind,
} from './packageKind.js';
import {withBaseUri} from './packageBaseUri.js';
import {shippedDotfileName} from './shippedDotfiles.js';
import {generateOntologyModules, ONTOLOGY_PREFIX} from './ontologyModules.js';
import {ONTOLOGIES_KEY, ONTOLOGY_NAMESPACE} from './generateOntology.js';

export interface PackageFilesOptions {
  /**
   * The ontology namespace, as `create-package <name> <uriBase>` takes it.
   * Without it: `{baseUri}ont/{slug}/` when `baseUri` is given, else
   * `https://linked.cm/ont/{slug}/`.
   */
  uriBase?: string;
  /**
   * The root the package's IRIs mint under, declared as a literal in
   * `src/package.ts` (`linkedPackage(name, {baseUri})`). Taken as given: pass
   * it through `normalizeBaseUri` first when it comes from a user.
   */
  baseUri?: string;
  /**
   * Dependencies (name → range) added to the template's `package.json`, e.g.
   * an asset package's ontology package.
   */
  dependencies?: Record<string, string>;
  /** The templates folder. Defaults to this package's `defaults/`. */
  templatesDir?: string;
}

/** Package-relative path (`/`-separated) → file content. */
export type PackageFiles = Record<string, string>;

/** The files whose `${…}` variables are filled; the rest are copied as they are. */
const FILLED_FILES = ['src/index.ts', 'package.json', 'src/package.ts'];

/**
 * The ontology kind's example files, renamed to the ontology slug. Its accessor modules are not
 * templates: they are generated ({@link ontologyScaffoldModules}).
 */
const EXAMPLE_ONTOLOGY_FILES = ['src/data/example-ontology.ttl'];
const FILLED_ONTOLOGY_FILES = EXAMPLE_ONTOLOGY_FILES;

/**
 * The accessor modules of a new ontology with no terms yet (`src/ontologies/<prefix>.ts`,
 * `.data.ts`, `.register.ts`), exactly as `linked generate-ontology` writes them for its
 * scaffolded Turtle (`src/data/<prefix>.ttl`, which declares only the ontology), so the first
 * `linked build` finds them current.
 */
export function ontologyScaffoldModules(
  prefix: string,
  namespace: string,
): PackageFiles {
  return generateOntologyModules({
    prefix,
    namespace,
    dataFiles: [`../data/${prefix}.ttl`],
    terms: [],
  });
}

/**
 * `package.json` text with the ontology's `linkedOntologies` entry added (`data` left to its
 * default, `["<prefix>.ttl"]`).
 */
export function withOntologyEntry(
  packageJson: string,
  prefix: string,
  namespace: string,
): string {
  const pkg = JSON.parse(packageJson);
  const entries = pkg[ONTOLOGIES_KEY] ?? {};
  // An existing entry (its own `data` list, say) is the package's; it is kept.
  if (entries[prefix]) return packageJson;
  pkg[ONTOLOGIES_KEY] = {...entries, [prefix]: {namespace}};
  // The file's own indentation and line endings are kept.
  const indent = /^[ \t]+(?=")/m.exec(packageJson)?.[0] ?? '  ';
  const eol = packageJson.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(pkg, null, indent).replace(/\n/g, eol) + eol;
}

/**
 * Refuses an ontology the scaffold cannot write: a slug that cannot name the modules or be a
 * Turtle prefix (it must start with a letter: `@prefix 3d:` is not Turtle), or a namespace that
 * is not an IRI ending in `/`, `#` or `:` (what `linkedOntologies` accepts).
 */
export function checkScaffoldOntology(prefix: string, namespace: string): void {
  if (!ONTOLOGY_PREFIX.test(prefix) || !/^[a-z]/i.test(prefix)) {
    throw new Error(
      `${JSON.stringify(prefix)} cannot name an ontology: start with a letter, then letters and digits, with single hyphens or underscores between them.`,
    );
  }
  if (!ONTOLOGY_NAMESPACE.test(namespace)) {
    throw new Error(
      `${JSON.stringify(namespace)} is not an ontology namespace: use an IRI ending in /, # or :, such as "https://example.org/ont/".`,
    );
  }
}

/**
 * This package's `defaults/` folder. The built module sits in `lib/esm/utils/`
 * and the source in `src/utils/`, so it is three or two levels up.
 */
export function cliTemplatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', '..', 'defaults'),
    path.join(here, '..', '..', 'defaults'),
  ];
  return (
    candidates.find((dir) => fs.existsSync(path.join(dir, 'package'))) ??
    candidates[1]
  );
}

/** The name forms a template can use, as `setNameVariables` derives them. */
export function nameVariants(name: string) {
  return {
    hyphenName: name.toLowerCase().replace(/[-_\s]+/g, '-'),
    camelCaseName: camelCase(name),
    underscoreName: name.replace(/[-\s]+/g, '_'),
    plainName: name.replace(/[-\s]+/g, ''),
  };
}

/** `some-package` → `somePackage`; a one-word name is kept as it is. */
function camelCase(str: string): string {
  const words = str.replace(/[^A-Za-z0-9]/g, ' ').split(' ');
  if (words.length < 2) return str;
  return words.reduce(
    (result, word) =>
      result + word.charAt(0).toUpperCase() + word.toLowerCase().slice(1),
  );
}

/**
 * The files of a new package of one kind, by package-relative path, sorted.
 *
 *   buildPackageFiles('@acme/planning-ont', 'ontology', {baseUri: 'https://acme.example/'})
 *   // → {'.gitignore': …, 'package.json': …, 'src/ontologies/planning.ts': …, …}
 *
 * `packageName` is used as given: `packageNameFor(name, kind)` adds the kind's
 * suffix the way the command does.
 */
export function buildPackageFiles(
  packageName: string,
  kind: ScaffoldKind,
  options: PackageFilesOptions = {},
): PackageFiles {
  const templatesDir = options.templatesDir ?? cliTemplatesDir();
  const {baseUri, dependencies} = options;

  // An ontology package `foo-ont` holds the ontology `foo`: that slug names its
  // files and its prefix, and its terms mint `{root}ont/foo/{Term}`.
  const ontologySlug =
    kind === 'ontology' ? ontologySlugFor(packageName) : undefined;
  const uriBase =
    options.uriBase ||
    (baseUri
      ? `${baseUri}ont/${ontologySlug ?? bareName(packageName)}/`
      : defaultOntologyNamespace(ontologySlug ?? packageName));

  const name = ontologySlug ?? bareName(packageName);
  const {hyphenName, camelCaseName, underscoreName, plainName} =
    nameVariants(name);
  // Longer similar names before the shorter ones.
  const variables: Record<string, string> = {
    uri_base: asNamespace(uriBase),
    package_name: packageName,
    output_file_name: packageName,
    underscore_name: underscoreName,
    hyphen_name: hyphenName,
    camel_name: camelCaseName,
    name,
    plain_name: plainName,
  };
  const fill = (content: string) =>
    Object.entries(variables).reduce(
      (out, [key, value]) => out.split('${' + key + '}').join(value),
      content,
    );

  // Template path → source file. A later folder overrides an earlier one.
  const sources = new Map<string, string>();
  const [shared, ...variants] = PACKAGE_TEMPLATE_DIRS[kind];
  if (variants.length === 0) {
    for (const file of listFiles(path.join(templatesDir, shared))) {
      sources.set(file, path.join(templatesDir, shared, file));
    }
  } else {
    for (const file of SHARED_TEMPLATE_FILES) {
      sources.set(file, path.join(templatesDir, shared, file));
    }
    for (const variant of variants) {
      for (const file of listFiles(path.join(templatesDir, variant))) {
        sources.set(file, path.join(templatesDir, variant, file));
      }
    }
  }

  const filled = new Set(
    kind === 'ontology'
      ? [...FILLED_FILES, ...FILLED_ONTOLOGY_FILES]
      : FILLED_FILES,
  );
  const files: PackageFiles = {};
  for (const [file, source] of sources) {
    let content = fs.readFileSync(source, 'utf8');
    if (filled.has(file)) content = fill(content);
    files[outputPath(file, kind === 'ontology' ? hyphenName : undefined)] =
      content;
  }

  if (kind === 'ontology') {
    checkScaffoldOntology(hyphenName, variables.uri_base);
    Object.assign(files, ontologyScaffoldModules(hyphenName, variables.uri_base));
    files['package.json'] = withOntologyEntry(
      files['package.json'],
      hyphenName,
      variables.uri_base,
    );
  }
  if (baseUri) {
    files['src/package.ts'] = withBaseUri(files['src/package.ts'], baseUri);
  }
  // The package says what it is: `linked.kind` merged into the template's
  // `linked` object, never replacing it.
  const pkg = JSON.parse(files['package.json']);
  pkg.linked = {...pkg.linked, kind};
  if (dependencies && Object.keys(dependencies).length) {
    pkg.dependencies = {...pkg.dependencies, ...dependencies};
  }
  files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';

  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Where a template file lands: dotfiles restored, the example ontology renamed. */
function outputPath(
  file: string,
  ontologyFileName: string | undefined,
): string {
  const parts = file.split('/');
  let last = shippedDotfileName(parts.pop()!);
  if (ontologyFileName && EXAMPLE_ONTOLOGY_FILES.includes(file)) {
    const [, ...extensions] = last.split('.');
    last = [ontologyFileName, ...extensions].join('.');
  }
  return [...parts, last].join('/');
}

/** Every file under a folder, relative and `/`-separated. */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...listFiles(dir, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}
