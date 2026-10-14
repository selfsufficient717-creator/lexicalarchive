import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExercises, buildMatchingRound, checkAnswer, nextReview } from '../practice.js';

const phrase = {
  term: 'break the ice',
  kind: 'idiom',
  definition: 'Make people feel relaxed when they first meet.',
  translation: 'Romper el hielo',
  language: 'Spanish',
  synonyms: ['get a conversation started'],
  antonyms: [],
  antonymNote: 'This idiom has no direct opposite.',
  usageNote: 'Use this for a first conversation, not for breaking something.',
  examples: ['A friendly question can break the ice.'],
  exercises: [{
    type: 'gap',
    question: 'We did not know each other, so I asked a friendly question to ____.',
    options: ['break the ice', 'leave immediately', 'stay silent'],
    answer: 'break the ice',
    explanation: 'The question helps everyone feel relaxed.',
  }],
};

test('answer checking ignores case, accents, spaces, and punctuation but rejects blanks', () => {
  assert.equal(checkAnswer('  CAFÉ! ', 'cafe'), true);
  assert.equal(checkAnswer('Break — the ice.', 'break the ice'), true);
  assert.equal(checkAnswer('Don’t give up!', "don't give up"), true);
  assert.equal(checkAnswer('ice-breaker', 'ice breaker'), true);
  assert.equal(checkAnswer('...', '!!!'), false);
  assert.equal(checkAnswer('', ''), false);
  assert.equal(checkAnswer(undefined, undefined), false);
  assert.equal(checkAnswer('stay silent', 'break the ice'), false);
  assert.equal(checkAnswer('Begin', ['start', 'begin']), true);
});

test('phrases retain their whole text in recall and translation activities', () => {
  const exercises = buildExercises(phrase, [], () => 0.999);
  assert.equal(exercises.find(exercise => exercise.type === 'recall').answer, 'break the ice');
  const translation = exercises.find(exercise => exercise.type === 'translation');
  assert.equal(translation.answer, 'Romper el hielo');
  assert.match(translation.question, /Spanish/);
  assert.deepEqual(exercises[0].options, phrase.exercises[0].options);
});

test('all supported generated exercise types are retained when answerable', () => {
  const item = {
    ...phrase,
    antonyms: ['make people uncomfortable'],
    exercises: ['meaning', 'synonym', 'antonym', 'gap', 'context', 'collocation'].map(type => ({
      type, question: `A question for ${type}`, options: ['correct option', 'other option'],
      answer: 'Correct option!', explanation: `Explanation for ${type}`,
    })),
  };
  assert.deepEqual(buildExercises(item, [], () => 0.999).map(exercise => exercise.type),
    ['meaning', 'synonym', 'antonym', 'gap', 'context', 'collocation', 'recall', 'translation']);
});

test('exercise options shuffle using injected randomness without mutating source data', () => {
  const before = JSON.stringify(phrase);
  const exercises = buildExercises(phrase, [], () => 0);
  assert.deepEqual(exercises[0].options, ['leave immediately', 'stay silent', 'break the ice']);
  assert.equal(exercises[0].answer, 'break the ice');
  assert.equal(JSON.stringify(phrase), before);
});

test('invalid or impossible questions are discarded instead of presented', () => {
  const item = { ...phrase, exercises: [
    { type: 'antonym', question: 'Choose its opposite.', options: ['one', 'two'], answer: 'one' },
    { type: 'gap', question: 'Choose an option.', options: ['one', 'two'], answer: 'absent' },
    { type: 'gap', question: 'One choice only.', options: ['one', 'ONE!'], answer: 'one' },
    { type: 'context', question: '', options: ['one', 'two'], answer: 'one' },
    { type: 'unknown', question: 'Unexpected type.', answer: 'one' },
    { type: 'meaning', question: 'Blank expected answer.', answer: '...' },
    { type: 'meaning', question: 'Malformed options.', answer: 'one', options: 'one' },
  ] };
  assert.deepEqual(buildExercises(item).map(exercise => exercise.type), ['recall', 'translation']);
  assert.deepEqual(buildExercises(null), []);
  assert.deepEqual(buildExercises({ term: 'test' }), []);
});

