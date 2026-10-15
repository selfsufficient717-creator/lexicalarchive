import test from 'node:test';
import assert from 'node:assert/strict';
import { createLookupCache } from '../server/lookup-cache.js';

const request = { text: 'break the ice', language: 'Russian', context: 'At our first meeting.' };
const card = () => ({ method: 'gemini-free', definition: 'Make a new social situation more comfortable.', examples: ['We played a game to break the ice.'] });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('repeated lookup reuses a complete AI card and returns independent copies', async () => {
  const lookup = createLookupCache();
  let calls = 0;
  const value = card();
  const load = async () => { calls++; return value; };
  const first = await lookup('user-a', request, load);
  first.examples.push('A caller changed this copy.');
  value.definition = 'The upstream object changed too.';
  const second = await lookup('user-a', request, load);
  assert.equal(calls, 1);
  assert.deepEqual(second, card());
});

test('account, capitalization, complete phrase, language and context have separate cache entries', async () => {
  const lookup = createLookupCache();
  let calls = 0;
  const load = async () => { calls++; return card(); };
  for (const [user, value] of [
    ['user-a', request], ['user-b', request],
    ['user-a', { ...request, text: 'Break the ice' }],
    ['user-a', { ...request, text: 'the ice' }],
    ['user-a', { ...request, language: 'Uzbek' }],
    ['user-a', { ...request, context: 'An icebreaker ship arrived.' }],
  ]) await lookup(user, value, load);
  assert.equal(calls, 6);
  await lookup('user-a', request, load);
  assert.equal(calls, 6);
});

test('concurrent identical requests share generation without sharing mutable results', async () => {
  const lookup = createLookupCache();
  const wait = deferred();
  let calls = 0;
  const load = () => { calls++; return wait.promise; };
  const first = lookup('user-a', request, load);
  const second = lookup('user-a', request, load);
  const anotherAccount = lookup('user-b', request, load);
  assert.equal(calls, 2);
  wait.resolve(card());
  const [a, b, c] = await Promise.all([first, second, anotherAccount]);
  a.examples.push('Changed.');
  assert.deepEqual(b, card());
  assert.deepEqual(c, card());
});

test('rejected shared generation is cleared so a later lookup can recover', async () => {
  const lookup = createLookupCache();
  const wait = deferred();
  const first = lookup('user-a', request, () => wait.promise);
  const second = lookup('user-a', request, () => wait.promise);
  const settled = Promise.allSettled([first, second]);
  wait.reject(new Error('Temporary outage.'));
  assert.ok((await settled).every(value => value.status === 'rejected'));
  assert.deepEqual(await lookup('user-a', request, async () => card()), card());
});

test('dictionary fallback and fallback-marked cards are not retained', async () => {
  for (const value of [{ ...card(), method: 'dictionary' }, { ...card(), fallbackNote: 'Temporary downgrade.' }]) {
    const lookup = createLookupCache();
    let calls = 0;
    const load = async () => { calls++; return value; };
    await lookup('user-a', request, load);
    await lookup('user-a', request, load);
    assert.equal(calls, 2);
    // A recovered complete card is eligible for future reuse.
    await lookup('user-a', request, async () => card());
    assert.deepEqual(await lookup('user-a', request, () => { throw new Error('Should reuse the recovered card.'); }), card());
  }
});

test('cache expiration is not extended by repeated reads', async () => {
  let time = 0, calls = 0;
  const lookup = createLookupCache({ now: () => time, ttl: 100 });
  const load = async () => { calls++; return card(); };
  await lookup('user-a', request, load);
  time = 99;
  await lookup('user-a', request, load);
  assert.equal(calls, 1);
  time = 100;
  await lookup('user-a', request, load);
  assert.equal(calls, 2);
});

test('entry bound evicts the least recently reused card', async () => {
  const lookup = createLookupCache({ maxEntries: 2 });
  let calls = 0;
  const load = async () => { calls++; return card(); };
  const a = { ...request, text: 'a' }, b = { ...request, text: 'b' }, c = { ...request, text: 'c' };
  for (const value of [a, b, a, c, a, b]) await lookup('user-a', value, load);
  assert.equal(calls, 4);
});

test('byte bound evicts old cards and excludes oversized cards', async () => {
  const bytes = Buffer.byteLength(JSON.stringify(card()));
  let calls = 0;
  const lookup = createLookupCache({ maxBytes: bytes });
  const load = async () => { calls++; return card(); };
  for (const text of ['a', 'b', 'a']) await lookup('user-a', { ...request, text }, load);
  assert.equal(calls, 3);
  const oversized = createLookupCache({ maxBytes: bytes - 1 });
  await oversized('user-a', request, load);
  await oversized('user-a', request, load);
  assert.equal(calls, 5);
});
