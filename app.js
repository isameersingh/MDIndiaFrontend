/**
 * app.js — MD India Insurance AI Frontend
 *
 * Handles:
 *  - API health check and status indicator
 *  - Thread management (create, switch, delete)
 *  - Conversation history persistence in localStorage
 *  - SSE streaming from POST /chat
 *  - Live agent thinking panel (tool_start / tool_end events)
 *  - Token streaming with animated cursor
 *  - Markdown rendering (tables, bold, code, lists)
 *  - Auto-resize textarea
 *  - Sidebar toggle (desktop collapse + mobile overlay)
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────
// Everything environment-specific (which backend to talk to) lives in
// window.ENV, set by env.js — a small file (committed to this repo) loaded
// via a <script> tag before this one (see index.html + env.example.js +
// README.md "Environment configuration"). This is the static-site
// equivalent of a `.env` file: there's no build step here to read a real
// .env, so flipping between local/staging/prod is a one-line edit (+
// commit) to env.js instead of a code change in app.js.
//
// Falls back to localhost:8000 (the documented default) if env.js wasn't
// found/loaded, so the app still boots (with an obvious "API Offline"
// status) rather than throwing on a missing global.
const ENV = window.ENV || {};
const API_BASE = ENV.API_BASE || 'http://localhost:8000';
const API_KEY = ENV.API_KEY || '';
const ENV_NAME = ENV.ENV_NAME || 'local';
const API_DOCS_URL = ENV.API_DOCS_URL || `${API_BASE}/docs`;

// Exposed on window so other classic (non-module) scripts, like
// citation-viewer.js, can build API URLs (e.g. the /pdf-page-image
// endpoint) without duplicating this constant.
window.API_BASE = API_BASE;
window.API_KEY = API_KEY;

const STORAGE_KEY = 'mdindia_threads';
const MAX_HISTORY = 50;

// ─── State ────────────────────────────────────────────────────────────────────
let currentThreadId = null;
let isStreaming = false;
let threads = [];        // [{ id, title, messages: [], createdAt }]

// ─── DOM References ───────────────────────────────────────────────────────────
const sidebar          = document.getElementById('sidebar');
const sidebarToggle    = document.getElementById('sidebarToggle');
const mobileMenuBtn    = document.getElementById('mobileMenuBtn');
const sidebarOverlay   = document.getElementById('sidebarOverlay');
const newChatBtn       = document.getElementById('newChatBtn');
const searchInput      = document.getElementById('searchInput');
const historyList      = document.getElementById('historyList');
const historyEmpty     = document.getElementById('historyEmpty');
const messagesArea     = document.getElementById('messagesArea');
const welcomeScreen    = document.getElementById('welcomeScreen');
const chatMessages     = document.getElementById('chatMessages');
const messageInput     = document.getElementById('messageInput');
const sendBtn          = document.getElementById('sendBtn');
const statusDot        = document.getElementById('statusDot');
const statusText       = document.getElementById('statusText');
const apiEnvBadge      = document.getElementById('apiEnvBadge');
const apiDocsLink      = document.getElementById('apiDocsLink');

// Reflect the active environment (env.js) in the sidebar footer — the
// badge text and the Swagger/OpenAPI docs link both follow API_BASE
// automatically, so switching env.js is the only change needed to point
// the whole UI at local/staging/prod.
if (apiEnvBadge) apiEnvBadge.textContent = ENV_NAME;
if (apiDocsLink) {
  apiDocsLink.href = API_DOCS_URL;
  apiDocsLink.title = `Open Swagger UI for ${API_BASE}`;
}

// Merge the configured API key (env.js → API_KEY) into fetch options as
// an Authorization header. No-op (returns options unchanged) when no key
// is set, which is the normal case for a local backend running with
// API_AUTH_ENABLED=false. See FRONTEND_INTEGRATION_GUIDE.md §3.
function withAuth(options = {}) {
  if (!API_KEY) return options;
  return {
    ...options,
    headers: { ...(options.headers || {}), 'Authorization': `Bearer ${API_KEY}` },
  };
}

// ─── API Health Check ─────────────────────────────────────────────────────────
async function checkHealth() {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Connecting...';
  try {
    const res = await fetch(`${API_BASE}/health`, withAuth({ signal: AbortSignal.timeout(5000) }));
    const data = await res.json();
    if (data.status === 'ok') {
      statusDot.className = 'status-dot online';
      const insurers = (data.insurers && data.insurers.length > 0)
        ? data.insurers.join(', ')
        : 'API';
      statusText.textContent = `Connected · ${insurers}`;
    } else {
      throw new Error('not ready');
    }
  } catch {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'API Offline';
  }
}

// ─── Thread Management ────────────────────────────────────────────────────────
function loadThreads() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    threads = raw ? JSON.parse(raw) : [];
  } catch { threads = []; }
}

function saveThreads() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(threads.slice(0, MAX_HISTORY)));
}

function findThread(id) {
  return threads.find(t => t.id === id);
}

async function createNewThread() {
  try {
    const res = await fetch(`${API_BASE}/threads/new`, withAuth({ method: 'POST' }));
    const data = await res.json();
    return data.thread_id;
  } catch {
    // Fallback: generate UUID locally if API is down
    return 'local-' + crypto.randomUUID();
  }
}

async function startNewChat() {
  const threadId = await createNewThread();
  const thread = {
    id: threadId,
    title: 'New conversation',
    messages: [],
    createdAt: Date.now()
  };
  threads.unshift(thread);
  saveThreads();
  switchThread(threadId);
}

function switchThread(threadId) {
  currentThreadId = threadId;

  // Mark active in sidebar
  document.querySelectorAll('.history-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === threadId);
  });

  // Render messages
  const thread = findThread(threadId);
  chatMessages.innerHTML = '';

  if (!thread || thread.messages.length === 0) {
    showWelcome(true);
  } else {
    showWelcome(false);
    thread.messages.forEach(m => {
      if (m.role === 'user') appendUserMessage(m.content, false);
      else if (m.role === 'assistant') appendAssistantMessage(m.content, m.citations, false);
    });
    scrollToBottom();
  }
}

function deleteThread(threadId) {
  threads = threads.filter(t => t.id !== threadId);
  saveThreads();
  renderHistory();
  if (currentThreadId === threadId) {
    if (threads.length > 0) switchThread(threads[0].id);
    else {
      currentThreadId = null;
      chatMessages.innerHTML = '';
      showWelcome(true);
    }
  }
}

function updateThreadTitle(threadId, firstMessage) {
  const thread = findThread(threadId);
  if (!thread) return;
  // Truncate to ~50 chars for sidebar title
  thread.title = firstMessage.slice(0, 60).replace(/\n/g, ' ');
  saveThreads();
  renderHistory();
}

// ─── History Sidebar ──────────────────────────────────────────────────────────
function renderHistory(filter = '') {
  historyList.innerHTML = '';
  const filtered = threads.filter(t =>
    !filter || t.title.toLowerCase().includes(filter.toLowerCase())
  );

  historyEmpty.style.display = filtered.length === 0 ? 'flex' : 'none';

  // Group by date
  const now = Date.now();
  const today = [];
  const week  = [];
  const older = [];

  filtered.forEach(t => {
    const age = now - t.createdAt;
    if (age < 86400000) today.push(t);
    else if (age < 604800000) week.push(t);
    else older.push(t);
  });

  const renderGroup = (label, items) => {
    if (!items.length) return;
    const labelEl = document.createElement('div');
    labelEl.className = 'history-section-label';
    labelEl.textContent = label;
    historyList.appendChild(labelEl);
    items.forEach(t => historyList.appendChild(createHistoryItem(t)));
  };

  renderGroup('Today', today);
  renderGroup('Previous 7 Days', week);
  renderGroup('Older', older);
}

function createHistoryItem(thread) {
  const el = document.createElement('div');
  el.className = 'history-item' + (thread.id === currentThreadId ? ' active' : '');
  el.dataset.id = thread.id;

  el.innerHTML = `
    <span class="history-item-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </span>
    <span class="history-item-text" title="${escapeHtml(thread.title)}">${escapeHtml(thread.title)}</span>
    <button class="history-item-delete" title="Delete conversation" aria-label="Delete conversation">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
      </svg>
    </button>`;

  el.addEventListener('click', e => {
    if (!e.target.closest('.history-item-delete')) switchThread(thread.id);
  });
  el.querySelector('.history-item-delete').addEventListener('click', e => {
    e.stopPropagation();
    deleteThread(thread.id);
  });
  return el;
}

// ─── Welcome / Chat Toggle ────────────────────────────────────────────────────
function showWelcome(show) {
  welcomeScreen.style.display = show ? 'flex' : 'none';
}

// ─── Message Rendering ────────────────────────────────────────────────────────
function appendUserMessage(text, save = true) {
  showWelcome(false);

  const row = document.createElement('div');
  row.className = 'message-row user';
  row.innerHTML = `
    <div class="bubble">
      <div class="message-content">${escapeHtml(text)}</div>
    </div>
    <div class="avatar user">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
      </svg>
    </div>`;
  chatMessages.appendChild(row);
  scrollToBottom();

  if (save && currentThreadId) {
    const thread = findThread(currentThreadId);
    if (thread) {
      thread.messages.push({ role: 'user', content: text });
      if (thread.messages.length === 1) updateThreadTitle(currentThreadId, text);
      else saveThreads();
    }
  }
}

function appendAssistantMessage(text, citations = [], save = true) {
  const row = createAssistantRow(text, citations);
  chatMessages.appendChild(row);
  scrollToBottom();

  if (save && currentThreadId) {
    const thread = findThread(currentThreadId);
    if (thread) {
      thread.messages.push({ role: 'assistant', content: text, citations });
      saveThreads();
    }
  }
  return row;
}

function createAssistantRow(text, citations = []) {
  const row = document.createElement('div');
  row.className = 'message-row assistant';

  const avatarHtml = `
    <div class="avatar ai">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>
    </div>`;

  row.innerHTML = `
    ${avatarHtml}
    <div style="flex:1;min-width:0;">
      <div class="bubble">
        <div class="message-content"></div>
        <div class="message-actions">
          <button class="action-btn copy-btn" title="Copy">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy
          </button>
        </div>
      </div>
    </div>`;

  // Render markdown into content div, then inject citation chips
  const contentEl = row.querySelector('.message-content');
  const bubble = row.querySelector('.bubble');
  contentEl.innerHTML = renderMarkdown(text);
  if (citations && citations.length > 0) {
    // Inline [N] chips only — no separate "Sources" summary row. The chips
    // themselves stay clickable (registerCitations wires up the click/hover
    // viewer), so every citation is still reachable, just not duplicated in
    // a footer list.
    CitationViewer.registerCitations(bubble, citations);
    CitationViewer.injectInlineMarkers(contentEl, citations);
  }

  // Copy handler
  row.querySelector('.copy-btn').addEventListener('click', function () {
    navigator.clipboard.writeText(text).then(() => {
      this.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      setTimeout(() => {
        this.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 2000);
    });
  });

  return row;
}

function buildThinkingPanel(steps) {
  if (!steps || steps.length === 0) return '';
  const stepsHtml = steps.map(s => `
    <div class="thinking-step">
      <span class="step-icon">${s.icon}</span>
      <div class="step-content">
        <div class="step-label">${escapeHtml(s.label)}</div>
        ${s.args ? `<div class="step-args">${escapeHtml(s.args)}</div>` : ''}
      </div>
    </div>`).join('');

  return `
    <div class="thinking-panel">
      <div class="thinking-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
        </svg>
        Thought for ${steps.length} step${steps.length > 1 ? 's' : ''}
        <svg class="thinking-chevron open" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <polyline points="18 15 12 9 6 15"/>
        </svg>
      </div>
      <div class="thinking-steps">${stepsHtml}</div>
    </div>`;
}

// ─── Streaming ────────────────────────────────────────────────────────────────
async function sendMessage(text) {
  if (isStreaming || !text.trim()) return;

  // Ensure we have an active thread
  if (!currentThreadId) {
    await startNewChat();
  }

  isStreaming = true;
  setSendLoading(true);

  appendUserMessage(text);
  messageInput.value = '';
  autoResizeTextarea();

  // Create an "in-progress" assistant row (typing indicator until first token)
  let fullText             = '';
  let accumulatedCitations = [];
  let accumulatedChart     = null;

  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.innerHTML = `
    <div class="avatar ai">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>
    </div>
    <div style="flex:1;min-width:0;" id="streamingContent">
      <div class="bubble" id="streamingBubble">
        <div class="typing-indicator">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>
      </div>
    </div>`;
  chatMessages.appendChild(row);
  scrollToBottom();

  const streamingContent = row.querySelector('#streamingContent');
  const streamingBubble  = row.querySelector('#streamingBubble');
  let thinkingPanelEl    = null;
  let contentEl          = null;
  let hasStartedStreaming = false;

  function ensureContentEl() {
    if (!contentEl) {
      streamingBubble.innerHTML = '';
      const msgContent = document.createElement('div');
      msgContent.className = 'message-content';
      streamingBubble.appendChild(msgContent);
      contentEl = msgContent;
    }
  }

  // ── Thinking panel (streams Gemini model reasoning text) ────────────
  let thinkingText         = '';
  let thinkingStartTime    = 0;
  let thinkingTimerInterval= null;
  let thinkingBodyEl       = null;
  let thinkingProseEl      = null;
  let thinkingCursorEl     = null;
  let toolTimelineEl       = null;
  let thinkingFinalized    = false;

  const TOOL_LABELS = {
    search_tariff_cards:  'Searching tariff cards',
    compare_hospitals:    'Comparing hospitals',
    compare_insurers:     'Comparing insurers',
    get_page_content:     'Fetching page',
    aggregate_collection: 'Aggregating data',
    list_metadata_values: 'Listing values',
  };

  function ensureThinkingPanel() {
    if (thinkingPanelEl) return;
    thinkingStartTime = Date.now();
    thinkingFinalized = false;

    thinkingPanelEl = document.createElement('div');
    thinkingPanelEl.className = 'thinking-panel';
    thinkingPanelEl.innerHTML = `
      <div class="thinking-header" id="thinkingToggle">
        <span class="thinking-spinner" id="thinkingSpinner" aria-hidden="true"></span>
        <span class="thinking-title" id="thinkingLabel">Thinking…</span>
        <svg class="thinking-chevron open" id="thinkingChevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <polyline points="18 15 12 9 6 15"/>
        </svg>
      </div>
      <div class="thinking-body" id="thinkingBody">
        <div class="tool-timeline" id="toolTimeline"></div>
        <div class="thinking-prose" id="thinkingProse"></div>
      </div>`;

    streamingContent.insertBefore(thinkingPanelEl, streamingBubble);
    thinkingBodyEl   = thinkingPanelEl.querySelector('#thinkingBody');
    thinkingProseEl  = thinkingPanelEl.querySelector('#thinkingProse');
    toolTimelineEl   = thinkingPanelEl.querySelector('#toolTimeline');

    // Append blinking cursor to prose
    thinkingCursorEl = document.createElement('span');
    thinkingCursorEl.className = 'thinking-cursor';
    thinkingProseEl.appendChild(thinkingCursorEl);

    // Expand body immediately (open by default while thinking)
    thinkingBodyEl.style.maxHeight = '280px';
    thinkingBodyEl.classList.add('open');

    // Live timer — updates every second
    thinkingTimerInterval = setInterval(() => {
      if (thinkingFinalized) return;
      const secs = Math.floor((Date.now() - thinkingStartTime) / 1000);
      const label = thinkingPanelEl.querySelector('#thinkingLabel');
      if (label) label.textContent = `Thinking for ${secs}s…`;
    }, 1000);

    // Collapse/expand on header click (smooth max-height transition)
    thinkingPanelEl.querySelector('#thinkingToggle').addEventListener('click', () => {
      const body    = thinkingBodyEl;
      const ch      = thinkingPanelEl.querySelector('#thinkingChevron');
      const isOpen  = body.classList.contains('open');
      if (isOpen) {
        body.style.maxHeight = body.scrollHeight + 'px'; // snapshot before collapsing
        requestAnimationFrame(() => {
          body.style.maxHeight = '0';
          body.classList.remove('open');
          ch.classList.remove('open');
        });
      } else {
        body.style.maxHeight = body.scrollHeight + 'px';
        body.classList.add('open');
        ch.classList.add('open');
        // Let CSS transition finish, then switch to auto so content can grow
        body.addEventListener('transitionend', () => {
          if (body.classList.contains('open')) body.style.maxHeight = '280px';
        }, { once: true });
      }
    });
  }

  function appendThinkingText(txt) {
    ensureThinkingPanel();
    thinkingText += txt;
    // Render as prose paragraphs (split on double-newline)
    if (thinkingCursorEl) thinkingCursorEl.remove();
    const paragraphs = thinkingText.split(/\n\n+/).filter(Boolean);
    thinkingProseEl.innerHTML = paragraphs
      .map(p => `<p>${escapeHtml(p.replace(/\n/g, ' '))}</p>`)
      .join('');
    thinkingProseEl.appendChild(thinkingCursorEl);
    // Auto-scroll while streaming
    thinkingBodyEl.scrollTop = thinkingBodyEl.scrollHeight;
  }

  function addToolBadge(toolName, done = false) {
    ensureThinkingPanel();
    const label = TOOL_LABELS[toolName] || toolName.replace(/_/g, ' ');
    const stepId = 'step-' + toolName.replace(/\W/g, '_');
    const existing = toolTimelineEl.querySelector('#' + stepId);
    if (existing) {
      if (done) {
        existing.className = 'timeline-step done';
        existing.querySelector('.step-dot').textContent = '✓';
        existing.querySelector('.step-label').textContent = label;
      }
      return;
    }
    const step = document.createElement('div');
    step.id = stepId;
    step.className = `timeline-step${done ? ' done' : ''}`;
    step.innerHTML = `<span class="step-dot">${done ? '✓' : ''}</span><span class="step-label">${escapeHtml(label)}${done ? '' : '…'}</span>`;
    toolTimelineEl.appendChild(step);
  }

  function finalizeThinkingPanel() {
    if (!thinkingPanelEl || thinkingFinalized) return;
    thinkingFinalized = true;
    // Stop live timer
    if (thinkingTimerInterval) { clearInterval(thinkingTimerInterval); thinkingTimerInterval = null; }
    // Remove blinking cursor
    if (thinkingCursorEl) thinkingCursorEl.remove();
    // Update header: spinner → brain icon, label → "Thought for Xs"
    const secs  = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
    const label = thinkingPanelEl.querySelector('#thinkingLabel');
    if (label) label.textContent = `Thought for ${secs}s`;
    const spinner = thinkingPanelEl.querySelector('#thinkingSpinner');
    if (spinner) {
      spinner.className = 'thinking-brain-icon';
      spinner.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26C17.81 13.47 19 11.38 19 9c0-3.87-3.13-7-7-7z"/><line x1="9" y1="17" x2="9" y2="21"/><line x1="15" y1="17" x2="15" y2="21"/></svg>`;
    }
    // Auto-collapse body (smooth transition)
    if (thinkingBodyEl && thinkingBodyEl.classList.contains('open')) {
      thinkingBodyEl.style.maxHeight = thinkingBodyEl.scrollHeight + 'px';
      requestAnimationFrame(() => {
        thinkingBodyEl.style.maxHeight = '0';
        thinkingBodyEl.classList.remove('open');
        const ch = thinkingPanelEl.querySelector('#thinkingChevron');
        if (ch) ch.classList.remove('open');
      });
    }
  }

  try {
    const response = await fetch(`${API_BASE}/chat`, withAuth({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, thread_id: currentThreadId })
    }));

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = ''; // SSE line buffer (handles cross-chunk JSON)
    let   cursorEl = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); }
        catch (err) {
          console.error('SSE parse error:', err, line.slice(0, 80));
          continue;
        }

        switch (event.type) {

          // ── Model thinking text (Gemini thinking mode) ────────
          case 'thinking_text':
            appendThinkingText(event.text || '');
            scrollToBottom();
            break;

          // ── Agent framework step (suppressed from UI) ─────────
          case 'thinking':
            // Just ensure the panel exists as a container; text comes from thinking_text
            ensureThinkingPanel();
            break;

          // ── Tool being called ─────────────────────────────────
          case 'tool_start':
            addToolBadge(event.tool, false);
            scrollToBottom();
            break;

          // ── Tool finished ─────────────────────────────────────────
          case 'tool_end':
            // event.tool is set for tool_end from our SSE layer
            if (event.tool) addToolBadge(event.tool, true);
            break;

          // ── Answer tokens (stream into contentEl) ─────────────
          case 'token':
            if (!hasStartedStreaming) {
              hasStartedStreaming = true;
              // Auto-collapse thinking panel the moment the answer starts — Claude-style
              finalizeThinkingPanel();
              ensureContentEl();
              cursorEl = document.createElement('span');
              cursorEl.className = 'streaming-cursor';
              contentEl.appendChild(cursorEl);
            }
            fullText += event.text;
            if (cursorEl) cursorEl.remove();
            contentEl.innerHTML = renderMarkdown(fullText);
            cursorEl = document.createElement('span');
            cursorEl.className = 'streaming-cursor';
            contentEl.appendChild(cursorEl);
            scrollToBottom();
            break;

          case 'chart_data':
            accumulatedChart = event;
            break;

          case 'citations':
            accumulatedCitations = event.data || [];
            break;

          case 'done': {
            // Finalize thinking panel
            finalizeThinkingPanel();

            // Remove answer cursor
            if (cursorEl) cursorEl.remove();

            // Render final markdown — then inject citation chips via DOM text-node walk
            if (contentEl) {
              contentEl.innerHTML = renderMarkdown(fullText);
              if (accumulatedCitations.length > 0) {
                CitationViewer.registerCitations(streamingBubble, accumulatedCitations);
                CitationViewer.injectInlineMarkers(contentEl, accumulatedCitations);
              }
            } else {
              // If no tokens were received, ensure we at least show something
              ensureContentEl();
            }

            // Comparison hospital cards
            if (accumulatedChart) {
              const chartEl = renderChart(accumulatedChart);
              if (chartEl) streamingBubble.appendChild(chartEl);
            }

            // Inline [N] chips only — no separate "Sources" summary row
            // (see the identical note in appendMessage() above).

            // Copy button
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            actions.innerHTML = `<button class="action-btn copy-btn">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>Copy</button>`;
            streamingBubble.appendChild(actions);
            actions.querySelector('.copy-btn').addEventListener('click', function () {
              navigator.clipboard.writeText(fullText).then(() => {
                this.textContent = '✓ Copied!';
                setTimeout(() => {
                  this.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy`;
                }, 2000);
              });
            });

            if (currentThreadId) {
              const thread = findThread(currentThreadId);
              if (thread) {
                thread.messages.push({ role: 'assistant', content: fullText, citations: accumulatedCitations });
                saveThreads();
              }
            }
            scrollToBottom();
            break;
          }


          case 'error':
            finalizeThinkingPanel();
            ensureContentEl();
            if (cursorEl) cursorEl.remove();
            streamingBubble.classList.add('error');
            contentEl.textContent = `Error: ${event.message}`;
            break;
        }
      }
    }
  } catch (err) {
    ensureContentEl();
    streamingBubble.classList.add('error');
    contentEl.textContent = `Connection error: ${err.message}. Is the API running?`;
  } finally {
    isStreaming = false;
    setSendLoading(false);
    renderHistory();
  }
}

/**
 * CITATION RULES — STRICTLY MANDATORY:
  - After EVERY specific tariff value, price, or charge you write, you MUST
    immediately append the citation number in brackets, like this: ₹5,000/day [3]
  - The citation number [N] must match the result number from the tool output.
  - In comparison tables, every cell value must have its citation: ₹18,000 [2]
  - If you mention a hospital name with a specific fact, cite it: Apollo Mumbai [1]
  - NEVER write a price or medical charge without [N] immediately after it.
  - Do NOT group all citations at the end — they must appear inline.
  - If data is missing for a cell, write: N/A

GENERAL RULES:
  - Always call at least one tool before answering.
  - Never answer from memory alone.
  - Use ₹ symbol for all Indian Rupee amounts.
  - Be concise after the table. Do not explain what you are about to do — just do it.
 */

