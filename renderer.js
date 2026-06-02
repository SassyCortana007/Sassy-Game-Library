const STEAM_STORE_APP = 'https://store.steampowered.com/app/';
const STEAM_CDN = 'https://cdn.akamai.steamstatic.com/steam/apps';

let games = [];
let allSuggestions = [];
let suggestionBasedOn = [];
let suggestionReason = 'ok';
let suggestionFetchToken = 0;
let suggestionDebounceTimer = null;
let suggestionFetchInProgress = false;
let searchTimeout = null;
let customCoverPath = null;
let customCoverPreviewUrl = null;
let manualSelectionAppids = [];

let activeSort = 'date-desc';
let tagOverflowOpen = false;
const selectedSuggestionTags = new Set();

const STEAM_CHECKMARK_SVG = `<svg width="18" height="18" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polyline points="3,12 8,18 19,5" stroke="#a4d007" stroke-width="3" stroke-linecap="square" stroke-linejoin="miter" fill="none"/></svg>`;

const STEAM_UNDO_SVG = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><line x1="4" y1="11" x2="18" y2="11" stroke="#66c0f4" stroke-width="3" stroke-linecap="square"/></svg>`;

const $ = (sel) => document.querySelector(sel);

const steamSearch = $('#steam-search');
const searchResults = $('#search-results');
const gameCountEl = $('#game-count');
const headingBacklog = $('#heading-backlog');
const headingCompleted = $('#heading-completed');
const gridBacklog = $('#grid-backlog');
const gridCompleted = $('#grid-completed');
const gridSuggested = $('#grid-suggested');
const suggestedContainer = $('#suggested-container');
const suggestionSourceBar = $('#suggestion-source-bar');
const basedOnBtn = $('#based-on-btn');
const basedOnClear = $('#based-on-clear');
const gameSelectOverlay = $('#game-select-overlay');
const gameSelectList = $('#game-select-list');
const suggestedTagBar = $('#suggested-tag-bar');
const tagPills = $('#tag-pills');
const tagOverflowPanel = $('#tag-overflow-panel');
const sortSelect = $('#sort-select');
const btnRefreshSuggestions = $('#btn-refresh-suggestions');
const customModal = $('#custom-modal');
const customForm = $('#custom-form');
const customName = $('#custom-name');
const coverPreview = $('#cover-preview');
const btnAddCustom = $('#btn-add-custom');
const btnCancelCustom = $('#btn-cancel-custom');
const btnPickCover = $('#btn-pick-cover');
const btnSubmitCustom = $('#btn-submit-custom');

function isCustomGame(game) {
  return !game.appid || String(game.appid).startsWith('custom_');
}

function isCustomAppid(appid) {
  return !appid || String(appid).startsWith('custom_');
}

function getSteamPortraitUrls(appid) {
  return [
    `${STEAM_CDN}/${appid}/library_600x900.jpg`,
    `${STEAM_CDN}/${appid}/library_600x900_2x.jpg`,
    `${STEAM_CDN}/${appid}/header.jpg`,
  ];
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function resolveImageUrl(headerImage) {
  if (!headerImage) return '';
  if (headerImage.startsWith('http')) return headerImage;
  return window.api.resolveCover(headerImage) || '';
}

async function getCardImageData(game) {
  if (!isCustomGame(game)) {
    const urls = getSteamPortraitUrls(game.appid);
    return { src: urls[0], fallbacks: urls.slice(1) };
  }
  return { src: await resolveImageUrl(game.headerImage), fallbacks: [] };
}

function bindSuggestionCoverFallbacks(container) {
  container.querySelectorAll('.game-card[data-appid] img.card-img').forEach((img) => {
    const appid = img.dataset.appid || img.closest('.game-card')?.dataset.appid;
    if (!appid) return;

    img.onerror = function () {
      if (this.src.includes('library_600x900_2x')) {
        this.src = `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;
      } else if (this.src.includes('library_600x900.jpg')) {
        this.src = `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`;
      } else {
        this.closest('.game-card').style.display = 'none';
      }
    };
  });
}

function bindCardClicks(container) {
  container.querySelectorAll('.game-card[data-store-url]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-action, .card-delete')) return;
      const url = card.dataset.storeUrl;
      if (url) window.api.openExternal(url);
    });
  });
}

