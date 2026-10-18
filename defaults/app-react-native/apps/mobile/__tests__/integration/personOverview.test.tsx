// The example PersonOverview screen with the real RemoteDataset and real fetch, against the API started by
// globalSetup on the reset app-test dataset: list 0, add (1), edit (the name changes and persists), delete (0).
import '@_linked/react/native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { PersonOverview } from '../../src/components/PersonOverview';
import { API_URL } from './apiEnv';

// env.ts resolves the API URL from Expo's config; point it at the test API. (jest.mock is hoisted above imports.)
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { apiUrl: 'http://localhost:4100', apiPort: 4000 } } },
}));

const WAIT = { timeout: 10000 };

describe('PersonOverview against the API', () => {
  it('uses the test API and a real fetch', () => {
    expect(process.env.SITE_ROOT).toBe(API_URL);
    // Node's fetch, not jest-expo's stubbed expo/fetch (see nodeFetchEnvironment.js).
    expect(globalThis.fetch).toBe((globalThis as any).__NODE_FETCH_GLOBALS__.fetch);
  });

  it('lists 0, adds one (1), edits it, deletes it (0)', async () => {
    await render(<PersonOverview />);
    await waitFor(() => expect(screen.getByTestId('person-empty')).toBeOnTheScreen(), WAIT);

    // Add
    await fireEvent.changeText(screen.getByTestId('person-add-given'), 'Ada');
    await fireEvent.changeText(screen.getByTestId('person-add-family'), 'Lovelace');
    await fireEvent.press(screen.getByTestId('person-add'));
    await waitFor(() => expect(screen.getAllByTestId('person-row')).toHaveLength(1), WAIT);
    await waitFor(() => expect(screen.getByTestId('person-name')).toHaveTextContent('Ada Lovelace'), WAIT);

    // Edit
    await fireEvent.press(screen.getByTestId('person-edit-button'));
    await fireEvent.changeText(screen.getByTestId('person-edit-given'), 'Grace');
    await fireEvent.press(screen.getByTestId('person-save'));
    await waitFor(() => expect(screen.getByTestId('person-name')).toHaveTextContent('Grace Lovelace'), WAIT);

    // The edit is stored, not only patched locally: a fresh mount reads it back from the API.
    await screen.unmount();
    await render(<PersonOverview />);
    await waitFor(() => expect(screen.getByTestId('person-name')).toHaveTextContent('Grace Lovelace'), WAIT);

    // Delete
    await fireEvent.press(screen.getByTestId('person-delete'));
    await waitFor(() => expect(screen.getByTestId('person-empty')).toBeOnTheScreen(), WAIT);
    expect(screen.queryAllByTestId('person-row')).toHaveLength(0);
  });
});
