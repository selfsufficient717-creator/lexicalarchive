import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, readConfig } from '../server/index.js';
import { validateWav } from '../server/validation.js';
import { createFeedback as ruleFeedback } from '../server/coaching.js';

const USER_ID = '11e40e32-cf88-4a1b-b650-51094d40f902';
const ITEM_ID = '02e40e32-cf88-4a1b-b650-51094d40f903';
const BEARER = 'Bearer header.payload.valid-test-signature';
const configEnv = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_public-test-key',
};

// A saved card remains authoritative during practice. Its fixtures intentionally
// differ from the client-supplied card and prompt used below.
function savedItem() {
  const definition = 'An agreement to stop fighting for a period of time.';
  const passage = 'After many months of fighting, families in the town had lost access to schools, shops, and hospitals. Local leaders met to discuss a possible _____. They hoped that an agreement to stop the fighting would allow aid workers to deliver food and medicine safely. Some residents remained cautious because earlier agreements had failed. Others believed that even a short pause could save lives and give both sides time to discuss longer term plans. Everyone agreed that rebuilding trust would require clear rules and practical action.';
  return {
    term: 'ceasefire', kind: 'word', pronunciation: '/ˈsiːs.faɪər/',
    definition, translation: 'перемирие', language: 'Russian',
    synonyms: ['truce'], antonyms: [],
    antonymNote: 'The dictionary supplies no direct antonym.',
    examples: ['Both sides agreed to a ceasefire.', 'The ceasefire allowed aid to reach the town.'],
    usageNote: 'A temporary agreement to stop fighting.',
    speakingPrompt: 'Describe how a ceasefire could help a community rebuild.',
    writingPrompt: 'Explain why a ceasefire needs trust and practical steps.',
    exercises: [
      { type: 'meaning', question: 'Choose the meaning.', options: [definition, 'A forecast of bad weather.'], answer: definition, explanation: 'This is the dictionary definition.' },
      { type: 'synonym', question: 'Choose a synonym.', options: ['truce', 'storm'], answer: 'truce', explanation: 'The dictionary lists truce as a synonym.' },
      { type: 'gap', question: passage, options: ['ceasefire', 'forecast'], answer: 'ceasefire', explanation: 'The paragraph describes an agreement to stop fighting.' },
      { type: 'context', question: 'Where does this word fit?', options: ['Conflict negotiations', 'A weather forecast'], answer: 'Conflict negotiations', explanation: 'A ceasefire is an agreement to stop fighting.' },
      { type: 'collocation', question: 'Which phrase is natural?', options: ['agree to a ceasefire', 'eat a ceasefire'], answer: 'agree to a ceasefire', explanation: 'An agreement can be made.' },
      { type: 'meaning', question: 'Is a ceasefire necessarily permanent?', options: ['No', 'Yes'], answer: 'No', explanation: 'It can last for a period of time.' },
    ],
    source: { type: 'dictionary', name: 'Free Dictionary API', url: 'https://api.dictionaryapi.dev/api/v2/entries/en/ceasefire' },
  };
}

function dictionaryEntry(word) {
  const definition = word === 'serendipity'
    ? 'The occurrence of useful or pleasant events by chance.'
    : savedItem().definition;
  return [{
    word,
    phonetic: '/test/',
    phonetics: [],
    meanings: [{
      partOfSpeech: 'noun',
      definitions: [
        { definition, example: `The article discussed ${word}.`, synonyms: word === 'ceasefire' ? ['truce'] : ['chance'], antonyms: [] },
        { definition: `Another documented sense of ${word}.`, example: `She learned the meaning of ${word}.`, synonyms: [], antonyms: [] },
      ],
      synonyms: word === 'ceasefire' ? ['truce'] : ['chance'],
      antonyms: [],
    }],
    license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
    sourceUrls: [`https://en.wiktionary.org/wiki/${word}`],
  }];
}

function wav(seconds = 2) {
  const dataLength = 32000 * seconds;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return { base64: buffer.toString('base64'), format: 'wav' };
}

