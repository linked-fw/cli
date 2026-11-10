/**
 * A package's ontology declarations: the `package.json` `"linkedOntologies"` entries, read and
 * validated. Pure (no file system), so any tool, in Node or a browser, finds an ontology's name,
 * namespace, module path and data files from the parsed `package.json`:
 *
 * ```ts
 * readOntologyConfigs(pkgJson)
 * // [{name: 'core', namespace: 'https://example.org/core/', module: 'linked-core',
 * //   generated: false, data: ['core.ttl']}]
 * ```
 *
 * The public import path of an ontology's terms is `<package>/ontologies/<module>`.
 */
import {ONTOLOGY_NAME} from './ontologyModules.js';

/** One `linkedOntologies` entry, validated. */
export interface OntologyConfig {
  /** The ontology's name within the package (the `linkedOntologies` key). */
  name: string;
  namespace: string;
  /** File names in `src/data/`. */
  data: string[];
  /**
   * The modules' file name in `src/ontologies/`, without extension; the public import path is
   * `<package>/ontologies/<module>`. Defaults to the name.
   */
  module: string;
  /** False: the modules are written by hand, so none is generated or checked for staleness. */
  generated: boolean;
}

/** What a `linkedOntologies` namespace must be: an IRI ending in a separator. */
export const ONTOLOGY_NAMESPACE = /^[a-z][a-z0-9+.-]*:\S*[/#:]$/i;

/** The `package.json` key. */
export const ONTOLOGIES_KEY = 'linkedOntologies';

/**
 * The package's `linkedOntologies` (its parsed `package.json`), sorted by name; empty when it has
 * none. Each entry carries its name, namespace, module, whether it is generated, and its data
 * files. Throws, naming the entry, on anything malformed and on two entries with one module.
 */
export function readOntologyConfigs(
  pkgJson: Record<string, unknown>,
): OntologyConfig[] {
  const raw = pkgJson[ONTOLOGIES_KEY];
  if (raw === undefined) return [];
  const where = `package.json "${ONTOLOGIES_KEY}"`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${where} must be an object of {"<name>": {"namespace": "<IRI>"}}.`,
    );
  }
  const configs = Object.entries(raw as Record<string, unknown>)
    .map(([name, entry]): OntologyConfig => {
      const at = `${where}.${name}`;
      // Lowercase only, so two names never differ only in case (one file on a case-insensitive
      // file system).
      if (!ONTOLOGY_NAME.test(name)) {
        throw new Error(
          `${at}: the name must be lowercase letters and digits, with single hyphens or underscores between them.`,
        );
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${at} must be an object with a "namespace".`);
      }
      const {namespace, data, module, generated} = entry as {
        namespace?: unknown;
        data?: unknown;
        module?: unknown;
        generated?: unknown;
      };
      if (
        typeof namespace !== 'string' ||
        !ONTOLOGY_NAMESPACE.test(namespace)
      ) {
        // Ending in a separator, so `…/ont` cannot claim `…/ontology` as the term `ology`.
        throw new Error(
          `${at}.namespace must be an IRI ending in /, # or :, such as "https://example.org/ont/".`,
        );
      }
      const files = data === undefined ? [`${name}.ttl`] : data;
      if (
        !Array.isArray(files) ||
        !files.length ||
        files.some(
          (f) =>
            typeof f !== 'string' ||
            !/^[A-Za-z0-9_][A-Za-z0-9._-]*\.ttl$/.test(f),
        )
      ) {
        throw new Error(
          `${at}.data must list one or more .ttl file names in src/data/.`,
        );
      }
      if (
        module !== undefined &&
        (typeof module !== 'string' || !ONTOLOGY_NAME.test(module))
      ) {
        throw new Error(
          `${at}.module must be a file name in src/ontologies/ without extension: lowercase letters and digits, with single hyphens or underscores between them.`,
        );
      }
      if (generated !== undefined && typeof generated !== 'boolean') {
        throw new Error(
          `${at}.generated must be true (the default) or false (modules written by hand).`,
        );
      }
      return {
        name,
        namespace,
        data: files as string[],
        module: typeof module === 'string' ? module : name,
        generated: generated !== false,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const byModule = new Map<string, string>();
  for (const {name, module} of configs) {
    const other = byModule.get(module);
    if (other !== undefined) {
      throw new Error(
        `${where}: "${other}" and "${name}" both use the module src/ontologies/${module}.ts; give one of them its own "module".`,
      );
    }
    byModule.set(module, name);
  }
  return configs;
}
