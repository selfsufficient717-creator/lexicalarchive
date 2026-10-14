# Connect Lexical Trove and publish it

The existing GitHub Pages URL remains the frontend address. GitHub Pages cannot run the private AI service. Set up a Supabase project and deploy the Node service once; learners then need only an email confirmation link.

## 1. Create the Supabase project

1. Open https://supabase.com/dashboard and create a project. Keep its database password private.
2. Open **SQL Editor**, paste the complete contents of `supabase/schema.sql`, and run it. This creates account profiles, private collections, assessment history, and an avatars bucket. If you already have similarly named tables or an avatars bucket, review the schema first instead of applying it blindly.
3. From the project's **Connect** / API settings, copy the **project URL** (`https://…supabase.co`) and **publishable key** or legacy **anon** key. These are public connection settings. Do not use the secret or service-role key.
4. Under **Authentication → URL Configuration**, set the site URL and allowed redirect URL to:
   `https://selfsufficient717-creator.github.io/lexicalarchive/`
   For local development, optionally allow `http://localhost:3000/`.
5. Enable email sign-in and email confirmations. The app requests a passwordless email link with automatic account creation. Test a new account and repeat sign-in.
6. Configure production SMTP under Supabase authentication email settings. The default test mailer can restrict recipients and volume; it is not sufficient for unrestricted public registration. Use your preferred supported mail provider's SMTP settings inside Supabase, never in the frontend.

The SQL policies keep each learner's collection and responses private, cap attempts at three in sequence, and restrict picture uploads to the user's own directory. Profile pictures are intentionally public. The app accepts JPEG, PNG, and WebP up to 2 MB.

## 2. Connect OpenAI to the backend

1. Create a project at https://platform.openai.com/ and enable API billing. ChatGPT subscriptions do not include API usage.
2. Create a project API key. Store it as **LEXICAL_AI_API_KEY** in your hosting service's secret environment settings. Never put it in `config.js`, GitHub files, a screenshot, or chat.
3. Set a project spending limit and alerts appropriate for your expected traffic. The app also limits authenticated requests, but in-memory rate limiting is not a billing cap.
4. The default text model is `gpt-4o-mini`. Speaking uses `gpt-audio` and submits the actual WAV recording. Confirm your project can access both models. Compatible replacements can be set with `LEXICAL_TEXT_MODEL` / `LEXICAL_AUDIO_MODEL`; a transcript-only model cannot assess pronunciation.

## 3. Deploy the Node API

Render is one supported option; another Node 24 host with HTTPS and sufficient request timeouts can work.

1. Connect this GitHub repository to https://dashboard.render.com/ and create a **Web Service**. Choose the branch containing this version. Use repository root as the working directory, `node --version` as the build command, and `npm start` as the start command. A blueprint is supplied at `server/render.yaml` for review; it selects a paid always-on instance, so do not accept a plan without reviewing its price.
2. Set these environment variables in the web service:

   | Name | Value |
   | --- | --- |
   | `NODE_VERSION` | `24.19.0` or a compatible Node 24 release |
   | `SUPABASE_URL` | Your Supabase HTTPS project URL |
   | `SUPABASE_ANON_KEY` | Your public publishable/anon key |
   | `LEXICAL_AI_API_KEY` | The OpenAI key, entered securely |
   | `ALLOWED_ORIGIN` | `https://selfsufficient717-creator.github.io` (without `/lexicalarchive/`) |
   | `LEXICAL_TEXT_MODEL` | `gpt-4o-mini` |
   | `LEXICAL_AUDIO_MODEL` | `gpt-audio` |

   The host supplies `PORT`. Leave provider keys on the server. No Supabase service-role key is required.
3. Deploy. Copy the service's HTTPS URL and request `/api/health`. You should see `{"ok":true,"configured":true}`. This checks configuration presence only.
4. For a local cloud test, set the same values through secure environment settings. Existing session proxy/CA settings must be retained. `npm start` enables Node's environment-proxy support. Add `api.openai.com` and your exact Supabase hostname to the managed environment's network settings if needed. Hosting outside this environment uses that host's networking, not these draft settings.

## 4. Connect the frontend

Set only these public fields in `config.js`:

```js
export const CONFIG = Object.freeze({
  apiBaseUrl: 'https://YOUR-SERVICE.onrender.com',
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-PUBLIC-PUBLISHABLE-OR-ANON-KEY',
});
```

Do not paste an OpenAI or service-role key here. The frontend verifies an email session before using private data and sends its access token to the API.

Commit the public configuration with the tested app files to the `main` branch used by GitHub Pages. Keep Pages configured for **Deploy from a branch → main → / (root)**. Wait for the Pages action to finish.

## 5. Check the live app before sharing it

- Request an email link for a new address, confirm it, and verify that signing out and signing back in restores the collection.
- Choose a translation language and paste **ceasefire**. Check the definition, translation, example sentences, and available exercises.
- Paste **read between the lines** with a source sentence. Check that it is treated as an expression and has a contextual explanation. Try another expression not mentioned anywhere in this repository.
- Collect two or more items and test matching meanings, synonyms, and valid antonyms. Check that expressions without opposites do not gain fake ones.
- Complete a written response, then both revisions. Read the overall impression and each mistake/why/improvement. Reload to confirm history and the three-attempt cap.
- Allow the microphone, record, listen back, then submit a spoken response. Verify the transcript and audio-based feedback, then do both revisions. Try a declined microphone permission too.
- Upload a profile photo. Check on a second account that vocabulary and feedback from the first account cannot be read.
- Check mobile layout, expired sign-in recovery, and a provider outage. Errors must remain visible and unsuccessful assessments must not consume an attempt.

Do not describe the app as fully connected until these checks pass. Automated tests use controlled service doubles and do not establish live account/email, AI quality, or database-policy readiness.
