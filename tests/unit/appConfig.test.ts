// `linked.app.json`: the reader, the add-only prefix builder, `linked prefixes`, and loading the
// map into core (server start, the client bundle).
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  addMissingPrefixes,
  APP_SCHEMA_URL,
  appOntologies,
  appPrefixesModuleCode,
  findAppRoot,
  loadAppPrefixes,
  newAppConfigText,
  parseAppConfig,
  prefixCandidate,
  linkedServerConfig,
  readAppConfig,
  readAppSettings,
  refreshAppPrefixes,
  serializeAppConfig,
} from '../../src/utils/appConfig.js';
import {
  APP_PREFIXES_MODULE,
  appPrefixes,
} from '../../src/plugins/app-prefixes.js';

const SCHEMA = path.join(__dirname, '..', '..', 'schema', 'app', '1.json');

describe('the reader', () => {
  const parse = (json: unknown) => () => parseAppConfig(JSON.stringify(json));

  test('a version 1 file', () => {
    expect(
      parseAppConfig(
        JSON.stringify({
          $schema: APP_SCHEMA_URL,
          schemaVersion: 1,
          prefixes: {schema: 'https://schema.org/', my_x2: 'urn:x:'},
        }),
      ),
    ).toEqual({
      $schema: APP_SCHEMA_URL,
      schemaVersion: 1,
      prefixes: {schema: 'https://schema.org/', my_x2: 'urn:x:'},
    });
    expect(parseAppConfig('{"schemaVersion": 1}')).toEqual({
      schemaVersion: 1,
      prefixes: {},
    });
  });

  test('refuses an unknown or missing schemaVersion, an unknown key, and bad prefixes', () => {
    expect(parse({schemaVersion: 2, prefixes: {}})).toThrow(
      'linked.app.json has "schemaVersion": 2, which this @_linked/cli does not know (it reads version 1). Update @_linked/cli.',
    );
    expect(parse({prefixes: {}})).toThrow(/has no "schemaVersion"/);
    expect(parse({schemaVersion: 1, webpack: {}})).toThrow(
      /has the key "webpack", which schema version 1 does not have/,
    );
    for (const prefix of ['server-utils', '1x', '_x', 'a.b', '']) {
      expect(
        parse({schemaVersion: 1, prefixes: {[prefix]: 'https://x.test/'}}),
      ).toThrow(
        `the prefix "${prefix}" must start with a letter, then letters, digits or _.`,
      );
    }
    expect(parse({schemaVersion: 1, prefixes: {x: 'not an iri'}})).toThrow(
      /must map to a namespace IRI/,
    );
    expect(parse({schemaVersion: 1, prefixes: []})).toThrow(
      /"prefixes" must be an object/,
    );
    expect(() => parseAppConfig('{', 'app/linked.app.json')).toThrow(
      /^app\/linked\.app\.json is not JSON/,
    );
  });

  test('the shipped schema says what the reader checks', () => {
    const schema = fs.readJsonSync(SCHEMA);
    expect(schema.$id).toBe(APP_SCHEMA_URL);
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      '$schema',
      'cssMode',
      'datasetCloneScript',
      'prefixes',
      'publish',
      'schemaVersion',
      'server',
      'syncShapesOnBoot',
    ]);
    expect(Object.keys(schema.properties.server.properties).sort()).toEqual([
      'apiOnly',
      'cachePaths',
      'cacheTimeout',
      'rawQueries',
      'rpcExposure',
    ]);
    expect(schema.properties.server.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.publish.properties).sort()).toEqual([
      'releasePrefix',
      'staticAssets',
    ]);
    expect(schema.properties.cssMode.enum).toEqual(['tailwind', 'postcss']);
    expect(schema.properties.server.properties.rpcExposure.enum).toEqual(['warn', 'enforce']);
    expect(schema.properties.server.properties.rawQueries.enum).toEqual(['off', 'session']);
    expect(schema.properties.prefixes.propertyNames.pattern).toBe(
      '^[A-Za-z][A-Za-z0-9_]*$',
    );
    expect(JSON.parse(newAppConfigText())).toEqual({
      $schema: APP_SCHEMA_URL,
      schemaVersion: 1,
      prefixes: {},
    });
  });
});

