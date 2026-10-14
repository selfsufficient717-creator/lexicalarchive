import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = await readFile(new URL('../services.js', import.meta.url), 'utf8');
const KEY = 'lexical-trove-session-v1';
const USER = { id: 'user-123', email: 'learner@example.com' };
const CONFIG = { apiBaseUrl: 'https://api.example.com', supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'public-anon-key' };
const originals = Object.fromEntries(['fetch', 'location', 'history', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let serial = 0;

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

async function fixture({ config = CONFIG, stored, hash = '', storageBlocked = false, replies = [] } = {}) {
  const values = new Map(stored === undefined ? [] : [[KEY, typeof stored === 'string' ? stored : JSON.stringify(stored)]]);
  const calls = [];
  const replacements = [];
  globalThis.location = { origin: 'https://selfsufficient717-creator.github.io', pathname: '/lexicalarchive/', search: '?keep=yes', hash };
  globalThis.history = { replaceState(_state, _title, url) { replacements.push(url); globalThis.location.hash = new URL(url, globalThis.location.origin).hash; } };
  globalThis.localStorage = {
    getItem(key) { if (storageBlocked) throw new Error('Blocked'); return values.get(key) || null; },
    setItem(key, value) { if (storageBlocked) throw new Error('Blocked'); values.set(key, value); },
    removeItem(key) { if (storageBlocked) throw new Error('Blocked'); values.delete(key); },
  };
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), ...options };
    calls.push(call);
    const reply = replies.shift();
    assert.notEqual(reply, undefined, `Unexpected fetch: ${url}`);
    if (typeof reply === 'function') return reply(call);
    if (reply instanceof Error) throw reply;
    const { status = 200, body = null } = reply;
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  const source = SOURCE.replace("import { CONFIG } from './config.js';", `const CONFIG = ${JSON.stringify(config)};`) + `\n// isolated module ${serial++}`;
  const service = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return { service, calls, values, replacements };
}

function session(extra = {}) {
  return { access_token: 'access-original', refresh_token: 'refresh-original', expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER, ...extra };
}
function refreshed() { return { access_token: 'access-renewed', refresh_token: 'refresh-renewed', expires_in: 3600, user: USER }; }

test('unconfigured services fail clearly without network requests', async () => {
  const { service, calls } = await fixture({ config: { apiBaseUrl: '', supabaseUrl: '', supabaseAnonKey: '' } });
  assert.equal(service.serviceReady(), false);
  assert.equal(service.accountReady(), false);
  assert.equal(await service.restoreSession(), null);
  await assert.rejects(service.api('/lexicon', {}), error => error.code === 'setup_required');
  await assert.rejects(service.sendMagicLink('learner@example.com'), error => error.code === 'setup_required');
  assert.equal(calls.length, 0);
});

test('browser configuration rejects service-role keys and insecure remote endpoints', async () => {
  const secretJwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  for (const key of ['sb_secret_private', secretJwt]) {
    const { service } = await fixture({ config: { ...CONFIG, supabaseAnonKey: key } });
    assert.equal(service.accountReady(), false);
  }
  const { service } = await fixture({ config: { ...CONFIG, apiBaseUrl: 'http://remote.example.com' } });
  assert.equal(service.serviceReady(), false);
});

test('magic link uses the correct Supabase redirect_to query and email-only signup', async () => {
  const { service, calls } = await fixture({ replies: [{ body: {} }] });
  await service.sendMagicLink(' learner@example.com ');
  assert.equal(calls[0].method, 'POST');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/auth/v1/otp');
  assert.equal(url.searchParams.get('redirect_to'), 'https://selfsufficient717-creator.github.io/lexicalarchive/');
  assert.deepEqual(JSON.parse(calls[0].body), {
    email: 'learner@example.com', create_user: true,
    options: { emailRedirectTo: 'https://selfsufficient717-creator.github.io/lexicalarchive/' },
  });
  assert.equal(calls[0].headers.apikey, CONFIG.supabaseAnonKey);
  assert.equal(calls[0].headers.Authorization, undefined);
  await assert.rejects(service.sendMagicLink('invalid'), error => error.code === 'invalid_email');
});

