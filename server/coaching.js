import { ApiError, CRITERIA } from './validation.js';

// Free coaching is deliberately limited to reproducible measurements. No
// language model, grammar service or transcription service is called here.
const WORDS = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’‘-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;
const POSSIBLE_DUPLICATES = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'is', 'are']);
const CONNECTORS = ['however', 'therefore', 'because', 'although', 'for example', 'as a result', 'in addition', 'first', 'next', 'finally', 'instead', 'meanwhile', 'also', 'but'];
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const normalized = (value) => value.normalize('NFKC').replace(/[‘’]/g, "'").toLocaleLowerCase('en');
const rounded = (value, places = 1) => Number(value.toFixed(places));
const plural = (count, singular, multiple = `${singular}s`) => `${count} ${count === 1 ? singular : multiple}`;

function tokens(value) {
  let previousEnd = 0;
  return Array.from(value.matchAll(WORDS), (match) => {
    const separator = value.slice(previousEnd, match.index);
    previousEnd = match.index + match[0].length;
    return { value: normalized(match[0]), start: match.index, end: previousEnd, gapBefore: separator.trim() ? normalized(separator).replace(/\s+/g, ' ').trim() : ' ' };
  });
}

function occurrences(source, term) {
  const wanted = tokens(term);
  if (!wanted.length) return 0;
  let count = 0;
  for (let index = 0; index <= source.length - wanted.length; index++) {
    if (wanted.every((word, offset) => source[index + offset].value === word.value && (offset === 0 || source[index + offset].gapBefore === word.gapBefore))) count++;
  }
  return count;
}

function measureText(value, term) {
  const words = tokens(value);
  const segments = Array.from(sentenceSegmenter.segment(value), (part) => ({ text: part.segment.trim(), words: tokens(part.segment).length })).filter((part) => part.words > 0);
  const duplicates = [];
  for (let index = 1; index < words.length; index++) {
    const before = words[index - 1];
    const current = words[index];
    // "had had", "that that", emphatic repetitions and punctuation-delimited
    // repetitions are not grammar errors. Even these candidates need review.
    if (current.value === before.value && POSSIBLE_DUPLICATES.has(current.value) && /^\s+$/.test(value.slice(before.end, current.start))) {
      duplicates.push(value.slice(before.start, current.end));
    }
  }
  const longest = segments.reduce((chosen, part) => part.words > chosen.words ? part : chosen, { text: '', words: 0 });
  return {
    metrics: {
      words: words.length,
      sentences: segments.length,
      averageSentenceWords: segments.length ? rounded(words.length / segments.length) : 0,
      longestSentenceWords: longest.words,
      targetOccurrences: occurrences(words, term),
      linkingExpressions: CONNECTORS.reduce((count, connector) => count + occurrences(words, connector), 0),
      possibleDuplications: duplicates.length,
    },
    duplicates,
    longest,
  };
}

function measureAudio(audio) {
  if (!audio?.base64) throw new ApiError(400, 'invalid_request', 'A validated WAV recording is required for speaking practice.');
  const buffer = Buffer.from(audio.base64, 'base64');
  let data;
  let sampleRate = 16000;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + size > buffer.length) break;
    const kind = buffer.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ' && size >= 16) sampleRate = buffer.readUInt32LE(offset + 12);
    if (kind === 'data') data = buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!data?.length || !sampleRate) throw new ApiError(400, 'invalid_request', 'The WAV recording has no usable audio samples.');
  const samples = data.length / 2;
  const frameSamples = Math.max(1, Math.round(sampleRate / 10));
  let quietSamples = 0;
  let quietRun = 0;
  let longestQuietRun = 0;
  for (let start = 0; start < samples; start += frameSamples) {
    const end = Math.min(samples, start + frameSamples);
    let energy = 0;
    for (let index = start; index < end; index++) energy += (data.readInt16LE(index * 2) / 32768) ** 2;
    // A fixed RMS threshold measures low amplitude, not silence or speech.
    if (Math.sqrt(energy / (end - start)) < 0.015) {
      quietSamples += end - start;
      quietRun += end - start;
      longestQuietRun = Math.max(longestQuietRun, quietRun);
    } else quietRun = 0;
  }
  return {
    durationSeconds: rounded(samples / sampleRate, 2),
    quietShare: rounded(quietSamples / samples, 3),
    longestQuietSeconds: rounded(longestQuietRun / sampleRate, 2),
  };
}

function termObservation(metrics, term, source = 'draft') {
  return metrics.targetOccurrences ? `The exact expression “${term}” appears ${metrics.targetOccurrences === 1 ? 'once' : `${metrics.targetOccurrences} times`} in the ${source}; its meaning and correctness are not assessed.` : `The exact expression “${term}” was not found in the ${source}. Paraphrases, inflected forms and alternative wording are not detected.`;
}