test('unavailable translations and absent antonyms do not generate invented content', () => {
  const exercises = buildExercises({ ...phrase, translation: 'N/A', antonyms: ['No direct antonym'] });
  assert.equal(exercises.some(exercise => exercise.type === 'translation'), false);
  assert.equal(exercises.some(exercise => exercise.type === 'antonym'), false);
  assert.equal(buildMatchingRound([{ ...phrase, antonyms: ['No direct antonym'] }, { term: 'other', antonyms: [] }], 'antonym'), null);
});

test('an optional meaning quiz uses distinct real library definitions only', () => {
  const library = [phrase,
    { term: 'first', definition: 'A first real definition.' },
    { term: 'duplicate', definition: 'A FIRST REAL DEFINITION!' },
    { term: 'second', definition: 'A second real definition.' },
    { term: 'same meaning', definition: phrase.definition },
  ];
  const quiz = buildExercises(phrase, library, () => 0.999).find(exercise => exercise.id === 'library-meaning');
  assert.deepEqual(quiz.options, [phrase.definition, 'A first real definition.', 'A second real definition.']);
  assert.equal(quiz.answer, phrase.definition);
  assert.equal(buildExercises(phrase, library.slice(0, 2)).some(exercise => exercise.id === 'library-meaning'), false);
});

test('a generated meaning quiz is not duplicated with a library-derived quiz', () => {
  const item = { ...phrase, exercises: [{ type: 'meaning', question: 'What does it mean?',
    options: [phrase.definition, 'A different meaning.'], answer: phrase.definition }] };
  const library = [{ term: 'a', definition: 'Meaning A.' }, { term: 'b', definition: 'Meaning B.' }];
  assert.equal(buildExercises(item, library).filter(exercise => exercise.type === 'meaning').length, 1);
});

test('matching activities have shared pair IDs and separately shuffled columns', () => {
  const items = [phrase, { term: 'under the weather', definition: 'Feeling a little ill.' },
    { term: 'ceasefire', definition: 'An agreement to stop fighting.' }];
  const original = JSON.stringify(items);
  const round = buildMatchingRound(items, 'meaning', () => 0);
  assert.equal(round.pairs.length, 3);
  assert.deepEqual(round.left.map(choice => choice.text), ['under the weather', 'ceasefire', 'break the ice']);
  for (const pair of round.pairs) {
    assert.equal(round.left.find(choice => choice.id === pair.id).text, pair.left);
    assert.equal(round.right.find(choice => choice.id === pair.id).text, pair.right);
  }
  assert.equal(JSON.stringify(items), original);
});

test('matching rejects duplicate targets and returns null when fewer than two pairs exist', () => {
  assert.equal(buildMatchingRound([phrase], 'meaning'), null);
  assert.equal(buildMatchingRound(null), null);
  assert.equal(buildMatchingRound([phrase, phrase], 'meaning'), null);
  assert.equal(buildMatchingRound([phrase, { ...phrase, term: 'another expression' }], 'meaning'), null);
  assert.equal(buildMatchingRound([phrase], 'unsupported'), null);
});

test('matching omits a shared target even when distinct displayed answers are possible', () => {
  assert.equal(buildMatchingRound([
    { term: 'first expression', synonyms: ['shared meaning', 'alternative meaning'] },
    { term: 'second expression', synonyms: ['shared meaning'] },
  ], 'synonym', () => 0.999), null);
});

test('shared synonyms and antonyms cannot become arbitrarily scored matching pairs', () => {
  const items = [
    { term: 'large', synonyms: ['big', 'huge'], antonyms: ['small', 'tiny'] },
    { term: 'enormous', synonyms: ['big', 'huge'], antonyms: ['small', 'tiny'] },
  ];
  assert.equal(buildMatchingRound(items, 'synonym'), null);
  assert.equal(buildMatchingRound(items, 'antonym'), null);
  const round = buildMatchingRound([...items,
    { term: 'call it a day', synonyms: ['finish work for now'] },
    { term: 'keep going', synonyms: ['continue'] },
  ], 'synonym', () => 0.999);
  assert.deepEqual(round.pairs.map(pair => pair.left), ['call it a day', 'keep going']);
});