describe('the settings', () => {
  const parse = (json: unknown) => () => parseAppConfig(JSON.stringify(json));
  const SETTINGS = {
    cssMode: 'tailwind',
    syncShapesOnBoot: false,
    datasetCloneScript: 'data:clone',
    publish: {staticAssets: ['fonts/**'], releasePrefix: 'rel'},
    server: {
      rpcExposure: 'enforce',
      rawQueries: 'off',
      apiOnly: true,
      cachePaths: ['/'],
      cacheTimeout: 1000,
    },
  };
  let app: string;
  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-app-settings-'));
  });
  afterEach(() => fs.removeSync(app));

  test('are read, checked, and written back in the schema order', () => {
    const config = parseAppConfig(
      JSON.stringify({server: SETTINGS.server, schemaVersion: 1, ...SETTINGS}),
    );
    expect(config).toEqual({schemaVersion: 1, prefixes: {}, ...SETTINGS});
    expect(serializeAppConfig(config)).toBe(
      JSON.stringify(
        {$schema: APP_SCHEMA_URL, schemaVersion: 1, prefixes: {}, ...SETTINGS},
        null,
        2,
      ) + '\n',
    );
  });

  test('a wrong value or an unknown nested key is refused, naming it', () => {
    expect(parse({schemaVersion: 1, cssMode: 'sass'})).toThrow(
      'linked.app.json: "cssMode" must be "tailwind" or "postcss", not "sass".',
    );
    expect(parse({schemaVersion: 1, syncShapesOnBoot: 'no'})).toThrow(
      '"syncShapesOnBoot" must be a boolean',
    );
    expect(parse({schemaVersion: 1, server: {rpcExposure: 'on'}})).toThrow(
      '"server.rpcExposure" must be "warn" or "enforce", not "on".',
    );
    expect(parse({schemaVersion: 1, server: {rawQueries: true}})).toThrow(
      '"server.rawQueries" must be "off" or "session"',
    );
    expect(parse({schemaVersion: 1, server: {multiCore: true}})).toThrow(
      'linked.app.json "server" has the key "multiCore", which schema version 1 does not have',
    );
    expect(parse({schemaVersion: 1, server: {cachePaths: '/'}})).toThrow(
      '"server.cachePaths" must be a list of strings.',
    );
    expect(parse({schemaVersion: 1, server: {cacheTimeout: -1}})).toThrow(
      '"server.cacheTimeout" must be a number of milliseconds',
    );
    expect(parse({schemaVersion: 1, publish: {target: 'x'}})).toThrow(
      '"publish" has the key "target"',
    );
    expect(parse({schemaVersion: 1, server: []})).toThrow('"server" must be an object.');
  });

  test('a leftover linked.config.js or lincd.config.js is refused, saying how to move it', () => {
    fs.writeJsonSync(path.join(app, 'linked.app.json'), {schemaVersion: 1});
    expect(readAppSettings(app)).toEqual({schemaVersion: 1, prefixes: {}});
    for (const file of ['linked.config.js', 'lincd.config.js']) {
      fs.writeFileSync(path.join(app, file), 'export default {};\n');
      expect(() => readAppSettings(app)).toThrow(
        `${path.join(app, file)} is no longer read: an app's settings live in linked.app.json. Move them there and delete ${file}`,
      );
      expect(() => linkedServerConfig(app, {})).toThrow(/is no longer read/);
      fs.removeSync(path.join(app, file));
    }
  });

  test("the server's configuration: the settings it reads; LINKED_RPC_EXPOSURE wins", () => {
    expect(linkedServerConfig(app, {})).toEqual({server: {}});
    fs.writeJsonSync(path.join(app, 'linked.app.json'), {schemaVersion: 1, ...SETTINGS});
    expect(linkedServerConfig(app, {})).toEqual({
      cssMode: 'tailwind',
      syncShapesOnBoot: false,
      server: SETTINGS.server,
    });
    expect(linkedServerConfig(app, {LINKED_RPC_EXPOSURE: 'warn'}).server).toEqual({
      ...SETTINGS.server,
      rpcExposure: 'warn',
    });
    expect(linkedServerConfig(app, {LINKED_RPC_EXPOSURE: ''}).server.rpcExposure).toBe('enforce');
    expect(() => linkedServerConfig(app, {LINKED_RPC_EXPOSURE: 'off'})).toThrow(
      'LINKED_RPC_EXPOSURE must be "warn" or "enforce", not "off".',
    );
    // A new object each time: the caller adds its load hooks to it.
    expect(linkedServerConfig(app, {}).server).not.toBe(linkedServerConfig(app, {}).server);
  });
});