function upstream({ authStatus = 200, confirmed = true, missingItem = false, initialAttempts = [], dictionaryStatus = 200, translationStatus = 200, storageStatus = 201, storageCode = 'unknown' } = {}) {
  const calls = [];
  const attempts = structuredClone(initialAttempts);
  const fetchImpl = async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: address, options, body });
    const parsed = new URL(address);
    if (address.endsWith('/auth/v1/user')) {
      return Response.json({ id: USER_ID, email: 'learner@example.test', email_confirmed_at: confirmed ? '2026-10-14T00:00:00Z' : null }, { status: authStatus });
    }
    if (address.includes('/rest/v1/items?')) return Response.json(missingItem ? [] : [{ id: ITEM_ID, payload: savedItem() }]);
    if (address.includes('/rest/v1/attempts?') && options.method === 'POST') {
      if (storageStatus !== 201) return Response.json({ code: storageCode, details: 'private-database-data', message: 'private SQL details' }, { status: storageStatus });
      const row = { ...body, id: `02e40e32-cf88-4a1b-b650-51094d40f90${body.attempt_number + 3}` };
      attempts.push(row);
      return Response.json([{ id: row.id, attempt_number: row.attempt_number }], { status: 201 });
    }
    if (address.includes('/rest/v1/attempts?')) return Response.json(attempts);
    if (parsed.hostname === 'api.dictionaryapi.dev') {
      const word = decodeURIComponent(parsed.pathname.split('/').pop());
      if (dictionaryStatus !== 200 || word.includes(' ')) return Response.json({ title: 'No Definitions Found', message: 'private upstream message' }, { status: dictionaryStatus === 200 ? 404 : dictionaryStatus });
      return Response.json(dictionaryEntry(word));
    }
    if (parsed.hostname === 'api.mymemory.translated.net') {
      if (translationStatus !== 200) return Response.json({ private_message: 'private translator account data' }, { status: translationStatus });
      return Response.json({ responseStatus: 200, responseData: { translatedText: 'перемирие', match: 0.95 }, matches: [] });
    }
    if (parsed.hostname === 'en.wiktionary.org') {
      if (decodeURIComponent(parsed.pathname).endsWith('/definition/break_the_ice')) {
        return Response.json({ en: [{ partOfSpeech: 'Verb', definitions: [{ definition: '(idiomatic) To make people feel more comfortable in a new social situation.', examples: ['We played a game to break the ice.'] }] }] });
      }
      return Response.json({ error: { code: 'missingtitle', info: 'The page is missing.' } }, { status: 404 });
    }
    throw new Error(`Unapproved network destination: ${parsed.hostname}`);
  };
  return { calls, attempts, fetchImpl };
}

