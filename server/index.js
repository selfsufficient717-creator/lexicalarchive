import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApiError, validateFeedbackRequest, validateLexiconRequest } from './validation.js';
import { createFeedback, createLexicon } from './ai.js';
import { authenticate, loadPractice, savePractice } from './supabase.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_BODY = 5_800_000;
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...['app.js', 'config.js', 'services.js', 'practice.js', 'recorder.js'].map((name) => [`/${name}`, [name, 'text/javascript; charset=utf-8']]),
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

export function readConfig(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const allowedOrigin = env.ALLOWED_ORIGIN || 'https://selfsufficient717-creator.github.io';
  const originUrl = new URL(allowedOrigin);
  if (originUrl.origin !== allowedOrigin || !['https:', 'http:'].includes(originUrl.protocol)) throw new Error('ALLOWED_ORIGIN must be an exact HTTP(S) origin, without a path.');
  if (originUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(originUrl.hostname)) throw new Error('Public ALLOWED_ORIGIN must use HTTPS.');
  if (supabaseUrl) {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('SUPABASE_URL must be an HTTPS project origin.');
  }
  const anonKey = env.SUPABASE_ANON_KEY || '';
  let keyRole;
  if (anonKey.split('.').length === 3) {
    try { keyRole = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString('utf8')).role; }
    catch { /* Supabase validates the actual key at the service boundary. */ }
  }
  if (anonKey.startsWith('sb_secret_') || keyRole === 'service_role') throw new Error('SUPABASE_ANON_KEY must be a public anon/publishable key, never a service-role or secret key.');
  const config = {
    aiKey: env.LEXICAL_AI_API_KEY || '',
    supabaseUrl,
    supabaseAnonKey: anonKey,
    allowedOrigin,
    textModel: env.LEXICAL_TEXT_MODEL || 'gpt-4o-mini',
    audioModel: env.LEXICAL_AUDIO_MODEL || 'gpt-audio',
  };
  config.configured = Boolean(config.aiKey && config.supabaseUrl && config.supabaseAnonKey);
  return config;
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'json_required', 'Use an application/json request.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new ApiError(413, 'request_too_large', 'This request exceeds the recording size limit.');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
      req.resume();
    };
    req.on('data', (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BODY) return fail(new ApiError(413, 'request_too_large', 'This request exceeds the recording size limit.'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'invalid_json', 'The request must contain valid JSON.')); }
    });
    req.on('error', () => fail(new ApiError(400, 'request_interrupted', 'The request was interrupted. Please retry.')));
    req.on('aborted', () => fail(new ApiError(400, 'request_interrupted', 'The request was interrupted. Please retry.')));
  });
}

function cors(req, res, config) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return;
  let sameOrigin = false;
  try {
    const parsed = new URL(origin);
    sameOrigin = parsed.origin === origin && parsed.host === req.headers.host && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)));
  } catch { /* an invalid Origin is rejected */ }
  if (origin !== config.allowedOrigin && !sameOrigin) throw new ApiError(403, 'origin_not_allowed', 'This origin cannot use the language service.');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function makeLimiter(now) {
  const buckets = new Map();
  return (key, minuteLimit, dayLimit) => {
    const time = now();
    if (buckets.size > 10000) {
      for (const [id, value] of buckets) if (time - value.dayStarted >= 86_400_000) buckets.delete(id);
      if (buckets.size > 10000) throw new ApiError(503, 'service_busy', 'The service is busy. Try again later.');
    }
    let bucket = buckets.get(key);
    if (!bucket) bucket = { minuteStarted: time, minute: 0, dayStarted: time, day: 0 };
    if (time - bucket.minuteStarted >= 60_000) Object.assign(bucket, { minuteStarted: time, minute: 0 });
    if (time - bucket.dayStarted >= 86_400_000) Object.assign(bucket, { dayStarted: time, day: 0 });
    if (bucket.minute >= minuteLimit || bucket.day >= dayLimit) throw new ApiError(429, 'rate_limit', 'You have reached the practice request limit. Please try again later.');
    bucket.minute++;
    bucket.day++;
    buckets.set(key, bucket);
  };
}

