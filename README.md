# Lexical Trove

A personal English word, phrase, and idiom collection with contextual practice, recordings, revisions, email-link accounts, and profile photos. There is no built-in word list or required paid AI service.

## Free workflows

Without an AI key, the app looks up real entries from Free Dictionary API and Wiktionary. Optional MyMemory translations use its anonymous free quota. Examples and word relations are shown only when the source supplies them. Dictionary wording and its first listed sense are used without claiming automatic simplification or context disambiguation. Missing expressions can be added manually, with a meaning and an example from the learner's source.

Practice includes matching, recall, translation recall, and gap exercises derived from real examples or pasted passages. A pasted passage of 80+ words can produce long-text gap practice. Sparse source data never becomes invented exercise content.

Basic writing/speaking coaching measures text patterns, exact expression occurrence, recording duration and volume. It has **no examiner scores** and does not claim to judge pronunciation, semantic correctness, topic relevance, naturalness, or factual reliability. Feedback and comparisons are labeled accordingly.

For richer explanations, varied generated exercises, and actual audio-based feedback, the owner can opt into **Gemini's free tier**. Keep the Google project's billing disabled; quotas and regional/model availability apply. If Gemini fails or its quota is exhausted, dictionary lookup and basic coaching are used transparently. The app does not call OpenAI and ignores any old OpenAI key.

## Run

Node 24+ is required. There are no runtime npm dependencies.

```sh
npm start
npm test
# Optional: requires Python Playwright and Chromium
python3 tests/browser_smoke.py
```

The backend needs only `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public publishable/anon key), and `ALLOWED_ORIGIN`. The public website settings are in `config.js`. See [DEPLOYMENT.md](DEPLOYMENT.md) for the already-created services and optional free Gemini setup.

`GET /api/health` reports configuration presence and `mode:"free"`; it does not establish external source readiness or AI account billing status.

## Accounts, costs, and privacy

Keep GitHub Pages, Render, and Supabase on their free plans. Free quotas, cold starts, pauses, email delivery restrictions, and storage limits apply. The app does not automatically upgrade a plan or purchase credits. Public registration beyond Supabase's test-mail recipient limits needs an SMTP provider; choose one with a free allowance or keep initial testing to allowed recipients. No domain or paid mail provider is required by this code.

Collections, drafts, transcripts, and feedback are protected by account-scoped Supabase row policies. Profile photos are public. Recordings stay local until submission; the app does not store the raw audio. Optional browser transcription may send audio to the browser vendor. Free-tier Gemini sends submitted content to Google under its free-service terms; review those terms before using sensitive material. Dictionary/translation providers receive the lookup expression, not the learner's original passage or performance.

Automated tests use controlled service responses, not real email or AI delivery. Verify live service behavior before making a readiness claim. All three attempts remain saved per item and practice mode; basic-coaching fallback also counts as an attempt, as disclosed in feedback.
