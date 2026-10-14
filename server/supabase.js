import { ApiError, validateFeedback, validateItem } from './validation.js';

export async function authenticate(config, fetchImpl, authorization) {
  if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(authorization)) throw new ApiError(401, 'authentication_required', 'Confirm your email and sign in to use this feature.');
  let response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: authorization, apikey: config.supabaseAnonKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ApiError(503, 'authentication_unavailable', 'Sign-in verification is temporarily unavailable.'); }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ApiError(401, 'session_expired', 'Your sign-in session has expired. Please sign in again.');
    throw new ApiError(503, 'authentication_unavailable', 'Sign-in verification is temporarily unavailable.');
  }
  let user;
  try { user = await response.json(); } catch { /* handled below */ }
  if (!user || typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)) throw new ApiError(503, 'authentication_unavailable', 'Sign-in verification could not be completed.');
  if (!user.email_confirmed_at || typeof user.email !== 'string' || !user.email) throw new ApiError(403, 'email_confirmation_required', 'Confirm your email before using the language service.');
  return { id: user.id, authorization };
}

async function db(config, fetchImpl, user, path, options = {}) {
  let response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}/rest/v1/${path}`, {
      ...options,
      headers: { apikey: config.supabaseAnonKey, Authorization: user.authorization, 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ApiError(503, 'storage_unavailable', 'Your saved practice could not be reached. Please try again.'); }
  if (!response.ok) {
    if (response.status === 409) throw new ApiError(409, 'attempt_conflict', 'This attempt was already submitted in another tab. Reload your practice history.');
    if (response.status === 400 && options.method === 'POST' && path.startsWith('attempts?')) {
      // The sequential-attempt trigger raises check_violation (23514), which
      // PostgREST reports as HTTP 400 after a concurrent API instance wins.
      // Inspect the machine code only; never return database messages/details.
      let code;
      try { code = (await response.json())?.code; } catch { /* handled as storage failure below */ }
      if (code === '23514') throw new ApiError(409, 'attempt_conflict', 'This activity changed while it was being assessed. Reload your practice history.');
    }
    throw new ApiError(503, 'storage_unavailable', 'Your saved practice could not be read or updated. Please try again.');
  }
  try { return await response.json(); }
  catch { throw new ApiError(503, 'storage_unavailable', 'Your saved practice returned an invalid response.'); }
}

export async function loadPractice(config, fetchImpl, user, itemId, mode) {
  const owner = `user_id=eq.${encodeURIComponent(user.id)}`;
  const items = await db(config, fetchImpl, user, `items?id=eq.${encodeURIComponent(itemId)}&${owner}&select=id,payload`);
  if (!Array.isArray(items) || items.length !== 1) throw new ApiError(404, 'item_not_found', 'Save this item to your collection before practicing.');
  let item;
  try { item = validateItem(items[0].payload); }
  catch { throw new ApiError(409, 'invalid_saved_item', 'This saved item needs a fresh learning card before it can be practiced.'); }
  const attempts = await db(config, fetchImpl, user, `attempts?item_id=eq.${encodeURIComponent(itemId)}&mode=eq.${mode}&${owner}&order=attempt_number.asc&select=id,prompt,response,feedback,attempt_number`);
  if (!Array.isArray(attempts)) throw new ApiError(503, 'storage_unavailable', 'Your attempt history could not be read.');
  if (attempts.length >= 3) throw new ApiError(409, 'attempt_limit', 'You have completed the initial response and both revisions for this activity.');
  let previousAttempts;
  try {
    previousAttempts = attempts.map((attempt, index) => {
      if (attempt.attempt_number !== index + 1 || typeof attempt.response !== 'string' || attempt.response.length > 20000) throw new Error('Invalid attempt history');
      return { response: attempt.response, feedback: validateFeedback(attempt.feedback, mode, index > 0) };
    });
  } catch { throw new ApiError(409, 'invalid_attempt_history', 'Your saved activity history could not be assessed safely.'); }
  const prompt = attempts[0]?.prompt || item[mode === 'speaking' ? 'speakingPrompt' : 'writingPrompt'];
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2500) throw new ApiError(409, 'invalid_saved_item', 'Your saved practice prompt is invalid.');
  return { item, prompt, previousAttempts, attemptNumber: attempts.length + 1 };
}

export async function savePractice(config, fetchImpl, user, itemId, mode, practice, feedback, response) {
  const rows = await db(config, fetchImpl, user, 'attempts?select=id,attempt_number', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: user.id, item_id: itemId, mode, attempt_number: practice.attemptNumber, prompt: practice.prompt, response: mode === 'speaking' ? feedback.transcript : response, feedback }),
  });
  if (!Array.isArray(rows) || !rows[0]?.id || rows[0].attempt_number !== practice.attemptNumber) throw new ApiError(503, 'storage_unavailable', 'The assessment could not be saved. Please reload your history before trying again.');
  return { ...feedback, attemptId: rows[0].id, attemptNumber: rows[0].attempt_number };
}
