import { CONFIG } from './config.js';

// The public publishable/anon key belongs here; service-role and OpenAI keys do not.
const SESSION_KEY = 'lexical-trove-session-v1';
let currentSession = null;
let sessionValidated = false;
let restorePromise = null;
let refreshPromise = null;
let sessionGeneration = 0;

export class ServiceError extends Error {
  constructor(message, { status = 0, code = 'service_error' } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

function validBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    const secureProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    return secureProtocol && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function publicKeyOnly(key) {
  if (typeof key !== 'string' || !key.trim() || key.startsWith('sb_secret_')) return false;
  try {
    const payload = key.split('.')[1];
    if (payload && typeof globalThis.atob === 'function') {
      const claims = JSON.parse(globalThis.atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      if (claims.role === 'service_role') return false;
    }
  } catch { /* Publishable keys are not JWTs. */ }
  return true;
}

export function serviceReady() { return validBaseUrl(CONFIG.apiBaseUrl); }
export function accountReady() { return validBaseUrl(CONFIG.supabaseUrl) && publicKeyOnly(CONFIG.supabaseAnonKey); }

function requireAccountConfig() {
  if (!accountReady()) {
    throw new ServiceError('Email sign-in is not connected yet. Please try again once accounts are available.', { code: 'setup_required' });
  }
}

function supabaseBase() { return CONFIG.supabaseUrl.replace(/\/+$/, ''); }
function now() { return Math.floor(Date.now() / 1000); }

function readStoredSession() {
  try {
    const value = globalThis.localStorage?.getItem(SESSION_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed.access_token === 'string' && typeof parsed.refresh_token === 'string' ? parsed : null;
  } catch { return null; }
}

function persistSession() {
  try {
    if (!globalThis.localStorage) return false;
    if (currentSession) {
      const { access_token, refresh_token, expires_at, user } = currentSession;
      globalThis.localStorage.setItem(SESSION_KEY, JSON.stringify({ access_token, refresh_token, expires_at, user }));
    } else {
      globalThis.localStorage.removeItem(SESSION_KEY);
    }
    return true;
  } catch { return false; }
}

function clearSession() {
  sessionGeneration += 1;
  currentSession = null;
  sessionValidated = false;
  persistSession();
}

function sessionFromTokens(tokens, previous = null) {
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new ServiceError('The sign-in service returned an incomplete session. Request a new email link.', { code: 'invalid_session' });
  }
  const expiresAt = Number(tokens.expires_at);
  const expiresIn = Number(tokens.expires_in);
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600),
    token_type: 'bearer',
    user: tokens.user || previous?.user || null,
    persisted: true,
  };
}

// Never expose a stored, unverified user as a signed-in account.
export function getSession() {
  if (!sessionValidated || !currentSession) return null;
  return { ...currentSession, user: { ...currentSession.user } };
}

function safeErrorMessage(value, fallback) {
  let message = typeof value === 'string' && value.trim() ? value.slice(0, 700) : fallback;
  for (const secret of [currentSession?.access_token, currentSession?.refresh_token, CONFIG.supabaseAnonKey]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

async function request(url, options = {}, fallback = 'The request could not be completed.') {
  let response;
  try { response = await globalThis.fetch(url, options); }
  catch {
    throw new ServiceError('Cannot reach the service. Check your connection and try again.', { code: 'network_error' });
  }
  let data = null;
  if (response.status !== 204) {
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); }
      catch {
        if (response.ok) throw new ServiceError('The service returned an unexpected response. Please try again.', { status: response.status, code: 'invalid_response' });
      }
    }
  }
  if (!response.ok) {
    const error = data?.error;
    const message = typeof error === 'object' && error ? error.message : data?.message || data?.msg || data?.error_description || (typeof error === 'string' ? error : null);
    throw new ServiceError(safeErrorMessage(message, fallback), {
      status: response.status,
      code: typeof error === 'object' && error ? error.code || 'service_error' : data?.code || data?.error_code || 'service_error',
    });
  }
  return data;
}

