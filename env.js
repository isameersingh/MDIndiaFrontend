/**
 * env.js — active environment configuration (committed to this repo)
 * ────────────────────────────────────────────────────────────────────────────
 * See env.example.js for the full explanation of every field. Edit API_BASE
 * below to switch between local/staging/prod; nothing else in the codebase
 * needs to change. This file is tracked in git, so changing environments
 * means committing the edit — don't put a real production API_KEY here
 * without treating that commit as sensitive.
 */
window.ENV = {
  ENV_NAME: 'prod',

  // Port 8000 (the documented default) is occupied on this machine by an
  // unrelated project — the MD India backend is currently running on 8001.
  // Change this back to 8000 (or to a staging/prod URL) as needed.
  API_BASE: 'http://10.14.31.134:30080',

  API_DOCS_URL: null,
  API_KEY: '',
};