async function start(t, options = {}) {
  const fake = upstream(options.upstream);
  const server = createApp({ config: options.config ?? readConfig(configEnv), fetchImpl: fake.fetchImpl, ...(options.feedbackImpl ? { feedbackImpl: options.feedbackImpl } : {}) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...fake, base,
    request: (route, body, headers = {}) => fetch(`${base}${route}`, {
      method: 'POST', headers: { Authorization: BEARER, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  };
}

function practiceRequest(mode = 'writing') {
  const item = savedItem();
  item.term = 'client-forged-term';
  return {
    itemId: ITEM_ID, item, mode, prompt: 'A client-forged prompt that must not replace the saved activity.', previousAttempts: [],
    ...(mode === 'writing'
      ? { response: 'A ceasefire helps families rebuild. First, both sides need clear rules. However, trust can be difficult after years of fighting. Leaders should explain how they will keep their promises.' }
      : { audio: wav(), durationSeconds: 2, transcript: 'A ceasefire helps families rebuild. Leaders need clear rules and trust.', transcriptConfirmed: true }),
  };
}

const assertNoPaidCalls = (calls) => assert.equal(calls.filter(({ url }) => /openai|anthropic|generativelanguage/i.test(url)).length, 0);

test('free health and configuration require no paid key and do not leak a leftover key', async (t) => {
  assert.equal(readConfig(configEnv).configured, true);
  const api = await start(t, { config: readConfig({ ...configEnv, LEXICAL_AI_API_KEY: 'obsolete-secret-must-never-be-used' }) });
  const response = await fetch(`${api.base}/api/health`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { ok: true, configured: true, mode: 'free' });
  assert.doesNotMatch(text, /obsolete-secret|sb_publishable/);
  assert.equal(api.calls.length, 0);
  const lookup = await api.request('/api/lexicon', { text: 'ceasefire', language: 'English' });
  assert.equal(lookup.status, 200);
  assertNoPaidCalls(api.calls);
});

test('free lookup fetches the pasted word from the dictionary rather than a fixed item list', async (t) => {
  const api = await start(t);
  const response = await api.request('/api/lexicon', { text: 'serendipity', language: 'English' });
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.term, 'serendipity');
  assert.match(card.definition, /useful or pleasant events by chance/);
  assert.ok(api.calls.some(({ url }) => url.endsWith('/entries/en/serendipity')));
  assert.equal(api.calls.filter(({ url }) => url.includes('mymemory')).length, 0, 'English does not need a translation request');
  assertNoPaidCalls(api.calls);
});

test('a supported translation uses only the free translator', async (t) => {
  const api = await start(t);
  const response = await api.request('/api/lexicon', { text: 'ceasefire', language: 'Russian' });
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.translation, 'перемирие');
  const request = api.calls.find(({ url }) => new URL(url).hostname === 'api.mymemory.translated.net');
  assert.ok(request);
  const params = new URL(request.url).searchParams;
  assert.equal(params.get('q'), 'ceasefire');
  assert.equal(params.get('langpair'), 'en|ru');
  assertNoPaidCalls(api.calls);
});

test('a pasted idiom falls back to the full Wiktionary expression and keeps its source', async (t) => {
  const api = await start(t);
  const response = await api.request('/api/lexicon', { text: 'break the ice', language: 'English' });
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.term, 'break the ice');
  assert.equal(card.kind, 'idiom');
  assert.match(card.definition, /comfortable in a new social situation/);
  assert.equal(card.source.name, 'Wiktionary');
  assert.ok(api.calls.some(({ url }) => url.endsWith('/definition/break_the_ice')));
  assert.ok(card.examples.includes('We played a game to break the ice.'));
  assertNoPaidCalls(api.calls);
});

test('missing entries remain explicit and translation downtime preserves dictionary lookup', async (t) => {
  const absent = await start(t, { upstream: { dictionaryStatus: 404 } });
  const missing = await absent.request('/api/lexicon', { text: 'unattestedword', language: 'English' });
  assert.equal(missing.status, 404);
  const text = await missing.text();
  assert.equal(JSON.parse(text).error.code, 'dictionary_not_found');
  assert.doesNotMatch(text, /private upstream/);
  assertNoPaidCalls(absent.calls);
  const translation = await start(t, { upstream: { translationStatus: 503 } });
  const response = await translation.request('/api/lexicon', { text: 'ceasefire', language: 'Russian' });
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.match(card.definition, /agreement to stop fighting/);
  assert.equal(card.translation, '');
  assert.match(card.translationNote, /unavailable|quota/i);
  assertNoPaidCalls(translation.calls);
});

test('free coaching uses saved prompts and honest unscored criteria, then persists its result', async (t) => {
  const api = await start(t);
  const request = practiceRequest();
  const response = await api.request('/api/feedback', request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.method, 'rules');
  assert.equal(result.attemptNumber, 1);
  assert.ok(result.attemptId);
  assert.equal(result.criteria.length, 5);
  assert.ok(result.criteria.every(({ score }) => score === null), 'Simple rules must not invent examiner grades');
  assert.equal(result.metrics.targetOccurrences, 1, 'The target match must use the saved term, not the client-supplied replacement');
  assert.ok(result.metrics.words > 20);
  assert.ok(result.limitations.length > 0);
  assert.ok(result.nextSteps.length > 0);
  assert.doesNotMatch(JSON.stringify(result), /client-forged-term/);
  const insert = api.calls.find(({ url, options }) => url.includes('/attempts?') && options.method === 'POST');
  assert.equal(insert.body.user_id, USER_ID);
  assert.equal(insert.body.item_id, ITEM_ID);
  assert.equal(insert.body.prompt, savedItem().writingPrompt);
  assert.equal(insert.body.response, request.response);
  assert.equal(insert.body.feedback.method, 'rules');
  assert.equal(insert.options.headers.Authorization, BEARER);
  assert.equal(api.calls.every(({ url }) => new URL(url).hostname === 'test-project.supabase.co'), true, 'Rule-based practice requires no external grading call');
  assertNoPaidCalls(api.calls);
});

test('both free revisions compare real history and a fourth submission cannot create another attempt', async (t) => {
  const api = await start(t);
  const request = practiceRequest();
  request.response = 'A ceasefire help families.';
  const first = await api.request('/api/feedback', request);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).attemptNumber, 1);
  request.response = 'A ceasefire helps families rebuild. First, leaders agree to clear rules. Then, communities can reopen schools and hospitals. However, both sides must keep their promises.';
  for (let number = 2; number <= 3; number++) {
    const revision = await api.request('/api/feedback', request);
    assert.equal(revision.status, 200);
    const result = await revision.json();
    assert.equal(result.attemptNumber, number);
    assert.equal(result.method, 'rules');
    assert.equal(typeof result.comparison, 'string');
    assert.ok(result.comparison.length > 0);
  }
  const denied = await api.request('/api/feedback', request);
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, 'attempt_limit');
  assert.equal(api.attempts.length, 3);
  assertNoPaidCalls(api.calls);
});

