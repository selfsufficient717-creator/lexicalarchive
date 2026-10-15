import { createHash } from 'node:crypto';

// Short-lived, process-local reuse of complete AI cards. Requests stay scoped to
// the verified account and the full expression/language/context; no auth or
// assessment results are cached. Render restarts naturally clear this cache.
export function createLookupCache({ now = Date.now, ttl = 15 * 60_000, maxEntries = 128, maxBytes = 8 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const pending = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes;
    entries.delete(key);
  }
  function expire() {
    for (const [key, entry] of entries) if (entry.expires <= now()) remove(key);
  }
  return async (userId, request, load) => {
    const key = createHash('sha256').update(JSON.stringify([userId, request.text, request.language, request.context])).digest('hex');
    expire();
    const previous = entries.get(key);
    if (previous) {
      entries.delete(key);
      entries.set(key, previous);
      return structuredClone(previous.value);
    }
    // Two tabs requesting the same item share one in-flight generation, while
    // each caller still receives an independent object and authenticates first.
    if (pending.has(key)) return structuredClone(await pending.get(key));
    const task = (async () => {
      const value = await load();
      // Let the next request retry Gemini after any fallback or error, rather
      // than retaining a temporary dictionary downgrade for the cache lifetime.
      if (value.method === 'gemini-free' && !value.fallbackNote) {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size <= maxBytes) {
          expire();
          while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) remove(entries.keys().next().value);
          entries.set(key, { value: structuredClone(value), bytes: size, expires: now() + ttl });
          bytes += size;
        }
      }
      return value;
    })();
    pending.set(key, task);
    try { return structuredClone(await task); }
    finally { if (pending.get(key) === task) pending.delete(key); }
  };
}