test('sign-in callback removes bearer credentials and verifies the real user before sign-in', async () => {
  const { service, calls, values, replacements } = await fixture({
    hash: '#access_token=from-link&refresh_token=refresh-link&expires_in=3600&type=magiclink&view=collection',
    replies: [{ body: USER }],
  });
  assert.equal(service.getSession(), null);
  assert.equal((await service.restoreSession()).user.id, USER.id);
  assert.equal(service.getSession().access_token, 'from-link');
  assert.equal(calls[0].url, `${CONFIG.supabaseUrl}/auth/v1/user`);
  assert.equal(calls[0].headers.Authorization, 'Bearer from-link');
  assert.deepEqual(replacements, ['/lexicalarchive/?keep=yes#view=collection']);
  assert.equal(JSON.parse(values.get(KEY)).user.id, USER.id);
});

test('expired callback error is stripped from the URL and provides a new-link instruction', async () => {
  const { service, calls, replacements } = await fixture({ hash: '#error=access_denied&error_description=Email+link+expired' });
  await assert.rejects(service.restoreSession(), error => error.code === 'link_expired' && /new link/.test(error.message));
  assert.deepEqual(replacements, ['/lexicalarchive/?keep=yes']);
  assert.equal(calls.length, 0);
});

test('stored profile claims do not bypass Supabase user verification', async () => {
  const { service } = await fixture({ stored: session({ user: { id: 'forged', email: 'forged@example.com' } }), replies: [{ body: USER }] });
  assert.equal(service.getSession(), null);
  assert.deepEqual((await service.restoreSession()).user, USER);
});

test('expired tokens are refreshed and renewed tokens authorize data operations', async () => {
  const { service, calls, values } = await fixture({ stored: session({ expires_at: 1 }), replies: [{ body: refreshed() }, { body: USER }, { body: [] }] });
  await service.restoreSession();
  await service.loadLibrary();
  assert.equal(new URL(calls[0].url).searchParams.get('grant_type'), 'refresh_token');
  assert.deepEqual(JSON.parse(calls[0].body), { refresh_token: 'refresh-original' });
  assert.equal(calls[1].headers.Authorization, 'Bearer access-renewed');
  assert.equal(calls[2].headers.Authorization, 'Bearer access-renewed');
  assert.equal(JSON.parse(values.get(KEY)).refresh_token, 'refresh-renewed');
});

test('authenticated API retries once after token rejection and handles structured errors', async () => {
  const { service, calls } = await fixture({ stored: session(), replies: [
    { body: USER }, { status: 401, body: { error: { code: 'expired', message: 'Expired token' } } },
    { body: refreshed() }, { status: 429, body: { error: { code: 'daily_limit', message: 'Your practice limit is reached.' } } },
  ] });
  await service.restoreSession();
  await assert.rejects(service.api('/lexicon', { text: 'ceasefire' }), error => error.status === 429 && error.code === 'daily_limit' && error.message === 'Your practice limit is reached.');
  assert.equal(calls[1].headers.Authorization, 'Bearer access-original');
  assert.equal(calls[3].headers.Authorization, 'Bearer access-renewed');
  assert.equal(calls[1].headers.apikey, undefined);
});

test('API can send multipart recordings without replacing their boundary header', async () => {
  const { service, calls } = await fixture({ stored: session(), replies: [{ body: USER }, { body: { overall: 'Clear response' } }] });
  await service.restoreSession();
  const data = new FormData();
  data.append('audio', new Blob(['audio'], { type: 'audio/webm' }), 'recording.webm');
  await service.api('/feedback/speaking', data);
  assert.equal(calls[1].body, data);
  assert.equal(calls[1].headers['Content-Type'], undefined);
});

test('REST mutation failures are reported rather than presented as successful saves', async () => {
  const { service } = await fixture({ stored: session(), replies: [{ body: USER }, { status: 403, body: { code: '42501', message: 'Row-level security denied this write.' } }] });
  await service.restoreSession();
  await assert.rejects(service.saveItem({ id: 'item-1', payload: { term: 'ceasefire' } }), error => error.status === 403 && error.code === '42501');
});

