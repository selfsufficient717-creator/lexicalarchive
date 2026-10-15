import * as services from './services.js';
import { buildExercises, buildMatchingRound, checkAnswer, nextReview } from './practice.js';
import { BrowserTranscriber, VoiceRecorder } from './recorder.js';

const $ = selector => document.querySelector(selector);
const element = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const button = (text, action, className = '') => {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};
const state = { items: [], activeId: null, mode: 'quiz', view: 'discover', busy: false, quiz: null, attempts: [], studioToken: 0, recording: null, audio: null, recorder: null, profile: null, draft: '', syncing: false };
const ownerId = () => services.getSession()?.user?.id || 'guest';
const storageKey = () => `lexical-trove:${ownerId()}`;
function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').className = `notice${error ? ' error' : ''}`;
  $('#notice').hidden = !message;
}
function status(node, message, error = false) { node.textContent = message; node.classList.toggle('error', error); }
function cacheItems() {
  try { localStorage.setItem(storageKey(), JSON.stringify(state.items)); }
  catch { notify('Your browser could not save a local copy. Your signed-in collection is still saved online.', true); }
}
function readCache() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey()) || '[]');
    return Array.isArray(data) ? data.filter(record => record?.id && typeof record.payload?.term === 'string') : [];
  } catch { return []; }
}
function active() { return state.items.find(item => item.id === state.activeId); }
function isDue(item) { return !item.review?.dueAt || Date.parse(item.review.dueAt) <= Date.now(); }
function revokeAudio() { if (state.audio?.url) URL.revokeObjectURL(state.audio.url); state.audio = null; }
function leaveRecording() { state.transcriber?.cancel();state.transcriber = null; state.recorder?.cancel(); state.recorder = null; state.recording = false; revokeAudio(); }

