// Runs after the setup files: installs expo's winter runtime first (it swaps in a stubbed `expo/fetch`), then
// restores Node's fetch globals saved by nodeFetchEnvironment.js, so RemoteDataset reaches the real API.
require('expo');

const saved: Record<string, unknown> = (globalThis as any).__NODE_FETCH_GLOBALS__;
for (const [name, value] of Object.entries(saved)) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}