function getTagFrequency() {
  const freq = new Map();
  for (const game of games) {
    for (const tag of game.tags || []) {
      freq.set(tag, (freq.get(tag) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function pruneSelectedSuggestionTags() {
  const allTags = new Set(getTagFrequency());
  for (const tag of selectedSuggestionTags) {
    if (!allTags.has(tag)) selectedSuggestionTags.delete(tag);
  }
}

function getTagFilterLayout() {
  const ranked = getTagFrequency();
  const top5 = ranked.slice(0, 5);
  const overflow = ranked.slice(5);
  const visibleTags = [...top5];

  for (const tag of selectedSuggestionTags) {
    if (ranked.includes(tag) && !visibleTags.includes(tag)) {
      visibleTags.push(tag);
    }
  }

  return { visibleTags, overflow, allTags: ranked };
}

function closeTagOverflow() {
  tagOverflowOpen = false;
  tagOverflowPanel.classList.remove('visible');
}

function openTagOverflow() {
  tagOverflowOpen = true;
  tagOverflowPanel.classList.add('visible');
}

function isTagPillActive(tag) {
  if (tag === 'all') return selectedSuggestionTags.size === 0;
  return selectedSuggestionTags.has(tag);
}

function toggleSuggestionTag(tag) {
  if (tag === 'all') {
    selectedSuggestionTags.clear();
  } else if (selectedSuggestionTags.has(tag)) {
    selectedSuggestionTags.delete(tag);
  } else {
    selectedSuggestionTags.add(tag);
  }
  closeTagOverflow();
  renderTagPills();
  renderSuggestions();
}

function getFilteredSuggestions() {
  if (selectedSuggestionTags.size === 0) return allSuggestions;
  return allSuggestions.filter((suggestion) => {
    if (!suggestion.tags?.length) return false;
    return [...selectedSuggestionTags].some((tag) => suggestion.tags.includes(tag));
  });
}

function updateSuggestionBasedOn() {
  if (suggestionReason === 'no_completed') {
    suggestionSourceBar.classList.add('hidden');
    return;
  }

  suggestionSourceBar.classList.remove('hidden');

  if (manualSelectionAppids.length === 0) {
    basedOnBtn.textContent = 'Based on: Auto (3 recent) ▾';
    basedOnClear.style.display = 'none';
    return;
  }

  const names = manualSelectionAppids
    .map((appid) => games.find((g) => String(g.appid) === String(appid))?.name)
    .filter(Boolean);
  basedOnClear.style.display = 'inline-block';

  if (names.length <= 2) {
    basedOnBtn.textContent = `Based on: ${names.join(', ')} ▾`;
  } else {
    basedOnBtn.textContent = `Based on: ${names[0]} +${names.length - 1} more ▾`;
  }
}

function getCompletedSteamGames() {
  return getGamesByStatus('completed').filter((g) => !isCustomGame(g));
}

function populateGameSelectList() {
  gameSelectList.innerHTML = '';
  const completed = getCompletedSteamGames();

  if (completed.length === 0) {
    gameSelectList.innerHTML =
      '<div style="color:#8f98a0;font-size:12px;padding:8px 4px;">No completed games yet. Complete some games first.</div>';
    return;
  }

  for (const game of completed) {
    const row = document.createElement('label');
    row.className = 'game-select-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(game.appid);
    if (manualSelectionAppids.some((appid) => String(appid) === String(game.appid))) {
      checkbox.checked = true;
    }

    const img = document.createElement('img');

    if (!game.appid || String(game.appid).startsWith('custom_')) {
      img.style.width = '80px';
      img.style.height = '30px';
      img.style.background = '#16202d';
      img.style.border = '1px solid #2a475e';
      img.style.borderRadius = '2px';
    } else {
      img.src = `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/capsule_231x87.jpg`;

      img.onerror = function () {
        if (this.src.includes('capsule_231x87')) {
          this.src = `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
        } else {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = `
      width: 80px; height: 30px;
      background: #16202d;
      border: 1px solid #2a475e;
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    `;
          wrapper.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 36 36"
           fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="10" width="28" height="18" rx="3"
              stroke="#4d9ddb" stroke-width="2" fill="none"/>
        <circle cx="12" cy="19" r="2.5"
                stroke="#4d9ddb" stroke-width="1.5" fill="none"/>
        <circle cx="24" cy="19" r="2.5"
                stroke="#4d9ddb" stroke-width="1.5" fill="none"/>
        <line x1="18" y1="10" x2="18" y2="6"
              stroke="#4d9ddb" stroke-width="2"
              stroke-linecap="square"/>
        <line x1="13" y1="6" x2="23" y2="6"
              stroke="#4d9ddb" stroke-width="2"
              stroke-linecap="square"/>
      </svg>
    `;
          this.replaceWith(wrapper);
        }
      };
    }

    const span = document.createElement('span');
    span.textContent = game.name;

    row.appendChild(checkbox);
    row.appendChild(img);
    row.appendChild(span);
    gameSelectList.appendChild(row);
  }
}

function openGameSelectDialog() {
  populateGameSelectList();
  gameSelectOverlay.style.display = 'flex';
}

function closeGameSelectDialog() {
  gameSelectOverlay.style.display = 'none';
}

async function clearManualSelection() {
  manualSelectionAppids = [];
  updateSuggestionBasedOn();
  scheduleSuggestionLoad();
}

function renderTagPillButton(tag) {
  const active = isTagPillActive(tag) ? ' active' : '';
  const label = tag === 'all' ? 'All' : escapeHtml(tag);
  const dataTag = tag === 'all' ? 'all' : escapeAttr(tag);
  return `<button type="button" class="tag-pill${active}" data-tag="${dataTag}">${label}</button>`;
}

function sortGames(list) {
  const sorted = [...list];
  switch (activeSort) {
    case 'date-asc':
      return sorted.sort((a, b) => a.addedAt - b.addedAt);
    case 'name-asc':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'name-desc':
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
    case 'date-desc':
    default:
      return sorted.sort((a, b) => b.addedAt - a.addedAt);
  }
}

function getGamesByStatus(status) {
  return sortGames(games.filter((g) => g.status === status));
}

async function loadLibrary() {
  games = await window.api.loadGames();
  updateCounts();
  renderTagPills();
  await renderSections();
  scheduleSuggestionLoad();
}

async function persistLibrary() {
  await window.api.saveGames(games);
  updateCounts();
  renderTagPills();
  await renderSections();
}

async function persistLibraryAndRefreshSuggestions() {
  await window.api.saveGames(games);
  updateCounts();
  renderTagPills();
  await renderSections();
  if (manualSelectionAppids.length === 0) {
    scheduleSuggestionLoad();
  }
}

async function refreshAll() {
  updateCounts();
  renderTagPills();
  await renderSections();
}
function updateCounts() {
  const backlogCount = games.filter((g) => g.status === 'backlog').length;
  const completedCount = games.filter((g) => g.status === 'completed').length;
  gameCountEl.textContent = games.length;
  headingBacklog.textContent = `TO PLAY (${backlogCount})`;
  headingCompleted.textContent = `COMPLETED (${completedCount})`;
}

function renderTagPills() {
  pruneSelectedSuggestionTags();

  const showTagBar = games.length >= 3 && getTagFrequency().length > 0;
  suggestedTagBar.classList.toggle('visible', showTagBar);

  if (!showTagBar) {
    closeTagOverflow();
    tagPills.innerHTML = '';
    tagOverflowPanel.innerHTML = '';
    return;
  }

  const { visibleTags, overflow } = getTagFilterLayout();

  let html = renderTagPillButton('all');
  for (const tag of visibleTags) {
    html += renderTagPillButton(tag);
  }

  if (overflow.length > 0) {
    html += `<button type="button" class="tag-pill tag-pill-more" id="btn-tag-more">+${overflow.length} more</button>`;
  }

  tagPills.innerHTML = html;

  tagPills.querySelectorAll('.tag-pill:not(#btn-tag-more)').forEach((pill) => {
    pill.addEventListener('click', () => toggleSuggestionTag(pill.dataset.tag));
  });

  const moreBtn = $('#btn-tag-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tagOverflowOpen) closeTagOverflow();
      else openTagOverflow();
    });
  }

  if (overflow.length === 0) {
    closeTagOverflow();
    tagOverflowPanel.innerHTML = '';
  } else {
    let panelHtml = '<div class="tag-pills">';
    for (const tag of overflow) {
      panelHtml += renderTagPillButton(tag);
    }
    panelHtml += '</div>';
    tagOverflowPanel.innerHTML = panelHtml;

    tagOverflowPanel.querySelectorAll('.tag-pill').forEach((pill) => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSuggestionTag(pill.dataset.tag);
      });
    });
  }

  if (!tagOverflowOpen) closeTagOverflow();
}

