// Example PersonPreview — single-Person row. Demonstrates @_linked/react's
// linkedComponent: the wrapper runs the per-row query and injects query
// result keys + `source` + `_refresh` into the render function. _refresh
// patches local query state for optimistic UI; on delete, the parent
// list re-runs via the PersonListRefresh context.
// A React Native port of the web app-template's example (linked-fw/app-template).
// Storage is imported first, so the row's queries go to the API store however this module is reached.
import '../shell/storage';

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { linkedComponent } from '@_linked/react';
import { Person } from '@_linked/schema/shapes/Person';
import { usePersonListRefresh } from './PersonOverviewContext';

export const PersonPreview = linkedComponent(
  Person.select((p) => [p.givenName, p.familyName]),
  ({ givenName, familyName, source, _refresh }) => {
    const refreshList = usePersonListRefresh();
    const [editing, setEditing] = useState(false);
    const [draftGiven, setDraftGiven] = useState(givenName ?? '');
    const [draftFamily, setDraftFamily] = useState(familyName ?? '');
    const [busy, setBusy] = useState(false);

    async function save() {
      if (!source.id) return;
      setBusy(true);
      try {
        await Person.update({
          givenName: draftGiven,
          familyName: draftFamily,
        }).for({ id: source.id });
        // Optimistic patch — no extra network round-trip needed.
        _refresh({ givenName: draftGiven, familyName: draftFamily });
        setEditing(false);
      } finally {
        setBusy(false);
      }
    }

    async function remove() {
      if (!source.id) return;
      setBusy(true);
      try {
        await Person.delete({ id: source.id });
        refreshList();
      } finally {
        setBusy(false);
      }
    }

    function startEdit() {
      setDraftGiven(givenName ?? '');
      setDraftFamily(familyName ?? '');
      setEditing(true);
    }

    if (editing) {
      return (
        <View style={styles.row} testID="person-edit">
          <TextInput
            style={styles.input}
            value={draftGiven}
            onChangeText={setDraftGiven}
            accessibilityLabel="First name"
            testID="person-edit-given"
          />
          <TextInput
            style={styles.input}
            value={draftFamily}
            onChangeText={setDraftFamily}
            accessibilityLabel="Last name"
            testID="person-edit-family"
          />
          <Pressable style={styles.button} onPress={save} disabled={busy} testID="person-save">
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.secondary]}
            onPress={() => setEditing(false)}
            disabled={busy}
            testID="person-cancel"
          >
            <Text>Cancel</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={styles.row} testID="person-row">
        <Text style={styles.name} testID="person-name">
          {givenName} {familyName}
        </Text>
        <View style={styles.actions}>
          <Pressable
            style={[styles.button, styles.secondary]}
            onPress={startEdit}
            disabled={busy}
            testID="person-edit-button"
          >
            <Text>Edit</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.danger]}
            onPress={remove}
            disabled={busy}
            testID="person-delete"
          >
            <Text style={styles.buttonText}>Delete</Text>
          </Pressable>
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  name: { flexGrow: 1, fontSize: 16 },
  actions: { flexDirection: 'row', gap: 8 },
  input: {
    flexGrow: 1,
    minWidth: 90,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  button: { backgroundColor: '#222', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  buttonText: { color: '#fff', fontWeight: '600' },
  secondary: { backgroundColor: '#eee' },
  danger: { backgroundColor: '#b3261e' },
});