test('free speaking coaches a confirmed transcript and never pretends to grade pronunciation', async (t) => {
  const api = await start(t);
  const request = practiceRequest('speaking');
  const response = await api.request('/api/feedback', request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.method, 'rules');
  assert.equal(result.transcript, request.transcript);
  assert.equal(result.metrics.durationSeconds, 2);
  const pronunciation = result.criteria.find(({ name }) => name === 'Pronunciation');
  assert.equal(pronunciation.score, null);
  assert.match(pronunciation.comment, /not|cannot|unassessed|unavailable/i);
  assert.ok(result.limitations.some((entry) => /pronunciation|audio|recording/i.test(entry)));
  const saved = api.attempts[0];
  assert.equal(saved.response, request.transcript);
  assert.equal(saved.audio, undefined);
  assert.ok(!JSON.stringify(saved).includes(request.audio.base64));
  assert.equal(api.calls.every(({ url }) => new URL(url).hostname === 'test-project.supabase.co'), true);
  assertNoPaidCalls(api.calls);
});

test('a supplied speaking transcript must be confirmed and rejected practice consumes no attempt', async (t) => {
  const api = await start(t);
  for (const overrides of [{ transcriptConfirmed: false }, { audio: { format: 'wav', base64: Buffer.from('not a wave recording').toString('base64') } }]) {
    const response = await api.request('/api/feedback', { ...practiceRequest('speaking'), ...overrides });
    assert.equal(response.status, 400);
  }
  assert.equal(api.attempts.length, 0);
  assertNoPaidCalls(api.calls);
});

test('audio without a transcript measures amplitude only and reports unassessed vocabulary', async (t) => {
  const api = await start(t);
  const response = await api.request('/api/feedback', { ...practiceRequest('speaking'), transcript: '', transcriptConfirmed: false });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.transcript, '');
  assert.equal(result.metrics.transcriptProvided, false);
  assert.equal(result.metrics.estimatedWordsPerMinute, undefined);
  assert.ok(result.criteria.every(({ score }) => score === null));
  assert.match(result.criteria.find(({ name }) => name === 'Lexical item usage').comment, /cannot|no transcript/i);
  assert.equal(api.attempts[0].response, '');
  assertNoPaidCalls(api.calls);
});