export function createApp({ config = readConfig(), fetchImpl = globalThis.fetch, now = Date.now, root = ROOT } = {}) {
  const limit = makeLimiter(now);
  const activeUsers = new Map();
  const activityLocks = new Set();
  let activeTotal = 0;

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    let user;
    let counted = false;
    let activityLock;
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const pathname = requestUrl.pathname;
      if (!pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'method_not_allowed', 'Use GET to load the website.');
        const file = PUBLIC_FILES.get(pathname);
        if (!file || requestUrl.search) throw new ApiError(404, 'not_found', 'This file does not exist.');
        let content;
        try { content = await readFile(path.join(root, file[0])); }
        catch { throw new ApiError(404, 'not_found', 'This file does not exist.'); }
        res.writeHead(200, { 'Content-Type': file[1] });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      cors(req, res, config);
      if (req.method === 'OPTIONS') {
        if (!['/api/health', '/api/lexicon', '/api/feedback'].includes(pathname)) throw new ApiError(404, 'not_found', 'This API route does not exist.');
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, configured: config.configured });
      if (!['/api/lexicon', '/api/feedback'].includes(pathname)) throw new ApiError(404, 'not_found', 'This API route does not exist.');
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST for this API route.');
      if (!config.configured) throw new ApiError(503, 'service_not_configured', 'The language service is awaiting deployment configuration.');
      // Managed hosts terminate connections at a reverse proxy. Socket addresses
      // are not reliably end-user IPs, and forwarded headers are untrusted.
      // Keep this an intentional process-wide authentication safety ceiling;
      // each authenticated account has its own stricter quota below.
      limit('auth:global', 1200, 100000);
      user = await authenticate(config, fetchImpl, req.headers.authorization);
      limit(`user:${user.id}`, 20, 300);
      if ((activeUsers.get(user.id) || 0) >= 2 || activeTotal >= 8) throw new ApiError(429, 'service_busy', 'An assessment is already running. Wait for it to finish.');
      activeUsers.set(user.id, (activeUsers.get(user.id) || 0) + 1);
      activeTotal++;
      counted = true;
      const body = await readBody(req);
      if (pathname === '/api/lexicon') {
        const result = await createLexicon(config, fetchImpl, validateLexiconRequest(body));
        return json(res, 200, result);
      }
      const request = validateFeedbackRequest(body);
      activityLock = `${user.id}:${request.itemId}:${request.mode}`;
      if (activityLocks.has(activityLock)) {
        activityLock = undefined;
        throw new ApiError(409, 'assessment_in_progress', 'This activity is already being assessed. Wait for its result.');
      }
      activityLocks.add(activityLock);
      const practice = await loadPractice(config, fetchImpl, user, request.itemId, request.mode);
      const feedback = await createFeedback(config, fetchImpl, { ...request, ...practice });
      const result = await savePractice(config, fetchImpl, user, request.itemId, request.mode, practice, feedback, request.response);
      json(res, 200, result);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const known = error instanceof ApiError;
      if (!known) console.error('Request failed:', error?.name || 'Error');
      if (!res.headersSent) json(res, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'The request could not be completed. Please try again.' } }, error?.status === 429 ? { 'Retry-After': '60' } : {});
      else res.end();
    } finally {
      if (activityLock) activityLocks.delete(activityLock);
      if (counted) {
        const remaining = (activeUsers.get(user.id) || 1) - 1;
        if (remaining) activeUsers.set(user.id, remaining);
        else activeUsers.delete(user.id);
        activeTotal--;
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 25_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    const config = readConfig();
    const server = createApp({ config });
    server.listen(port, '0.0.0.0', () => {
      console.log(`Lexical Trove listening on port ${port}. Language service ${config.configured ? 'configured' : 'awaiting configuration'}.`);
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); });
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