function authHeaders(token, extra = {}) {
  return { apikey: CONFIG.supabaseAnonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

function removeLinkParameters(params) {
  for (const key of ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type', 'error', 'error_code', 'error_description']) params.delete(key);
  const remaining = params.toString();
  if (globalThis.history?.replaceState && globalThis.location) {
    globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search || ''}${remaining ? `#${remaining}` : ''}`);
  }
}

function captureSignInLink() {
  const hash = globalThis.location?.hash;
  if (!hash || !hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has('access_token') && !params.has('refresh_token') && !params.has('error') && !params.has('error_description')) return null;
  const tokens = Object.fromEntries(params);
  // Remove bearer credentials from the visible URL before any network request.
  removeLinkParameters(params);
  if (tokens.error || tokens.error_description) {
    throw new ServiceError('This email sign-in link has expired or was already used. Request a new link.', { code: 'link_expired' });
  }
  return sessionFromTokens(tokens);
}

async function refreshSession() {
  if (refreshPromise) return refreshPromise;
  if (!currentSession?.refresh_token) {
    clearSession();
    throw new ServiceError('Please sign in with an email link to continue.', { code: 'sign_in_required', status: 401 });
  }
  const originalSession = currentSession;
  const originalGeneration = sessionGeneration;
  refreshPromise = (async () => {
    try {
      const data = await request(`${supabaseBase()}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: authHeaders(null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ refresh_token: originalSession.refresh_token }),
      }, 'Your session could not be renewed. Please sign in again.');
      if (sessionGeneration !== originalGeneration) throw new ServiceError('You have signed out. Sign in again to continue.', { status: 401, code: 'sign_in_required' });
      if (!data?.user?.id) throw new ServiceError('Your session could not be verified. Please sign in again.', { status: 401, code: 'invalid_session' });
      currentSession = sessionFromTokens(data);
      sessionValidated = true;
      currentSession.persisted = persistSession();
      return currentSession;
    } catch (error) {
      if (sessionGeneration === originalGeneration && (error.status === 400 || error.status === 401 || error.status === 403 || error.code === 'invalid_session')) clearSession();
      throw error;
    } finally { refreshPromise = null; }
  })();
  return refreshPromise;
}

export async function restoreSession() {
  if (!accountReady()) return null;
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    let fromLink;
    try { fromLink = captureSignInLink(); }
    catch (error) { clearSession(); throw error; }
    if (fromLink) { currentSession = fromLink; sessionValidated = false; }
    if (!currentSession) { currentSession = readStoredSession(); sessionValidated = false; }
    if (!currentSession) return null;
    const originalGeneration = sessionGeneration;
    try {
      if (Number(currentSession.expires_at) <= now() + 60) await refreshSession();
      const expectedToken = currentSession.access_token;
      const user = await request(`${supabaseBase()}/auth/v1/user`, { headers: authHeaders(currentSession.access_token) }, 'Your account could not be verified. Please sign in again.');
      if (sessionGeneration !== originalGeneration || currentSession?.access_token !== expectedToken) throw new ServiceError('Your sign-in session changed. Sign in again to continue.', { code: 'sign_in_required', status: 401 });
      if (!user?.id) throw new ServiceError('Your account could not be verified. Please sign in again.', { status: 401, code: 'invalid_session' });
      currentSession.user = user;
      sessionValidated = true;
      currentSession.persisted = persistSession();
      return getSession();
    } catch (error) {
      if (sessionGeneration !== originalGeneration && error.code === 'sign_in_required') return null;
      if (error.status === 401 && currentSession?.refresh_token) {
        try {
          await refreshSession();
          return getSession();
        } catch (refreshError) {
          if ([400, 401, 403].includes(refreshError.status)) {
            clearSession();
            if (fromLink) throw new ServiceError('This email sign-in link has expired. Request a new link.', { code: 'link_expired' });
            return null;
          }
          throw refreshError;
        }
      }
      if ([400, 401, 403].includes(error.status)) {
        clearSession();
        if (!fromLink) return null;
      }
      throw error;
    } finally { restorePromise = null; }
  })();
  // A synchronous no-session return still needs to release the in-flight promise.
  try { return await restorePromise; }
  finally { restorePromise = null; }
}

async function signedInSession() {
  requireAccountConfig();
  if (!sessionValidated || !currentSession) await restoreSession();
  if (!currentSession || !sessionValidated) throw new ServiceError('Sign in with an email link to save your collection and use AI practice.', { status: 401, code: 'sign_in_required' });
  if (Number(currentSession.expires_at) <= now() + 60) await refreshSession();
  return currentSession;
}