describe('the add-only builder', () => {
  const ont = (
    packageName: string,
    name: string,
    namespace: string,
    suggestedPrefix = name,
  ) => ({
    packageName,
    name,
    namespace,
    suggestedPrefix,
  });

  test('adds the suggested prefix for a namespace not in the map; never changes or removes one', () => {
    const map = {sdo: 'https://schema.org/', mine: 'https://me.test/'};
    const {prefixes, added} = addMissingPrefixes(map, [
      ont('@_linked/schema', 'schema', 'https://schema.org/'),
      ont('@_linked/rdfs', 'rdfs', 'http://www.w3.org/2000/01/rdf-schema#'),
    ]);
    expect(prefixes).toEqual({
      sdo: 'https://schema.org/',
      mine: 'https://me.test/',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    });
    expect(Object.keys(prefixes)).toEqual(['sdo', 'mine', 'rdfs']);
    expect(added).toEqual([
      {
        prefix: 'rdfs',
        namespace: 'http://www.w3.org/2000/01/rdf-schema#',
        packageName: '@_linked/rdfs',
        name: 'rdfs',
      },
    ]);
    expect(map).toEqual({sdo: 'https://schema.org/', mine: 'https://me.test/'});
  });

  test('a taken prefix gets _2, _3, …', () => {
    const {prefixes} = addMissingPrefixes(
      {ex: 'https://a.test/', ex_2: 'https://b.test/'},
      [
        ont('p', 'ex', 'https://c.test/'),
        ont('q', 'ex', 'https://d.test/'),
        ont('r', 'ex', 'https://d.test/'),
      ],
    );
    expect(prefixes).toEqual({
      ex: 'https://a.test/',
      ex_2: 'https://b.test/',
      ex_3: 'https://c.test/',
      ex_4: 'https://d.test/',
    });
  });

  test('a suggested prefix legal in Turtle but not in the map becomes a map name', () => {
    expect(prefixCandidate('server-utils')).toBe('server_utils');
    expect(prefixCandidate('a.b')).toBe('a_b');
    expect(prefixCandidate('_x')).toBe('p_x');
    const {prefixes} = addMissingPrefixes({}, [
      ont('s', 'server-utils', 'https://s.test/'),
    ]);
    expect(prefixes).toEqual({server_utils: 'https://s.test/'});
  });
});