function showView(view) {
  if (state.view === 'practice' && view !== 'practice') { leaveRecording(); state.studioToken++; }
  state.view = view;
  document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== `${view}-view`; });
  document.querySelectorAll('nav [data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  if (view === 'library') renderLibrary();
  if (view === 'practice') renderPractice();
}
function updateCollection() {
  $('#library-count').textContent = state.items.length;
  const select = $('#practice-item');
  select.replaceChildren(element('option', '', 'Choose from your trove'));
  select.firstChild.value = '';
  for (const record of state.items) {
    const option = element('option', '', record.payload.term);
    option.value = record.id;
    select.append(option);
  }
  select.value = state.activeId || '';
  renderLibrary();
}
async function loadCollection() {
  const owner = ownerId();
  state.items = readCache();
  updateCollection();
  if (services.getSession() && services.accountReady()) {
    state.syncing = true;
    try {
      const items = await services.loadLibrary();
      if (ownerId() !== owner) return;
      state.items = items;cacheItems();updateCollection();
    }
    catch (error) { if (ownerId() === owner) notify(`Your saved copy is available, but we couldn’t sync your trove. ${error.message}`, true); }
    finally { state.syncing = false; }
  }
}
function needsServices(statusNode) {
  if (!services.accountReady() || !services.serviceReady()) {
    status(statusNode, 'The learning service is being connected. Automatic explanations and feedback will be available once it is ready.', true);
    return false;
  }
  if (!services.getSession()) {
    status(statusNode, 'Sign in with your email to explore this item and keep it in your trove.');
    openAccount();
    return false;
  }
  return true;
}
async function lookup(event) {
  event?.preventDefault();
  const text = $('#lexical-input').value.trim();
  const language = $('#language').value.trim();
  const output = $('#lookup-status');
  if (!text || !language) { status(output, 'Add a word or phrase and choose your translation language.', true); return; }
  if (state.busy || !needsServices(output)) return;
  const owner = ownerId();
  state.busy = true;
  $('#lookup-button').disabled = true;
  status(output, 'Looking up the expression and preparing your practice…');
  try {
    try { localStorage.setItem('lexical-trove-language', language); } catch {}
    const payload = await services.api('/api/lexicon', { text, language, context: $('#context').value.trim() });
    if (ownerId() !== owner) return;
    const record = { id: crypto.randomUUID(), payload, review: { dueAt: new Date().toISOString(), intervalDays: 0, streak: 0, reviewCount: 0 } };
    await services.saveItem(record);
    if (ownerId() !== owner) return;
    state.items.unshift(record);
    if (state.view === 'discover') state.activeId = record.id;
    cacheItems(); updateCollection(); renderEntry(record);
    status(output, 'Added to your trove. Understanding it is the beginning—now make it stick.');
    $('#entry-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (ownerId() === owner) {
      status(output, error.message, true);
      if (error.code === 'dictionary_not_found') { $('#manual-entry').open = true;$('#manual-term').value = text; }
    }
  }
  finally {
    state.busy = false; $('#lookup-button').disabled = false;
    if (state.pendingPaste) { state.pendingPaste = false; setTimeout(() => lookup(), 0); }
  }
}
function renderEntry(record) {
  const item = record.payload;
  const panel = $('#entry-panel');
  panel.replaceChildren(); panel.hidden = false;
  const top = element('div', 'entry-top');
  const heading = element('div');
  heading.append(element('span', 'badge', item.kind), element('h2', 'entry-title', item.term));
  const pronunciation = element('div', 'pronunciation', item.pronunciation || '');
  heading.append(pronunciation);
  top.append(heading, button('Listen ♫', () => speak(item.term)));
  const translation = element('div', 'translation');
  translation.append(element('span', '', item.language), element('strong', '', item.translation || item.translationNote || 'Translation unavailable.'));
  if (item.translation && item.translationNote) translation.append(element('small', 'muted', item.translationNote));
  const grid = element('div', 'entry-grid');
  const examples = element('section');
  examples.append(element('h3', '', 'In real sentences'));
  const list = element('ol', 'examples');
  (item.examples || []).forEach((example, index) => { const row = element('li', '', example);if (item.examplesSource?.[index]) row.append(element('small', 'source-label', item.examplesSource[index]));list.append(row); });
  if (!item.examples?.length) examples.append(element('p', 'muted', item.examplesNote || 'This dictionary entry has no example sentence. You can add your original passage for context.'));
  examples.append(list);
  const relations = element('section');
  for (const [title, values] of [['Similar meanings', item.synonyms], ['Opposites', item.antonyms]]) {
    relations.append(element('h3', '', title));
    const chips = element('div', 'word-chips');
    if (values?.length) values.forEach(value => chips.append(element('span', 'chip', value)));
    else chips.append(element('span', 'muted', title === 'Opposites' ? (item.antonymNote || 'There isn’t a natural direct opposite in this context.') : 'No close substitute in this context.'));
    relations.append(chips);
  }
  if (item.antonyms?.length && item.antonymNote) relations.append(element('p', 'muted', item.antonymNote));
  grid.append(examples, relations);
  const actions = element('div', 'entry-actions');
  actions.append(button('Practise this item →', () => { state.activeId = record.id; state.quiz = null; state.mode = 'quiz'; showView('practice'); }, 'primary'), button('Open my trove', () => showView('library')));
  if (item.fallbackNote) panel.append(element('p', 'usage-note', item.fallbackNote));
  panel.append(top, element('p', 'entry-definition', item.definition), translation, grid, element('p', 'usage-note', item.usageNote || 'Use the original context to choose the meaning that fits.'), actions);
  for (const source of [item.source, item.translationSource]) {
    if (!source) continue;
    const line = element('p', 'source-label');
    if (safeAvatar(source.url)) { const link = element('a', '', source.name);link.href = source.url;link.target = '_blank';link.rel = 'noopener noreferrer';line.append(link); }
    else line.textContent = source.name;
    if (source.license) { line.append(document.createTextNode(` · ${source.license}`));if (safeAvatar(source.licenseUrl)) { const link = element('a', '', 'License');link.href = source.licenseUrl;link.target = '_blank';link.rel = 'noopener noreferrer';line.append(document.createTextNode(' · '), link); } }
    panel.append(line);
  }
}
function speak(text) {
  if (!globalThis.speechSynthesis) { notify('Text-to-speech is not available in this browser.', true); return; }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'en-US'; utterance.rate = 0.85;
  speechSynthesis.speak(utterance);
}
function renderLibrary() {
  const query = $('#library-search').value.trim().toLowerCase();
  const dueOnly = $('#due-only').checked;
  const filtered = state.items.filter(record => (!dueOnly || isDue(record)) && [record.payload.term, record.payload.definition, record.payload.translation].join(' ').toLowerCase().includes(query));
  const container = $('#library-cards'); container.replaceChildren();
  $('#library-summary').textContent = `${state.items.length} collected · ${state.items.filter(isDue).length} ready to review`;
  $('#library-empty').hidden = filtered.length > 0;
  if (!filtered.length && state.items.length) {
    $('#library-empty h2').textContent = 'Nothing here just now.';
    $('#library-empty p').textContent = dueOnly ? 'You’re caught up. Uncheck “Ready to review” to see your whole trove.' : 'Try another search to find your item.';
  } else {
    $('#library-empty h2').textContent = 'A little space for a lot of language.';
    $('#library-empty p').textContent = 'Your trove starts with one word, phrase, or idiom.';
  }
  for (const record of filtered) {
    const card = element('article', 'library-card');
    card.append(element('span', 'badge', record.payload.kind), element('h3', '', record.payload.term), element('p', '', record.payload.definition), element('p', '', record.payload.translation || record.payload.translationNote || ''));
    card.append(element('span', 'due-badge', isDue(record) ? 'Ready for another look' : `Next review ${new Date(record.review.dueAt).toLocaleDateString()}`));
    const actions = element('div', 'card-actions');
    actions.append(button('Explore', () => { state.activeId = record.id; renderEntry(record); showView('discover'); $('#entry-panel').scrollIntoView({ behavior: 'smooth' }); }), button('Practise →', () => { state.activeId = record.id; state.quiz = null; showView('practice'); }), button('Remove', async () => {
      if (!confirm(`Remove “${record.payload.term}” and its practice history from your trove?`)) return;
      try {
        if (services.getSession()) await services.deleteItem(record.id);
        state.items = state.items.filter(item => item.id !== record.id);
        if (state.activeId === record.id) { state.activeId = null; $('#entry-panel').hidden = true; }
        cacheItems(); updateCollection();
      } catch (error) { notify(error.message, true); }
    }, 'danger'));
    card.append(actions); container.append(card);
  }
}
function renderPractice() {
  leaveRecording(); state.studioToken++;
  $('#practice-item').value = state.activeId || '';
  document.querySelectorAll('[data-mode]').forEach(node => node.classList.toggle('active', node.dataset.mode === state.mode));
  const container = $('#practice-content'); container.replaceChildren();
  if (!active()) {
    const empty = element('div', 'empty-state');
    empty.append(element('span', '', '✳'), element('h2', '', 'Start with a discovery.'), element('p', '', 'Choose an item from your trove, or add one to begin practising.'), button('Explore a word or phrase →', () => showView('discover'), 'primary')); container.append(empty); return;
  }
  if (state.mode === 'quiz') renderQuiz();
  else if (state.mode === 'match') renderMatching();
  else renderStudio();
}
async function saveReview(correct, itemId) {
  const record = state.items.find(item => item.id === itemId); if (!record) return;
  const previous = record.review;
  record.review = nextReview(previous, correct);
  try { if (services.getSession()) await services.saveReview(record.id, record.review); cacheItems(); updateCollection(); }
  catch (error) { record.review = previous; notify(`Your answer was checked, but review progress could not be saved. ${error.message}`, true); }
}
function renderQuiz() {
  const record = active();
  if (!state.quiz || state.quiz.itemId !== record.id) state.quiz = { itemId: record.id, exercises: buildExercises(record.payload, state.items.map(item => item.payload)), index: 0, correct: 0, recorded: false };
  const quiz = state.quiz;
  const container = $('#practice-content'); container.replaceChildren();
  const card = element('section', 'practice-card');
  if (quiz.index >= quiz.exercises.length) {
    card.append(element('span', 'badge', 'A LITTLE MORE FAMILIAR'), element('h2', '', 'A good moment to put it to use.'), element('p', '', `${quiz.correct} of ${quiz.exercises.length} exercises answered correctly. Review timing adjusts as you practise.`));
    const actions = element('div', 'practice-actions');
    actions.append(button('Try writing →', () => { state.mode = 'writing'; renderPractice(); }, 'primary'), button('Go again', () => { state.quiz = null; renderQuiz(); }));card.append(actions); container.append(card); return;
  }
  const exercise = quiz.exercises[quiz.index];
  const labels = { meaning: 'Find the meaning', synonym: 'Find a synonym', antonym: 'Find the opposite', gap: 'A word in context', context: 'Choose the right context', collocation: 'Natural word partners', recall: 'Active recall', translation: 'Translation recall' };
  const topline = element('div', 'practice-topline');topline.append(element('span', '', labels[exercise.type] || 'Quick practice'), element('span', '', `${quiz.index + 1} / ${quiz.exercises.length}`));
  const track = element('div', 'progress-track');const fill = element('div', 'progress-fill');fill.style.width = `${quiz.index / quiz.exercises.length * 100}%`;track.append(fill);
  card.append(topline, track);
  if (exercise.type !== 'recall') card.append(element('span', 'badge', record.payload.term));
  card.append(element('p', 'quiz-question', exercise.question));
  let chosen = null;
  let answered = false;
  const result = element('div', 'quiz-result');result.hidden = true;
  const actions = element('div', 'practice-actions');
  if (exercise.options?.length) {
    const options = element('div', 'quiz-options');
    exercise.options.forEach(option => {
      const choice = button(option, () => {
        if (answered) return;
        chosen = option;
        options.querySelectorAll('button').forEach(node => { node.classList.toggle('selected', node === choice); node.setAttribute('aria-pressed', String(node === choice)); });
        check.disabled = false;
      });choice.setAttribute('aria-pressed', 'false');options.append(choice);
    }); card.append(options);
  } else {
    const input = element('input', 'quiz-input'); input.placeholder = 'Write your answer…';input.setAttribute('aria-label', 'Your answer');
    input.addEventListener('input', () => { chosen = input.value; check.disabled = !chosen.trim(); });card.append(input);
  }
  const check = button(exercise.options?.length ? 'Check answer' : 'Reveal & compare', async () => {
    if (answered) return;
    answered = true;
    // Free-definition recall is self-assessed: a paraphrase should not be marked wrong by string equality.
    if (!exercise.options?.length) {
      result.hidden = false;result.append(element('p', '', `Reference answer: ${exercise.answer}`), element('p', 'muted', exercise.explanation || 'Compare the meaning, rather than exact wording.'));
      check.hidden = true;
      actions.append(button('I remembered it', () => finish(true), 'primary'), button('I need another look', () => finish(false)));
    } else { await finish(checkAnswer(chosen, exercise.acceptedAnswers?.length ? exercise.acceptedAnswers : exercise.answer)); }
  }, 'primary');check.disabled = true;
  async function finish(correct) {
    actions.replaceChildren();
    if (correct) quiz.correct++;
    result.hidden = false;
    if (exercise.options?.length) {
      result.classList.toggle('error', !correct);
      result.replaceChildren(element('strong', '', correct ? 'That’s it.' : 'A useful one to revisit.'), element('p', '', `Answer: ${exercise.answer}`), element('p', 'muted', exercise.explanation));
    }
    if (quiz.index + 1 === quiz.exercises.length && !quiz.recorded) {
      quiz.recorded = true;
      await saveReview(quiz.correct === quiz.exercises.length, record.id);
    }
    const next = button(quiz.index + 1 === quiz.exercises.length ? 'Finish this round →' : 'Next exercise →', () => { quiz.index++; renderQuiz(); }, 'primary');actions.append(next);
  }
  actions.append(check);card.append(result, actions);container.append(card);
}
function renderMatching(relation = 'meaning') {
  const container = $('#practice-content'); container.replaceChildren();
  const card = element('section', 'practice-card');card.append(element('h2', '', 'Make the connection.'), element('p', 'muted', 'Select an item on the left, then its partner on the right.'));
  const label = element('label', 'mode-select', 'Match ');const select = element('select');select.setAttribute('aria-label', 'Matching relation');
  for (const [value, text] of [['meaning', 'Meanings'], ['synonym', 'Synonyms'], ['antonym', 'Antonyms']]) { const option = element('option', '', text);option.value = value;select.append(option); }
  select.value = relation;select.addEventListener('change', () => renderMatching(select.value));label.append(select);card.append(label);
  const round = buildMatchingRound(state.items.map(record => record.payload), relation);
  if (!round) { card.append(element('p', 'usage-note', `Collect at least two items with distinct, unambiguous ${relation === 'meaning' ? 'meanings' : `${relation}s`} to build a matching round. Some words and idioms have no direct opposite; we won’t invent one.`));container.append(card);return; }
  const grid = element('div', 'match-grid'), left = element('div', 'match-column'), right = element('div', 'match-column');
  const output = element('p', 'form-status');output.setAttribute('role', 'status');let chosen = null;const matched = new Set();
  round.left.forEach(pair => { const b = button(pair.text, () => { chosen = pair.id; left.querySelectorAll('button').forEach(node => { node.classList.toggle('selected', node === b); node.setAttribute('aria-pressed', String(node === b)); }); });b.dataset.pair = pair.id;b.setAttribute('aria-pressed', 'false');left.append(b); });
  round.right.forEach(pair => { const b = button(pair.text, () => {
    if (!chosen) { status(output, 'Choose an item on the left first.');return; }
    if (chosen === pair.id) {
      matched.add(pair.id);b.disabled = true;b.classList.add('matched');
      const partner = [...left.children].find(node => node.dataset.pair === pair.id);partner.disabled = true;partner.classList.remove('selected');partner.classList.add('matched');partner.setAttribute('aria-pressed', 'false');chosen = null;
      status(output, matched.size === round.pairs.length ? 'All connected. Nicely done.' : 'That’s the connection.');
    } else status(output, 'Not quite—try another partner.', true);
  });right.append(b); });
  grid.append(left, right);card.append(grid, output, button('Shuffle another round ↻', () => renderMatching(relation)));container.append(card);
}

