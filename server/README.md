# Lexical Trove API and account setup

GitHub Pages serves the interface. It cannot keep an AI provider key secret or run an API. This Node 24 server generates learning cards and evaluates practice; Supabase supplies email authentication, private collections and attempt history. There are no runtime dependencies and no built-in sample cards or fabricated feedback.

## Configure Supabase

1. Create a Supabase project and run [schema.sql](../supabase/schema.sql) in its SQL editor. Review it before executing in an existing project.
2. Enable email authentication. Enable confirmation and magic-link sign-in. For production delivery, configure your SMTP provider; Supabase's default mail service has restrictive limits.
3. Set the Auth site URL to `https://selfsufficient717-creator.github.io/lexicalarchive/`. Add that exact URL to the allowed redirect URLs. Add `http://localhost:3000/` only for local testing.
4. Put the project URL and **public anon key** in the frontend's public `config.js`. These are intentionally public; database row-level security controls access. Never put a service-role key or the AI key there.
5. Profile pictures use the public `avatars` bucket. JPEG, PNG and WebP pictures are limited to 2 MB and users can write only under their own UUID folder. Pictures are publicly accessible; do not upload private documents. Collections, writing and speech transcripts are private to each account through RLS.

## Configure and run the API

Use the existing repository checkout; cloud tasks are isolated and do not need extra Git worktrees. Node 24 is sufficient; there is nothing to install. Supply these environment variables through the hosting service's secret settings:

| Variable | Purpose |
| --- | --- |
| `LEXICAL_AI_API_KEY` | Secret OpenAI API key with access to the chosen text and audio models; kept only on the server |
| `SUPABASE_URL` | HTTPS project URL |
| `SUPABASE_ANON_KEY` | Project's public anon key; used with each signed-in user's bearer token |
| `ALLOWED_ORIGIN` | Exact browser origin; default `https://selfsufficient717-creator.github.io`, without `/lexicalarchive/` |
| `LEXICAL_TEXT_MODEL` | Optional text model; defaults to `gpt-4o-mini` |
| `LEXICAL_AUDIO_MODEL` | Optional model supporting WAV `input_audio` and JSON text output; defaults to `gpt-audio` |
| `PORT` | HTTP listen port; defaults to `3000` |

Run `npm start`. Its `--use-env-proxy` flag preserves the managed cloud's inherited proxy routing; keep configured CA trust and TLS verification enabled. The server also serves only the application's public files for local development. It never serves this directory, environment files, SQL, or repository metadata. Set the frontend API base URL to the HTTPS API service origin. For localhost, use `http://localhost:3000` and add the local Auth redirect URL described above. You can use `node --use-env-proxy --env-file=server/.env server/index.js` locally with an ignored file copied from `.env.example`; never commit that file.

Render can use the blueprint [render.yaml](render.yaml) (select `server/render.yaml` as the blueprint path). It includes a paid Starter instance: review the provider's pricing before creating it. Other hosts need only Node 24 and HTTPS. Provider usage also incurs charges. Set spending limits on the provider project. Do not place the AI key in GitHub Pages settings intended for frontend builds.

The cloud environment currently has none of `LEXICAL_AI_API_KEY`, `SUPABASE_URL`, or `SUPABASE_ANON_KEY`. Real provider calls, email delivery, and database policies cannot be verified until those services are provisioned. Mocked tests verify the API contracts and security behavior without sending learner data to a provider. For network-restricted runtimes, permit `api.openai.com` and the exact project's `YOUR_PROJECT.supabase.co` host; do not replace an unknown allowlist.

## API behavior

- `GET /api/health` reports `{ "ok": true, "configured": true|false }`. It checks configuration presence; it does not claim provider or database readiness.
- `POST /api/lexicon` accepts `{ text, context, language }`, requires a confirmed Supabase user bearer token, and returns a validated learning card. Arbitrary words, chunks, idioms and phrases are supported; generated content is automated and can contain errors.
- `POST /api/feedback` accepts `{ itemId, item, mode, prompt, response }` for writing or `{ itemId, item, mode, prompt, audio: { base64, format: "wav" }, durationSeconds }` for speaking. `itemId` must refer to the user's saved item. The saved item, fixed activity prompt and prior attempts are read from the database; submitted prompt/history cannot bypass the revision limit. Returns the feedback object plus `attemptId` and `attemptNumber` after saving.
- Audio must be mono 16-bit PCM at 16 kHz, between 1 and 120 seconds (under 4 MB). The audio model **listens to the recording** to assess fluency and pronunciation, rather than grading a transcript. WAV audio is forwarded to OpenAI only for the assessment, never stored by this app; the resulting transcript and feedback are saved to the user's account. Provider retention follows the provider account's data settings.
- Feedback begins with the overall impression and lists each concrete mistake, why it matters and an improvement. Writing covers ideas, coherence, word choice, naturalness and readability. Speaking covers fluency, organization, lexical item use and pronunciation. Scores are approximate coaching on a 1–5 scale; unassessable criteria use `null` with an explanation. Revisions are explicitly compared with previous attempts.
- Each saved item has one writing and one speaking activity, each allowing an initial response and two revisions. SQL enforces sequential numbering and the cap across reloads and API instances. Assessment failures do not count as attempts. If the client loses the final result, reload history before resubmitting because the database write may have completed.

The server validates bearer tokens through Supabase on every request; a token merely decoding as a JWT is insufficient. It applies exact-origin CORS, body/audio validation, timeouts, 20 requests/minute and 300/day per account, and concurrency limits. A separate process-wide ceiling permits at most 1,200 authentication requests/minute and 100,000/day, because reverse-proxy socket addresses do not reliably identify end users; forwarded IP headers are never blindly trusted. In-memory rate limits are per API process; use a shared rate-limit gateway/store before scaling to multiple instances. Database constraints still enforce the attempt cap globally. CORS supplements authentication; it is not an authorization boundary.

Learner text and audio are sent to the configured model provider for generation/assessment. Do not paste sensitive personal information. This app never claims to verify external facts or provide certified examination scores. The backend uses the public Supabase key with the user's JWT, never bypasses RLS with a service-role credential, and never exposes provider error bodies or tokens.

Run `npm test` for meaningful request validation, mocked audio-provider routing, authentication, revision limits, CORS and secret-file isolation checks. Before real rollout, verify confirmation-email delivery, two-account RLS isolation, avatar restrictions, actual audio-model output, three-attempt persistence, provider billing limits, and browser microphone support on the deployed HTTPS origins.