test('the free routes retain confirmation, exact CORS, and input limits before dictionary work', async (t) => {
  const api = await start(t);
  const denied = await api.request('/api/lexicon', {}, { Origin: 'https://selfsufficient717-creator.github.io.evil.example' });
  assert.equal(denied.status, 403);
  assert.equal(api.calls.length, 0);
  assert.equal((await api.request('/api/lexicon', {}, { Authorization: '' })).status, 401);
  assert.equal(api.calls.length, 0);
  for (const [body, headers, status] of [
    [{ text: 'x'.repeat(301), language: 'English' }, {}, 400],
    ['{unclosed', {}, 400],
    ['{}', { 'Content-Type': 'text/plain' }, 415],
    [JSON.stringify({ text: 'x'.repeat(5_800_000) }), {}, 413],
  ]) assert.equal((await api.request('/api/lexicon', body, headers)).status, status);
  assert.equal(api.calls.filter(({ url }) => new URL(url).hostname !== 'test-project.supabase.co').length, 0);
  const unconfirmed = await start(t, { upstream: { confirmed: false } });
  assert.equal((await unconfirmed.request('/api/lexicon', { text: 'ceasefire', language: 'English' })).status, 403);
  assert.equal(unconfirmed.calls.length, 1);
  const expired = await start(t, { upstream: { authStatus: 401 } });
  assert.equal((await expired.request('/api/lexicon', { text: 'ceasefire', language: 'English' })).status, 401);
  assert.equal(expired.calls.length, 1);
  const allowed = await fetch(`${api.base}/api/feedback`, { method: 'OPTIONS', headers: { Origin: readConfig(configEnv).allowedOrigin, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), readConfig(configEnv).allowedOrigin);
});

test('free persistence conflicts are safe and do not return private database messages', async (t) => {
  const api = await start(t, { upstream: { storageStatus: 400, storageCode: '23514' } });
  const response = await api.request('/api/feedback', practiceRequest());
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, 'attempt_conflict');
  assert.doesNotMatch(text, /private-database-data|private SQL details/);
  assert.equal(api.attempts.length, 0);
  assertNoPaidCalls(api.calls);
});

test('concurrent submissions of one activity cannot burn a second attempt', async (t) => {
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  const api = await start(t, { feedbackImpl: async (...args) => {
    entered();
    await finish;
    return ruleFeedback(...args);
  } });
  const running = api.request('/api/feedback', practiceRequest());
  await started;
  try {
    const duplicate = await api.request('/api/feedback', practiceRequest());
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'assessment_in_progress');
    assert.equal(api.attempts.length, 0);
  } finally {
    release();
  }
  const completed = await running;
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).attemptNumber, 1);
  assert.equal(api.attempts.length, 1);
  assertNoPaidCalls(api.calls);
});

