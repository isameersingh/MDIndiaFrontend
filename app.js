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
const API_BASE = 'http://localhost:8000';
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

// ─── API Health Check ─────────────────────────────────────────────────────────
async function checkHealth() {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Connecting...';
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.status === 'ok') {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'API Connected';
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
    const res = await fetch(`${API_BASE}/threads/new`, { method: 'POST' });
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
      else if (m.role === 'assistant') appendAssistantMessage(m.content, m.thinking, false);
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

function appendAssistantMessage(text, thinking = [], save = true) {
  const row = createAssistantRow(text, thinking);
  chatMessages.appendChild(row);
  scrollToBottom();

  if (save && currentThreadId) {
    const thread = findThread(currentThreadId);
    if (thread) {
      thread.messages.push({ role: 'assistant', content: text, thinking });
      saveThreads();
    }
  }
  return row;
}

function createAssistantRow(text, thinking = []) {
  const row = document.createElement('div');
  row.className = 'message-row assistant';

  const avatarHtml = `
    <div class="avatar ai">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>
    </div>`;

  const thinkingHtml = buildThinkingPanel(thinking);

  row.innerHTML = `
    ${avatarHtml}
    <div style="flex:1;min-width:0;">
      ${thinkingHtml}
      <div class="bubble">
        <div class="message-content">${renderMarkdown(text)}</div>
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

  // Copy handler
  row.querySelector('.copy-btn').addEventListener('click', function () {
    navigator.clipboard.writeText(text).then(() => {
      this.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      setTimeout(() => {
        this.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 2000);
    });
  });

  // Collapsible thinking panel
  const header = row.querySelector('.thinking-header');
  if (header) {
    header.addEventListener('click', () => {
      const steps = row.querySelector('.thinking-steps');
      const chevron = row.querySelector('.thinking-chevron');
      const collapsed = steps.style.display === 'none';
      steps.style.display = collapsed ? 'flex' : 'none';
      chevron.classList.toggle('open', collapsed);
    });
  }

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

  // Create an "in-progress" assistant row
  const thinkingSteps = [];
  let fullText = '';

  // Build the row with a typing indicator initially
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

  function addThinkingStep(step) {
    thinkingSteps.push(step);
    if (!thinkingPanelEl) {
      thinkingPanelEl = document.createElement('div');
      thinkingPanelEl.className = 'thinking-panel';
      thinkingPanelEl.innerHTML = `
        <div class="thinking-header" id="thinkingToggle">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
          </svg>
          <span id="thinkingLabel">Thinking...</span>
          <svg class="thinking-chevron open" id="thinkingChevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </div>
        <div class="thinking-steps" id="thinkingStepsList"></div>`;
      streamingContent.insertBefore(thinkingPanelEl, streamingBubble);

      // Collapse toggle
      thinkingPanelEl.querySelector('#thinkingToggle').addEventListener('click', () => {
        const sl = thinkingPanelEl.querySelector('#thinkingStepsList');
        const ch = thinkingPanelEl.querySelector('#thinkingChevron');
        const c = sl.style.display === 'none';
        sl.style.display = c ? 'flex' : 'none';
        ch.classList.toggle('open', c);
      });
    }

    const stepsList = thinkingPanelEl.querySelector('#thinkingStepsList');
    const stepEl = document.createElement('div');
    stepEl.className = 'thinking-step';
    stepEl.innerHTML = `
      <span class="step-icon">${step.icon}</span>
      <div class="step-content">
        <div class="step-label">${escapeHtml(step.label)}</div>
        ${step.args ? `<div class="step-args">${escapeHtml(step.args)}</div>` : ''}
      </div>`;
    stepsList.appendChild(stepEl);

    const label = thinkingPanelEl.querySelector('#thinkingLabel');
    label.textContent = `Thought ${thinkingSteps.length} step${thinkingSteps.length > 1 ? 's' : ''}`;
    scrollToBottom();
  }

  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, thread_id: currentThreadId })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Add streaming cursor
    let cursorEl = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const raw = decoder.decode(value, { stream: true });
      const lines = raw.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); }
        catch { continue; }

        switch (event.type) {
          case 'thinking':
            // General thinking step (agent re-reasoning)
            addThinkingStep({
              icon: '🤔',
              label: event.text,
              args: null
            });
            break;

          case 'tool_start':
            // Agent is calling a specific tool
            const argsStr = event.args
              ? Object.entries(event.args)
                  .filter(([, v]) => v != null)
                  .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                  .join(' | ')
              : '';
            addThinkingStep({
              icon: '🔧',
              label: `Calling: ${event.tool}`,
              args: argsStr || null
            });
            break;

          case 'tool_end':
            addThinkingStep({
              icon: '✅',
              label: `Tool complete`,
              args: event.preview ? event.preview.slice(0, 120) : null
            });
            break;

          case 'token':
            if (!hasStartedStreaming) {
              hasStartedStreaming = true;
              ensureContentEl();
              cursorEl = document.createElement('span');
              cursorEl.className = 'streaming-cursor';
              contentEl.appendChild(cursorEl);
            }
            fullText += event.text;
            // Re-render markdown with cursor
            if (cursorEl) cursorEl.remove();
            contentEl.innerHTML = renderMarkdown(fullText);
            cursorEl = document.createElement('span');
            cursorEl.className = 'streaming-cursor';
            contentEl.appendChild(cursorEl);
            scrollToBottom();
            break;

          case 'done':
            // Remove cursor and finalize
            if (cursorEl) cursorEl.remove();
            if (contentEl) contentEl.innerHTML = renderMarkdown(fullText);

            // Add action buttons
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
                setTimeout(() => { this.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy`; }, 2000);
              });
            });

            // Save to thread
            if (currentThreadId) {
              const thread = findThread(currentThreadId);
              if (thread) {
                thread.messages.push({ role: 'assistant', content: fullText, thinking: thinkingSteps });
                saveThreads();
              }
            }
            scrollToBottom();
            break;

          case 'error':
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
    contentEl.textContent = `Connection error: ${err.message}. Please ensure the API server is running.`;
  } finally {
    isStreaming = false;
    setSendLoading(false);
    renderHistory();
  }
}

// ─── Markdown Renderer ────────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Code blocks (must come before inline code)
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Tables
  html = html.replace(/(\|.+\|\n)+/g, match => {
    const lines = match.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return match;
    const rows = lines.filter(l => !/^\|[-: |]+\|$/.test(l.trim()));
    const header = rows[0];
    const body = rows.slice(1);
    const cells = row => row.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => c.trim());
    const th = cells(header).map(c => `<th>${c}</th>`).join('');
    const trs = body.map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bullet lists
  html = html.replace(/^[*\-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`);

  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (double newlines)
  html = html.replace(/\n\n+/g, '</p><p>');

  // Single newlines to <br> within paragraphs
  html = html.replace(/\n/g, '<br>');

  return html;
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