/**
 * Render hospital comparison card grid.
 * chart_data = {type, insurance_company, procedure, hospitals: [{name, city, state, ...}]}
 */
function renderChart(chartData) {
  if (!chartData || !chartData.hospitals || !chartData.hospitals.length) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'chart-container';

  const title = chartData.insurance_company
    ? `${chartData.insurance_company}${chartData.procedure ? ' — ' + chartData.procedure : ''}`
    : 'Hospital Comparison';

  wrapper.innerHTML = `
    <div class="chart-header">
      <span class="chart-title">🏥 ${escapeHtml(title)} (${chartData.hospitals.length} hospitals)</span>
    </div>
    <div class="chart-body">
      <div class="hospital-cards-grid" id="hospitalCardsGrid"></div>
    </div>`;

  const grid = wrapper.querySelector('#hospitalCardsGrid');
  chartData.hospitals.forEach((hosp, idx) => {
    const card = document.createElement('div');
    card.className = 'hospital-card';
    card.innerHTML = `
      <div class="hospital-card-num">Hospital ${idx + 1}</div>
      <div class="hospital-card-name">${escapeHtml(hosp.name || 'Unknown')}</div>
      <div class="hospital-card-location">
        ${escapeHtml(hosp.city || '')}${hosp.city && hosp.state ? ', ' : ''}${escapeHtml(hosp.state || '')}
      </div>
      ${hosp.pdf_path ? '<div class="hospital-card-action">📄 View Source</div>' : ''}`;

    if (hosp.pdf_path) {
      card.addEventListener('click', () => CitationViewer.open([{
        id: idx + 1,
        hospital: hosp.name,
        city: hosp.city || '',
        state: hosp.state || '',
        page: 1,
        pdf_path: hosp.pdf_path,
        block_type: 'text',
        bbox: { x1: 0, y1: 0, x2: 1, y2: 1 },
        verified: null,
      }], idx + 1));
    }
    grid.appendChild(card);
  });

  return wrapper;
}

