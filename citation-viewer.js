/**
 * citation-viewer.js
 * ────────────────────────────────────────────────────────────────────────────
 * A self-contained, reusable "CitationViewer" component for a document
 * intelligence RAG UI.
 *
 * Conceptually this is the vanilla-JS equivalent of:
 *
 *    <CitationViewer citations={citations} activeId={activeId} />
 *
 * There is no build step / framework in this project (plain HTML+JS+CSS), so
 * the component is implemented as a singleton module bound to a fixed DOM
 * skeleton in index.html (#cvDrawer, #cvBackdrop, …) instead of a JSX tree —
 * but the external API mirrors the same props/behaviour:
 *
 *    CitationViewer.open(citations, activeId)   // mount + set active citation
 *    CitationViewer.close()
 *    CitationViewer.next() / .prev()
 *
 * It also owns everything related to *inline* citation markers so a chat
 * message only has to call two helpers to get fully working citations:
 *
 *    CitationViewer.registerCitations(containerEl, citations)
 *    CitationViewer.injectInlineMarkers(rootEl, citations)
 *    CitationViewer.renderSourcesRow(citations)
 *
 * DATA SHAPE (per citation):
 * {
 *   id, hospital, insurance, city, state, page, page_width, page_height,
 *   pdf_path, source_json, block_type, table_id, bbox:{x1,y1,x2,y2}, snippet,
 *   verified
 * }
 */
'use strict';

