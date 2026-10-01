/**
 * `linked doctor` — check an app's dev dependency setup for the problems that
 * otherwise only show up in the browser.
 *
 * It loads the app's Vite config the way the dev server does, runs the same
 * client-dependency scan `createViteConfig` runs (./client-dep-includes.ts), and
 * warns about:
 *
 * - `optimizeDeps.include` entries that do not resolve. Vite only logs these,
 *   and the dependency then reaches the browser unoptimised — a CommonJS one
 *   fails on `require`. The usual cause is a package npm installed NESTED under
 *   a framework package, which needs the `'<pkg> > <dep>'` form.
 * - a framework package's dependency whose React peer range excludes the app's
 *   React. That is why npm nests it (vaul 0.9 under `@_linked/primitives` with
 *   React 19); the fix is a newer release of the dependency in that package.
 *
 * Hand-written include entries that the scan now generates are listed too, as
 * safe to delete.
 */
import path from 'node:path';
import semver from 'semver';
import {readInstalledPkg} from '../installed-packages.js';
import {
  lastClientDepScan,
  packageNameOf,
  resolvePackageFile,
  scanLinkedClientDeps,
  type ClientDepScan,
} from '../client-dep-includes.js';

export interface DoctorFinding {
  level: 'warn' | 'info';
  message: string;
}

export interface DiagnoseInput {
  cwd: string;
  /** The app's own `optimizeDeps.include` (hand-written, before generation). */
  appInclude: string[];
  scan: ClientDepScan;
}

/** Split a Vite include entry (`a > b > c/sub`) and resolve it hop by hop, like Vite's nested-dep syntax. */
export async function resolveIncludeEntry(
  cwd: string,
  entry: string,
): Promise<string | null> {
  const hops = entry
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  let fromDir = cwd;
  for (let i = 0; i < hops.length; i++) {
    const name = packageNameOf(hops[i]);
    const installed = await readInstalledPkg(name, fromDir);
    if (!installed) return null;
    if (i === hops.length - 1) {
      const subpath = hops[i] === name ? '.' : `.${hops[i].slice(name.length)}`;
      return resolvePackageFile(installed.root, installed.json, subpath);
    }
    fromDir = installed.root;
  }
  return null;
}

/** The peer names whose ranges must admit the app's copy. */
const CHECKED_PEERS = ['react', 'react-dom'];

export async function diagnose({
  cwd,
  appInclude,
  scan,
}: DiagnoseInput): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const generated = new Map(scan.entries.map((e) => [e.entry, e]));

  // 1. Include entries that do not resolve.
  await Promise.all(
    appInclude.map(async (entry) => {
      if (await resolveIncludeEntry(cwd, entry)) return;
      const nestedForm = scan.entries.find(
        (e) => e.nested && (e.specifier === entry || e.depName === entry),
      );
      findings.push({
        level: 'warn',
        message:
          `optimizeDeps.include entry '${entry}' does not resolve from ${cwd}` +
          (nestedForm
            ? ` — it is installed under ${nestedForm.from}; use '${nestedForm.entry}' (generated automatically, so the entry can simply be removed)`
            : ' — remove it from vite.config, or install the package'),
      });
    }),
  );

  // 2. Dependencies of framework packages whose React peer range excludes the app's React.
  const appVersions = new Map<string, string>();
  for (const peer of CHECKED_PEERS) {
    const installed = await readInstalledPkg(peer, cwd);
    if (installed?.json?.version) appVersions.set(peer, installed.json.version);
  }
  const seen = new Set<string>();
  for (const pkg of scan.frameworkPackages) {
    for (const dep of Object.keys(pkg.json?.dependencies ?? {})) {
      const installed = await readInstalledPkg(dep, pkg.root);
      if (!installed || seen.has(`${pkg.name}\0${dep}`)) continue;
      const excluded = [...appVersions].filter(([peer, version]) => {
        const range = installed.json.peerDependencies?.[peer];
        return (
          range && !semver.satisfies(version, range, {includePrerelease: true})
        );
      });
      if (!excluded.length) continue;
      seen.add(`${pkg.name}\0${dep}`);
      const [firstPeer, appVersion] = excluded[0];
      const nested =
        path
          .relative(cwd, installed.root)
          .split(path.sep)
          .filter((s) => s === 'node_modules').length > 1;
      findings.push({
        level: 'warn',
        message:
          `${pkg.name} depends on ${dep}@${installed.json.version}, whose peer range ` +
          excluded
            .map(
              ([peer]) => `${peer} '${installed.json.peerDependencies[peer]}'`,
            )
            .join(', ') +
          ` excludes the app's ${excluded.map(([peer, v]) => `${peer} ${v}`).join(', ')}` +
          (nested ? `, so npm installed it nested under ${pkg.name}` : '') +
          `. Bump ${dep} in ${pkg.name} to a release that supports ${firstPeer} ${semver.major(appVersion)}.`,
      });
    }
  }

  // 3. Hand-written entries the scan generates anyway.
  const redundant = appInclude.filter((e) => generated.has(e));
  if (redundant.length) {
    findings.push({
      level: 'info',
      message:
        `${redundant.length} optimizeDeps.include entr${redundant.length === 1 ? 'y is' : 'ies are'} generated ` +
        `automatically and can be removed from vite.config:\n` +
        redundant.map((e) => `    ${e}`).join('\n'),
    });
  }
  return findings;
}

export interface DoctorOptions {
  cwd?: string;
}

/** Load the app's dev config and return what the plugin scanned, running the scan itself if the plugin did not. */
async function loadAppScan(
  cwd: string,
): Promise<{appInclude: string[]; scan: ClientDepScan}> {
  const {resolveConfig} = await import('vite');
  lastClientDepScan.current = null;
  const config = await resolveConfig(
    {root: cwd, mode: 'development', logLevel: 'error'},
    'serve',
  );
  const recorded = lastClientDepScan.current as
    import('../client-dep-includes.js').RecordedClientDepScan | null;
  if (recorded && path.resolve(recorded.cwd) === path.resolve(cwd)) {
    return {appInclude: recorded.appInclude, scan: recorded.scan};
  }
  // The app does not use createViteConfig (or turned the generation off): scan
  // what it excludes, with the workspaces the helper would have discovered.
  const {discoverWorkspaces} = await import('../vite-config.js');
  const optimizeDeps = config.optimizeDeps ?? {};
  return {
    appInclude: optimizeDeps.include ?? [],
    scan: await scanLinkedClientDeps(optimizeDeps.exclude ?? [], {
      cwd,
      sourceWorkspaces: await discoverWorkspaces([], cwd),
    }),
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const started = performance.now();
  const {appInclude, scan} = await loadAppScan(cwd);
  const findings = await diagnose({cwd, appInclude, scan});
  for (const f of findings) {
    (f.level === 'warn' ? console.warn : console.log)(
      `${f.level === 'warn' ? 'warning' : 'note'}: ${f.message}`,
    );
  }
  const warnings = findings.filter((f) => f.level === 'warn').length;
  console.log(
    `linked doctor: ${warnings} warning${warnings === 1 ? '' : 's'}; ` +
      `${scan.entries.length} client dependencies of ${scan.frameworkPackages.length} linked packages ` +
      `generated for optimizeDeps.include (${Math.round(performance.now() - started)}ms)`,
  );
  process.exitCode = warnings ? 1 : 0;
}
