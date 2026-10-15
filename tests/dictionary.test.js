import test from 'node:test';
import assert from 'node:assert/strict';
import { createLexicon, plainText } from '../server/dictionary.js';

const dictionaryHost = 'https://api.dictionaryapi.dev';
const wikiHost = 'https://en.wiktionary.org';
const translationHost = 'https://api.mymemory.translated.net';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function definition(term = 'ceasefire', overrides = {}) {
  return [{ word: term, phonetic: '/ˈsiːsfaɪə/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'An agreement to stop fighting.', example: 'The two sides agreed to a ceasefire.', synonyms: ['truce'], antonyms: [], ...overrides }] }], license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' } }];
}
function fixture(handler) {
  const calls = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, init });
    assert.ok([dictionaryHost, wikiHost, translationHost].includes(url.origin), `Unexpected provider ${url.origin}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    return handler(url, init);
  };
  return { fetchImpl, calls };
}
const request = (text = 'ceasefire', language = 'English', context = '') => ({ text, language, context });
const config = { aiKey: 'must-never-be-used' };

test('no-cost word lookup returns actual dictionary data with source licensing', async () => {
  const { fetchImpl, calls } = fixture(() => json(definition()));
  const card = await createLexicon(config, fetchImpl, request());
  assert.equal(card.definition, 'An agreement to stop fighting.');
  assert.equal(card.kind, 'word');
  assert.deepEqual(card.synonyms, ['truce']);
  assert.deepEqual(card.antonyms, []);
  assert.match(card.antonymNote, /does not list an antonym/);
  assert.deepEqual(card.examples, ['The two sides agreed to a ceasefire.']);
  assert.equal(card.source.name, 'Free Dictionary API');
  assert.equal(card.source.license, 'CC BY-SA 3.0');
  assert.equal(card.source.licenseUrl, 'https://creativecommons.org/licenses/by-sa/3.0/');
  assert.equal(card.translation, '');
  assert.match(card.translationNote, /already in English/);
  assert.equal(calls.length, 1);
  assert.equal(card.exercises.find(exercise => exercise.type === 'gap').question.includes('a _____.'), true);
});

test('foreign-language translation uses only the item, not learner context', async () => {
  const privateContext = 'A private sentence about the ceasefire.';
  const { fetchImpl, calls } = fixture(url => url.origin === dictionaryHost
    ? json(definition()) : json({ responseStatus: 200, responseData: { translatedText: 'прекращение огня' }, quotaFinished: false }));
  const card = await createLexicon(config, fetchImpl, request('ceasefire', 'Russian', privateContext));
  assert.equal(card.translation, 'прекращение огня');
  assert.equal(card.translationSource.name, 'MyMemory');
  assert.equal(calls[1].url.searchParams.get('q'), 'ceasefire');
  assert.equal(calls[1].url.searchParams.get('langpair'), 'en|ru');
  assert.ok(calls.every(call => !call.url.href.includes('private')));
});

test('phrases and idioms remain a whole exact lexical item on Wiktionary fallback', async () => {
  const { fetchImpl, calls } = fixture(url => url.origin === dictionaryHost ? json({}, 404)
    : json({ en: [{ partOfSpeech: 'Verb', definitions: [{ definition: '(idiomatic) To make people feel comfortable.', examples: ['A game can break the ice.'] }] }] }));
  const card = await createLexicon(config, fetchImpl, request('break the ice'));
  assert.equal(card.term, 'break the ice');
  assert.equal(card.kind, 'idiom');
  assert.equal(card.source.name, 'Wiktionary');
  assert.match(card.source.url, /break_the_ice$/);
  assert.equal(card.source.license, 'CC BY-SA 4.0');
  assert.deepEqual(card.examples, ['A game can break the ice.']);
  assert.match(calls[0].url.pathname, /break%20the%20ice$/);
  assert.match(calls[1].url.pathname, /break_the_ice$/);
  assert.equal(calls.length, 2);
});

test('stable MediaWiki API fallback selects the English section and quoted examples', async () => {
  const { fetchImpl, calls } = fixture(url => {
    if (url.origin === dictionaryHost || url.pathname.includes('rest_v1')) return json({}, 404);
    assert.equal(url.searchParams.get('page'), 'under_the_weather');
    if (url.searchParams.get('prop') === 'sections') return json({ parse: { sections: [{ index: '1', line: 'French' }, { index: '3', line: 'English' }] } });
    assert.equal(url.searchParams.get('section'), '3');
    return json({ parse: { text: { '*': '<div><h3>Adjective</h3><ol><li>(idiomatic) Feeling <a href="/wiki/unwell">unwell</a>.<dl><dd><span class="e-example">I am <b>under the weather</b> today.</span><span class="e-translation">This is not the example.</span></dd></dl></li><li>A second meaning.</li></ol></div>' } } });
  });
  const card = await createLexicon(config, fetchImpl, request('under the weather'));
  assert.equal(card.definition, '(idiomatic) Feeling unwell .');
  assert.deepEqual(card.examples, ['I am under the weather today.']);
  assert.match(card.usageNote, /2 senses/);
  assert.equal(calls.length, 4);
});

test('the dictionary must not substitute a different word for the requested phrase', async () => {
  const { fetchImpl } = fixture(url => url.origin === dictionaryHost ? json(definition('ice'))
    : url.pathname.includes('rest_v1') ? json({}, 404) : json({ error: { code: 'missingtitle' } }));
  await assert.rejects(createLexicon(config, fetchImpl, request('break the ice')), error => error.status === 404 && error.code === 'dictionary_not_found');
});

test('no examples or antonyms are invented when the source omits them', async () => {
  const { fetchImpl } = fixture(() => json(definition('ceasefire', { example: undefined, synonyms: [], antonyms: [] })));
  const card = await createLexicon(config, fetchImpl, request());
  assert.deepEqual(card.examples, []);
  assert.match(card.examplesNote, /did not provide an example/);
  assert.deepEqual(card.exercises, []);
});

test('learner-supplied context is explicitly attributed when no dictionary example exists', async () => {
  const { fetchImpl } = fixture(() => json(definition('ceasefire', { example: undefined })));
  const context = 'We heard about a ceasefire on the news.';
  const card = await createLexicon(config, fetchImpl, request('ceasefire', 'English', context));
  assert.deepEqual(card.examples, [context]);
  assert.match(card.examplesSource[0], /Your pasted context/);
  assert.match(card.examplesNote, /not an independently verified example/);
});

test('a long learner context excerpt retains the target expression near its end', async () => {
  const { fetchImpl } = fixture(() => json(definition('ceasefire', { example: undefined })));
  const context = `${'Earlier context. '.repeat(120)}The ceasefire was announced.`;
  const card = await createLexicon(config, fetchImpl, request('ceasefire', 'English', context));
  assert.ok(card.examples[0].length <= 1500);
  assert.match(card.examples[0], /The ceasefire was announced/);
  assert.match(card.examplesSource[0], /Your pasted context/);
});

test('long gap practice uses only the real pasted passage and removes one occurrence', async () => {
  const { fetchImpl } = fixture(() => json(definition('ceasefire', { example: undefined })));
  const passage = `The ceasefire was announced. ${'People followed the news carefully and discussed their hopes for tomorrow. '.repeat(8)}The ceasefire remained fragile.`;
  const card = await createLexicon(config, fetchImpl, request('ceasefire', 'English', passage));
  const gap = card.exercises.find(exercise => exercise.type === 'gap');
  assert.match(gap.question, /^Source: your pasted passage/);
  assert.equal((gap.question.match(/_____/g) || []).length, 1);
  assert.equal(gap.question.split('\n')[1], passage.replace('ceasefire', '_____'));
  assert.match(gap.explanation, /have not been verified/);
  assert.equal(gap.answer, 'ceasefire');
  assert.deepEqual(gap.options, []);
});

test('partial word substrings do not create false gap exercises or context examples', async () => {
  const { fetchImpl } = fixture(() => json(definition('art', { definition: 'Creative work.', example: 'We went to a party.', synonyms: [] })));
  const card = await createLexicon(config, fetchImpl, request('art', 'English', 'The party began. '.repeat(50)));
  assert.equal(card.exercises.some(exercise => exercise.type === 'gap'), false);
});

test('first-sense data does not mix in synonyms and antonyms from other senses', async () => {
  const body = definition('fine', { definition: 'Of good quality.', example: 'This is fine.', synonyms: [], antonyms: [] });
  body[0].meanings[0].definitions.push({ definition: 'A financial penalty.', example: 'He paid a fine.', synonyms: ['penalty'], antonyms: ['reward'] });
  body[0].meanings[0].synonyms = ['penalty'];
  body[0].meanings[0].antonyms = ['reward'];
  const { fetchImpl } = fixture(() => json(body));
  const card = await createLexicon(config, fetchImpl, request('fine'));
  assert.deepEqual(card.synonyms, []);
  assert.deepEqual(card.antonyms, []);
  assert.deepEqual(card.examples, ['This is fine.']);
  assert.match(card.usageNote, /first is shown/);
});

test('relation exercises accept every listed same-sense synonym or antonym', async () => {
  const { fetchImpl } = fixture(() => json(definition('good', { definition: 'Having desirable qualities.', synonyms: ['fine', 'excellent'], antonyms: ['bad', 'poor'], example: undefined })));
  const card = await createLexicon(config, fetchImpl, request('good'));
  const synonym = card.exercises.find(exercise => exercise.type === 'synonym');
  const antonym = card.exercises.find(exercise => exercise.type === 'antonym');
  assert.deepEqual(synonym.acceptedAnswers, ['fine', 'excellent']);
  assert.deepEqual(antonym.acceptedAnswers, ['bad', 'poor']);
  assert.equal(synonym.answer, 'fine');
  assert.deepEqual(synonym.options, []);
  assert.deepEqual(antonym.options, []);
});

test('unsupported translation languages produce an explicit note and no translation request', async () => {
  const { fetchImpl, calls } = fixture(() => json(definition()));
  const card = await createLexicon(config, fetchImpl, request('ceasefire', 'Invented language'));
  assert.equal(card.translation, '');
  assert.match(card.translationNote, /not supported/);
  assert.equal(calls.length, 1);
});

for (const [label, body, status] of [
  ['quota error code', { responseStatus: 429, responseData: { translatedText: 'MYMEMORY WARNING: quota' } }, 200],
  ['quota finished', { responseStatus: 200, quotaFinished: true, responseData: { translatedText: 'warning' } }, 200],
  ['HTTP provider outage', {}, 503],
  ['missing translation response', { responseStatus: 200, responseData: {} }, 200],
]) test(`translation ${label} does not prevent dictionary lookup or impersonate a translation`, async () => {
  const { fetchImpl } = fixture(url => url.origin === dictionaryHost ? json(definition()) : json(body, status));
  const card = await createLexicon(config, fetchImpl, request('ceasefire', 'Uzbek'));
  assert.equal(card.translation, '');
  assert.ok(card.translationNote.length > 0);
  assert.equal(card.definition, 'An agreement to stop fighting.');
  assert.equal(card.translationSource, undefined);
});

test('over-500-byte expressions skip MyMemory instead of violating its request limits', async () => {
  const term = '🧠'.repeat(130);
  const { fetchImpl, calls } = fixture(() => json(definition(term)));
  const card = await createLexicon(config, fetchImpl, request(term, 'Russian'));
  assert.equal(card.translation, '');
  assert.match(card.translationNote, /500-byte/);
  assert.equal(calls.length, 1);
});

test('HTML and entities become plain text; scripts are omitted', () => {
  assert.equal(plainText('<script>alert(1)</script><b>A &amp; B</b> &#x2014; &#8217; <style>bad</style>'), 'A & B — ’');
  assert.equal(plainText(null), '');
  assert.equal(plainText('x'.repeat(100001)), '');
});

test('HTML provider definitions and examples are sanitized before returning a card', async () => {
  const { fetchImpl } = fixture(() => json(definition('ceasefire', { definition: '<b>An agreement</b><script>bad()</script> to stop fighting.', example: '<i>They &amp; their neighbours</i> want a ceasefire.' })));
  const card = await createLexicon(config, fetchImpl, request());
  assert.equal(card.definition, 'An agreement to stop fighting.');
  assert.deepEqual(card.examples, ['They & their neighbours want a ceasefire.']);
});

test('user URL-like content cannot change provider destinations or add query parameters', async () => {
  const term = 'https://attacker.example/?q=secret&evil=1';
  const { fetchImpl, calls } = fixture(url => url.origin === dictionaryHost ? json(definition(term))
    : json({ responseStatus: 200, responseData: { translatedText: 'test translation' } }));
  await createLexicon(config, fetchImpl, request(term, 'ru'));
  assert.equal(calls[0].url.origin, dictionaryHost);
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[1].url.searchParams.get('q'), term);
  assert.equal(calls[1].url.searchParams.has('evil'), false);
});

test('successful lookups and translations are cached without cross-request mutation', async () => {
  const { fetchImpl, calls } = fixture(url => url.origin === dictionaryHost ? json(definition())
    : json({ responseStatus: 200, responseData: { translatedText: 'прекращение огня' } }));
  const first = await createLexicon(config, fetchImpl, request('ceasefire', 'Russian'));
  first.source.name = 'changed';
  first.synonyms.push('fake');
  first.translationSource.name = 'changed';
  const second = await createLexicon(config, fetchImpl, request('ceasefire', 'Russian'));
  assert.equal(calls.length, 2);
  assert.equal(second.source.name, 'Free Dictionary API');
  assert.equal(second.translationSource.name, 'MyMemory');
  assert.deepEqual(second.synonyms, ['truce']);
});

test('failed translations are not cached, allowing retry after a quota or service recovery', async () => {
  let failed = true;
  const { fetchImpl, calls } = fixture(url => url.origin === dictionaryHost ? json(definition())
    : failed ? json({}, 503) : json({ responseStatus: 200, responseData: { translatedText: 'sulh' } }));
  assert.equal((await createLexicon(config, fetchImpl, request('ceasefire', 'Uzbek'))).translation, '');
  failed = false;
  assert.equal((await createLexicon(config, fetchImpl, request('ceasefire', 'Uzbek'))).translation, 'sulh');
  assert.equal(calls.length, 3);
});

test('all unavailable providers return a recoverable free dictionary error', async () => {
  const { fetchImpl } = fixture(() => { throw new Error('network failed'); });
  await assert.rejects(createLexicon(config, fetchImpl, request()), error => error.status === 502 && error.code === 'dictionary_unavailable');
});

test('exact item misses return manual-entry guidance rather than invented definitions', async () => {
  const { fetchImpl } = fixture(url => url.origin === dictionaryHost || url.pathname.includes('rest_v1') ? json({}, 404) : json({ error: { code: 'missingtitle' } }));
  await assert.rejects(createLexicon(config, fetchImpl, request('unknown unusual long phrase')), error => error.status === 404 && error.code === 'dictionary_not_found' && /manually/.test(error.message));
});

test('word miss plus a Wiktionary outage is not claimed to prove a phrase has no entry', async () => {
  const { fetchImpl } = fixture(url => url.origin === dictionaryHost ? json({}, 404) : json({}, 503));
  await assert.rejects(createLexicon(config, fetchImpl, request('break the ice')), error => error.code === 'dictionary_unavailable');
});

test('invalid lexical items are rejected before any provider request', async () => {
  const { fetchImpl, calls } = fixture(() => assert.fail('No request should occur'));
  for (const text of ['', ' ', 'x'.repeat(301), 'invalid\u0000term']) await assert.rejects(createLexicon(config, fetchImpl, request(text)), error => error.code === 'invalid_request');
  assert.equal(calls.length, 0);
});

test('multiline pasted expressions normalize whitespace while preserving the full phrase', async () => {
  const { fetchImpl, calls } = fixture(() => json(definition('break the ice')));
  const card = await createLexicon(config, fetchImpl, request('break\n the\tice'));
  assert.equal(card.term, 'break the ice');
  assert.match(calls[0].url.pathname, /break%20the%20ice$/);
});

const exactMiss = url => url.origin === dictionaryHost || url.pathname.includes('rest_v1')
  ? json({}, 404) : json({ error: { code: 'missingtitle' } });
const requestedSpelling = url => url.searchParams.get('page') || decodeURIComponent(url.pathname.split('/').at(-1));

for (const term of ['Incontrovertible', 'INCONTROVERTIBLE']) test(`a lowercase retry finds ${term} while preserving the pasted spelling`, async () => {
  const { fetchImpl, calls } = fixture(url => url.origin === dictionaryHost && requestedSpelling(url) === 'incontrovertible'
    ? json(definition('incontrovertible', { definition: 'Impossible to dispute.', example: 'The evidence was incontrovertible.', synonyms: [], antonyms: [] }))
    : exactMiss(url));
  const card = await createLexicon(config, fetchImpl, request(term));
  assert.equal(card.term, term);
  assert.equal(card.definition, 'Impossible to dispute.');
  assert.match(card.source.url, /\/incontrovertible$/);
  assert.match(card.usageNote, /lowercase spelling “incontrovertible”/);
  assert.match(card.usageNote, /Capitalization can change/);
  assert.equal(calls.length, 4);
  assert.equal(requestedSpelling(calls[0].url), term);
  assert.equal(requestedSpelling(calls[1].url), term);
  assert.equal(requestedSpelling(calls[2].url), term);
});

test('title-cased idioms retry the whole lowercase expression and never its component words', async () => {
  const { fetchImpl, calls } = fixture(url => url.pathname.includes('rest_v1') && requestedSpelling(url) === 'break_the_ice'
    ? json({ en: [{ partOfSpeech: 'Verb', definitions: [{ definition: '(idiomatic) To make people feel comfortable.', examples: ['A game can break the ice.'] }] }] })
    : exactMiss(url));
  const card = await createLexicon(config, fetchImpl, request('Break The Ice'));
  assert.equal(card.term, 'Break The Ice');
  assert.equal(card.kind, 'idiom');
  assert.match(card.source.url, /\/break_the_ice$/);
  assert.match(card.usageNote, /lowercase spelling “break the ice”/);
  assert.deepEqual(calls.map(call => requestedSpelling(call.url)), ['Break The Ice', 'Break_The_Ice', 'Break_The_Ice', 'break the ice', 'break_the_ice']);
});

test('exact-case dictionary entries take precedence over folded responses in the same body', async () => {
  const { fetchImpl, calls } = fixture(() => json([
    ...definition('may', { definition: 'To be permitted to do something.' }),
    ...definition('May', { definition: 'The fifth month of the year.' }),
  ]));
  const card = await createLexicon(config, fetchImpl, request('May'));
  assert.equal(card.definition, 'The fifth month of the year.');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(card.usageNote, /lowercase spelling/);
});

test('an exact proper-name Wiktionary entry takes precedence over a lowercase dictionary response', async () => {
  const { fetchImpl, calls } = fixture(url => url.origin === dictionaryHost
    ? json(definition('may', { definition: 'To be permitted to do something.' }))
    : json({ en: [{ partOfSpeech: 'Proper noun', definitions: [{ definition: 'The fifth month of the year.' }] }] }));
  const month = await createLexicon(config, fetchImpl, request('May'));
  const modal = await createLexicon(config, fetchImpl, request('may'));
  assert.equal(month.definition, 'The fifth month of the year.');
  assert.match(month.source.url, /\/May$/);
  assert.doesNotMatch(month.usageNote, /lowercase spelling/);
  assert.equal(modal.definition, 'To be permitted to do something.');
  assert.match(modal.source.url, /\/may$/);
  assert.equal((await createLexicon(config, fetchImpl, request('May'))).definition, month.definition);
  assert.equal(calls.length, 3);
});

test('an exact-case stable Wiktionary entry is used before a lowercase retry despite a REST outage', async () => {
  const { fetchImpl, calls } = fixture(url => {
    if (url.origin === dictionaryHost) return json({}, 404);
    if (url.pathname.includes('rest_v1')) return json({}, 503);
    assert.equal(url.searchParams.get('page'), 'May');
    if (url.searchParams.get('prop') === 'sections') return json({ parse: { sections: [{ line: 'English', index: '1' }] } });
    return json({ parse: { text: { '*': '<h3>Proper noun</h3><ol><li>The fifth month of the year.</li></ol>' } } });
  });
  const card = await createLexicon(config, fetchImpl, request('May'));
  assert.equal(card.definition, 'The fifth month of the year.');
  assert.match(card.source.url, /\/May$/);
  assert.equal(calls.length, 4);
  assert.doesNotMatch(card.usageNote, /lowercase spelling/);
});

test('dictionary and translation caches keep abbreviation and ordinary-word case distinct', async () => {
  const { fetchImpl, calls } = fixture(url => {
    const term = url.origin === dictionaryHost ? requestedSpelling(url) : url.searchParams.get('q');
    if (url.origin === dictionaryHost) return json(definition(term, { definition: term === 'US' ? 'The United States.' : 'The object form of we.' }));
    return json({ responseStatus: 200, responseData: { translatedText: term === 'US' ? 'США' : 'нас' } });
  });
  const abbreviation = await createLexicon(config, fetchImpl, request('US', 'Russian'));
  const pronoun = await createLexicon(config, fetchImpl, request('us', 'Russian'));
  assert.equal(abbreviation.definition, 'The United States.');
  assert.equal(abbreviation.translation, 'США');
  assert.equal(pronoun.definition, 'The object form of we.');
  assert.equal(pronoun.translation, 'нас');
  assert.equal((await createLexicon(config, fetchImpl, request('US', 'Russian'))).translation, 'США');
  assert.equal(calls.length, 4);
});

test('a verified lowercase reading is available during original-case outages with an explicit qualification', async () => {
  const { fetchImpl, calls } = fixture(url => {
    if (url.origin === dictionaryHost && requestedSpelling(url) === 'incontrovertible') return json(definition('incontrovertible', { definition: 'Impossible to dispute.' }));
    return url.pathname.includes('rest_v1') ? json({}, 503) : exactMiss(url);
  });
  const card = await createLexicon(config, fetchImpl, request('Incontrovertible'));
  assert.equal(card.term, 'Incontrovertible');
  assert.equal(card.definition, 'Impossible to dispute.');
  assert.match(card.source.url, /\/incontrovertible$/);
  assert.match(card.usageNote, /exact capitalization could not be fully checked/);
  assert.match(card.usageNote, /lowercase spelling “incontrovertible”/);
  assert.equal(calls.length, 4);
});

test('lowercase fallback during an outage does not cache over a proper entry after recovery', async () => {
  let recovered = false;
  const { fetchImpl, calls } = fixture(url => {
    if (url.origin === dictionaryHost) return json(definition('may', { definition: 'To be permitted to do something.' }));
    if (recovered && url.pathname.includes('rest_v1')) return json({ en: [{ partOfSpeech: 'Proper noun', definitions: [{ definition: 'The fifth month of the year.' }] }] });
    return json({}, 503);
  });
  const fallback = await createLexicon(config, fetchImpl, request('May'));
  assert.equal(fallback.definition, 'To be permitted to do something.');
  assert.match(fallback.usageNote, /exact capitalization could not be fully checked/);
  recovered = true;
  const exact = await createLexicon(config, fetchImpl, request('May'));
  assert.equal(exact.definition, 'The fifth month of the year.');
  assert.match(exact.source.url, /\/May$/);
  assert.doesNotMatch(exact.usageNote, /lowercase spelling/);
  assert.equal(calls.length, 6);
});

for (const [label, unavailable] of [
  ['original dictionary', url => url.origin === dictionaryHost && requestedSpelling(url) === 'Unknown'],
  ['original REST dictionary', url => url.pathname.includes('rest_v1') && requestedSpelling(url) === 'Unknown'],
  ['lowercase dictionary', url => url.origin === dictionaryHost && requestedSpelling(url) === 'unknown'],
  ['lowercase stable dictionary', url => url.pathname === '/w/api.php' && requestedSpelling(url) === 'unknown'],
]) test(`an ${label} outage plus other spelling misses remains a recoverable error`, async () => {
  const { fetchImpl, calls } = fixture(url => unavailable(url) ? json({}, 503) : exactMiss(url));
  await assert.rejects(createLexicon(config, fetchImpl, request('Unknown')), error => error.status === 502 && error.code === 'dictionary_unavailable');
  assert.equal(calls.length, 6);
});

test('capitalized whole-expression misses return manual guidance only after both spellings miss', async () => {
  const { fetchImpl, calls } = fixture(exactMiss);
  await assert.rejects(createLexicon(config, fetchImpl, request('An Unknown Expression')), error => error.status === 404 && error.code === 'dictionary_not_found');
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map(call => requestedSpelling(call.url)), ['An Unknown Expression', 'An_Unknown_Expression', 'An_Unknown_Expression', 'an unknown expression', 'an_unknown_expression', 'an_unknown_expression']);
});

test('a malformed successful provider response is unavailable rather than proof of absence', async () => {
  const { fetchImpl } = fixture(url => url.origin === dictionaryHost ? json({}, 404)
    : url.pathname.includes('rest_v1') ? json({}, 404) : json({}));
  await assert.rejects(createLexicon(config, fetchImpl, request('unknown')), error => error.status === 502 && error.code === 'dictionary_unavailable');
});