/* ─────────────────────────────────────────────────────────────────────────
   Legacy PDF viewer panel (iframe + OCR text tab) has been replaced by the
   CitationViewer component (citation-viewer.js), which renders source page
   images with bbox-accurate highlight boxes, a metadata sidebar, and
   multi-citation paging. See CitationViewer.open() / registerCitations() /
   injectInlineMarkers() used throughout this file — only inline [N] chips
   are shown (no separate "Sources" footer row); each chip is still fully
   clickable/hoverable via registerCitations().
   ───────────────────────────────────────────────────────────────────────── */

// ─── Markdown Renderer ────────────────────────────────────────────────────────
/**
 * Convert markdown text to HTML.
 *
 * CRITICAL ORDER:
 * 1. Extract table blocks from raw text FIRST (before any escaping)
 *    so that pipe chars and [N] markers survive intact.
 * 2. Escape remaining text.
 * 3. Apply inline/block formatting.
 *
 * Citation [N] tokens are left as plain text nodes so that
 * CitationViewer.injectInlineMarkers() can find them via TreeWalker afterwards.
 */
// Placeholder token that survives marked.js + DOMPurify without being altered.
// Must not contain chars that HTML/markdown parsers treat specially.
const CITE_PLACEHOLDER_RE  = /\[(\d+)\]/g;
const CITE_RESTORE_RE      = /XCITEX(\d+)XCITEX/g;
function _protectCiteMarkers(text) {
  return text.replace(CITE_PLACEHOLDER_RE, 'XCITEX$1XCITEX');
}
function _restoreCiteMarkers(html) {
  return html.replace(CITE_RESTORE_RE, '[$1]');
}