function scheduleSuggestionLoad() {
  showSuggestionsLoading();

  clearTimeout(suggestionDebounceTimer);

  suggestionDebounceTimer = setTimeout(() => {
    loadSuggestions();
  }, 1500);
}

function showSuggestionsLoading() {
  const container = document.getElementById('suggested-container');
  if (!container) return;
  container.innerHTML = `
    <div style="
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 40px 0;
    ">
      <svg width="36" height="36" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="20"
          fill="none"
          stroke="#2a475e"
          stroke-width="4"/>
        <circle cx="24" cy="24" r="20"
          fill="none"
          stroke="#4d9ddb"
          stroke-width="4"
          stroke-linecap="round"
          stroke-dasharray="30 96"
          style="transform-origin:center;
                 animation:spin 0.8s linear infinite;"/>
      </svg>
    </div>
  `;
}

async function buildCardHtml(game, options = {}) {
  const { mode = 'library' } = options;
  const { src, fallbacks } = await getCardImageData(game);
  const storeUrl = !isCustomGame(game)
    ? game.storeUrl || `${STEAM_STORE_APP}${game.appid}/`
    : '';
  const isClickable = Boolean(storeUrl);
  const cardClass = 'game-card';
  const storeAttr = isClickable ? ` data-store-url="${escapeAttr(storeUrl)}"` : '';
  const badge = isCustomGame(game) ? '<span class="card-badge">Custom</span>' : '';

  let actionBox = '';
  if (mode === 'backlog') {
    actionBox = `<button type="button" class="card-action card-action--complete" data-action="complete" title="Mark as completed" aria-label="Mark ${escapeAttr(game.name)} as completed">${STEAM_CHECKMARK_SVG}</button>`;
  } else if (mode === 'completed') {
    actionBox = `<button type="button" class="card-action card-action--undo" data-action="undo" title="Move back to backlog" aria-label="Move ${escapeAttr(game.name)} back to backlog">${STEAM_UNDO_SVG}</button>`;
  } else if (mode === 'suggested') {
    actionBox = `<button type="button" class="card-action card-action--add" data-action="add" title="Add to backlog" aria-label="Add ${escapeAttr(game.name)} to backlog">+</button>`;
  }

  const deleteBtn =
    mode !== 'suggested'
      ? `<button type="button" class="card-delete" title="Remove game" aria-label="Remove ${escapeAttr(game.name)}">×</button>`
      : '';

  const idAttr =
    mode === 'suggested' ? `data-appid="${game.appid}"` : `data-id="${escapeAttr(game.id)}"`;

  const appidAttr =
    game.appid && !isCustomGame(game) ? ` data-appid="${escapeAttr(String(game.appid))}"` : '';

  return `
    <article class="${cardClass}" ${idAttr}${storeAttr}>
      <img class="card-img" src="${escapeAttr(src)}"${appidAttr} alt="" loading="lazy">
      <div class="card-bar">
        <span class="card-title" title="${escapeAttr(game.name)}">${escapeHtml(game.name)}</span>
        ${actionBox}
      </div>
      ${deleteBtn}
      ${badge}
    </article>`;
}