function textReviewFindings(measurement, term, source) {
  const entries = [];
  if (!measurement.metrics.targetOccurrences) entries.push({
    mistake: `The exact target expression “${term}” was not found in your ${source}.`,
    why: 'This activity asks you to practice the target expression. The check only finds whole words and phrases, so it may miss valid inflected forms or variations.',
    improvement: `Try using “${term}” in an original sentence, then compare your intended meaning with its definition and examples.`,
  });
  for (const excerpt of [...new Set(measurement.duplicates)].slice(0, 5)) entries.push({
    mistake: `Possible repeated word to review: “${excerpt}”.`,
    why: 'Two identical words appear next to each other. This may be accidental duplication, but repetition can also be intentional; it is not a confirmed grammar error.',
    improvement: 'Read this part aloud. Remove one copy only if the repetition does not serve your intended meaning.',
  });
  if (measurement.longest.words > 40) entries.push({
    mistake: `Long sentence to review (${measurement.longest.words} words): “${measurement.longest.text.slice(0, 180)}${measurement.longest.text.length > 180 ? '…' : ''}”.`,
    why: 'A long sentence can be harder to follow. Length alone does not make it incorrect or unclear; this is a review suggestion.',
    improvement: 'Check that the main point is easy to find. If needed, divide the sentence at a natural change of idea and keep the connection between the two parts clear.',
  });
  return entries;
}

function compareAttempt(metrics, previous, term, mode, number) {
  const changes = [];
  const earlierText = typeof previous.response === 'string' ? previous.response : previous.feedback?.transcript;
  if (typeof earlierText === 'string' && (mode === 'writing' || (earlierText.trim() && metrics.transcriptProvided))) {
    const before = measureText(earlierText, term).metrics;
    const label = mode === 'speaking' ? 'stored transcript' : 'draft';
    changes.push(`${label} word count ${before.words === metrics.words ? `is unchanged at ${metrics.words}` : `changed from ${before.words} to ${metrics.words}`}`);
    changes.push(`exact target occurrences ${before.targetOccurrences === metrics.targetOccurrences ? `are unchanged at ${metrics.targetOccurrences}` : `changed from ${before.targetOccurrences} to ${metrics.targetOccurrences}`}`);
    changes.push(`possible adjacent duplications ${before.possibleDuplications === metrics.possibleDuplications ? `are unchanged at ${metrics.possibleDuplications}` : `changed from ${before.possibleDuplications} to ${metrics.possibleDuplications}`}`);
    if (mode === 'writing') changes.push(`sentence-sized segments ${before.sentences === metrics.sentences ? `are unchanged at ${metrics.sentences}` : `changed from ${before.sentences} to ${metrics.sentences}`}`);
  }
  if (mode === 'speaking') {
    const earlierAudio = previous.feedback?.method === 'rules' ? previous.feedback.metrics : null;
    if (Number.isFinite(earlierAudio?.durationSeconds)) changes.push(`recording duration changed from ${earlierAudio.durationSeconds} to ${metrics.durationSeconds} seconds`);
    if (Number.isFinite(earlierAudio?.quietShare)) changes.push(`low-volume audio changed from ${Math.round(earlierAudio.quietShare * 100)}% to ${Math.round(metrics.quietShare * 100)}%`);
    if (!earlierAudio) changes.push('earlier acoustic measurements are unavailable, so delivery cannot be compared');
    if (!metrics.transcriptProvided || !earlierText?.trim()) changes.push('both transcripts are needed to compare text patterns');
  }
  return `Compared with attempt ${number}: ${changes.length ? changes.join('; ') : 'no comparable measured information was available'}.`;
}

