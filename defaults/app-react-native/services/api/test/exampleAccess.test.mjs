import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowsAnonymousExampleWrites,
  exampleAccess,
} from '../src/exampleAccess.ts';

const PERSON = 'https://linked.cm/shape/schema/Person';
const THING = 'https://linked.cm/shape/schema/Thing';
const OTHER = 'https://linked.cm/shape/server/LinkedServer';
const example = new Set([PERSON, THING]);

const anon = (...shapes) => ({ shapes: new Set(shapes), linkedAuth: undefined });
const signedIn = (...shapes) => ({
  shapes: new Set(shapes),
  linkedAuth: { userAccount: { id: 'urn:account' } },
});

test('only NODE_ENV=development allows anonymous example writes', () => {
  assert.equal(allowsAnonymousExampleWrites('development'), true);
  for (const env of ['production', 'test', '', undefined, 'Development']) {
    assert.equal(allowsAnonymousExampleWrites(env), false, String(env));
  }
});

test('anonymous reads of the example are allowed in every environment', () => {
  for (const writes of [true, false]) {
    const { read } = exampleAccess(example, writes);
    assert.equal(read(anon(PERSON)), true);
    assert.equal(read(anon(PERSON, THING)), true);
  }
});

test('anonymous writes of the example only in development', () => {
  assert.equal(exampleAccess(example, true).write(anon(PERSON)), true);
  assert.equal(exampleAccess(example, false).write(anon(PERSON)), false);
});

test('a query touching anything outside the example needs a session', () => {
  const { read, write } = exampleAccess(example, true);
  assert.equal(read(anon(OTHER)), false);
  assert.equal(read(anon(PERSON, OTHER)), false);
  assert.equal(write(anon(PERSON, OTHER)), false);
  assert.equal(read(anon()), false);
  assert.equal(write(anon()), false);
});

test('a signed-in session may run any query, as the default rule allows', () => {
  const { read, write } = exampleAccess(example, false);
  assert.equal(read(signedIn(OTHER)), true);
  assert.equal(write(signedIn(OTHER)), true);
  assert.equal(write(signedIn(PERSON)), true);
});
