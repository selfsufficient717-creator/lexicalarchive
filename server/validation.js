export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ownObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (message) => { throw new ApiError(400, 'invalid_request', message); };

function text(value, name, max, { optional = false, allowEmpty = false } = {}) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) bad(`${name} must be ${allowEmpty ? 'a' : 'a nonempty'} text value of at most ${max} characters.`);
  return value.trim();
}

function strings(value, name, maxItems = 12, maxLength = 1000, minItems = 0) {
  if (!Array.isArray(value) || value.length > maxItems || value.length < minItems) bad(`${name} must contain between ${minItems} and ${maxItems} text entries.`);
  return value.map((entry) => text(entry, name, maxLength));
}

export function validateLexiconRequest(body) {
  if (!ownObject(body)) bad('A JSON object is required.');
  return {
    text: text(body.text, 'Lexical item', 300),
    context: text(body.context, 'Context', 2500, { optional: true, allowEmpty: true }),
    language: text(body.language, 'Translation language', 80),
  };
}

export function validateItem(item) {
  if (!ownObject(item)) bad('A lexical item object is required.');
  if (!['word', 'phrase', 'idiom'].includes(item.kind)) bad('Lexical item kind is invalid.');
  if (!Array.isArray(item.exercises) || item.exercises.length < 6 || item.exercises.length > 12) bad('A lexical item must have 6–12 exercises.');
  const exercises = item.exercises.map((exercise) => {
    if (!ownObject(exercise) || !['meaning', 'synonym', 'antonym', 'gap', 'context', 'collocation'].includes(exercise.type)) bad('Exercise type is invalid.');
    const options = strings(exercise.options, 'Exercise options', 6, 500, 2);
    const answer = text(exercise.answer, 'Exercise answer', 500);
    if (!options.includes(answer) || new Set(options).size !== options.length) bad('Exercise options must be distinct and contain its answer.');
    const question = text(exercise.question, 'Exercise question', 4500);
    if (exercise.type === 'gap' && ((question.match(/_____/g) || []).length !== 1 || question.split(/\s+/).length < 80)) bad('A gap exercise must contain one _____ placeholder in a passage of at least 80 words.');
    return { type: exercise.type, question, options, answer, explanation: text(exercise.explanation, 'Exercise explanation', 1500) };
  });
  if (!exercises.some((entry) => entry.type === 'meaning') || !exercises.some((entry) => entry.type === 'gap') || !exercises.some((entry) => ['context', 'collocation'].includes(entry.type))) bad('Exercises must include meaning matching, an extended gap passage, and context or collocation practice.');
  if ((!Array.isArray(item.antonyms) || item.antonyms.length === 0) && exercises.some((entry) => entry.type === 'antonym')) bad('An item without antonyms must not invent an antonym exercise.');
  return {
    term: text(item.term, 'Term', 300),
    kind: item.kind,
    pronunciation: text(item.pronunciation, 'Pronunciation', 500, { allowEmpty: true }),
    definition: text(item.definition, 'Definition', 2500),
    translation: text(item.translation, 'Translation', 1500),
    language: text(item.language, 'Translation language', 80),
    synonyms: strings(item.synonyms, 'Synonyms', 8, 300),
    antonyms: strings(item.antonyms, 'Antonyms', 8, 300),
    antonymNote: text(item.antonymNote, 'Antonym note', 1500, { allowEmpty: Array.isArray(item.antonyms) && item.antonyms.length > 0 }),
    examples: strings(item.examples, 'Examples', 8, 1500, 2),
    usageNote: text(item.usageNote, 'Usage note', 2000),
    speakingPrompt: text(item.speakingPrompt, 'Speaking prompt', 2000),
    writingPrompt: text(item.writingPrompt, 'Writing prompt', 2000),
    exercises,
  };
}

export const CRITERIA = {
  writing: ['Topic understanding and ideas', 'Cohesion and coherence', 'Word choice', 'Naturalness', 'Readability'],
  speaking: ['Fluency', 'Idea organization', 'Lexical item usage', 'Pronunciation'],
};