export async function createFeedback(_config, _fetchImpl, request) {
  const { mode, item, response = '', transcript = '', audio, previousAttempts = [] } = request;
  const speaking = mode === 'speaking';
  const sourceText = speaking ? transcript : response;
  const measured = measureText(sourceText, item.term);
  const metrics = { ...measured.metrics, ...(speaking ? { ...measureAudio(audio), transcriptProvided: Boolean(transcript.trim()) } : {}) };
  if (speaking && metrics.transcriptProvided) metrics.estimatedWordsPerMinute = rounded(metrics.words * 60 / metrics.durationSeconds);
  const limitations = [
    'This free feedback uses rule-based coaching, not an examiner or AI assessment. It cannot judge topic relevance, reliability of ideas, grammatical correctness, word meaning in context or naturalness.',
    'Word and sentence counts are estimates. An exact expression match does not establish correct vocabulary use; paraphrases and inflected forms can be missed.',
  ];
  const nextSteps = [];
  let mistakes = speaking && !metrics.transcriptProvided ? [] : textReviewFindings(measured, item.term, speaking ? 'supplied transcript' : 'draft');
  let comments;
  let overall;
  if (speaking) {
    limitations.push('Audio is measured for duration and low amplitude only. Background noise, microphone volume and breathing affect these measurements. Pronunciation and spoken fluency are not assessed.');
    limitations.push('Text observations use the supplied transcript, not independent recognition of the recording. Any timing estimate assumes that the transcript accurately matches the audio.');
    const level = `About ${Math.round(metrics.quietShare * 100)}% of the audio is below a fixed low-volume threshold; the longest such stretch is ${metrics.longestQuietSeconds} seconds.`;
    overall = `Your recording is ${metrics.durationSeconds} seconds long. ${level} ${metrics.transcriptProvided ? `The supplied transcript contains ${plural(metrics.words, 'word')}. ${termObservation(metrics, item.term, 'transcript')}` : 'No transcript was supplied, so text patterns cannot be checked.'} This free check does not grade speaking quality.`;
    comments = [
      `${level} This cannot distinguish a pause from a quiet microphone or judge fluency.${metrics.transcriptProvided ? ` The transcript timing estimate is ${metrics.estimatedWordsPerMinute} words per minute if it matches the recording; this is not a fluency score.` : ''}`,
      metrics.transcriptProvided ? `Found ${plural(metrics.linkingExpressions, 'linking expression')} in the supplied transcript. Read the transcript and listen back to check the order of your ideas; their logical connection is not assessed.` : 'No transcript was supplied. Idea organization cannot be assessed from amplitude or duration.',
      metrics.transcriptProvided ? termObservation(metrics, item.term, 'supplied transcript') : 'No transcript was supplied. The check cannot determine whether you said the target expression or used it correctly.',
      'Not assessed. This free check does not recognize pronunciation, stress, accent or intelligibility. Listen to your recording and compare the target expression with a trusted pronunciation example.',
    ];
    if (metrics.quietShare >= 0.9) mistakes.unshift({
      mistake: 'Most of the recording has very low amplitude.',
      why: 'This could be silence, a quiet microphone or distance from the microphone. The check cannot determine whether speech was intelligible.',
      improvement: 'Play the recording back before revising. If your voice is hard to hear, check microphone permission and input level, then record closer to the microphone.',
    });
    nextSteps.push('Listen to your recording: check whether the listener can follow your opening point, supporting example and conclusion.');
    if (!metrics.transcriptProvided) nextSteps.push('Add an accurate transcript of what you said to enable text checks; correct any automatic transcription before submitting.');
    else nextSteps.push(`Check your intended use of “${item.term}” against the definition and examples; an exact match is not proof of correct use.`);
    nextSteps.push('Compare pronunciation with a trusted reference and ask a teacher or conversation partner for pronunciation feedback if possible.');
  } else {
    overall = `Your draft contains ${plural(metrics.words, 'word')} in ${plural(metrics.sentences, 'sentence-sized segment')}. ${termObservation(metrics, item.term)} This free check measures text patterns; it does not grade your ideas or language quality.`;
    comments = [
      'Not assessed. Check whether each main point answers the practice prompt and whether factual claims have reliable support; this rule check cannot determine relevance or truth.',
      `Found ${plural(metrics.linkingExpressions, 'linking expression')}. Their presence does not establish coherence. Check whether each sentence follows logically from the previous one.`,
      termObservation(metrics, item.term),
      'Not assessed. Compare your phrasing with trustworthy examples and read it aloud; these rules cannot determine whether wording is idiomatic.',
      `Average sentence-sized segment length: ${metrics.averageSentenceWords} words; longest: ${metrics.longestSentenceWords} words. Sentence length alone does not establish clarity or grammatical correctness.`,
    ];
    if (!metrics.targetOccurrences) nextSteps.push(`Use “${item.term}” in an original sentence and check that its meaning fits your point.`);
    if (measured.duplicates.length) nextSteps.push('Review the possible repetitions above and remove only accidental duplicates.');
    nextSteps.push('Check your response against the prompt: identify your main point, supporting example and conclusion.');
    nextSteps.push('Read your draft aloud, then compare the target expression with the dictionary definition and examples before revising.');
  }
  const comparison = previousAttempts.length ? `${previousAttempts.map((attempt, index) => compareAttempt(metrics, attempt, item.term, mode, index + 1)).join(' ')} These are observed changes in measurements, not evidence that the ideas, vocabulary, fluency or pronunciation improved.` : null;
  return {
    overall,
    criteria: CRITERIA[mode].map((name, index) => ({ name, score: null, comment: comments[index] })),
    mistakes,
    nextSteps: nextSteps.slice(0, 4),
    comparison,
    limitations,
    ...(speaking ? { transcript } : {}),
    method: 'rules',
    metrics,
  };
}