const CitationViewer = (function () {

  // ── Normalisation ──────────────────────────────────────────────────────
  function normalize(raw) {
    const bbox = raw.bbox || {};
    return {
      id: Number(raw.id),
      hospital: raw.hospital || 'Unknown source',
      insurance: raw.insurance || '',
      city: raw.city || '',
      state: raw.state || '',
      page: Number(raw.page) || 1,
      page_width: Number(raw.page_width) || 0,
      page_height: Number(raw.page_height) || 0,
      pdf_path: (raw.pdf_path || '').trim(),
      source_json: raw.source_json || '',
      block_type: raw.block_type || 'text',
      table_id: raw.table_id || '',
      bbox: {
        x1: clamp01(numOr(bbox.x1, 0)),
        y1: clamp01(numOr(bbox.y1, 0)),
        x2: clamp01(numOr(bbox.x2, 1)),
        y2: clamp01(numOr(bbox.y2, 1)),
      },
      snippet: raw.snippet || '',
      verified: (raw.verified === true || raw.verified === false) ? raw.verified : null,
    };
  }
  function numOr(v, fallback) { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; }
  function clamp01(n) { return Math.min(1, Math.max(0, n)); }
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n).trim() + '…' : str;
  }

  /**
   * Browsers can't render a PDF inside an <img> tag, so the source page has
   * to be rasterized server-side. Build the URL for the backend's
   * /pdf-page-image endpoint (see MDIndiaChatBot/src/api.py) rather than
   * assigning the raw pdf_path (a backend filesystem path) to img.src.
   */
  function buildPageImageUrl(cite) {
    const base = (typeof window !== 'undefined' && window.API_BASE) || '';
    return `${base}/pdf-page-image?pdf_path=${encodeURIComponent(cite.pdf_path)}&page=${cite.page}`;
  }

  // ── Component state ──────────────────────────────────────────────────────
  const state = {
    citations: [],   // full list for the *current* answer
    index: 0,        // index of active citation within `citations`
    zoom: 1,
    ready: false,
    loadedImgUrl: null, // URL currently loaded into els.pageImg, to skip needless reloads
  };

  let els = {};

  function grabEls() {
    els = {
      backdrop: document.getElementById('cvBackdrop'),
      drawer: document.getElementById('cvDrawer'),
      headerNum: document.getElementById('cvHeaderNum'),
      headerHospital: document.getElementById('cvHeaderHospital'),
      headerSub: document.getElementById('cvHeaderSub'),
      pagerCount: document.getElementById('cvPagerCount'),
      prevBtn: document.getElementById('cvPrevBtn'),
      nextBtn: document.getElementById('cvNextBtn'),
      closeBtn: document.getElementById('cvCloseBtn'),
      viewer: document.getElementById('cvViewer'),
      viewerScroll: document.getElementById('cvViewerScroll'),
      pageFrame: document.getElementById('cvPageFrame'),
      pageImg: document.getElementById('cvPageImg'),
      boxesLayer: document.getElementById('cvBoxesLayer'),
      placeholder: document.getElementById('cvPlaceholder'),
      zoomControls: document.getElementById('cvZoomControls'),
      zoomIn: document.getElementById('cvZoomIn'),
      zoomOut: document.getElementById('cvZoomOut'),
      zoomLevel: document.getElementById('cvZoomLevel'),
      metaHospital: document.getElementById('metaHospital'),
      metaInsurance: document.getElementById('metaInsurance'),
      metaLocation: document.getElementById('metaLocation'),
      metaPage: document.getElementById('metaPage'),
      metaTable: document.getElementById('metaTable'),
      metaVerifiedRow: document.getElementById('metaVerifiedRow'),
      metaVerifiedBadge: document.getElementById('metaVerifiedBadge'),
      metaSnippet: document.getElementById('metaSnippet'),
      metaBlockType: document.getElementById('metaBlockType'),
    };
  }

  function init() {
    if (state.ready) return;
    grabEls();
    if (!els.drawer) return; // markup not present on this page

    els.closeBtn.addEventListener('click', close);
    els.backdrop.addEventListener('click', close);
    els.prevBtn.addEventListener('click', prev);
    els.nextBtn.addEventListener('click', next);
    els.zoomIn.addEventListener('click', () => setZoom(state.zoom + 0.2));
    els.zoomOut.addEventListener('click', () => setZoom(state.zoom - 0.2));

    document.addEventListener('keydown', (e) => {
      if (!document.body.classList.contains('cv-open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    });

    // Re-draw boxes if the drawer is resized (e.g. viewport resize while open)
    window.addEventListener('resize', () => {
      if (document.body.classList.contains('cv-open')) drawBoxes(false);
    });

    attachGlobalCitationDelegation();
    state.ready = true;
  }

  // ── Public API ───────────────────────────────────────────────────────────
  function open(citations, activeId) {
    init();
    if (!els.drawer || !citations || !citations.length) return;
    state.citations = citations.map(normalize);
    const idx = state.citations.findIndex(c => c.id === Number(activeId));
    state.index = idx >= 0 ? idx : 0;
    state.zoom = 1;
    document.body.classList.add('cv-open');
    render(true);
  }

  function close() {
    document.body.classList.remove('cv-open');
  }

  function next() {
    if (state.index < state.citations.length - 1) { state.index++; render(true); }
  }

  function prev() {
    if (state.index > 0) { state.index--; render(true); }
  }

  function goToId(id) {
    const idx = state.citations.findIndex(c => c.id === Number(id));
    if (idx >= 0) { state.index = idx; render(true); }
  }

  function setZoom(z) {
    state.zoom = Math.min(2.5, Math.max(0.6, Math.round(z * 100) / 100));
    els.pageFrame.style.zoom = state.zoom;
    els.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';
    requestAnimationFrame(() => drawBoxes(false));
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function render(pulseActive) {
    const cite = state.citations[state.index];
    if (!cite) return;

    // Header
    els.headerNum.textContent = cite.id;
    els.headerHospital.textContent = cite.hospital;
    const subParts = [cite.block_type === 'table' ? '📊 Table' : '📄 Text', `Page ${cite.page}`];
    if (cite.table_id) subParts.push(cite.table_id);
    els.headerSub.textContent = subParts.join(' · ');
    els.pagerCount.textContent = `${state.index + 1} / ${state.citations.length}`;
    els.prevBtn.disabled = state.index === 0;
    els.nextBtn.disabled = state.index === state.citations.length - 1;

    // Metadata sidebar
    els.metaHospital.textContent = cite.hospital || '—';
    els.metaInsurance.textContent = cite.insurance || '—';
    const loc = [cite.city, cite.state].filter(v => v && v.toLowerCase() !== 'unknown').join(', ');
    els.metaLocation.textContent = loc || '—';
    els.metaPage.textContent = cite.page ? `Page ${cite.page}` : '—';
    els.metaTable.textContent = cite.table_id || (cite.block_type === 'table' ? 'Table (untitled)' : 'Paragraph');

    if (cite.verified === null) {
      els.metaVerifiedRow.hidden = true;
    } else {
      els.metaVerifiedRow.hidden = false;
      els.metaVerifiedBadge.className = 'cv-verified-badge ' + (cite.verified ? 'is-true' : 'is-false');
      els.metaVerifiedBadge.innerHTML = cite.verified
        ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Verified'
        : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Not verified';
    }

    els.metaSnippet.textContent = cite.snippet ? truncate(cite.snippet, 400) : 'No preview text available for this source.';
    els.metaBlockType.textContent = cite.block_type === 'table' ? '▦ Table source' : '¶ Text source';
    els.metaBlockType.className = 'cv-blocktype-tag ' + (cite.block_type === 'table' ? 'is-table' : 'is-text');

    // Source page image + graceful degradation
    state.zoom = 1;
    els.pageFrame.style.zoom = 1;
    els.zoomLevel.textContent = '100%';

    if (!cite.pdf_path) {
      els.placeholder.classList.add('visible');
      els.viewerScroll.classList.remove('visible');
      els.zoomControls.classList.remove('visible');
      els.boxesLayer.innerHTML = '';
    } else {
      els.placeholder.classList.remove('visible');
      els.viewerScroll.classList.add('visible');
      els.zoomControls.classList.add('visible');

      const onReady = () => {
        drawBoxes(pulseActive);
      };
      const imgUrl = buildPageImageUrl(cite);
      // Compare against the URL we last *set* (state.loadedImgUrl), not
      // els.pageImg.src — the browser absolutizes `src` to a full URL, so
      // comparing it directly to a relative/differently-built URL was
      // always true, forcing a needless reload on every click.
      if (state.loadedImgUrl !== imgUrl) {
        els.boxesLayer.innerHTML = '';
        els.pageImg.onload = onReady;
        els.pageImg.onerror = () => {
          els.placeholder.classList.add('visible');
          els.viewerScroll.classList.remove('visible');
          els.zoomControls.classList.remove('visible');
        };
        state.loadedImgUrl = imgUrl;
        els.pageImg.src = imgUrl;
      } else {
        onReady();
      }
    }
  }

  /**
   * Draw highlight rectangles for every citation that shares the active
   * citation's page number, converting normalized bbox → pixel coordinates:
   *
   *   displayScale = renderedImageWidth / page_width
   *   pixel_x1 = bbox.x1 * page_width * displayScale   (== bbox.x1 * renderedImageWidth)
   *   pixel_y1 = bbox.y1 * page_height * displayScale
   */
  function drawBoxes(pulseActive) {
    const active = state.citations[state.index];
    if (!active || !active.pdf_path) return;
    const renderedWidth = els.pageImg.clientWidth;
    if (!renderedWidth) return;

    const pageWidth = active.page_width || renderedWidth;
    const pageHeight = active.page_height || els.pageImg.clientHeight;
    const displayScale = renderedWidth / pageWidth;

    const sameCitations = state.citations.filter(c => c.page === active.page && c.pdf_path === active.pdf_path);

    els.boxesLayer.innerHTML = '';
    let activeBoxEl = null;

    sameCitations.forEach(c => {
      const { x1, y1, x2, y2 } = c.bbox;
      const px1 = x1 * pageWidth * displayScale;
      const py1 = y1 * pageHeight * displayScale;
      const pw = (x2 - x1) * pageWidth * displayScale;
      const ph = (y2 - y1) * pageHeight * displayScale;

      const box = document.createElement('div');
      const isActive = c.id === active.id;
      box.className = 'cv-box ' + (c.block_type === 'table' ? 'cv-box-table' : 'cv-box-text') + (isActive ? ' cv-box-active' : '');
      box.style.left = px1 + 'px';
      box.style.top = py1 + 'px';
      box.style.width = Math.max(pw, 4) + 'px';
      box.style.height = Math.max(ph, 4) + 'px';
      box.title = `[${c.id}] ${c.hospital}`;

      const tag = document.createElement('span');
      tag.className = 'cv-box-tag';
      tag.textContent = c.id;
      box.appendChild(tag);

      if (!isActive) {
        box.addEventListener('click', (e) => { e.stopPropagation(); goToId(c.id); });
      }
      els.boxesLayer.appendChild(box);
      if (isActive) activeBoxEl = box;
    });

    if (activeBoxEl) {
      activeBoxEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      if (pulseActive) {
        activeBoxEl.classList.add('cv-box-pulse');
        setTimeout(() => activeBoxEl && activeBoxEl.classList.remove('cv-box-pulse'), 1600);
      }
    }
  }

  // ── Inline citation markers ─────────────────────────────────────────────

  /**
   * Store the full citation list for an answer on its container element so
   * that clicking *any* chip/badge inside it can open the multi-citation
   * pager with the complete set, not just the single clicked citation.
   */
  function registerCitations(containerEl, citations) {
    if (!containerEl) return;
    containerEl.dataset.citations = JSON.stringify((citations || []).map(normalize));
  }

  const SKIP_TAGS = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE']);
  function isInsideSkipTag(node, rootEl) {
    let el = node.parentElement;
    while (el && el !== rootEl) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      el = el.parentElement;
    }
    return false;
  }

  /**
   * Parse [n] / [n][m] patterns inside rootEl's text nodes and replace them
   * with clickable pill-style citation badges. Adjacent citations such as
   * [5][6] become two separate, individually clickable badges.
   */
  function injectInlineMarkers(rootEl, citations) {
    if (!citations || !citations.length || !rootEl) return;
    const citeMap = {};
    citations.forEach(c => { citeMap[Number(c.id)] = normalize(c); });

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!/\[\d+\]/.test(node.nodeValue)) return NodeFilter.FILTER_SKIP;
        if (isInsideSkipTag(node, rootEl)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    textNodes.forEach(tn => {
      const parent = tn.parentNode;
      if (!parent) return;
      const parts = tn.nodeValue.split(/(\[\d+\])/);
      const frag = document.createDocumentFragment();
      let changed = false;

      parts.forEach(part => {
        const m = part.match(/^\[(\d+)\]$/);
        const cite = m ? citeMap[Number(m[1])] : null;
        if (cite) {
          changed = true;
          frag.appendChild(buildChip(cite));
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      });

      if (changed) parent.replaceChild(frag, tn);
    });
  }

  function buildChip(cite) {
    const chip = document.createElement('span');
    chip.className = 'citation-chip';
    chip.textContent = cite.id;
    chip.dataset.citeId = cite.id;
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', `Citation ${cite.id}: ${cite.hospital}, page ${cite.page}`);
    return chip;
  }

  /**
   * Build the "Sources" row shown below an answer bubble — one pill per
   * citation with insurer / hospital / page, click opens the full viewer.
   */
  function renderSourcesRow(citations) {
    const row = document.createElement('div');
    row.className = 'citations-row';
    if (!citations || !citations.length) return row;

    const label = document.createElement('span');
    label.className = 'citations-row-label';
    label.textContent = 'Sources';
    row.appendChild(label);

    citations.forEach(raw => {
      const c = normalize(raw);
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'citation-badge';
      badge.dataset.citeId = c.id;

      const blockIcon = c.block_type === 'table' ? '▦' : '¶';
      badge.innerHTML = `
        <span class="citation-badge-num">${c.id}</span>
        <span class="citation-badge-body">
          <span class="citation-badge-hospital">${escapeHtml(c.hospital)}</span>
          <span class="citation-badge-sub">${escapeHtml(c.insurance || '')}${c.insurance ? ' · ' : ''}p.${c.page} ${blockIcon}</span>
        </span>`;
      row.appendChild(badge);
    });

    return row;
  }

  // ── Hover tooltip + click-to-open (global event delegation) ────────────
  let tooltipEl = null;

  function showTooltip(chipEl, cite) {
    hideTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'cv-tooltip';
    tooltipEl.innerHTML = `
      <div class="cv-tooltip-head">
        <span class="cv-tooltip-num">[${cite.id}]</span>
        <span class="cv-tooltip-hospital">${escapeHtml(cite.hospital)}</span>
      </div>
      <div class="cv-tooltip-meta">Page ${cite.page}${cite.insurance ? ' · ' + escapeHtml(cite.insurance) : ''}</div>
      <div class="cv-tooltip-snippet">${escapeHtml(truncate(cite.snippet, 120) || 'No preview available')}</div>
      <div class="cv-tooltip-hint">Click to view source page</div>`;
    document.body.appendChild(tooltipEl);

    const rect = chipEl.getBoundingClientRect();
    const tt = tooltipEl.getBoundingClientRect();
    let top = rect.top + window.scrollY - tt.height - 10;
    let left = rect.left + window.scrollX + rect.width / 2 - tt.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tt.width - 8));
    if (top < window.scrollY + 4) top = rect.bottom + window.scrollY + 10;
    tooltipEl.style.top = top + 'px';
    tooltipEl.style.left = left + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
  }

  function findCitationsForChip(chipEl) {
    const carrier = chipEl.closest('[data-citations]');
    if (!carrier) return null;
    try {
      const list = JSON.parse(carrier.dataset.citations);
      const id = Number(chipEl.dataset.citeId);
      const cite = list.find(c => c.id === id);
      return cite ? { list, cite } : null;
    } catch { return null; }
  }

  function attachGlobalCitationDelegation() {
    document.addEventListener('mouseover', (e) => {
      const chip = e.target.closest('.citation-chip, .citation-badge');
      if (!chip) return;
      const found = findCitationsForChip(chip);
      if (found) showTooltip(chip, found.cite);
    });
    document.addEventListener('mouseout', (e) => {
      const chip = e.target.closest('.citation-chip, .citation-badge');
      if (!chip) return;
      hideTooltip();
    });
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.citation-chip, .citation-badge');
      if (!chip) return;
      e.preventDefault();
      hideTooltip();
      const found = findCitationsForChip(chip);
      if (found) open(found.list, found.cite.id);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const chip = e.target.closest('.citation-chip');
      if (!chip) return;
      e.preventDefault();
      const found = findCitationsForChip(chip);
      if (found) open(found.list, found.cite.id);
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    open,
    close,
    next,
    prev,
    goToId,
    registerCitations,
    injectInlineMarkers,
    renderSourcesRow,
  };
})();

if (typeof window !== 'undefined') window.CitationViewer = CitationViewer;
