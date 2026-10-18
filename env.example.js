/**
 * env.example.js — environment configuration TEMPLATE
 * ────────────────────────────────────────────────────────────────────────────
 * This is a build-step-free static site (no webpack/vite, no npm install),
 * so a real `.env` file can't be parsed by the browser. This file is the
 * static-site equivalent: a plain JS file, loaded via a <script> tag before
 * app.js / citation-viewer.js, that sets window.ENV with everything that
 * differs between environments.
 *
 * SETUP (one-time, per machine/deployment):
 *   1. Copy this file to `env.js`               cp env.example.js env.js
 *   2. Edit the values in `env.js` below.
 *   3. `env.js` IS committed to this repo (unlike a typical `.env` file) —
 *      switching environments means editing `env.js` directly and
 *      committing that change. There's no real secret in it today
 *      (API_KEY defaults to ''), but if you ever put a live production key
 *      in there, treat that commit as sensitive and rotate the key if the
 *      repo is ever made public.
 *
 * Everything that talks to the backend (health checks, chat streaming, the
 * citation viewer's /pdf-page-image calls, and the "API Docs" link in the
 * sidebar) is derived from API_BASE below — so switching environments is a
 * one-line change in a single file, with no other code edits required.
 */
window.ENV = {
  // Short label shown in the UI (sidebar footer) so it's obvious at a
  // glance which backend you're pointed at. Purely cosmetic.
  ENV_NAME: 'local',

  // Base URL of the backend API for this environment. Every fetch() call
  // in app.js and citation-viewer.js is built from this value.
  //   Local development : 'http://localhost:8000'  (or 8001, see README)
  //   Client/prod server: 'http://10.14.31.133:30085'  (or your real domain)
  API_BASE: 'http://localhost:8000',

  // Optional: override the Swagger/OpenAPI docs URL if it isn't simply
  // `${API_BASE}/docs` (e.g. docs are hosted at a different path/host
  // behind a gateway). Leave null to default to `${API_BASE}/docs`.
  API_DOCS_URL: null,

  // Optional: API key sent as `Authorization: Bearer <key>` on every
  // request except /health, required once the backend has
  // API_AUTH_ENABLED=true (see FRONTEND_INTEGRATION_GUIDE.md §3). Leave
  // empty for a local backend running with auth disabled.
  API_KEY: '',
};
