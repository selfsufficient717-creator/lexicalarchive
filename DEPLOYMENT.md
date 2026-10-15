# Run Lexical Trove without paid services

The site can stay at https://selfsufficient717-creator.github.io/lexicalarchive/ with the free Render API at https://lexical-trove-api.onrender.com. Keep the Render and Supabase projects on their **Free** plans. No OpenAI credits or key are used by this version.

## Already configured

- Supabase project: `https://xnctcfonfxzqjjronlse.supabase.co`.
- Run `supabase/schema.sql` once in that project. The existing schema works for dictionary cards and coaching metadata; this update needs no new migration.
- Supabase Site URL and allowed redirect URL: `https://selfsufficient717-creator.github.io/lexicalarchive/`.
- GitHub Pages: `main` branch, repository root.
- Render: Node 24, `lexical-trove` branch, empty root directory, build `node --version`, start `npm start`, **Free** instance. The supplied `server/render.yaml` now also selects Free.

Required Render variables:

| Name | Value |
| --- | --- |
| `NODE_VERSION` | `24.19.0` or compatible Node 24 release |
| `SUPABASE_URL` | `https://xnctcfonfxzqjjronlse.supabase.co` |
| `SUPABASE_ANON_KEY` | Your existing public Supabase publishable/anon key |
| `ALLOWED_ORIGIN` | `https://selfsufficient717-creator.github.io` (no path) |

Render supplies `PORT`. Remove the old `LEXICAL_AI_API_KEY`, `LEXICAL_TEXT_MODEL`, and `LEXICAL_AUDIO_MODEL` variables if present. This version ignores them, even if they remain. No Supabase service-role key is used.

## Optional richer AI with Gemini's free tier

1. Open https://aistudio.google.com/api-keys and sign in with Google.
2. Create an API key in a project on the **Free** tier. Check its tier before using it. **Keep billing disabled and do not link a billing account.** Quotas apply and the model must be available in your region.
3. Enter the key directly in Render's environment settings as `LEXICAL_GEMINI_API_KEY`; never paste it in chat, GitHub, or a screenshot.
4. After confirming the project is on the free tier with billing disabled, add `GEMINI_FREE_TIER` with value `true`, then save and redeploy.

Both the key and explicit flag are required. Without either, the app uses dictionaries and basic coaching. The adapter pins Gemini 2.5 Flash rather than accepting arbitrary model overrides. Current availability and free limits are described by Google's [pricing](https://ai.google.dev/gemini-api/docs/pricing) and [rate-limit](https://ai.google.dev/gemini-api/docs/rate-limits) documentation.

The server cannot determine a Google project's billing status from an API key. `GEMINI_FREE_TIER=true` is the owner's acknowledgment, not a billing-enforcement mechanism. Keeping Google billing disabled prevents falling into paid API usage. Do not enable billing to work around a quota error: the app falls back to the keyless workflow.

Gemini uses the actual WAV recording for speaking feedback. Its output is approximate coaching, not an official exam score. Free-service data terms may allow Google to use submitted content to improve products; review [Gemini API terms](https://ai.google.dev/gemini-api/terms) and avoid sensitive material.

## What works without Gemini

- English word definitions from Free Dictionary API; full phrase/idiom entries from Wiktionary when available.
- Optional translations through MyMemory, with limits. English target requires no translation call. Unsupported languages or quota failures produce a note and preserve the card.
- Actual source examples and relations; no fabricated examples or antonyms. If an entry is missing, the learner can add its meaning and example manually.
- Matching, recall, spaced review, and gaps from real examples or the learner's pasted passages. Dictionary coverage does not guarantee every item has every exercise type.
- Recording, playback, an optional corrected transcript, basic coaching, and both revisions. Basic coaching explicitly leaves examiner criteria ungraded and cannot assess pronunciation or nuanced ideas.

Source documentation: [Free Dictionary API](https://github.com/meetDeveloper/freeDictionaryAPI), [Wiktionary](https://en.wiktionary.org/), [MyMemory](https://mymemory.translated.net/doc/spec.php). Source license attribution is retained on cards. Translation sends only the expression; dictionary requests likewise never include the learner's passage or performance.

## Free hosting and email limits

Free Render instances may sleep and need time to wake. Supabase's free project has storage/usage limits and can pause inactive projects. Stay on free plans and do not enable automatic paid upgrades.

Passwordless email registration remains supported. Supabase's default test mailer restricts recipients/rate and is not unrestricted public SMTP. For public registration, configure a mail provider with a free SMTP allowance and verify its sender. For initial testing, use an address permitted by Supabase's test mailer. Review any provider's current free allowance; do not pick a paid plan to follow this guide.

## Development and verification

Run `npm start` and `npm test` from the repository root with Node 24+. The startup command preserves inherited proxy and TLS trust. In a restricted cloud environment, permit the exact API/Supabase hosts plus `api.dictionaryapi.dev`, `en.wiktionary.org`, and `api.mymemory.translated.net`; optional Gemini needs `generativelanguage.googleapis.com`. Draft saves do not apply those network changes automatically.

The public config sends normal website requests to the deployed Render API. For live local API development, use a local public-config override and permitted local Supabase redirect rather than changing the deployed site's secret settings.

After deployment:

1. Sign in by email and check saved collection restoration.
2. Paste an English word such as **important**; check definition, attribution, example availability, and translation notes.
3. Test a complete idiom, then an expression missing from dictionaries and its manual-entry route.
4. Paste a real 80+ word source passage containing the expression and check long-gap practice.
5. Submit writing and recorded speaking through all three attempts. With no Gemini, confirm feedback is labeled basic coaching, pronunciation is ungraded, and corrections cite only observed patterns.
6. If free Gemini is configured, test an arbitrary phrase, generated exercises, actual audio feedback, and a quota outage that returns a clearly labeled fallback.
7. Check profile photo ownership and second-account privacy. Do not describe mocked test results as live provider verification.

## Lookup troubleshooting

Capitalized words and phrases are checked with their original spelling first, then their complete lowercase spelling. Exact entries take priority; a lowercase fallback is explicitly labeled. Case-sensitive meanings and their cached translations stay separate. A failed provider is reported as unavailable rather than evidence that a word does not exist.

Open `https://lexical-trove-api.onrender.com/api/health` to inspect the safe `gemini` flags. `keyPresent:false` means the Render key variable is missing/blank; `freeTierConfirmed:false` means its explicit free-tier flag is not set to `true`; `enabled:true` only means those settings are present, not that the key/model/quota works. Never send the actual key. Render logs use the safe `gemini_fallback` event and a category for quota, permissions, missing model, or invalid response. If dictionaries also fail, the app preserves the AI fallback reason.
