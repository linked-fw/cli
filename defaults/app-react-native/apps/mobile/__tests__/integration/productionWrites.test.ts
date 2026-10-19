// The example access rule (services/api/src/exampleAccess.ts) outside development: a second API, started with
// NODE_ENV=production on the same test dataset, still answers anonymous reads of Person but refuses every anonymous
// write with 401, through the same RemoteDataset the app uses.
// Storage first: RemoteDataset goes through Server.call, which reads SITE_ROOT (set by ./env) when it loads.
import '../../src/shell/storage';
import { Person } from '@_linked/schema/shapes/Person';

import { PRODUCTION_API_PORT, PRODUCTION_API_URL, resolveFusekiEnv } from './apiEnv';
import { type StartedApi, startApi, stopApi } from './startApi';

// env.ts resolves the API URL from Expo's config; point it at the production API. (jest.mock is hoisted above
// imports, so the URL is a literal: PRODUCTION_API_URL.)
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'http://localhost:4101', apiPort: 4000 } } },
}));

let started: StartedApi | undefined;

beforeAll(async () => {
  started = await startApi({ port: PRODUCTION_API_PORT, nodeEnv: 'production', fuseki: resolveFusekiEnv() });
}, 90_000);

afterAll(async () => {
  if (started) await stopApi(started);
});

describe('the example access rule with NODE_ENV=production', () => {
  it('targets the production API', () => {
    expect(process.env.SITE_ROOT).toBe(PRODUCTION_API_URL);
  });

  it('allows an anonymous read of Person', async () => {
    const people = await Person.select((p) => [p.givenName]);
    expect(Array.isArray(people)).toBe(true);
  });

  it('refuses an anonymous create, and nothing is written', async () => {
    await expect(Person.create({ givenName: 'Eve', familyName: 'Anonymous' })).rejects.toThrow(
      'Authentication required',
    );
    const people = await Person.select((p) => [p.givenName]);
    expect(people.map((p) => p.givenName)).not.toContain('Eve');
  });

  it('refuses an anonymous update and delete', async () => {
    const id = `${PRODUCTION_API_URL}/data/person-that-does-not-exist`;
    await expect(Person.update({ givenName: 'Eve' }).for({ id })).rejects.toThrow('Authentication required');
    await expect(Person.delete({ id })).rejects.toThrow('Authentication required');
  });
});