async function renderGrid(gridEl, gameList, mode, emptyMessage) {
  if (gameList.length === 0) {
    gridEl.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }

  const cards = await Promise.all(gameList.map((g) => buildCardHtml(g, { mode })));
  gridEl.innerHTML = cards.join('');
  bindCoverFallbacks(gridEl);
  bindCardClicks(gridEl);
}

function bindCoverFallbacks(container) {
  container.querySelectorAll('img.card-img').forEach((img) => {
    const appid = img.dataset.appid;

    img.onerror = function () {
      if (isCustomAppid(appid)) {
        const placeholder = document.createElement('div');
        placeholder.style.cssText = `
      width: 100%; height: 100%;
      background: #16202d;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 8px;
    `;
        placeholder.innerHTML = `
      <svg width="36" height="36" viewBox="0 0 36 36"
           fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="10" width="28" height="18" rx="3"
              stroke="#4d9ddb" stroke-width="2" fill="none"/>
        <circle cx="12" cy="19" r="2.5"
                stroke="#4d9ddb" stroke-width="1.5" fill="none"/>
        <circle cx="24" cy="19" r="2.5"
                stroke="#4d9ddb" stroke-width="1.5" fill="none"/>
        <line x1="18" y1="10" x2="18" y2="6"
              stroke="#4d9ddb" stroke-width="2"
              stroke-linecap="square"/>
        <line x1="13" y1="6" x2="23" y2="6"
              stroke="#4d9ddb" stroke-width="2"
              stroke-linecap="square"/>
      </svg>
      <span style="color:#4d9ddb; font-size:11px;
                   font-family:'Motiva Sans','Segoe UI',sans-serif;
                   text-align:center; padding: 0 8px;">
        Custom Game
      </span>
    `;
        img.replaceWith(placeholder);
        return;
      }

      if (this.src.includes('library_600x900_2x')) {
        this.src = `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;
      } else if (this.src.includes('library_600x900.jpg')) {
        this.src = `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`;
      } else {
        const gameName = escapeHtml(
          this.closest('.game-card')?.querySelector('.card-title')?.textContent?.trim() || ''
        );
        const placeholder = document.createElement('div');
        placeholder.style.cssText = `
          width: 100%; height: 100%;
          background: #16202d;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          gap: 8px; padding: 12px;
        `;
        placeholder.innerHTML = `
          <svg width="36" height="36" viewBox="0 0 36 36"
               fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="10" width="28" height="18" rx="3"
                  stroke="#4d9ddb" stroke-width="2" fill="none"/>
            <circle cx="12" cy="19" r="2.5"
                    stroke="#4d9ddb" stroke-width="1.5" fill="none"/>
            <circle cx="24" cy="19" r="2.5"
                    stroke="#4d9ddb" stroke-width="1.5" fill="none"/>
            <line x1="18" y1="10" x2="18" y2="6"
                  stroke="#4d9ddb" stroke-width="2"
                  stroke-linecap="square"/>
            <line x1="13" y1="6" x2="23" y2="6"
                  stroke="#4d9ddb" stroke-width="2"
                  stroke-linecap="square"/>
          </svg>
          <span style="color:#4d9ddb; font-size:11px;
                       font-family:'Motiva Sans','Segoe UI',sans-serif;
                       text-align:center; line-height:1.4;
                       display:-webkit-box; -webkit-line-clamp:3;
                       -webkit-box-orient:vertical; overflow:hidden;">
            ${gameName}
          </span>
        `;
        this.replaceWith(placeholder);
      }
    };
  });
}

async function renderSections() {
  const backlogGames = getGamesByStatus('backlog');
  const completedGames = getGamesByStatus('completed');

  await renderGrid(gridBacklog, backlogGames, 'backlog', 'No games here yet');
  await renderGrid(gridCompleted, completedGames, 'completed', 'No games here yet');

  bindLibraryCardEvents(gridBacklog, 'backlog');
  bindLibraryCardEvents(gridCompleted, 'completed');
}

function bindLibraryCardEvents(gridEl, sectionMode) {
  gridEl.querySelectorAll('.card-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeGame(btn.closest('.game-card').dataset.id);
    });
  });

  gridEl.querySelectorAll('[data-action="complete"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setGameStatus(btn.closest('.game-card').dataset.id, 'completed');
    });
  });

  gridEl.querySelectorAll('[data-action="undo"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setGameStatus(btn.closest('.game-card').dataset.id, 'backlog');
    });
  });

  gridEl.querySelectorAll('.game-card').forEach((card) => {
    card.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const id = card.dataset.id;
      const result = await window.api.showContextMenu({
        gameId: id,
        x: e.clientX,
        y: e.clientY,
      });
      if (result?.action === 'remove') removeGame(id);
    });
  });
}

async function setGameStatus(id, status) {
  const game = games.find((g) => g.id === id);
  if (!game || game.status === status) return;
  const previousStatus = game.status;
  game.status = status;
  if (previousStatus === 'completed' || status === 'completed') {
    await persistLibraryAndRefreshSuggestions();
  } else {
    await persistLibrary();
  }
}
async function removeGame(id) {
  const game = games.find((g) => g.id === id);
  if (!game) return;

  if (game.custom && game.headerImage && !game.headerImage.startsWith('http')) {
    await window.api.deleteCover(game.headerImage);
  }

  games = games.filter((g) => g.id !== id);
  await persistLibrary();
}

async function handleSuggestionsResult(data) {
  btnRefreshSuggestions.classList.remove('spinning');

  const suggestions = Array.isArray(data) ? data : (data.suggestions || []);
  const reason = Array.isArray(data) ? 'fetch_failed' : (data.reason || 'fetch_failed');

  suggestionReason = reason;
  allSuggestions = suggestions;
  suggestionBasedOn = Array.isArray(data) ? [] : (data.basedOn || []);

  if (suggestions.length === 0) {
    let message = '';
    switch (reason) {
      case 'no_completed':
        message = 'Complete some games to get personalised suggestions.';
        break;
      case 'fetch_failed':
        message = 'Couldn\'t load suggestions. Check your connection and try refreshing.';
        break;
      case 'all_owned':
        message = 'No new suggestions right now. Try completing more games or refresh later.';
        break;
      default:
        message = 'Couldn\'t load suggestions. Check your connection and try refreshing.';
    }
    suggestedTagBar.classList.remove('visible');
    suggestedContainer.innerHTML = `
      <div class="suggestions-empty">
        <span>${message}</span>
      </div>
    `;
    updateSuggestionBasedOn();
    return;
  }

  await renderSuggestions();
}

async function loadSuggestions() {
  if (suggestionFetchInProgress) return;
  suggestionFetchInProgress = true;

  const refreshBtn = document.getElementById('suggestions-refresh-btn')
    || document.getElementById('btn-refresh-suggestions');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.style.opacity = '0.4';
    refreshBtn.style.cursor = 'not-allowed';
    refreshBtn.style.pointerEvents = 'none';
  }

  suggestionFetchToken += 1;
  const myToken = suggestionFetchToken;
  console.log('loadSuggestions token:', myToken);

  const payload = { games, token: myToken };
  if (manualSelectionAppids.length > 0) {
    payload.sourceAppids = manualSelectionAppids;
  }

  try {
    const data = await window.api.steamGetSuggestions(payload);
    console.log('Received suggestions token:', data?.token, 'current:', suggestionFetchToken);
    if (Number(data.token) !== Number(suggestionFetchToken)) {
      console.log('Discarding stale suggestions result');
      return;
    }
    await handleSuggestionsResult(data);
  } catch (err) {
    console.error('Suggestions IPC failed:', err);
    if (Number(myToken) === Number(suggestionFetchToken)) {
      await handleSuggestionsResult({
        suggestions: [],
        reason: 'fetch_failed',
        basedOn: [],
        token: myToken,
      });
    }
  } finally {
    suggestionFetchInProgress = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.style.opacity = '';
      refreshBtn.style.cursor = '';
      refreshBtn.style.pointerEvents = '';
    }
  }
}

async function renderSuggestions() {
  updateSuggestionBasedOn();

  renderTagPills();

  const suggestions = getFilteredSuggestions();

  if (suggestions.length === 0) {
    suggestedContainer.innerHTML =
      '<p class="suggested-placeholder">No suggestions match the selected tags.</p>';
    return;
  }
  suggestedContainer.innerHTML = '<div class="game-grid" id="grid-suggested"></div>';
  const grid = $('#grid-suggested');

  const cards = await Promise.all(
    suggestions.map((s) => buildCardHtml(s, { mode: 'suggested' }))
  );
  grid.innerHTML = cards.join('');
  bindSuggestionCoverFallbacks(grid);
  bindCardClicks(grid);

  grid.querySelectorAll('[data-action="add"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const appid = Number(btn.closest('.game-card').dataset.appid);
      const suggestion = getFilteredSuggestions().find((s) => s.appid === appid);
      if (suggestion) await addSteamGameFromSuggestion(suggestion);    });
  });
}

async function addSteamGameFromSuggestion(suggestion) {
  if (games.some((g) => g.appid === suggestion.appid)) return;

  const { tags } = await window.api.steamFetchTags(suggestion.appid);

  games.push({
    id: generateId(),
    appid: suggestion.appid,
    name: suggestion.name,
    headerImage: suggestion.headerImage,
    storeUrl: suggestion.storeUrl,
    custom: false,
    status: 'backlog',
    tags,
    addedAt: Date.now(),
  });

  await persistLibrary();
}

async function searchSteam(term) {
  if (!term.trim()) {
    hideSearchResults();
    return;
  }

  const { items, error } = await window.api.steamSearch(term);

  if (error || !items?.length) {
    searchResults.innerHTML = `<div class="search-empty">${error ? 'Search failed — check your connection' : 'No games found'}</div>`;
    searchResults.classList.add('visible');
    return;
  }

  searchResults.innerHTML = items
    .slice(0, 8)
    .map(
      (item) => `
      <div class="search-result" data-appid="${item.id}">
        <img src="${escapeAttr(item.tiny_image || '')}" alt="">
        <span>${escapeHtml(item.name)}</span>
      </div>`
    )
    .join('');

  searchResults.classList.add('visible');

  searchResults.querySelectorAll('.search-result').forEach((el) => {
    el.addEventListener('click', () =>
      addSteamGame({
        appid: Number(el.dataset.appid),
        name: el.querySelector('span').textContent,
      })
    );
  });
}

async function addSteamGame({ appid, name }) {
  if (games.some((g) => g.appid === appid)) {
    steamSearch.value = '';
    hideSearchResults();
    return;
  }

  const { tags } = await window.api.steamFetchTags(appid);

  games.push({
    id: generateId(),
    appid,
    name,
    headerImage: `${STEAM_CDN}/${appid}/library_600x900.jpg`,
    storeUrl: `${STEAM_STORE_APP}${appid}/`,
    custom: false,
    status: 'backlog',
    tags,
    addedAt: Date.now(),
  });

  steamSearch.value = '';
  hideSearchResults();
  await persistLibrary();
}

function hideSearchResults() {
  searchResults.classList.remove('visible');
  searchResults.innerHTML = '';
}

function openCustomModal() {
  customModal.classList.add('visible');
  customName.value = '';
  customCoverPath = null;
  customCoverPreviewUrl = null;
  coverPreview.innerHTML = 'No image';
  btnSubmitCustom.disabled = true;
}

function closeCustomModal() {
  customModal.classList.remove('visible');
  if (customCoverPreviewUrl) URL.revokeObjectURL(customCoverPreviewUrl);
  customCoverPath = null;
  customCoverPreviewUrl = null;
}

function validateCustomForm() {
  btnSubmitCustom.disabled = !(customName.value.trim() && customCoverPath);
}

steamSearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => searchSteam(steamSearch.value), 300);
});

steamSearch.addEventListener('focus', () => {
  if (steamSearch.value.trim()) searchSteam(steamSearch.value);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) hideSearchResults();
  if (!e.target.closest('#tag-filter-wrap')) closeTagOverflow();
});

basedOnBtn.addEventListener('click', () => {
  openGameSelectDialog();
});

basedOnClear.addEventListener('click', () => {
  clearManualSelection();
});

$('#game-select-close').addEventListener('click', () => {
  closeGameSelectDialog();
});

gameSelectOverlay.addEventListener('click', (e) => {
  if (e.target === gameSelectOverlay) closeGameSelectDialog();
});

$('#game-select-find').addEventListener('click', async () => {
  const checked = [
    ...gameSelectList.querySelectorAll('input[type="checkbox"]:checked'),
  ].map((input) => input.value);

  manualSelectionAppids = checked.length === 0 ? [] : checked;
  closeGameSelectDialog();
  updateSuggestionBasedOn();
  await loadSuggestions();
});

btnRefreshSuggestions.addEventListener('click', () => scheduleSuggestionLoad());

sortSelect.addEventListener('change', () => {
  activeSort = sortSelect.value;
  renderSections();
});

btnAddCustom.addEventListener('click', openCustomModal);
btnCancelCustom.addEventListener('click', closeCustomModal);
customModal.addEventListener('click', (e) => {
  if (e.target === customModal) closeCustomModal();
});

customName.addEventListener('input', validateCustomForm);

btnPickCover.addEventListener('click', async () => {
  const filePath = await window.api.pickImage();
  if (!filePath) return;

  customCoverPath = filePath;
  if (customCoverPreviewUrl) URL.revokeObjectURL(customCoverPreviewUrl);
  customCoverPreviewUrl = `file://${filePath.replace(/\\/g, '/')}`;
  coverPreview.innerHTML = `<img src="${customCoverPreviewUrl}" alt="Cover preview">`;
  validateCustomForm();
});

customForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!customName.value.trim() || !customCoverPath) return;

  const id = generateId();
  const relativePath = await window.api.saveCover({ id, sourcePath: customCoverPath });

  games.push({
    id,
    appid: 'custom_' + Date.now().toString(36) + Math.random().toString(36).substr(2),
    name: customName.value.trim(),
    headerImage: relativePath,
    custom: true,
    status: 'backlog',
    tags: [],
    addedAt: Date.now(),
  });

  closeCustomModal();
  await persistLibrary();
});