async function renderStudio() {
  const record = active(), mode = state.mode, token = state.studioToken;
  const container = $('#practice-content');container.replaceChildren();
  const card = element('section', 'practice-card studio');
  card.append(element('span', 'badge', mode === 'writing' ? 'Writing studio' : 'Speaking studio'), element('h2', '', 'An idea of your own.'), element('p', 'muted', 'One response. Two chances to revise. Feedback you can actually use.'));
  const prompt = mode === 'writing' ? record.payload.writingPrompt : record.payload.speakingPrompt;
  const topic = element('div', 'studio-prompt');topic.append(element('p', '', prompt), element('small', '', `Work “${record.payload.term}” naturally into your response.`));card.append(topic);
  const output = element('p', 'form-status');output.setAttribute('role', 'status');
  const work = element('div');card.append(work, output);container.append(card);
  state.attempts = [];
  if (services.getSession()) {
    status(output, 'Loading your previous attempts…');
    try { state.attempts = await services.loadAttempts(record.id, mode); }
    catch (error) { status(output, `We couldn’t load your attempts. ${error.message}`, true);return; }
  }
  if (token !== state.studioToken) return;
  status(output, '');
  let attempts = state.attempts.sort((a, b) => a.attempt_number - b.attempt_number);
  const steps = element('div', 'attempt-steps');
  ['First response', 'Revision one', 'Revision two'].forEach((text, index) => { const step = element('div', `attempt-step${index < attempts.length ? ' complete' : index === attempts.length ? ' current' : ''}`);step.append(element('span', '', String(index + 1)), element('span', 'step-label', text));steps.append(step); });work.append(steps);
  if (attempts.length >= 3) work.append(element('p', 'usage-note', 'All three attempts are complete for this topic. Compare your versions below, then keep practising with quizzes or another item.'));
  else {
    if (mode === 'writing') buildWriting(work, output, record, prompt, attempts, token);
    else buildSpeaking(work, output, record, prompt, attempts, token);
  }
  if (attempts.length) {
    const last = attempts.at(-1);work.append(renderFeedback(last.feedback, last.attempt_number));
    if (mode === 'writing') { const version = element('details', 'attempt-history');version.append(element('summary', '', 'Read your latest response'), element('p', 'transcript', last.response));work.append(version); }
    if (attempts.length > 1) {
      const history = element('details', 'attempt-history');history.append(element('summary', '', 'Compare earlier attempts'));
      attempts.slice(0, -1).forEach(attempt => { history.append(element('h3', '', `Attempt ${attempt.attempt_number}`));history.append(element('p', 'transcript', attempt.response || attempt.feedback?.transcript || ''));history.append(renderFeedback(attempt.feedback, attempt.attempt_number)); });work.append(history);
    }
  }
}
function buildWriting(work, output, record, prompt, attempts, token) {
  const textarea = element('textarea');textarea.maxLength = 12000;textarea.setAttribute('aria-label', 'Your writing response');textarea.placeholder = 'Make your point. Use the vocabulary naturally. Let the ideas connect.';
  const draftKey = `${record.id}:${attempts.length}`;
  state.drafts ||= {};
  textarea.value = state.drafts[draftKey] ?? attempts.at(-1)?.response ?? '';
  const info = element('div', 'response-info');const count = element('span');info.append(count, element('span', '', 'Aim for 80–250 words'));
  const update = () => { state.drafts[draftKey] = textarea.value; count.textContent = `${textarea.value.trim().split(/\s+/).filter(Boolean).length} words`; };textarea.addEventListener('input', update);update();
  const submit = button(attempts.length ? 'Assess my revision →' : 'Get writing feedback →', async () => {
    const response = textarea.value.trim();
    if (response.split(/\s+/).length < 10) { status(output, 'Write at least 10 words so there is enough to give useful feedback.', true);return; }
    if (!needsServices(output)) return;
    submit.disabled = true;status(output, 'Reviewing your response and preparing feedback…');
    try {
      await services.api('/api/feedback', { mode: 'writing', itemId: record.id, item: record.payload, prompt, response, previousAttempts: attempts.map(a => ({ response: a.response, feedback: a.feedback })) });
      delete state.drafts[draftKey];
      if (token === state.studioToken) { state.studioToken++; await renderStudio(); }
    } catch (error) { status(output, error.message, true); }
    finally { submit.disabled = false; }
  }, 'primary');
  work.append(textarea, info, submit, element('p', 'privacy-note', 'Your response is saved to your account. Free-tier AI feedback is used only when configured; otherwise clearly labeled basic coaching checks your draft without an AI service.'));
}
function buildSpeaking(work, output, record, prompt, attempts, token) {
  work.append(element('p', 'recording-note', 'Aim for 30–90 seconds. Listen back before sending. Free-tier AI can assess the audio when connected; basic coaching reports timing and transcript checks without pronunciation grades. Maximum recording: two minutes.'));
  const autoLabel = element('label', 'check-label');const auto = element('input');auto.type = 'checkbox';auto.id = 'auto-transcribe';auto.disabled = !BrowserTranscriber.supported();autoLabel.append(auto, document.createTextNode('Use optional browser transcription'));
  const transcriptLabel = element('label', '', 'Transcript · optional, but useful for basic coaching');transcriptLabel.htmlFor = 'speaking-transcript';
  const transcript = element('textarea');transcript.id = 'speaking-transcript';transcript.rows = 4;transcript.maxLength = 12000;transcript.placeholder = 'After recording, type what you actually said, or correct the browser transcription.';
  const confirmationLabel = element('label', 'check-label');const confirmation = element('input');confirmation.id = 'transcript-confirmed';confirmation.type = 'checkbox';confirmationLabel.append(confirmation, document.createTextNode('I checked that this transcript matches my recording'));
  transcript.addEventListener('input', () => { confirmation.checked = false; });
  work.append(autoLabel, element('p', 'privacy-note', 'Browser transcription is optional and may send speech to your browser provider. You can leave it off and type a transcript yourself.'));
  const controls = element('div', 'record-controls');const timer = element('span', 'record-timer', '0:00');
  const preview = element('audio');preview.controls = true;preview.hidden = true;preview.setAttribute('aria-label', 'Listen to your recording');
  const submit = button(attempts.length ? 'Assess my new recording →' : 'Get speaking feedback →', async () => {
    if (!state.audio || !needsServices(output)) return;
    if (transcript.value.trim() && !confirmation.checked) { status(output, 'Check the transcript and confirm it matches your recording before submitting.', true);return; }
    submit.disabled = true;recordButton.disabled = true;status(output, 'Preparing feedback for your recording…');
    try {
      await services.api('/api/feedback', { mode: 'speaking', itemId: record.id, item: record.payload, prompt, audio: { base64: state.audio.base64, format: 'wav' }, durationSeconds: state.audio.durationSeconds, transcript: transcript.value.trim(), transcriptConfirmed: confirmation.checked, previousAttempts: attempts.map(a => ({ response: a.response, feedback: a.feedback })) });
      if (token === state.studioToken) { leaveRecording();state.studioToken++;await renderStudio(); }
    } catch (error) { status(output, error.message, true); }
    finally { submit.disabled = false;recordButton.disabled = false; }
  }, 'primary');submit.disabled = true;
  const recordButton = button('● Start recording', async () => {
    if (state.recording) { await stop();return; }
    revokeAudio();state.transcriber?.cancel();transcript.value = '';confirmation.checked = false;preview.hidden = true;submit.disabled = true;recordButton.disabled = true;
    const recorder = new VoiceRecorder();state.recorder = recorder;
    try {
      await recorder.start(seconds => { timer.textContent = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }, () => stop());
      if (token !== state.studioToken) { recorder.cancel();return; }
      state.recording = true;
      if (auto.checked) {
        state.transcriber = new BrowserTranscriber();
        try { state.transcriber.start(text => { transcript.value = text;confirmation.checked = false; }, message => status(output, message)); } catch (error) { status(output, error.message); }
      }
      recordButton.textContent = '■ Stop recording';recordButton.classList.add('recording');status(output, 'Recording on this device. Stop when you’re ready.');
    } catch (error) { status(output, error.name === 'NotAllowedError' ? 'Microphone access was declined. Allow access in your browser to record a response.' : error.message, true); }
    finally { recordButton.disabled = false; }
  }, 'record-button');
  async function stop() {
    if (!state.recording) return;
    state.recording = false;state.transcriber?.stop();recordButton.disabled = true;status(output, 'Preparing your recording…');
    try {
      const audio = await state.recorder.stop();
      if (token !== state.studioToken) { URL.revokeObjectURL(audio.url);return; }
      state.audio = audio;preview.src = audio.url;preview.hidden = false;submit.disabled = false;status(output, 'Listen back, record again if you like, then submit for feedback.');
    } catch (error) { status(output, error.message, true); }
    finally { recordButton.textContent = '● Record again';recordButton.classList.remove('recording');recordButton.disabled = false; }
  }
  controls.append(recordButton, timer);work.append(controls, preview, transcriptLabel, transcript, confirmationLabel, submit, element('p', 'privacy-note', 'Submitting sends your recording to the learning service. If free-tier Gemini is configured, it also processes the audio; otherwise basic checks run on our server. The app saves your transcript and feedback, not the audio. Accent variation is not a mistake.'));
}
function renderFeedback(feedback, number) {
  const section = element('section', 'feedback');
  section.append(element('p', 'eyebrow', `${feedback.method === 'rules' ? 'BASIC COACHING' : 'FEEDBACK'} · ATTEMPT ${number}`), element('h3', '', 'Overall impression'), element('p', 'overall', feedback.overall));
  let comparison;
  if (feedback.comparison) { comparison = element('div', 'comparison');comparison.append(element('strong', '', 'What changed'), element('p', '', feedback.comparison)); }
  let criteriaGrid;
  if (feedback.criteria?.length) {
    const grid = element('div', 'criteria-grid');
    feedback.criteria.forEach(criterion => { const card = element('div', 'criterion');const title = element('div', 'criterion-title');title.append(element('span', '', criterion.name), element('span', '', criterion.score == null ? 'Not graded' : `${criterion.score} / 5`));card.append(title, element('p', '', criterion.comment));grid.append(card); });criteriaGrid = grid;
  }
  section.append(element('h3', '', 'One improvement at a time'));
  const mistakes = element('ol', 'mistake-list');
  (feedback.mistakes || []).forEach(mistake => { const row = element('li');for (const [label, value] of [['Mistake', mistake.mistake], ['Why?', mistake.why], ['How to improve', mistake.improvement]]) { const p = element('p');p.append(element('strong', '', `${label} `), document.createTextNode(value));row.append(p); }mistakes.append(row); });
  if (mistakes.children.length) section.append(mistakes);else section.append(element('p', 'muted', feedback.method === 'rules' ? 'No issues detected by these basic checks. Meaning and grammar still need your own review.' : 'No specific errors identified in this response.'));
  if (criteriaGrid) section.append(criteriaGrid);
  if (comparison) section.append(comparison);
  if (feedback.nextSteps?.length) { section.append(element('h4', 'subheading', 'Try this next'));const list = element('ul');feedback.nextSteps.forEach(step => list.append(element('li', '', step)));section.append(list); }
  if (feedback.transcript) { const transcript = element('details');transcript.append(element('summary', '', 'Read the recording transcript'), element('p', 'transcript', feedback.transcript));section.append(transcript); }
  (feedback.limitations || []).forEach(limit => section.append(element('p', 'feedback-limit', limit)));
  section.append(element('p', 'feedback-limit', feedback.method === 'rules' ? 'Basic coaching uses measurements and simple checks. It does not assign examiner scores or judge pronunciation, naturalness, factual accuracy, or semantic correctness.' : 'These 1–5 ratings are learning guidance, not standardized test results.'));
  return section;
}