/**
 * Render markdown to sanitised HTML using marked.js + DOMPurify.
 *
 * Citation markers [N] are protected before parsing so marked.js never
 * interprets them as footnotes or link references.
 * Tables are wrapped in .md-table-wrap for horizontal scrolling.
 */
function renderMarkdown(text) {
  if (!text) return '';

  // Use marked.js when available (loaded via CDN in index.html)
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    // Step 1: protect [N] from being parsed as markdown link references
    const protected_ = _protectCiteMarkers(text);

    marked.use({
      gfm:      true,
      breaks:   true,
      pedantic: false,
    });
    const rawHtml = marked.parse(protected_);

    // Step 2: sanitize
    let safe = DOMPurify.sanitize(rawHtml, {
      ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'th', 'td'],
      ADD_ATTR: ['data-cite-id', 'data-chunk-id', 'data-pdf-path', 'data-page',
                 'data-hospital', 'data-insurance', 'data-section', 'data-table',
                 'data-snippet'],
    });

    // Step 3: restore [N] markers (now plain text in the HTML)
    safe = _restoreCiteMarkers(safe);

    // Step 4: wrap every <table> in a .md-table-wrap scroll container
    safe = safe.replace(/<table>/g,  '<div class="md-table-wrap"><table>');
    safe = safe.replace(/<\/table>/g, '</table></div>');
    return safe;
  }

  // ── Fallback (CDN not yet loaded) ──
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,     '<em>$1</em>');
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