function showToast(message, color = '#c6d4df', duration = 2500) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.color = color;
  toast.classList.add('visible');

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove('visible');
  }, duration);
}

window.api.onTriggerRefresh(() => {
  if (document.getElementById('refresh-overlay')) {
    setTimeout(() => window.location.reload(), 400);
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'refresh-overlay';
  overlay.style.cssText = `
  position: fixed; inset: 0; z-index: 9999;
  background: #1b2838;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 16px;
`;
  overlay.innerHTML = `
  <svg width="48" height="48" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="20"
      fill="none" stroke="#2a475e" stroke-width="4"/>
    <circle cx="24" cy="24" r="20"
      fill="none" stroke="#4d9ddb" stroke-width="4"
      stroke-linecap="round" stroke-dasharray="30 96"
      style="transform-origin:center;
             animation:spin 0.8s linear infinite;"/>
  </svg>
  <span style="color:#c6d4df; font-size:14px;
               font-family:'Motiva Sans','Segoe UI',sans-serif;">
    Refreshing…
  </span>
`;
  document.body.appendChild(overlay);

  setTimeout(() => window.location.reload(), 400);
});
function showMergeDialog() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('merge-overlay');
    overlay.style.display = 'flex';

    const cleanup = (result) => {
      overlay.style.display = 'none';
      resolve(result);
    };

    document.getElementById('merge-btn-merge')
      .onclick = () => cleanup('merge');
    document.getElementById('merge-btn-replace')
      .onclick = () => cleanup('replace');
    document.getElementById('merge-btn-cancel')
      .onclick = () => cleanup('cancel');

    overlay.onclick = (e) => {
      if (e.target === overlay) cleanup('cancel');
    };
  });
}

window.api.onExportSuccess(() =>
  showToast('Library exported successfully', '#c6d4df', 2500)
);
window.api.onShowToast((payload) => {
  showToast(payload?.message || '', payload?.color || '#c6d4df', 3000);
});

window.api.onShowMergeDialog(() => showMergeDialog());

document.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const isActive = item.classList.contains('active');
    document.querySelectorAll('.menu-item').forEach((i) => i.classList.remove('active'));
    if (!isActive) item.classList.add('active');
  });
});

document.addEventListener('click', () => {
  document.querySelectorAll('.menu-item').forEach((i) => i.classList.remove('active'));
});

document.getElementById('opt-refresh').addEventListener('click', () => {
  window.api.triggerRefresh();
});

document.getElementById('opt-export').addEventListener('click', () => {
  window.api.exportLibrary();
});

document.getElementById('opt-load').addEventListener('click', () => {
  window.api.loadLibrary();
});

document.getElementById('opt-github').addEventListener('click', () => {
  window.api.openGithub();
});

loadLibrary();