describe('an app', () => {
  let app: string;
  const ttl = (namespace: string, prefix: string) =>
    `@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix vann: <http://purl.org/vocab/vann/> .\n` +
    `<${namespace}> a owl:Ontology ; vann:preferredNamespacePrefix "${prefix}" ; vann:preferredNamespaceUri "${namespace}" .\n`;
  const installPackage = (
    dir: string,
    name: string,
    ontologies: Record<
      string,
      {namespace: string; prefix: string; where?: 'src' | 'lib'}
    >,
    dependencies: Record<string, string> = {},
  ) => {
    fs.outputJsonSync(path.join(dir, 'package.json'), {
      name,
      linked: {kind: 'ontology'},
      dependencies,
      linkedOntologies: Object.fromEntries(
        Object.entries(ontologies).map(([n, o]) => [
          n,
          {namespace: o.namespace},
        ]),
      ),
    });
    for (const [n, o] of Object.entries(ontologies)) {
      const data = o.where === 'lib' ? 'lib/esm/data' : 'src/data';
      fs.outputFileSync(
        path.join(dir, data, `${n}.ttl`),
        ttl(o.namespace, o.prefix),
      );
    }
  };

  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-appconfig-'));
    fs.outputJsonSync(path.join(app, 'package.json'), {
      name: 'my-app',
      linked: {kind: 'app'},
      dependencies: {'@x/one': '1', '@x/plain': '1'},
    });
    installPackage(
      path.join(app, 'node_modules/@x/one'),
      '@x/one',
      {
        alpha: {namespace: 'https://one.test/alpha/', prefix: 'alpha'},
        beta: {
          namespace: 'https://one.test/beta/',
          prefix: 'server-utils',
          where: 'lib',
        },
      },
      {'@x/two': '1'},
    );
    // A dependency of a dependency, whose suggested prefix is taken.
    installPackage(path.join(app, 'node_modules/@x/two'), '@x/two', {
      gamma: {namespace: 'https://two.test/', prefix: 'alpha'},
    });
    // Not a linked package: not read.
    fs.outputJsonSync(path.join(app, 'node_modules/@x/plain/package.json'), {
      name: '@x/plain',
      linkedOntologies: {nope: {namespace: 'https://nope.test/'}},
    });
  });
  afterEach(() => fs.removeSync(app));

  test('its installed ontologies, from src/data or lib/esm/data, sorted', async () => {
    expect(await appOntologies(app)).toEqual([
      {
        packageName: '@x/one',
        name: 'alpha',
        namespace: 'https://one.test/alpha/',
        suggestedPrefix: 'alpha',
      },
      {
        packageName: '@x/one',
        name: 'beta',
        namespace: 'https://one.test/beta/',
        suggestedPrefix: 'server-utils',
      },
      {
        packageName: '@x/two',
        name: 'gamma',
        namespace: 'https://two.test/',
        suggestedPrefix: 'alpha',
      },
    ]);
  });

  test('linked prefixes creates the file, then only adds', async () => {
    const first = await refreshAppPrefixes(app);
    expect(first.created).toBe(true);
    expect(first.added.map((a) => a.prefix)).toEqual([
      'alpha',
      'server_utils',
      'alpha_2',
    ]);
    const text = fs.readFileSync(path.join(app, 'linked.app.json'), 'utf8');
    expect(text).toBe(
      JSON.stringify(
        {
          $schema: APP_SCHEMA_URL,
          schemaVersion: 1,
          prefixes: {
            alpha: 'https://one.test/alpha/',
            server_utils: 'https://one.test/beta/',
            alpha_2: 'https://two.test/',
          },
        },
        null,
        2,
      ) + '\n',
    );

    // The owner renames one and removes another: a run adds back only the missing namespace.
    fs.writeJsonSync(path.join(app, 'linked.app.json'), {
      schemaVersion: 1,
      prefixes: {a: 'https://one.test/alpha/', alpha_2: 'https://two.test/'},
    });
    const second = await refreshAppPrefixes(app);
    expect(second.created).toBe(false);
    expect(readAppConfig(app)!.prefixes).toEqual({
      a: 'https://one.test/alpha/',
      alpha_2: 'https://two.test/',
      server_utils: 'https://one.test/beta/',
    });
    // Nothing missing: the file is not rewritten.
    const before = fs.readFileSync(path.join(app, 'linked.app.json'), 'utf8');
    expect((await refreshAppPrefixes(app)).added).toEqual([]);
    expect(fs.readFileSync(path.join(app, 'linked.app.json'), 'utf8')).toBe(
      before,
    );
  });

  test('linked prefixes keeps the settings', async () => {
    const settings = {cssMode: 'tailwind', server: {rawQueries: 'off'}};
    fs.writeJsonSync(path.join(app, 'linked.app.json'), {schemaVersion: 1, ...settings});
    expect((await refreshAppPrefixes(app)).added.length).toBe(3);
    expect(readAppConfig(app)).toMatchObject(settings);
  });

  test('refuses a package, an unknown version, and missing vann data', async () => {
    const pkg = path.join(app, 'node_modules/@x/two');
    await expect(refreshAppPrefixes(pkg)).rejects.toThrow(
      /is not a linked app/,
    );

    fs.writeJsonSync(path.join(app, 'linked.app.json'), {schemaVersion: 3});
    await expect(refreshAppPrefixes(app)).rejects.toThrow(/"schemaVersion": 3/);

    fs.removeSync(path.join(app, 'linked.app.json'));
    fs.writeFileSync(path.join(pkg, 'src/data/gamma.ttl'), '');
    await expect(refreshAppPrefixes(app)).rejects.toThrow(
      /^@x\/two: the ontology "gamma" has no suggested prefix/,
    );
  });

  test('the app a folder belongs to stops at a repository boundary', () => {
    const member = path.join(app, 'packages/member');
    fs.outputJsonSync(path.join(member, 'package.json'), {
      name: 'member',
      linked: {kind: 'ontology'},
    });
    const checkout = path.join(app, 'packages-local/checkout');
    fs.outputJsonSync(path.join(checkout, 'package.json'), {name: 'checkout'});
    fs.outputFileSync(path.join(checkout, '.git'), 'gitdir: elsewhere\n');
    expect(findAppRoot(app)).toBe(app);
    expect(findAppRoot(member)).toBe(app);
    expect(findAppRoot(checkout)).toBeUndefined();
  });

  test('server start loads the map into core through the runtime import; nothing without a file', async () => {
    const loaded: Record<string, string>[] = [];
    const importModule = async (specifier: string) => {
      expect(specifier).toBe('@_linked/core/utils/Prefix');
      return {
        Prefix: {load: (map: Record<string, string>) => loaded.push(map)},
      };
    };
    expect(await loadAppPrefixes(app, importModule)).toBeUndefined();
    expect(loaded).toEqual([]);

    fs.writeJsonSync(path.join(app, 'linked.app.json'), {
      schemaVersion: 1,
      prefixes: {a: 'urn:a:'},
    });
    expect(await loadAppPrefixes(app, importModule)).toEqual({a: 'urn:a:'});
    expect(loaded).toEqual([{a: 'urn:a:'}]);

    // A core older than Prefix.load: nothing loaded, a warning.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      await loadAppPrefixes(app, async () => ({Prefix: {add() {}}})),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /has no Prefix\.load, so its prefix map is not loaded/,
      ),
    );
    warn.mockRestore();
  });

  test('the client bundle: the entry imports the virtual module first, on its first line', async () => {
    const plugin = appPrefixes({appRoot: app, entry: 'src/index.tsx'}) as any;
    const entry = path.join(app, 'src/index.tsx');
    expect(plugin.resolveId(APP_PREFIXES_MODULE)).toBe(
      '\0' + APP_PREFIXES_MODULE,
    );
    expect(plugin.resolveId('other')).toBeNull();

    const ctx = {
      watched: [] as string[],
      addWatchFile(f: string) {
        this.watched.push(f);
      },
    };
    expect(plugin.load.call(ctx, '\0' + APP_PREFIXES_MODULE)).toBe(
      'export {};\n',
    );
    fs.writeJsonSync(path.join(app, 'linked.app.json'), {
      schemaVersion: 1,
      prefixes: {a: 'urn:a:'},
    });
    expect(plugin.load.call(ctx, '\0' + APP_PREFIXES_MODULE)).toBe(
      appPrefixesModuleCode({a: 'urn:a:'}),
    );
    expect(appPrefixesModuleCode({a: 'urn:a:'})).toMatch(
      /^import \{Prefix\} from '@_linked\/core\/utils\/Prefix';\nif \(typeof Prefix\.load === 'function'\) Prefix\.load\(\{"a":"urn:a:"\}\);\nelse console\.warn\(/,
    );
    expect(ctx.watched).toEqual([path.join(app, 'linked.app.json')]);
    expect(plugin.load.call(ctx, '/other.ts')).toBeNull();

    const code = "import './App';\nrender();\n";
    expect(plugin.transform(code, entry, {})).toEqual({
      code: `import '${APP_PREFIXES_MODULE}';import './App';\nrender();\n`,
      map: null,
    });
    expect(
      plugin.transform(code, `${entry}?v=1`, {}).code.split('\n'),
    ).toHaveLength(3);
    expect(plugin.transform(code, entry, {ssr: true})).toBeNull();
    expect(
      plugin.transform(code, path.join(app, 'src/App.tsx'), {}),
    ).toBeNull();

    fs.writeJsonSync(path.join(app, 'linked.app.json'), {schemaVersion: 9});
    expect(() => plugin.load.call(ctx, '\0' + APP_PREFIXES_MODULE)).toThrow(
      /"schemaVersion": 9/,
    );
  });
});
