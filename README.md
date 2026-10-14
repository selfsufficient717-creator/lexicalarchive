# Lexical Archive

A responsive word collection with search, category filters, random discovery, and favorites saved in the browser. Definitions and examples are curated editorial descriptions. No account, API key, or dependencies are required.

## Run locally

From this directory:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

Open http://localhost:8000 on your own machine. Managed onboarding does not expose localhost previews.

## Publish a website

Commit these files and push them to GitHub. In the repository settings, choose **Pages → Deploy from a branch**, select your published branch and **/ (root)**, then save. GitHub provides the public website address after deployment. Availability depends on repository visibility and your GitHub plan.

## Content

Edit the word entries in `app.js`. Favorites are stored on the current browser only.