test('saving an item forces account ownership and preserves its ID, payload and review', async () => {
  const { service, calls } = await fixture({ stored: session(), replies: [{ body: USER }, { status: 204 }] });
  await service.restoreSession();
  const item = { id: 'item-1', user_id: 'another-user', payload: { term: 'ceasefire' }, review: { streak: 2 }, unknown: 'not a schema field' };
  const saved = await service.saveItem(item);
  assert.deepEqual(saved, { id: item.id, user_id: USER.id, payload: item.payload, review: item.review });
  assert.deepEqual(JSON.parse(calls[1].body), saved);
  assert.equal(calls[1].headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  assert.equal(new URL(calls[1].url).searchParams.get('on_conflict'), 'id');
});

test('review update notices absent cloud items instead of discarding progress silently', async () => {
  const { service, calls } = await fixture({ stored: session(), replies: [{ body: USER }, { body: [] }] });
  await service.restoreSession();
  await assert.rejects(service.saveReview('item-1', { due: 'tomorrow' }), error => error.code === 'item_not_found');
  const url = new URL(calls[1].url);
  assert.equal(url.searchParams.get('id'), 'eq.item-1');
  assert.equal(url.searchParams.get('user_id'), `eq.${USER.id}`);
});

test('attempt history is scoped to an account, item and mode, in revision order', async () => {
  const row = { attempt_number: 1, response: 'A ceasefire can protect civilians.', feedback: { overall: 'Relevant ideas' } };
  const { service, calls } = await fixture({ stored: session(), replies: [{ body: USER }, { body: [row] }] });
  await service.restoreSession();
  assert.deepEqual(await service.loadAttempts('item-1', 'writing'), [row]);
  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get('item_id'), 'eq.item-1');
  assert.equal(query.get('mode'), 'eq.writing');
  assert.equal(query.get('order'), 'attempt_number.asc');
  assert.equal(query.get('user_id'), `eq.${USER.id}`);
  await assert.rejects(service.loadAttempts('item-1', 'invalid'), error => error.code === 'invalid_mode');
});

test('profile names and avatar ownership are validated before persistence', async () => {
  const photo = `${CONFIG.supabaseUrl}/storage/v1/object/public/avatars/${USER.id}/avatar.png`;
  const profile = { user_id: USER.id, display_name: 'Learner', avatar_url: photo };
  const { service, calls } = await fixture({ stored: session(), replies: [{ body: USER }, { body: [profile] }] });
  await service.restoreSession();
  assert.deepEqual(await service.saveProfile({ display_name: ' Learner ', avatar_url: photo }), profile);
  assert.deepEqual(JSON.parse(calls[1].body), profile);
  await assert.rejects(service.saveProfile({ display_name: 'x'.repeat(81) }), error => error.code === 'invalid_profile');
  await assert.rejects(service.saveProfile({ avatar_url: 'javascript:alert(1)' }), error => error.code === 'invalid_avatar');
  await assert.rejects(service.saveProfile({ avatar_url: `${photo}/../../other/photo.png` }), error => error.code === 'invalid_avatar');
});

test('avatar upload checks real image type and stores in the user-owned folder', async () => {
  const { service, calls } = await fixture({ stored: session(), replies: [{ body: USER }, { body: { Key: 'avatars/photo.png' } }] });
  await service.restoreSession();
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: 'image/png' });
  const publicUrl = await service.uploadAvatar(png);
  assert.match(calls[1].url, new RegExp(`/storage/v1/object/avatars/${USER.id}/[a-zA-Z0-9-]+\\.png$`));
  assert.equal(calls[1].body, png);
  assert.equal(calls[1].headers['x-upsert'], 'false');
  assert.equal(calls[1].headers['Content-Type'], 'image/png');
  assert.equal(publicUrl, calls[1].url.replace('/object/avatars/', '/object/public/avatars/'));
  await assert.rejects(service.uploadAvatar(new Blob(['not an image'], { type: 'image/png' })), error => error.code === 'invalid_avatar');
  await assert.rejects(service.uploadAvatar(new Blob(['<svg/>'], { type: 'image/svg+xml' })), error => error.code === 'invalid_avatar');
  await assert.rejects(service.uploadAvatar(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' })), error => error.code === 'invalid_avatar');
});

test('blocked localStorage retains a verified in-memory session without promising persistence', async () => {
  const { service } = await fixture({ storageBlocked: true, hash: '#access_token=from-link&refresh_token=refresh-link&expires_in=3600', replies: [{ body: USER }] });
  const restored = await service.restoreSession();
  assert.equal(restored.user.id, USER.id);
  assert.equal(restored.persisted, false);
  assert.equal(service.getSession().persisted, false);
});