export async function sendMagicLink(email) {
  requireAccountConfig();
  const value = typeof email === 'string' ? email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
    throw new ServiceError('Enter a valid email address.', { code: 'invalid_email' });
  }
  if (!globalThis.location?.origin || !globalThis.location?.pathname) throw new ServiceError('Open the website in a browser to request a sign-in link.', { code: 'browser_required' });
  const redirectTo = `${globalThis.location.origin}${globalThis.location.pathname}`;
  const query = new URLSearchParams({ redirect_to: redirectTo });
  return request(`${supabaseBase()}/auth/v1/otp?${query}`, {
    method: 'POST',
    headers: authHeaders(null, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email: value, create_user: true, options: { emailRedirectTo: redirectTo } }),
  }, 'The sign-in email could not be sent. Try again in a moment.');
}

export async function signOut() {
  const token = currentSession?.access_token;
  // Local sign-out succeeds even when the revocation service is unavailable.
  clearSession();
  if (!token || !accountReady()) return;
  try {
    await request(`${supabaseBase()}/auth/v1/logout`, { method: 'POST', headers: authHeaders(token) }, 'The server session could not be revoked.');
  } catch (error) {
    if (error.status === 401 || error.status === 403) return;
    throw new ServiceError('You are signed out on this device. The server could not revoke the session; try again when your connection returns.', { code: 'logout_incomplete', status: error.status });
  }
}

async function authenticatedRequest(url, options = {}, supabase = false) {
  let session = await signedInSession();
  const generation = sessionGeneration;
  const userId = session.user.id;
  const requireSameAccount = () => {
    if (sessionGeneration !== generation || !sessionValidated || currentSession?.user?.id !== userId) {
      throw new ServiceError('Your account changed while this request was running. Please try again from your current account.', { code: 'account_changed', status: 409 });
    }
  };
  const makeOptions = () => ({ ...options, headers: { ...(supabase ? { apikey: CONFIG.supabaseAnonKey } : {}), ...options.headers, Authorization: `Bearer ${session.access_token}` } });
  const dispatch = async () => {
    // Do not send a mutation or return private data after local account ownership changes.
    requireSameAccount();
    try {
      const result = await request(url, makeOptions());
      requireSameAccount();
      return result;
    } catch (error) {
      requireSameAccount();
      throw error;
    }
  };
  try { return await dispatch(); }
  catch (error) {
    if (error.status !== 401) throw error;
    requireSameAccount();
    try { session = await refreshSession(); }
    catch (refreshError) { requireSameAccount(); throw refreshError; }
    requireSameAccount();
    return dispatch();
  }
}

export async function api(path, body) {
  if (!serviceReady()) throw new ServiceError('The learning service is not connected yet. Please try again later.', { code: 'setup_required' });
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new ServiceError('Invalid service route.', { code: 'invalid_request' });
  const isForm = typeof globalThis.FormData === 'function' && body instanceof globalThis.FormData;
  const options = { method: body === undefined ? 'GET' : 'POST', headers: {} };
  if (body !== undefined) {
    options.body = isForm ? body : JSON.stringify(body);
    if (!isForm) options.headers['Content-Type'] = 'application/json';
  }
  return authenticatedRequest(`${CONFIG.apiBaseUrl.replace(/\/+$/, '')}${path}`, options);
}

function rest(path, options = {}) { return authenticatedRequest(`${supabaseBase()}/rest/v1/${path}`, options, true); }
function jsonMutation(method, value, prefer = 'return=representation') {
  return { method, headers: { 'Content-Type': 'application/json', Prefer: prefer }, body: JSON.stringify(value) };
}
function validId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new ServiceError('This learning item has no valid ID. Save it again.', { code: 'invalid_item' });
  return value;
}
function userFilter(session) { return `user_id=eq.${encodeURIComponent(validId(session.user.id))}`; }

export async function loadLibrary() {
  const session = await signedInSession();
  return rest(`items?select=*&order=created_at.desc&${userFilter(session)}`);
}

export async function saveItem(item) {
  const session = await signedInSession();
  if (!item?.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) throw new ServiceError('This learning item is incomplete. Look it up again before saving.', { code: 'invalid_item' });
  const row = { id: validId(item.id), user_id: session.user.id, payload: item.payload, review: item.review || {} };
  await rest('items?on_conflict=id', jsonMutation('POST', row, 'resolution=merge-duplicates,return=minimal'));
  return row;
}