/**
 * Escape HTML but preserve [N] citation tokens as-is
 * (used for table cell content so TreeWalker can find them).
 */
function escapeHtmlLite(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Note: we do NOT escape [ and ] so [N] citation markers survive
}



// ─── UI Helpers ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  });
}

function autoResizeTextarea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

function setSendLoading(loading) {
  sendBtn.classList.toggle('loading', loading);
  sendBtn.disabled = loading;
  if (!loading) updateSendBtn();
}

function updateSendBtn() {
  sendBtn.disabled = messageInput.value.trim().length === 0 || isStreaming;
}

// ─── Sidebar Toggle ───────────────────────────────────────────────────────────
function toggleSidebar() {
  const isCollapsed = sidebar.classList.contains('collapsed');
  sidebar.classList.toggle('collapsed', !isCollapsed);
}

function openMobileSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('visible');
}

function closeMobileSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('visible');
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

// Send on button click
sendBtn.addEventListener('click', () => {
  if (!isStreaming) sendMessage(messageInput.value.trim());
});

// Send on Enter (Shift+Enter = newline)
messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming && messageInput.value.trim()) {
      sendMessage(messageInput.value.trim());
    }
  }
});

// Auto-resize and enable/disable send button
messageInput.addEventListener('input', () => {
  autoResizeTextarea();
  updateSendBtn();
});