test('bad stored JSON does not sign a user in or contact the service', async () => {
  const { service, calls } = await fixture({ stored: '{invalid JSON' });
  assert.equal(await service.restoreSession(), null);
  assert.equal(await service.restoreSession(), null);
  assert.equal(service.getSession(), null);
  assert.equal(calls.length, 0);
});

test('revoked refresh tokens clear saved authentication', async () => {
  const { service, values } = await fixture({ stored: session({ expires_at: 1 }), replies: [{ status: 400, body: { error_code: 'refresh_token_not_found', message: 'Refresh token not found.' } }] });
  assert.equal(await service.restoreSession(), null);
  assert.equal(service.getSession(), null);
  assert.equal(values.has(KEY), false);
});

test('sign-out clears local authentication even when revocation cannot be reached', async () => {
  const { service, values } = await fixture({ stored: session(), replies: [{ body: USER }, new Error('offline')] });
  await service.restoreSession();
  await assert.rejects(service.signOut(), error => error.code === 'logout_incomplete');
  assert.equal(service.getSession(), null);
  assert.equal(values.has(KEY), false);
});

test('failed service error messages redact tokens and public configuration keys', async () => {
  const { service } = await fixture({ stored: session(), replies: [{ body: USER }, { status: 500, body: { error: { code: 'failed', message: `Do not echo access-original, refresh-original, or ${CONFIG.supabaseAnonKey}.` } } }] });
  await service.restoreSession();
  await assert.rejects(service.api('/lexicon', {}), error => error.code === 'failed' && !/access-original|refresh-original|public-anon-key/.test(error.message));
});

test('a delayed account verification cannot sign a user back in after sign-out', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service, values } = await fixture({ stored: session(), replies: [() => pending, { status: 204 }] });
  const restoring = service.restoreSession();
  await service.signOut();
  release(new Response(JSON.stringify(USER), { status: 200 }));
  assert.equal(await restoring, null);
  assert.equal(service.getSession(), null);
  assert.equal(values.has(KEY), false);
});

test('a delayed library response cannot expose private records after sign-out', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const pendingResponse = new Promise(resolve => { release = resolve; });
  const { service } = await fixture({ stored: session(), replies: [
    { body: USER }, () => { markStarted(); return pendingResponse; }, { status: 204 },
  ] });
  await service.restoreSession();
  const loading = service.loadLibrary();
  await started;
  await service.signOut();
  release(new Response(JSON.stringify([{ id: 'private-item', payload: { term: 'personal phrase' } }]), { status: 200 }));
  await assert.rejects(loading, error => error.code === 'account_changed');
  assert.equal(service.getSession(), null);
});

test('a stale rejected mutation cannot refresh or retry under another account generation', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const pendingResponse = new Promise(resolve => { release = resolve; });
  const { service, calls } = await fixture({ stored: session(), replies: [
    { body: USER }, () => { markStarted(); return pendingResponse; }, { status: 204 },
  ] });
  await service.restoreSession();
  const saving = service.saveItem({ id: 'private-item', payload: { term: 'personal phrase' } });
  await started;
  await service.signOut();
  release(new Response(JSON.stringify({ message: 'Expired bearer token' }), { status: 401 }));
  await assert.rejects(saving, error => error.code === 'account_changed');
  assert.equal(calls.length, 3);
  assert.equal(calls.some(call => call.url.includes('/auth/v1/token')), false);
});

test('sign-out during retry refresh prevents a second API mutation from being dispatched', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const pendingRefresh = new Promise(resolve => { release = resolve; });
  const { service, calls } = await fixture({ stored: session(), replies: [
    { body: USER }, { status: 401, body: { error: 'Expired bearer token' } },
    () => { markStarted(); return pendingRefresh; }, { status: 204 },
  ] });
  await service.restoreSession();
  const assessing = service.api('/feedback/writing', { response: 'Private response' });
  await started;
  await service.signOut();
  release(new Response(JSON.stringify(refreshed()), { status: 200 }));
  await assert.rejects(assessing, error => error.code === 'account_changed');
  assert.equal(calls.filter(call => call.url.endsWith('/feedback/writing')).length, 1);
  assert.equal(service.getSession(), null);
});
