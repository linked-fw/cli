// Asserts the cause of the React Native crash in @_linked/react's root loader and error elements: they render
// DOM host elements (<svg>), which have no native view config. @_linked/react/native replaces them on import;
// importing linkedComponent from the root barrel instead must make both tests fail with Received: ["svg", ...].
import { act, render, screen } from '@testing-library/react-native';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { setQueryDispatch } from '@_linked/core/queries/queryDispatch';
import { linkedComponent } from '@_linked/react/native';
import { Text } from 'react-native';
import { Example } from 'app-shapes';

type Mode = 'loading' | 'error';
let mode: Mode = 'loading';

// A stub store: the query never settles while loading, and rejects in error mode.
const stubStore: any = {
  selectQuery: () =>
    mode === 'loading' ? new Promise(() => {}) : Promise.reject(new Error('stub store: query failed')),
  askQuery: async () => false,
  createQuery: async () => ({}),
  updateQuery: async () => ({}),
  deleteQuery: async () => ({}),
};
LinkedStorage.setDefaultDataset(stubStore);
setQueryDispatch(stubStore);

const ExampleLabel = linkedComponent(Example.select((s) => s.label), ({ label }: any) => (
  <Text>{label}</Text>
));

type Node = { type: string; children: (Node | string)[] | null };

function lowercaseHostTypes(tree: Node | Node[] | null): string[] {
  const found: string[] = [];
  const visit = (node: Node | string | null) => {
    if (!node || typeof node === 'string') return;
    if (/^[a-z]/.test(node.type)) found.push(node.type);
    node.children?.forEach(visit);
  };
  (Array.isArray(tree) ? tree : [tree]).forEach(visit);
  return found;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('@_linked/react/native render defaults', () => {
  test('a loading component renders only React Native elements', async () => {
    mode = 'loading';
    await render(<ExampleLabel of={{ id: 'urn:example:loading' }} />);

    expect(lowercaseHostTypes(screen.toJSON() as any)).toEqual([]);
    expect(screen.getByTestId('linked-loader')).toBeTruthy();
  });

  test('a failed component renders only React Native elements', async () => {
    mode = 'error';
    // A subject of its own: @_linked/react shares one request per query and subject, so reusing the loading
    // test's subject would join its request, which never settles, and never reach the error state.
    await render(<ExampleLabel of={{ id: 'urn:example:error' }} />);
    // Let the rejected query settle and the component re-render into its error state.
    await act(flush);

    expect(lowercaseHostTypes(screen.toJSON() as any)).toEqual([]);
    expect(screen.getByTestId('linked-error')).toBeTruthy();
  });
});
