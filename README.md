# Lexical Trove

Turn English words, phrases, long expressions, and idioms encountered in real life into a personal learning collection. There is no built-in word list. Every card is generated from the learner's input and optional source context.

## What it does

- Automatic lookup after pasting, with simple meanings, translation into a chosen language, natural example sentences, usage notes, synonyms, and linguistically appropriate antonyms.
- Meaning, synonym, and antonym matching; contextual multiple choice; collocation exercises; long-passage gap filling; active and translation recall; spaced review.
- Writing topics with feedback on relevance/ideas, cohesion/coherence, word choice, naturalness, and readability.
- Microphone recording and audio-based feedback on fluency, organization, target expression use, and pronunciation. Accent differences are not automatically mistakes.
- Feedback starts with an overall impression and explains each mistake, why it is wrong, and how to improve. Each item's writing and speaking topic permits an initial response and two revisions, with comparisons and retained history.
- Email confirmation links without passwords, cloud-saved collections, and profile photos.

## Architecture

The static frontend can stay on GitHub Pages. A small authenticated Node API calls OpenAI with a server-only key. Supabase handles email sign-in, private data with row-level security, and profile images. No OpenAI or Supabase service-role key belongs in browser code. See [DEPLOYMENT.md](DEPLOYMENT.md) for the setup walkthrough.

The repo intentionally has no configured service URLs or keys. Without them, the interface explains that the learning service is not connected; it does not fabricate definitions, sign-in, or feedback. Tests use fixtures only in test code. Actual AI output and email delivery require live services to be checked after configuration.

## Development

Node 24+ is required. There are no npm dependencies to install.

```sh
npm start
```

The server listens on port 3000 (or `PORT`) and serves only the public frontend files. Configure `config.js` and the backend environment variables to use live services. `GET /api/health` reports `configured: false` until the backend requirements are present; `configured: true` reports settings presence, not provider readiness.

```sh
npm test
# Optional integration tests, with Python Playwright and Chromium installed:
python3 tests/browser_smoke.py
```

Browser tests mock provider/auth responses. They check UI behavior, not real AI accuracy, email delivery, or Supabase deployment.

## Data and limitations

Words, writing responses, transcripts, and feedback are private to the signed-in user's account. Profile pictures are public images. Recordings stay on the device until submission, then go to the API/OpenAI for assessment; the app saves a transcript and feedback, not the audio. Provider processing and retention policies still apply.

AI explanations and feedback are fallible learning guidance. They are not official exam grades or factual verification. Expressions without a natural opposite do not receive invented antonyms. Matching needs at least two collected items with distinct relationships. Microphone recording needs HTTPS (or localhost), permission, and a compatible browser.

Reviews currently schedule at the item level. Each fixed writing/speaking topic has three attempts total; collect another item for another topic. A future version can add multiple independent topic sessions and progress charts.
