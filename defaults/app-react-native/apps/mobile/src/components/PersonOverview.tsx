// Example PersonOverview — demonstrates @_linked/react's data binding:
// linkedSetComponent for the list (auto-runs the query, injects results and
// an injected _refresh); linkedComponent for each row (see PersonPreview).
// After Person.create the form calls _refresh() to re-run the list query.
// A React Native port of the web app-template's example (linked-fw/app-template).
//
// `linkedSetComponent` checks LinkedStorage when this module loads, so storage is imported first.
// Replace or extend this with your own shapes (see https://linked.cm).
import '../shell/storage';

import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { linkedSetComponent } from '@_linked/react';
import { Person } from '@_linked/schema/shapes/Person';
import { PersonPreview } from './PersonPreview';
import { PersonListRefreshProvider } from './PersonOverviewContext';

const PersonList = linkedSetComponent(
  Person.select((p) => [p.givenName, p.familyName]),
  ({ linkedData = [], _refresh, refreshRef }: any) => {
    // Forward the list's _refresh up via a ref so the sibling form +
    // child rows can trigger a re-fetch through context.
    if (refreshRef) {
      refreshRef.current = _refresh;
    }

    if (linkedData.length === 0) {
      return (
        <Text style={styles.empty} testID="person-empty">
          No people yet. Add one below.
        </Text>
      );
    }

    return (
      <View style={styles.list} testID="person-list">
        {linkedData.map((p: { id: string }) => (
          <PersonPreview key={p.id} of={{ id: p.id }} />
        ))}
      </View>
    );
  },
);

function PersonAddForm({ onAdded }: { onAdded: () => void }) {
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!given && !family) return;
    setBusy(true);
    try {
      await Person.create({ givenName: given, familyName: family });
      setGiven('');
      setFamily('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.form}>
      <TextInput
        style={styles.input}
        value={given}
        placeholder="First name"
        onChangeText={setGiven}
        testID="person-add-given"
      />
      <TextInput
        style={styles.input}
        value={family}
        placeholder="Last name"
        onChangeText={setFamily}
        testID="person-add-family"
      />
      <Pressable style={styles.button} onPress={submit} disabled={busy} testID="person-add">
        <Text style={styles.buttonText}>Add</Text>
      </Pressable>
    </View>
  );
}

export function PersonOverview() {
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  return (
    <PersonListRefreshProvider value={refresh}>
      <View style={styles.root} testID="person-overview">
        <Text style={styles.title}>People</Text>
        <Text style={styles.intro}>
          Example code using the @_linked query DSL against your local Fuseki dataset. Edit
          src/components/PersonOverview.tsx to extend it.
        </Text>
        <PersonList refreshRef={refreshRef} />
        <PersonAddForm onAdded={refresh} />
      </View>
    </PersonListRefreshProvider>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: 'stretch', padding: 16, gap: 12 },
  title: { fontSize: 22, fontWeight: '600' },
  intro: { color: '#555' },
  empty: { color: '#888', fontStyle: 'italic' },
  list: { gap: 8 },
  form: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  input: {
    flexGrow: 1,
    minWidth: 100,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  button: { backgroundColor: '#222', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
