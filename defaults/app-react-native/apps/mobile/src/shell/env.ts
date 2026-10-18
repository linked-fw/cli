// Resolves the API URL and exposes it to @_linked/server's RemoteDataset, which reads process.env.SITE_ROOT and
// DATA_ROOT at runtime. ./storage imports this module, so the variables are set before the store is constructed.
import Constants from 'expo-constants';

import { defaultApiPort } from './apiPort.json';

export type ApiUrlInput = {
  // `unknown`: the dev-client manifest serializes `apiUrl: null` from app.config.ts as `{}`.
  extra?: { apiUrl?: unknown; apiPort?: number } | null;
  hostUri?: string | null;
};

/**
 * `extra.apiUrl` (EXPO_PUBLIC_API_URL) if it is a non-empty string; otherwise the dev machine's host from Expo's
 * `hostUri` (`192.168.1.5:8081`) with the API port; otherwise localhost.
 */
export function resolveApiUrl({ extra, hostUri }: ApiUrlInput): string {
  if (typeof extra?.apiUrl === 'string' && extra.apiUrl) return extra.apiUrl;
  const port = extra?.apiPort ?? defaultApiPort;
  const host = hostUri ? hostUri.split(':')[0] : '';
  return `http://${host || 'localhost'}:${port}`;
}

export const apiUrl: string = resolveApiUrl({
  extra: Constants.expoConfig?.extra as ApiUrlInput['extra'],
  hostUri: Constants.expoConfig?.hostUri,
});

process.env.SITE_ROOT = apiUrl;
process.env.DATA_ROOT = `${apiUrl}/data`;
