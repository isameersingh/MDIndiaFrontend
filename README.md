# MD India Insurance AI — Frontend

A static, no-build-step chat UI for the MD India tariff-card / insurance AI
assistant. It streams answers from a backend API over SSE and renders every
tariff figure with a clickable, numbered citation that opens a source-page
viewer (`citation-viewer.js`) showing exactly which page/table/paragraph the
figure came from.

This repo is **frontend only** — plain HTML/CSS/JS, no npm install, no build
step. It talks to a separate backend API (the "MDIndiaChatBot" service) that
is **not** part of this repo and must be running for the chat to work.

```
index.html            app shell markup (sidebar, chat, citation-viewer drawer)
style.css              all styling
app.js                 chat/thread logic, SSE streaming, markdown rendering
citation-viewer.js     reusable CitationViewer component (source page + bbox viewer)
env.example.js         environment config template (kept in sync with env.js)
env.js                 active environment config — committed; see note below
logo/                  MD India logo asset
```

## Prerequisites

- Any modern browser (Chrome, Edge, Safari, Firefox).
- A way to serve static files over `http://` (opening `index.html` directly
  via `file://` will break the SSE fetch calls due to CORS — always serve it).
- The backend API running (see **Backend** below). Without it the app still
  loads, but the sidebar status will show **"API Offline"** and sending a
  message will fail.
- A one-time `env.js` setup (see **Environment configuration** below) —
  without it the app falls back to `http://localhost:8000`.

No Node/npm/Python packages need to be installed for the frontend itself.

## Environment configuration

This is a build-step-free static site, so a real `.env` file can't be read
by the browser. `env.js` is the static-site equivalent: a plain JS file,
loaded by `index.html` before `app.js`/`citation-viewer.js`, that sets
`window.ENV`. Every backend URL used anywhere in the app (health checks,
chat streaming, the citation viewer's `/pdf-page-image` calls, and the
"API Docs" link in the sidebar) is derived from this one file.

**One-time setup:**

```bash
cp env.example.js env.js
```

Then edit `env.js`:

```js
window.ENV = {
  ENV_NAME: 'local',                   // shown in the sidebar footer
  API_BASE: 'http://localhost:8000',   // ← the only line you usually need to change
  API_DOCS_URL: null,                  // override if docs aren't at `${API_BASE}/docs`
  API_KEY: '',                         // Authorization: Bearer <key>, if the backend requires auth
};
```

`env.js` **is committed to this repo** (unlike a typical `.env`, which is
usually git-ignored) — it currently holds no real secret (`API_KEY` is
empty), so there's nothing sensitive to leak today. If you ever put a real
production API key into `API_KEY`, treat that commit as sensitive (rotate
the key if the repo/branch is ever made public, and consider moving to a
git-ignored key file at that point instead of editing this guidance after
the fact).

**Switching environments** is then just editing `API_BASE` (and `API_KEY`
if the target backend has auth enabled) in `env.js` and committing the
change like any other code update:

```js
// Local development
API_BASE: 'http://localhost:8000',

// Pointed at the client/prod server (see FRONTEND_INTEGRATION_GUIDE.md §2.1
// in the backend repo for the real reachable hostname once one exists)
API_BASE: 'http://10.14.31.133:30085',
API_KEY:  'your-prod-api-key',
```

No other file needs to change — reload the page and the sidebar's
connectivity badge, the "API Docs" link, and every API call all follow the
new value automatically.

## Running the frontend

Pick any static file server. From this folder:

```bash
# Option A — Python (built in on macOS/Linux)
python3 -m http.server 5500

# Option B — Node, if you have it
npx serve -l 5500

# Option C — VS Code / Cursor "Live Server" extension
# Right-click index.html → "Open with Live Server"
```

Then open:

```
http://localhost:5500
```

## Backend

The UI expects a backend API exposing these endpoints:

| Method | Endpoint                                      | Purpose                                              |
|--------|------------------------------------------------|-------------------------------------------------------|
| GET    | `/health`                                       | Health check — powers the sidebar status dot          |
| POST   | `/threads/new`                                  | Creates a new conversation thread, returns `thread_id` |
| POST   | `/chat`                                         | `{ message, thread_id }` → **SSE stream** of tokens, thinking text, tool calls, a final `citations` array, and a `done` event |
| GET    | `/pdf-page-image?pdf_path=...&page=...`         | Returns a rasterized image of a source PDF page (used by `citation-viewer.js` to render the page + bbox overlay) |

The documented default port is **`8000`**. Start the backend (its own
repo/instructions — look for `MDIndiaChatBot` / `src/api.py`), then confirm
it's reachable at whichever `API_BASE` you set in `env.js`:

```bash
curl http://localhost:8000/health
```

> **Note:** on this machine port `8000` is occupied by an unrelated local
> project, so the active `env.js` here points at `8001` instead — check
> `API_BASE` in your own `env.js` before you start the backend, or just
> match whichever port you run it on. See **Environment configuration**
> above to change it.

The backend also serves interactive API docs (Swagger UI / ReDoc) at
`${API_BASE}/docs` and `${API_BASE}/redoc` — the sidebar's "API Docs" link
opens whichever one `env.js` currently points at.

## Citation data contract

Each item in the `citations` array sent by the backend (as part of the SSE
`citations` event) is expected to look like:

```json
{
  "id": 1,
  "hospital": "Swami Sarvanand Hospital",
  "insurance": "PPN",
  "city": "Unknown",
  "state": "Unknown",
  "page": 7,
  "page_width": 791,
  "page_height": 1023,
  "pdf_path": "ocrdata/PPN/150249836_....pdf",
  "source_json": "ocrdata/PPN/150249836_....json",
  "block_type": "table",
  "table_id": "tbl-6.md",
  "bbox": { "x1": 0.1466, "y1": 0.0577, "x2": 0.8167, "y2": 0.8240 },
  "snippet": "preview text of the matched row/paragraph",
  "verified": null
}
```

`CitationViewer` (in `citation-viewer.js`) normalizes this shape, so missing
fields degrade gracefully (empty `pdf_path` → "Source page image
unavailable" placeholder, `verified: null` → no badge shown).

## Troubleshooting

- **Sidebar shows "API Offline"** — the backend isn't running or isn't on
  the port set in `API_BASE`. Check with `curl http://localhost:<port>/health`.
- **Chat sends but nothing streams back** — open the browser DevTools
  Network tab and check the `/chat` request; CORS errors usually mean the
  backend needs to allow your frontend's origin.
- **Citation click shows "Source page image unavailable"** — expected
  when `pdf_path` is empty for that citation; the metadata sidebar and
  matched snippet are still shown.
- **Conversation history disappears** — history is stored in
  `localStorage` under the key `mdindia_threads` (per browser/profile), not
  on the backend.