export async function deleteItem(id) {
  const session = await signedInSession();
  await rest(`items?id=eq.${encodeURIComponent(validId(id))}&${userFilter(session)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

export async function saveReview(id, review) {
  const session = await signedInSession();
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw new ServiceError('Invalid review progress.', { code: 'invalid_review' });
  const rows = await rest(`items?id=eq.${encodeURIComponent(validId(id))}&${userFilter(session)}`, jsonMutation('PATCH', { review }));
  if (!Array.isArray(rows) || !rows.length) throw new ServiceError('This item is no longer in your account. Reload your collection before reviewing it.', { code: 'item_not_found' });
  return rows[0];
}

export async function loadAttempts(itemId, mode) {
  const session = await signedInSession();
  if (!['writing', 'speaking'].includes(mode)) throw new ServiceError('Choose a writing or speaking practice.', { code: 'invalid_mode' });
  return rest(`attempts?select=*&item_id=eq.${encodeURIComponent(validId(itemId))}&mode=eq.${mode}&order=attempt_number.asc&${userFilter(session)}`);
}

// Evaluated responses are normally persisted by the API, which enforces three attempts.
export async function saveAttempt(record) {
  const session = await signedInSession();
  if (!record || !['writing', 'speaking'].includes(record.mode) || !Number.isInteger(record.attempt_number) || record.attempt_number < 1 || record.attempt_number > 3) throw new ServiceError('Invalid practice attempt.', { code: 'invalid_attempt' });
  const row = {
    ...(record.id ? { id: validId(record.id) } : {}),
    user_id: session.user.id,
    item_id: validId(record.item_id),
    mode: record.mode,
    attempt_number: record.attempt_number,
    prompt: record.prompt,
    response: record.response,
    feedback: record.feedback,
  };
  const rows = await rest('attempts', jsonMutation('POST', row));
  return rows?.[0] || row;
}

export async function loadProfile() {
  const session = await signedInSession();
  const rows = await rest(`profiles?select=*&${userFilter(session)}&limit=1`);
  return rows?.[0] || null;
}

export async function saveProfile({ display_name = '', avatar_url = null } = {}) {
  const session = await signedInSession();
  const displayName = typeof display_name === 'string' ? display_name.trim() : '';
  if (displayName.length > 80) throw new ServiceError('Use a display name of 80 characters or fewer.', { code: 'invalid_profile' });
  if (avatar_url) {
    const allowedPrefix = `${supabaseBase()}/storage/v1/object/public/avatars/${validId(session.user.id)}/`;
    if (typeof avatar_url !== 'string' || !avatar_url.startsWith(allowedPrefix) || !/^[a-zA-Z0-9-]+\.(jpg|png|webp)$/.test(avatar_url.slice(allowedPrefix.length))) throw new ServiceError('Upload a profile photo from this account first.', { code: 'invalid_avatar' });
  }
  const row = { user_id: session.user.id, display_name: displayName, avatar_url: avatar_url || null };
  const rows = await rest('profiles?on_conflict=user_id', jsonMutation('POST', row, 'resolution=merge-duplicates,return=representation'));
  return rows?.[0] || row;
}

function randomFileId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  throw new ServiceError('Your browser cannot safely upload a photo. Use a current browser over HTTPS.', { code: 'browser_required' });
}

async function imageMatchesType(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  return [82, 73, 70, 70].every((value, i) => bytes[i] === value) && [87, 69, 66, 80].every((value, i) => bytes[i + 8] === value);
}

export async function uploadAvatar(file) {
  const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  if (!file || !types[file.type] || typeof file.slice !== 'function') throw new ServiceError('Choose a JPEG, PNG, or WebP photo.', { code: 'invalid_avatar' });
  if (!file.size || file.size > 2 * 1024 * 1024) throw new ServiceError('Choose a photo of 2 MB or less.', { code: 'invalid_avatar' });
  if (!await imageMatchesType(file)) throw new ServiceError('This file does not match its image format. Choose a JPEG, PNG, or WebP photo.', { code: 'invalid_avatar' });
  const session = await signedInSession();
  const path = `${validId(session.user.id)}/${randomFileId()}.${types[file.type]}`;
  await authenticatedRequest(`${supabaseBase()}/storage/v1/object/avatars/${path}`, {
    method: 'POST', headers: { 'Content-Type': file.type, 'x-upsert': 'false' }, body: file,
  }, true);
  return `${supabaseBase()}/storage/v1/object/public/avatars/${path}`;
}