test('free lookup remains bounded per confirmed user', async (t) => {
  const api = await start(t);
  for (let count = 0; count < 20; count++) {
    assert.equal((await api.request('/api/lexicon', { text: 'ceasefire', language: 'English' })).status, 200);
  }
  const dictionariesBefore = api.calls.filter(({ url }) => new URL(url).hostname === 'api.dictionaryapi.dev').length;
  const limited = await api.request('/api/lexicon', { text: 'ceasefire', language: 'English' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(api.calls.filter(({ url }) => new URL(url).hostname === 'api.dictionaryapi.dev').length, dictionariesBefore);
  assertNoPaidCalls(api.calls);
});

test('missing saved items and failed dictionaries never persist fabricated practice', async (t) => {
  const api = await start(t, { upstream: { missingItem: true } });
  const response = await api.request('/api/feedback', practiceRequest());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'item_not_found');
  assert.equal(api.attempts.length, 0);
  assert.equal(api.calls.filter(({ url, options }) => options.method === 'POST' && url.includes('/attempts?')).length, 0);
  const absent = await start(t, { upstream: { dictionaryStatus: 404 } });
  assert.equal((await absent.request('/api/lexicon', { text: 'unattestedword', language: 'English' })).status, 404);
  assert.equal(absent.attempts.length, 0);
  assertNoPaidCalls(api.calls);
  assertNoPaidCalls(absent.calls);
});

test('the service does not expose server code, credentials, repository metadata or arbitrary files', async (t) => {
  const api = await start(t);
  for (const route of ['/server/index.js', '/server/coaching.js', '/server/dictionary.js', '/server/.env.example', '/.env', '/.git/config', '/supabase/schema.sql', '/package.json']) {
    assert.equal((await fetch(`${api.base}${route}`)).status, 404, route);
  }
  assert.equal((await fetch(`${api.base}/`)).status, 200);
  assert.equal((await fetch(`${api.base}/config.js`)).status, 200);
  assert.equal(api.calls.length, 0);
});

test('free readiness still rejects privileged Supabase credentials and non-origin URLs', () => {
  assert.equal(readConfig({}).configured, false);
  assert.throws(() => readConfig({ ...configEnv, SUPABASE_ANON_KEY: 'sb_secret_do-not-use' }));
  const jwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature`;
  assert.throws(() => readConfig({ ...configEnv, SUPABASE_ANON_KEY: jwt }));
  assert.throws(() => readConfig({ ...configEnv, ALLOWED_ORIGIN: 'https://example.test/path' }));
  assert.throws(() => readConfig({ ...configEnv, ALLOWED_ORIGIN: 'http://example.test' }));
  assert.throws(() => readConfig({ ...configEnv, SUPABASE_URL: 'https://test-project.supabase.co/private-path' }));
});

test('missing Supabase configuration remains explicit without trying external services', async (t) => {
  const api = await start(t, { config: readConfig({}) });
  const response = await api.request('/api/lexicon', { text: 'ceasefire', language: 'English' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'service_not_configured');
  assert.equal(api.calls.length, 0);
});

test('audio remains structurally validated before free acoustic analysis', () => {
  assert.equal(validateWav(wav(2), 2).durationSeconds, 2);
  assert.throws(() => validateWav(wav(121), 121));
  assert.throws(() => validateWav(wav(2), 12));
  const wrongRate = Buffer.from(wav(2).base64, 'base64');
  wrongRate.writeUInt32LE(8000, 24);
  assert.throws(() => validateWav({ base64: wrongRate.toString('base64'), format: 'wav' }));
  const truncated = Buffer.from(wav(2).base64, 'base64').subarray(0, 80);
  assert.throws(() => validateWav({ base64: truncated.toString('base64'), format: 'wav' }));
});

test('Gemini is opt-in and a free-tier quota failure falls back to dictionary data', async t => {
  const fake = upstream();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(String(url));
    if (new URL(url).hostname === 'generativelanguage.googleapis.com') return Response.json({ error: { message: 'private upstream material' } }, { status: 429 });
    return fake.fetchImpl(url, options);
  };
  const config = readConfig({ ...configEnv, LEXICAL_GEMINI_API_KEY: 'gemini-test-only', GEMINI_FREE_TIER: 'true', LEXICAL_AI_API_KEY: 'old-key-must-never-be-used' });
  assert.equal(config.geminiEnabled, true);
  const app = createApp({ config, fetchImpl });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve);app.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/lexicon`, { method: 'POST', headers: { Authorization: BEARER, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'ceasefire', language: 'English' }) });
  const card = await response.json();
  assert.equal(response.status, 200);
  assert.equal(card.method, 'dictionary');
  assert.match(card.fallbackNote, /dictionary/);
  assert.equal(calls.filter(url => url.includes('generativelanguage.googleapis.com')).length, 1);
  assert.equal(calls.some(url => url.includes('openai.com')), false);
  assert.equal(JSON.stringify(card).includes('private upstream'), false);
});

test('Gemini quota fallback persists honest basic coaching rather than a fake AI grade', async t => {
  const fake = upstream();
  let geminiCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (new URL(url).hostname === 'generativelanguage.googleapis.com') { geminiCalls++;return Response.json({}, { status: 429 }); }
    return fake.fetchImpl(url, options);
  };
  const config = readConfig({ ...configEnv, LEXICAL_GEMINI_API_KEY: 'gemini-test-only', GEMINI_FREE_TIER: 'true' });
  const app = createApp({ config, fetchImpl });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve);app.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/feedback`, { method: 'POST', headers: { Authorization: BEARER, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'writing', itemId: ITEM_ID, item: savedItem(), prompt: 'client prompt', response: 'A ceasefire gives people time to discuss a lasting agreement.', previousAttempts: [] }) });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.method, 'rules');
  assert.equal(result.attemptNumber, 1);
  assert.equal(result.criteria.every(criterion => criterion.score === null), true);
  assert.match(result.limitations[0], /basic coaching/);
  assert.equal(geminiCalls, 1);
  assert.equal(fake.attempts.length, 1);
});

test('a Gemini key alone never enables AI unless free-tier mode is explicitly acknowledged', () => {
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    const config = readConfig({ ...configEnv, LEXICAL_GEMINI_API_KEY: 'gemini-test-only', GEMINI_FREE_TIER: flag });
    assert.equal(config.geminiEnabled, false);
    assert.equal(config.configured, true);
  }
});