export function validateFeedback(feedback, mode, revision = false) {
  if (!ownObject(feedback)) bad('Feedback must be an object.');
  if (!Array.isArray(feedback.criteria) || feedback.criteria.length !== CRITERIA[mode].length) bad('Feedback must cover every assessment criterion.');
  const criteria = feedback.criteria.map((criterion, index) => {
    if (!ownObject(criterion) || criterion.name !== CRITERIA[mode][index]) bad('Feedback criteria names or ordering are invalid.');
    if (criterion.score !== null && (!Number.isFinite(criterion.score) || criterion.score < 1 || criterion.score > 5)) bad('Feedback scores must be between 1 and 5, or null when unassessable.');
    return { name: criterion.name, score: criterion.score, comment: text(criterion.comment, 'Criterion comment', 2500) };
  });
  if (!Array.isArray(feedback.mistakes) || feedback.mistakes.length > 20) bad('Feedback mistakes must be a list of at most 20 entries.');
  const mistakes = feedback.mistakes.map((entry) => {
    if (!ownObject(entry)) bad('A mistake must be an object.');
    return { mistake: text(entry.mistake, 'Mistake', 2000), why: text(entry.why, 'Why it is wrong', 2500), improvement: text(entry.improvement, 'How to improve', 2500) };
  });
  const comparison = revision ? text(feedback.comparison, 'Revision comparison', 3000) : null;
  const result = {
    overall: text(feedback.overall, 'Overall impression', 3500),
    criteria,
    mistakes,
    nextSteps: strings(feedback.nextSteps, 'Next steps', 8, 1500, 1),
    comparison,
    limitations: strings(feedback.limitations, 'Assessment limitations', 8, 1500),
  };
  if (mode === 'speaking') result.transcript = text(feedback.transcript, 'Recording transcript', 20000, { allowEmpty: true });
  return result;
}

export function validateWav(audio, claimedDuration) {
  if (!ownObject(audio) || audio.format !== 'wav' || typeof audio.base64 !== 'string') bad('Speaking practice needs a WAV recording.');
  if (audio.base64.length > 5_600_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.base64) || audio.base64.length % 4 !== 0) bad('Recording is invalid or exceeds the 4 MB limit.');
  const wav = Buffer.from(audio.base64, 'base64');
  if (wav.length < 44 || wav.length > 4_200_000 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') bad('Recording must be a valid PCM WAV file.');
  if (wav.readUInt32LE(4) + 8 !== wav.length) bad('WAV recording length does not match its header.');
  let format;
  let dataLength;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (offset + 8 + size > wav.length) bad('WAV recording contains an invalid chunk.');
    const id = wav.toString('ascii', offset, offset + 4);
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: wav.readUInt16LE(offset + 8), channels: wav.readUInt16LE(offset + 10),
        sampleRate: wav.readUInt32LE(offset + 12), byteRate: wav.readUInt32LE(offset + 16),
        blockAlign: wav.readUInt16LE(offset + 20), bits: wav.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') {
      if (dataLength !== undefined) bad('WAV recording contains multiple audio chunks.');
      dataLength = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !dataLength || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 || format.sampleRate !== 16000 || format.blockAlign !== 2 || format.byteRate !== 32000 || dataLength % 2) bad('Recordings must be 16 kHz, mono, 16-bit PCM WAV.');
  const durationSeconds = dataLength / format.byteRate;
  if (durationSeconds < 1 || durationSeconds > 120) bad('Record between 1 and 120 seconds.');
  if (claimedDuration !== undefined && (!Number.isFinite(claimedDuration) || Math.abs(claimedDuration - durationSeconds) > 1)) bad('Reported recording duration does not match the audio.');
  return { base64: audio.base64, format: 'wav', durationSeconds };
}

export function validateFeedbackRequest(body) {
  if (!ownObject(body) || !['writing', 'speaking'].includes(body.mode)) bad('Choose writing or speaking practice.');
  const item = validateItem(body.item);
  const prompt = text(body.prompt, 'Practice prompt', 2500);
  if (body.previousAttempts !== undefined && (!Array.isArray(body.previousAttempts) || body.previousAttempts.length > 2)) bad('Each activity permits an initial response and two revisions.');
  const previousAttempts = (body.previousAttempts || []).map((attempt, index) => {
    if (!ownObject(attempt)) bad('Previous attempts must be objects.');
    return {
      response: text(attempt.response, 'Previous response', 20000, { allowEmpty: true }),
      feedback: validateFeedback(attempt.feedback, body.mode, index > 0),
    };
  });
  if (typeof body.itemId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.itemId)) bad('Save your item before practicing. A valid itemId is required.');
  const itemId = body.itemId;
  const result = { mode: body.mode, item, itemId, prompt, previousAttempts };
  if (body.mode === 'writing') result.response = text(body.response, 'Writing response', 20000);
  else result.audio = validateWav(body.audio, body.durationSeconds);
  return result;
}
