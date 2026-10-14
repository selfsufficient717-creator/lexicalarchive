/** Pure learning helpers. Content comes from a lookup or the learner's library. */
const exerciseTypes = new Set(['meaning', 'synonym', 'antonym', 'gap', 'context', 'collocation']);
const unavailable = /^(?:none|n\/?a|not applicable|not available|unavailable|no (?:direct |natural |exact |common )?(?:antonym|synonym|translation)s?)(?:[.!]|\s*\([^)]*\))?$/i;
const dayMilliseconds = 24 * 60 * 60 * 1000;
const reviewIntervals = [1, 3, 7, 14, 30, 60, 120, 180];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function usable(value) {
  const valueText = text(value);
  return valueText && !unavailable.test(valueText) ? valueText : '';
}

function normalize(value) {
  return text(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[’'`]/g, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ignore presentation differences without accepting an empty response. */
export function checkAnswer(actual, expected) {
  const answer = normalize(actual);
  if (!answer) return false;
  const acceptable = Array.isArray(expected) ? expected : [expected];
  return acceptable.some(value => normalize(value) === answer);
}

function shuffle(values, rng) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomValue = Number(rng());
    const fraction = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON) : 0.5;
    const swapIndex = Math.floor(fraction * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function uniqueTexts(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap(value => {
    const candidate = usable(value);
    const key = normalize(candidate);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [candidate];
  });
}

/**
 * Validate supplied exercises, add recall, and use real saved definitions for
 * an optional meaning quiz. An absent antonym never becomes a made-up answer.
 */
export function buildExercises(item, library = [], rng = Math.random) {
  const term = usable(item?.term);
  const definition = usable(item?.definition);
  if (!term || !definition) return [];
  const exercises = [];
  const synonyms = uniqueTexts(item.synonyms).filter(value => !checkAnswer(value, term));
  const antonyms = uniqueTexts(item.antonyms).filter(value => !checkAnswer(value, term));

  for (const [index, source] of (Array.isArray(item.exercises) ? item.exercises : []).entries()) {
    if (!source || !exerciseTypes.has(source.type)) continue;
    if (source.type === 'synonym' && !synonyms.length) continue;
    if (source.type === 'antonym' && !antonyms.length) continue;
    const question = text(source.question);
    const answer = usable(source.answer);
    if (!question || !normalize(answer)) continue;
    const options = uniqueTexts(source.options);
    // An invalid choice question must not silently turn into a text question.
    if (Array.isArray(source.options) && source.options.length && (options.length < 2 || !options.some(option => checkAnswer(option, answer)))) continue;
    if (source.options !== undefined && !Array.isArray(source.options)) continue;
    const displayedAnswer = options.find(option => checkAnswer(option, answer)) || answer;
    exercises.push({
      id: `exercise-${index}-${source.type}`,
      type: source.type,
      question,
      options: shuffle(options, rng),
      answer: displayedAnswer,
      explanation: text(source.explanation) || definition,
    });
  }

  if (!exercises.some(exercise => exercise.type === 'meaning')) {
    const distractors = uniqueTexts((Array.isArray(library) ? library : [])
      .filter(candidate => candidate && !checkAnswer(candidate.term, term))
      .map(candidate => candidate.definition))
      .filter(candidate => !checkAnswer(candidate, definition));
    if (distractors.length >= 2) {
      exercises.push({
        id: 'library-meaning',
        type: 'meaning',
        question: `Which meaning matches “${term}”?`,
        options: shuffle([definition, ...shuffle(distractors, rng).slice(0, 3)], rng),
        answer: definition,
        explanation: definition,
      });
    }
  }

  exercises.push({
    id: 'recall',
    type: 'recall',
    question: `Which word or phrase means: ${definition}`,
    options: [],
    answer: term,
    explanation: text(item.usageNote) || definition,
  });

  const translation = usable(item.translation);
  if (translation && !checkAnswer(translation, term)) {
    const language = text(item.language);
    exercises.push({
      id: 'translation',
      type: 'translation',
      question: `Translate “${term}”${language ? ` into ${language}` : ''}.`,
      options: [],
      answer: translation,
      explanation: definition,
    });
  }
  return exercises;
}

/** Build an actual matching activity, omitting unavailable or ambiguous pairs. */
export function buildMatchingRound(items, relation = 'meaning', rng = Math.random) {
  if (!['meaning', 'synonym', 'antonym'].includes(relation) || !Array.isArray(items)) return null;
  const candidates = [];
  const leftCandidates = new Map();
  for (const [index, item] of items.entries()) {
    const left = usable(item?.term);
    const leftKey = normalize(left);
    if (!leftKey) continue;
    const targets = (relation === 'meaning' ? uniqueTexts([item.definition]) : uniqueTexts(item[`${relation}s`]))
      .filter(target => relation === 'meaning' || normalize(target) !== leftKey);
    if (!targets.length) continue;
    const existing = leftCandidates.get(leftKey);
    if (existing) {
      existing.targets = uniqueTexts([...existing.targets, ...targets]);
    } else {
      const candidate = { id: `${relation}-${index}`, left, targets };
      candidates.push(candidate);
      leftCandidates.set(leftKey, candidate);
    }
  }
  // A distinct displayed answer is insufficient: another displayed term may
  // also list that answer as a valid synonym/antonym. Only use targets whose
  // listed relationship belongs to one candidate, so a valid swap cannot be
  // marked wrong merely because its pair ID differs.
  const targetCounts = new Map();
  for (const candidate of candidates) {
    for (const target of candidate.targets) {
      const key = normalize(target);
      targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
    }
  }
  const unambiguous = candidates.flatMap(candidate => {
    const right = candidate.targets.find(target => targetCounts.get(normalize(target)) === 1);
    return right ? [{ id: candidate.id, left: candidate.left, right }] : [];
  });
  if (unambiguous.length < 2) return null;
  const pairs = unambiguous.length > 6 ? shuffle(unambiguous, rng).slice(0, 6) : unambiguous;
  return {
    pairs,
    left: shuffle(pairs.map(pair => ({ id: pair.id, text: pair.left })), rng),
    right: shuffle(pairs.map(pair => ({ id: pair.id, text: pair.right })), rng),
  };
}

function counter(value) {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), 1_000_000) : 0;
}

/** Review tomorrow after a miss; successive successful reviews space out. */
export function nextReview(previous, correct, now = new Date()) {
  const currentTime = new Date(now);
  if (!Number.isFinite(currentTime.getTime())) throw new TypeError('A valid review date is required.');
  const streak = correct === true ? Math.min(counter(previous?.streak) + 1, 1_000_000) : 0;
  const intervalDays = correct === true ? reviewIntervals[Math.min(streak - 1, reviewIntervals.length - 1)] : 1;
  const due = new Date(currentTime.getTime() + intervalDays * dayMilliseconds);
  if (!Number.isFinite(due.getTime())) throw new TypeError('The review date is outside the supported range.');
  return {
    intervalDays,
    dueAt: due.toISOString(),
    streak,
    reviewCount: Math.min(counter(previous?.reviewCount) + 1, 1_000_000),
  };
}