test('matching keeps exclusive alternative targets when every pair is unambiguous', () => {
  const round = buildMatchingRound([
    { term: 'first expression', synonyms: ['shared meaning', 'first unique meaning'] },
    { term: 'second expression', synonyms: ['shared meaning', 'second unique meaning'] },
  ], 'synonym', () => 0.999);
  assert.deepEqual(round.pairs.map(pair => pair.right), ['first unique meaning', 'second unique meaning']);
});

test('duplicate terms combine listed relations instead of hiding another valid answer', () => {
  assert.equal(buildMatchingRound([
    { term: 'large', synonyms: ['big'] },
    { term: 'LARGE!', synonyms: ['huge'] },
    { term: 'enormous', synonyms: ['huge'] },
  ], 'synonym'), null);
});

test('matching selects at most six unambiguous pairs using injected randomness', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    term: `item ${index}`, definition: `A unique meaning for item ${index}.`,
  }));
  const original = JSON.stringify(items);
  const round = buildMatchingRound(items, 'meaning', () => 0);
  assert.equal(round.pairs.length, 6);
  assert.deepEqual(round.pairs.map(pair => pair.left), ['item 1', 'item 2', 'item 3', 'item 4', 'item 5', 'item 6']);
  const other = buildMatchingRound(items, 'meaning', () => 0.999);
  assert.deepEqual(other.pairs.map(pair => pair.left), ['item 0', 'item 1', 'item 2', 'item 3', 'item 4', 'item 5']);
  assert.equal(JSON.stringify(items), original);
});

test('synonym and antonym rounds keep whole phrases and omit missing relationships', () => {
  const items = [phrase,
    { term: 'call it a day', synonyms: ['finish work for now'], antonyms: ['keep working'] },
    { term: 'keep going', synonyms: ['continue'], antonyms: ['give up'] },
  ];
  assert.equal(buildMatchingRound(items, 'synonym').pairs[0].right, 'get a conversation started');
  const antonyms = buildMatchingRound(items, 'antonym');
  assert.deepEqual(antonyms.pairs.map(pair => pair.left), ['call it a day', 'keep going']);
});

test('scheduling starts tomorrow, spaces successful recalls, and resets after a miss', () => {
  const now = '2026-10-14T09:00:00.000Z';
  const first = nextReview(null, true, now);
  assert.deepEqual(first, { intervalDays: 1, dueAt: '2026-10-15T09:00:00.000Z', streak: 1, reviewCount: 1 });
  const second = nextReview(first, true, now);
  assert.equal(second.intervalDays, 3);
  assert.equal(second.streak, 2);
  assert.equal(second.reviewCount, 2);
  const missed = nextReview(second, false, now);
  assert.deepEqual(missed, { intervalDays: 1, dueAt: '2026-10-15T09:00:00.000Z', streak: 0, reviewCount: 3 });
  assert.equal(first.streak, 1);
});

test('scheduling bounds invalid or very large counters and refuses invalid dates', () => {
  const now = new Date('2026-10-14T09:00:00Z');
  const malformed = nextReview({ streak: -3, reviewCount: Infinity }, true, now);
  assert.equal(malformed.streak, 1);
  assert.equal(malformed.reviewCount, 1);
  const mature = nextReview({ streak: Number.MAX_SAFE_INTEGER, reviewCount: Number.MAX_SAFE_INTEGER }, true, now);
  assert.equal(mature.intervalDays, 180);
  assert.equal(mature.streak, 1_000_000);
  assert.equal(mature.reviewCount, 1_000_000);
  assert.equal(now.toISOString(), '2026-10-14T09:00:00.000Z');
  assert.throws(() => nextReview(null, true, 'not a date'), /valid review date/);
});