function safeAvatar(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}
function updateAccountHeader() {
  const user = services.getSession()?.user;
  $('#account-label').textContent = user ? (state.profile?.display_name || 'My profile') : 'Sign in';
  const avatar = $('#header-avatar');avatar.replaceChildren();
  if (state.profile?.avatar_url && safeAvatar(state.profile.avatar_url)) { const img = element('img');img.src = state.profile.avatar_url;img.alt = '';avatar.append(img); }
  else avatar.textContent = user ? (state.profile?.display_name || user.email || 'Y').charAt(0).toUpperCase() : '→';
}
function openAccount() {
  const dialog = $('#account-dialog'), content = $('#account-content');content.replaceChildren();
  if (!dialog.open) dialog.showModal();
  if (!services.getSession()) {
    content.append($('#signin-template').content.cloneNode(true));
    $('#signin-form').addEventListener('submit', async event => {
      event.preventDefault();const out = $('#signin-status');const submit = $('#signin-form button');submit.disabled = true;
      try { await services.sendMagicLink($('#email').value.trim());status(out, 'Check your inbox for a sign-in link. You can close this window while you wait.'); }
      catch (error) { status(out, error.message, true); }
      finally { submit.disabled = false; }
    });
    return;
  }
  content.append(element('p', 'eyebrow', 'YOUR LITTLE CORNER OF LANGUAGE'), element('h2', '', 'Make yourself at home.'), element('p', '', services.getSession().user.email));
  const form = element('form');const label = element('label', '', 'Your name');label.htmlFor = 'display-name';const name = element('input');name.id = 'display-name';name.maxLength = 60;name.value = state.profile?.display_name || '';name.placeholder = 'What should we call you?';
  const photo = element('div', 'profile-photo');
  if (state.profile?.avatar_url && safeAvatar(state.profile.avatar_url)) { const img = element('img');img.id = 'profile-avatar';img.src = state.profile.avatar_url;img.alt = 'Your profile photo';photo.append(img); }
  const uploadLabel = element('label', '', 'Public profile photo · JPG, PNG, or WebP, up to 2 MB');const upload = element('input');upload.type = 'file';upload.accept = 'image/jpeg,image/png,image/webp';upload.setAttribute('aria-label', 'Choose a profile photo');uploadLabel.append(upload);photo.append(uploadLabel);
  const out = element('p', 'form-status');out.setAttribute('role', 'status');
  const save = element('button', 'primary', 'Save my profile');save.type = 'submit';
  form.append(label, name, photo, save, out);
  form.addEventListener('submit', async event => {
    event.preventDefault();save.disabled = true;status(out, 'Saving…');
    try {
      let avatar_url = state.profile?.avatar_url || null;
      if (upload.files[0]) avatar_url = await services.uploadAvatar(upload.files[0]);
      await services.saveProfile({ display_name: name.value.trim() || 'Learner', avatar_url });state.profile = { display_name: name.value.trim() || 'Learner', avatar_url };updateAccountHeader();status(out, 'Profile saved. Looking good.');
    } catch (error) { status(out, error.message, true); }
    finally { save.disabled = false; }
  });content.append(form, button('Sign out', async () => {
    try { await services.signOut();state.profile = null;state.activeId = null;state.drafts = {};status($('#lookup-status'), '');leaveRecording();state.studioToken++;$('#entry-panel').hidden = true;updateAccountHeader();await loadCollection();dialog.close();showView('discover');notify('You’re signed out. Your trove is waiting in your account.'); }
    catch (error) { notify(error.message, true); }
    finally {
      if (!services.getSession()) {
        state.profile = null;state.activeId = null;state.drafts = {};status($('#lookup-status'), '');leaveRecording();state.studioToken++;$('#entry-panel').hidden = true;
        updateAccountHeader();await loadCollection();dialog.close();showView('discover');
      }
    }
  }));
}
async function addManualItem(event) {
  event.preventDefault();
  const out = $('#manual-status');
  if (!needsServices(out)) return;
  const owner = ownerId(), term = $('#manual-term').value.trim(), definition = $('#manual-definition').value.trim();
  if (!term || !definition) { status(out, 'Add your expression and its meaning first.', true);return; }
  const submit = $('#manual-form button');submit.disabled = true;
  try {
    const language = $('#language').value.trim() || 'English';
    const translation = $('#manual-translation').value.trim();
    const example = $('#manual-example').value.trim();
    const payload = {
      term, kind: /\s/.test(term) ? 'phrase' : 'word', pronunciation: '', definition,
      translation, language, translationNote: translation ? 'Your own translation.' : 'No translation supplied.',
      synonyms: [], antonyms: [], antonymNote: 'No opposite has been supplied for this entry.',
      examples: example ? [example] : [], examplesSource: example ? ['Your own source sentence'] : [],
      examplesNote: 'No example has been supplied. You can revisit your original source.',
      usageNote: 'This is your own entry. Check its meaning and usage against your source.',
      speakingPrompt: `Tell a short real or imagined story where “${term}” fits. Explain the situation, the main event, and what you learned.`,
      writingPrompt: `Describe a situation that illustrates “${term}”. Explain the context and a consequence, using the expression naturally.`,
      exercises: [], method: 'manual', source: { name: 'Your own entry', url: '' },
    };
    const record = { id: crypto.randomUUID(), payload, review: { dueAt: new Date().toISOString(), intervalDays: 0, streak: 0, reviewCount: 0 } };
    await services.saveItem(record);
    if (ownerId() !== owner) return;
    state.items.unshift(record);if (state.view === 'discover') state.activeId = record.id;cacheItems();updateCollection();renderEntry(record);
    status(out, 'Saved to your trove. You can practise this expression like any other item.');
    $('#manual-entry').open = false;$('#entry-panel').scrollIntoView({ behavior: 'smooth' });
  } catch (error) { if (ownerId() === owner) status(out, error.message, true); }
  finally { submit.disabled = false; }
}
$('#manual-form').addEventListener('submit', addManualItem);
$('#capture-form').addEventListener('submit', lookup);
let pasteTimer;
$('#lexical-input').addEventListener('paste', () => {
  clearTimeout(pasteTimer);
  if ($('#auto-paste').checked) pasteTimer = setTimeout(() => { if (state.busy) state.pendingPaste = true; else lookup(); }, 850);
});
$('#language').addEventListener('change', () => { try { localStorage.setItem('lexical-trove-language', $('#language').value.trim()); } catch {} });
try { $('#language').value = localStorage.getItem('lexical-trove-language') || ''; } catch {}
document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => showView(node.dataset.view)));
document.querySelectorAll('[data-mode]').forEach(node => node.addEventListener('click', () => { state.mode = node.dataset.mode;renderPractice(); }));
$('#practice-item').addEventListener('change', () => { state.activeId = $('#practice-item').value || null;state.quiz = null;renderPractice(); });
$('#library-search').addEventListener('input', renderLibrary);$('#due-only').addEventListener('change', renderLibrary);
$('#account-button').addEventListener('click', openAccount);$('#close-account').addEventListener('click', () => $('#account-dialog').close());
window.addEventListener('pagehide', leaveRecording);
async function initialize() {
  try {
    await services.restoreSession();
    if (services.getSession()) state.profile = await services.loadProfile();
  } catch (error) { notify(error.message, true); }
  updateAccountHeader();await loadCollection();
}
initialize();
