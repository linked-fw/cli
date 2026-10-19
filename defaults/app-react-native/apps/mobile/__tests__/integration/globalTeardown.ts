/// <reference types="node" />
// Stops the API started by globalSetup (its whole process group) and removes its exit and signal handlers.
import { type StartedApi, stopApi } from './startApi';

export default async function globalTeardown() {
  const started: StartedApi | undefined = (globalThis as any).__LINKED_API__;
  if (started) await stopApi(started);
}
