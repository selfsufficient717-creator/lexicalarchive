# Free learning service

Node 24 HTTP service with Supabase authentication, dictionary lookup, basic coaching, and optional Gemini free-tier AI. There are no runtime dependencies or OpenAI calls.

`npm start` respects environment proxies and CA trust. `SUPABASE_URL` and `SUPABASE_ANON_KEY` configure accounts/data; `ALLOWED_ORIGIN` is the exact Pages origin. See [../DEPLOYMENT.md](../DEPLOYMENT.md) for free Render setup and the optional Gemini key/explicit free-tier flag. Keep Google billing disabled.

- `GET /api/health`: reports `ok`, Supabase `configured`, `mode:"free"`, and Gemini setup flags `{keyPresent,freeTierConfirmed,enabled}`. These are presence checks only, never key values or a live model/billing check.
- `POST /api/lexicon`: authenticated `{text,context,language}`. Gemini is used only with the owner-confirmed free-tier flag and key; otherwise, or on an AI failure, Free Dictionary API/Wiktionary supply actual entries and optional MyMemory translations.
- `POST /api/feedback`: authenticated `{itemId,mode,item,prompt,response?,audio?,transcript?,transcriptConfirmed?,previousAttempts?}`. Saved item, prompt and attempt history are authoritative. Gemini receives the actual WAV if enabled. On fallback, rule-based coaching reports measurable patterns with null scores and clear limitations.

Audio is 16kHz mono 16-bit PCM WAV, 1–120 seconds. The app stores transcript/feedback, not raw audio. A supplied transcript must be confirmed by the learner. Pronunciation is never inferred from text. Basic coaching does not assess pronunciation, linguistic naturalness, correctness, semantic topic relevance, or factual reliability.

The Supabase schema caps each activity at an initial attempt plus two revisions, serializes concurrent inserts, and scopes private rows to the user. RLS is not bypassed. CORS, body/length limits, per-user request limits, and strict provider-output validation remain enforced.

All default dictionary/translation URLs are fixed HTTPS destinations, with timeouts, bounded caches and no redirect following. Source text is converted to plain text and attribution retained. Generated AI cards are labeled separately. Unknown expressions are not reduced to individual words or assigned invented meanings.

`npm test` verifies dictionaries, translation failure recovery, rule measurements, actual audio routing, free-tier opt-in, quota fallbacks, revision history, authentication, concurrency, private-file isolation and secret redaction with service doubles. Live email delivery, source availability, and Gemini free-tier access require separate checks. Cloud network policy does not control Render's outbound traffic.