// New chat
newChatBtn.addEventListener('click', startNewChat);

// Suggestion cards
document.querySelectorAll('.suggestion-card').forEach(card => {
  card.addEventListener('click', () => {
    const prompt = card.dataset.prompt;
    messageInput.value = prompt;
    autoResizeTextarea();
    updateSendBtn();
    sendMessage(prompt);
  });
});

// Sidebar desktop toggle
sidebarToggle.addEventListener('click', toggleSidebar);

// Main toggle (mobile & desktop)
mobileMenuBtn.addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    openMobileSidebar();
  } else {
    toggleSidebar();
  }
});
sidebarOverlay.addEventListener('click', closeMobileSidebar);

// Search
searchInput.addEventListener('input', e => renderHistory(e.target.value));

// ─── Citation click/hover handling ───────────────────────────────────────────
// Fully owned by citation-viewer.js — see CitationViewer's global delegated
// listeners for hover tooltips and click-to-open behaviour on
// `.citation-chip` (inline markers) and `.citation-badge` (sources row).

// ─── Initialise ───────────────────────────────────────────────────────────────
async function init() {
  loadThreads();
  renderHistory();

  // Load most recent thread or start welcome
  if (threads.length > 0) {
    switchThread(threads[0].id);
  } else {
    showWelcome(true);
    // Auto-start a fresh thread for first-time users
    const threadId = await createNewThread();
    const thread = { id: threadId, title: 'New conversation', messages: [], createdAt: Date.now() };
    threads.unshift(thread);
    saveThreads();
    currentThreadId = threadId;
    renderHistory();
  }

  // Health check
  await checkHealth();
  // Recheck every 30 seconds
  setInterval(checkHealth, 30000);
}

init();
