// js/map.js — Complete map script (final).
// - Only one players display: draggable floating panel (no 'inline' or 'top').
// - Connectors drawn from the players panel to assigned buildings.
// - Popups, drag/drop assignment, postMessage live updates, polling fallback, autosave,
//   grid rendering, stage notes, and all other features preserved.
//
// Resource-conservative poll/load behavior included (conditional requests, timeouts, backoff, visibility checks).

'use strict';

/* ========================
   CONFIG / STATE
   ======================== */
const CONFIG = {
  GRID_SIZE: 12,
  TILE_WIDTH: 120,
  TILE_HEIGHT: 100,
  SHOW_GRID_BY_DEFAULT: true,
  GRID_LABELS: false,
  CLICK_MARKER_MS: 900,
  POLL_ENABLED: true,
  POLL_INTERVAL_MS: 2500
};

// Auto-disable polling on mobile by default to protect free hosts
try {
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width:900px)').matches) {
    CONFIG.POLL_ENABLED = false;
    console.info('[map] mobile detected — polling disabled by default to reduce network usage');
  }
} catch (e) { /* ignore */ }

let mapData = null;
let currentLegionIndex = 0;
let currentStageNumber = 1;
let showGrid = CONFIG.SHOW_GRID_BY_DEFAULT;

let CLIP = { minX: 0, maxX: 0, minY: 0, maxY: 0, minS: 0, maxS: 0 };

let layout = {
  tileWidth: CONFIG.TILE_WIDTH,
  tileHeight: CONFIG.TILE_HEIGHT,
  playWidth: 0,
  playHeight: 0,
  centerX: 0,
  centerY: 0,
  playLeft: 0,
  playTop: 0,
  wrapperWidth: 0,
  wrapperHeight: 0,
  mapRect: null,
  parentRect: null
};

/* ========================
   DOM REFS
   ======================== */
const mapEl = document.getElementById('map');
let tileOverlay = null;
let coordsPanel = null;
let coordsContent = null;
let copyCoordsBtn = null;
let closeCoordsBtn = null;
let clickMarker = null;
let stageNoteEl = null;

let playersPanel = null;
let playersHeader = null;
let playersToggleBtn = null;
let connectorsSvg = null;

let playersPanelVisible = true; // single display mode

let docClickHandlerAdded = false;
const popupStore = new Map();

/* expose minimal globals for debugging */
try {
  window.mapData = mapData;
  window.currentLegionIndex = currentLegionIndex;
  window.currentStageNumber = currentStageNumber;
  window.playersPanelVisible = playersPanelVisible;
} catch (e){}

/* ========================
   HELPERS
   ======================== */
function el(id){ return document.getElementById(id); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }

function computeClipFromGridSize(){
  const n = Math.max(1, Math.floor(CONFIG.GRID_SIZE));
  const halfLow = Math.floor((n - 1) / 2);
  const min = -halfLow;
  const max = min + n - 1;
  CLIP.minX = min; CLIP.maxX = max;
  CLIP.minY = min; CLIP.maxY = max;
  CLIP.minS = min; CLIP.maxS = max;
}

function computeLayout(){
  computeClipFromGridSize();
  layout.tileWidth = CONFIG.TILE_WIDTH;
  layout.tileHeight = CONFIG.TILE_HEIGHT;
  layout.playWidth = CONFIG.GRID_SIZE * layout.tileWidth;
  layout.playHeight = CONFIG.GRID_SIZE * layout.tileHeight;

  document.documentElement.style.setProperty('--play-width', Math.round(layout.playWidth) + 'px');
  document.documentElement.style.setProperty('--play-height', Math.round(layout.playHeight) + 'px');
  document.documentElement.style.setProperty('--tile-width', Math.round(layout.tileWidth) + 'px');
  document.documentElement.style.setProperty('--tile-height', Math.round(layout.tileHeight) + 'px');
  document.documentElement.style.setProperty('--building-size', Math.round(layout.tileWidth) + 'px');

  const mapRect = mapEl.getBoundingClientRect();
  const parentRect = (mapEl.parentElement || document.body).getBoundingClientRect();
  layout.mapRect = mapRect;
  layout.parentRect = parentRect;

  layout.wrapperWidth = mapRect.width || layout.playWidth;
  layout.wrapperHeight = mapRect.height || layout.playHeight;
  layout.playLeft = (layout.wrapperWidth - layout.playWidth) / 2;
  layout.playTop = (layout.wrapperHeight - layout.playHeight) / 2;
  layout.centerX = layout.playLeft + layout.playWidth / 2;
  layout.centerY = layout.playTop + layout.playHeight / 2;
}

function screenFromGrid(gx, gy){
  return { x: layout.centerX + (gx - gy) * (layout.tileWidth / 2), y: layout.centerY + (gx + gy) * (layout.tileHeight / 2) };
}
function gridFromScreen(sx, sy){
  const relX = sx - layout.centerX;
  const relY = sy - layout.centerY;
  const a = layout.tileWidth / 2;
  const b = layout.tileHeight / 2;
  const gx = 0.5 * (relX / a + relY / b);
  const gy = 0.5 * (relY / b - relX / a);
  return { gx, gy };
}

function hashStringToHue(s){
  let h = 0;
  for (let i=0;i<s.length;i++){ h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h) % 360;
}
function colorForBuildingId(id){
  const hue = hashStringToHue(String(id || 'b'));
  return `hsl(${hue} 78% 45%)`;
}

/* ========================
   SCHEDULING
   ======================== */
let pendingDraw = false;
function scheduleDrawConnectors(){
  if (pendingDraw) return;
  pendingDraw = true;
  requestAnimationFrame(() => { pendingDraw = false; try { drawConnectorsForCurrentStage(); } catch(e){} });
}

/* ========================
   GRID RENDERING
   ======================== */
function renderGrid(enable){
  if (!mapEl) return;
  mapEl.querySelectorAll('.iso-grid-line').forEach(n=>n.remove());
  if (!enable) return;

  const tileW = Math.round(layout.tileWidth);
  const tileH = Math.round(layout.tileHeight);
  const mapRect = layout.mapRect || mapEl.getBoundingClientRect();

  for (let x = CLIP.minX; x <= CLIP.maxX; x++) {
    for (let y = CLIP.minY; y <= CLIP.maxY; y++) {
      const s = x + y;
      if (s < CLIP.minS || s > CLIP.maxS) continue;
      const center = screenFromGrid(x, y);
      const playLeft = (mapRect.width - layout.playWidth) / 2;
      const playTop = (mapRect.height - layout.playHeight) / 2;
      const margin = 20;
      if (center.x < playLeft - margin || center.x > playLeft + layout.playWidth + margin) continue;
      if (center.y < playTop - margin || center.y > playTop + layout.playHeight + margin) continue;

      const tile = document.createElement('div');
      tile.className = 'iso-grid-line';
      tile.style.left = center.x + 'px';
      tile.style.top = center.y + 'px';
      tile.style.width = tileW + 'px';
      tile.style.height = tileH + 'px';
      tile.style.transform = 'translate(-50%,-50%)';

      if (CONFIG.GRID_LABELS) {
        const lbl = document.createElement('div');
        lbl.className = 'tile-label';
        lbl.textContent = `${x},${y}`;
        tile.appendChild(lbl);
      }

      mapEl.appendChild(tile);
    }
  }
}

/* ========================
   POPUPS
   ======================== */
function showPopupForBuilding(buildingId, opts = { persistent: false }) {
  const popup = popupStore.get(buildingId);
  if (!popup || !mapEl) return;
  popup.dataset.persistent = opts.persistent ? '1' : '';

  const bEl = Array.from(mapEl.querySelectorAll('.building')).find(d => d.dataset.buildingId === buildingId);
  if (!bEl) return;

  const mapRect = layout.mapRect || mapEl.getBoundingClientRect();
  const bRect = bEl.getBoundingClientRect();

  popup.style.display = 'block';
  popup.style.visibility = 'hidden';
  popup.style.left = '0px';
  popup.style.top = '0px';

  const popupW = popup.offsetWidth || popup.getBoundingClientRect().width;
  const popupH = popup.offsetHeight || popup.getBoundingClientRect().height;

  const desiredLeft = (bRect.left - mapRect.left) + (bRect.width / 2) - (popupW / 2);
  const desiredTop = (bRect.top - mapRect.top) - popupH - 8;

  const pad = 6;
  popup.style.left = Math.round(clamp(desiredLeft, pad, Math.max(pad, mapRect.width - popupW - pad))) + 'px';
  popup.style.top = Math.round(clamp(desiredTop, pad, Math.max(pad, mapRect.height - popupH - pad))) + 'px';
  popup.style.visibility = 'visible';
}
function hidePopup(popupEl, force = false) {
  if (!popupEl) return;
  if (!force && popupEl.dataset.persistent === '1') return;
  popupEl.style.display = 'none';
  popupEl.dataset.persistent = '';
}

/* ========================
   POSITION BUILDINGS
   ======================== */
function positionBuildings(){
  if (!mapEl) return;
  computeLayout();
  const domBuildings = Array.from(mapEl.querySelectorAll('.building'));
  domBuildings.forEach(div => {
    const meta = div._meta || {};
    const img = div.querySelector('img');
    const names = div.querySelector('.player-names');

    div.style.width = Math.round(layout.tileWidth) + 'px';
    div.style.height = Math.round(layout.tileHeight) + 'px';
    div.style.overflow = 'visible';

    let center = { x: layout.centerX, y: layout.centerY };
    if (typeof meta.gridX !== 'undefined' && typeof meta.gridY !== 'undefined' && meta.gridX !== '' && meta.gridY !== '') {
      center = screenFromGrid(Number(meta.gridX), Number(meta.gridY));
    } else if (typeof meta.coords_x !== 'undefined' && typeof meta.coords_y !== 'undefined') {
      const px = (Number(meta.coords_x) || 0) / 100;
      const py = (Number(meta.coords_y) || 0) / 100;
      center.x = layout.playLeft + px * layout.playWidth;
      center.y = layout.playTop + py * layout.playHeight;
    }

    div.style.left = Math.round(center.x) + 'px';
    div.style.top = Math.round(center.y) + 'px';
    div.style.transform = 'translate(-50%,-50%)';

    const imgScale = (typeof meta.img_scale === 'number' && meta.img_scale > 0) ? meta.img_scale : 1.0;
    if (img) {
      img.style.width = (100 * imgScale) + '%';
      img.style.height = (100 * imgScale) + '%';
      img.style.objectFit = 'contain';
      img.style.position = 'absolute';
      img.style.left = '50%';
      img.style.top = '50%';
      img.style.transform = 'translate(-50%,-50%)';
      img.style.pointerEvents = 'auto';
    }

    // No inline badges — we use the floating panel only
    if (names){
      names.innerHTML = '';
      names.style.display = 'none';
    }
  });

  popupStore.forEach(p => { p.style.display = 'none'; p.dataset.persistent = ''; });

  renderGrid(showGrid);
  document.documentElement.style.setProperty('--play-width', Math.round(layout.playWidth) + 'px');
  document.documentElement.style.setProperty('--play-height', Math.round(layout.playHeight) + 'px');

  updatePlayersPanel();
}

/* ========================
   UI: panels (single floating panel kept)
   ======================== */
function ensureUIElements(){
  if (!mapEl) throw new Error('#map element not found');

  if (!tileOverlay){
    tileOverlay = document.createElement('div');
    tileOverlay.id = 'tileOverlay';
    tileOverlay.className = 'tile-overlay';
    tileOverlay.style.display = 'none';
    mapEl.appendChild(tileOverlay);
  }

  if (!coordsPanel){
    coordsPanel = document.createElement('div');
    coordsPanel.id = 'mapCoords';
    coordsPanel.className = 'map-coords';
    coordsPanel.style.display = 'none';
    coordsContent = document.createElement('div');
    coordsContent.id = 'coordsContent';
    coordsPanel.appendChild(coordsContent);
    const actions = document.createElement('div'); actions.className = 'coords-actions';
    copyCoordsBtn = document.createElement('button'); copyCoordsBtn.id = 'copyCoordsBtn'; copyCoordsBtn.type = 'button'; copyCoordsBtn.textContent = 'Copy (gridX,gridY)';
    closeCoordsBtn = document.createElement('button'); closeCoordsBtn.id = 'closeCoordsBtn'; closeCoordsBtn.type = 'button'; closeCoordsBtn.textContent = 'Close';
    actions.appendChild(copyCoordsBtn); actions.appendChild(closeCoordsBtn); coordsPanel.appendChild(actions);
    (mapEl.parentElement || document.body).appendChild(coordsPanel);

    copyCoordsBtn.addEventListener('click', async ()=> {
      const gx = coordsPanel.dataset.gridX, gy = coordsPanel.dataset.gridY;
      if (typeof gx === 'undefined' || typeof gy === 'undefined') return;
      try { await navigator.clipboard.writeText(`${gx},${gy}`); const prev = copyCoordsBtn.textContent; copyCoordsBtn.textContent = 'Copied'; setTimeout(()=> copyCoordsBtn.textContent = prev, 1200); } catch (e) { alert('Copy failed'); }
    });
    closeCoordsBtn.addEventListener('click', ()=> { coordsPanel.style.display = 'none'; if (tileOverlay) tileOverlay.style.display = 'none'; });
  } else {
    coordsContent = coordsContent || coordsPanel.querySelector('#coordsContent');
    copyCoordsBtn = copyCoordsBtn || coordsPanel.querySelector('#copyCoordsBtn');
    closeCoordsBtn = closeCoordsBtn || coordsPanel.querySelector('#closeCoordsBtn');
  }

  if (!clickMarker){
    clickMarker = document.createElement('div');
    clickMarker.id = 'mapClickMarker';
    clickMarker.className = 'map-click-marker';
    clickMarker.style.display = 'none';
    mapEl.appendChild(clickMarker);
  }

  if (!stageNoteEl){
    stageNoteEl = document.createElement('div');
    stageNoteEl.id = 'stageNote';
    stageNoteEl.className = 'stage-note';
    stageNoteEl.style.position = 'absolute';
    stageNoteEl.style.left = '50%';
    stageNoteEl.style.top = '8px';
    stageNoteEl.style.transform = 'translateX(-50%)';
    stageNoteEl.style.zIndex = '13000';
    stageNoteEl.style.padding = '6px 10px';
    stageNoteEl.style.background = 'rgba(255,255,255,0.92)';
    stageNoteEl.style.borderRadius = '8px';
    stageNoteEl.style.boxShadow = '0 6px 18px rgba(0,0,0,0.12)';
    stageNoteEl.style.display = 'none';
    (mapEl.parentElement || document.body).appendChild(stageNoteEl);
  }

  ensurePlayersPanel();
}

function ensurePlayersPanel(){
  const parent = mapEl.parentElement || document.body;

  playersPanel = document.getElementById('playersPanel');
  if (!playersPanel){
    playersPanel = document.createElement('div');
    playersPanel.id = 'playersPanel';
    playersPanel.style.position = 'absolute';
    playersPanel.style.right = '12px';
    playersPanel.style.top = '12px';
    playersPanel.style.display = playersPanelVisible ? 'block' : 'none';
    playersPanel.style.touchAction = 'none';
    playersPanel.style.zIndex = 25000;
    playersPanel.style.maxWidth = '320px';
    playersPanel.style.background = 'rgba(255,255,255,0.98)';
    playersPanel.style.border = '1px solid rgba(0,0,0,0.04)';
    playersPanel.style.borderRadius = '10px';
    playersPanel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.12)';
    parent.appendChild(playersPanel);
  } else {
    playersPanel.style.display = playersPanelVisible ? 'block' : 'none';
  }

  playersHeader = document.getElementById('playersHeader');
  if (!playersHeader){
    playersHeader = document.createElement('div');
    playersHeader.id = 'playersHeader';
    playersHeader.className = 'players-drag-handle';
    playersHeader.textContent = 'Players';
    playersHeader.style.cursor = 'grab';
    playersHeader.style.padding = '8px';
    playersHeader.style.fontWeight = '700';
    playersHeader.style.textAlign = 'center';
    playersPanel.insertBefore(playersHeader, playersPanel.firstChild);
  }

  makePanelDraggable(playersPanel, playersHeader, parent);

  playersToggleBtn = document.getElementById('playersToggleBtn');
  if (!playersToggleBtn){
    playersToggleBtn = document.createElement('button');
    playersToggleBtn.id = 'playersToggleBtn';
    playersToggleBtn.className = 'players-toggle btn';
    playersToggleBtn.textContent = playersPanelVisible ? 'Hide Players' : 'Show Players';
    playersToggleBtn.style.position = 'absolute';
    playersToggleBtn.style.right = '12px';
    playersToggleBtn.style.top = '4px';
    playersToggleBtn.style.zIndex = '25010';
    parent.appendChild(playersToggleBtn);
    playersToggleBtn.addEventListener('click', ()=> {
      playersPanelVisible = !playersPanelVisible;
      playersPanel.style.display = playersPanelVisible ? 'block' : 'none';
      playersToggleBtn.textContent = playersPanelVisible ? 'Hide Players' : 'Show Players';
      scheduleDrawConnectors();
    });
  } else {
    playersToggleBtn.textContent = playersPanelVisible ? 'Hide Players' : 'Show Players';
  }

  connectorsSvg = document.getElementById('connectorsSvg');
  if (!connectorsSvg){
    connectorsSvg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    connectorsSvg.id = 'connectorsSvg';
    connectorsSvg.style.position = 'absolute';
    connectorsSvg.style.left = '0';
    connectorsSvg.style.top = '0';
    connectorsSvg.style.width = '100%';
    connectorsSvg.style.height = '100%';
    connectorsSvg.style.pointerEvents = 'none';
    connectorsSvg.style.zIndex = '26000';
    (mapEl.parentElement || document.body).appendChild(connectorsSvg);
  } else {
    connectorsSvg.style.position = connectorsSvg.style.position || 'absolute';
  }
}

function makePanelDraggable(panel, handle, parent){
  if (!panel || !handle) return;
  handle.style.touchAction = 'none';
  let dragging = false;
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0;
  let parentRect = null;

  const onPointerDown = (ev) => {
    ev.preventDefault();
    dragging = true;
    handle.style.cursor = 'grabbing';
    panel.classList.add('players-dragging');
    parentRect = parent.getBoundingClientRect();
    const clientX = ev.clientX !== undefined ? ev.clientX : (ev.touches && ev.touches[0].clientX);
    const clientY = ev.clientY !== undefined ? ev.clientY : (ev.touches && ev.touches[0].clientY);
    startX = clientX; startY = clientY;
    const panelRect = panel.getBoundingClientRect();
    startLeft = panelRect.left - parentRect.left;
    startTop = panelRect.top - parentRect.top;
    panel.style.left = (startLeft) + 'px';
    panel.style.right = '';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('touchmove', onPointerMove, { passive:false });
    window.addEventListener('touchend', onPointerUp);
  };

  const onPointerMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    const clientX = ev.clientX !== undefined ? ev.clientX : (ev.touches && ev.touches[0].clientX);
    const clientY = ev.clientY !== undefined ? ev.clientY : (ev.touches && ev.touches[0].clientY);
    const dx = clientX - startX;
    const dy = clientY - startY;
    const maxLeft = parentRect.width - panel.offsetWidth - 6;
    const maxTop = parentRect.height - panel.offsetHeight - 6;
    let newLeft = Math.round(startLeft + dx);
    let newTop = Math.round(startTop + dy);
    newLeft = clamp(newLeft, 6, Math.max(6, maxLeft));
    newTop = clamp(newTop, 6, Math.max(6, maxTop));
    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
    scheduleDrawConnectors();
  };

  const onPointerUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = 'grab';
    panel.classList.remove('players-dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('touchmove', onPointerMove);
    window.removeEventListener('touchend', onPointerUp);
    scheduleDrawConnectors();
  };

  handle.removeEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointerdown', onPointerDown);
  handle.removeEventListener('touchstart', onPointerDown);
  handle.addEventListener('touchstart', onPointerDown, { passive:false });
}

/* ========================
   PLAYERS PANEL RENDERING
   ======================== */
function updatePlayersPanel(){
  ensurePlayersPanel();

  playersPanel.innerHTML = '';
  if (playersHeader) playersPanel.appendChild(playersHeader);

  const lg = mapData?.legion_data?.[currentLegionIndex];
  if (!lg){
    const empty = document.createElement('div');
    empty.textContent = 'No legion data';
    empty.style.padding = '8px';
    playersPanel.appendChild(empty);
    scheduleDrawConnectors();
    return;
  }

  const title = document.createElement('div');
  title.textContent = lg.legion_id || ('Legion ' + (currentLegionIndex+1));
  title.style.fontWeight = '600';
  title.style.margin = '6px 4px';
  title.style.textAlign = 'center';
  playersPanel.appendChild(title);

  // Add building filter dropdown
  const filterRow = document.createElement('div');
  filterRow.style.padding = '6px';
  filterRow.style.borderBottom = '1px solid rgba(0,0,0,0.08)';
  
  const filterLabel = document.createElement('label');
  filterLabel.textContent = 'Filter by building: ';
  filterLabel.style.fontSize = '11px';
  filterLabel.style.color = '#666';
  
  const filterSelect = document.createElement('select');
  filterSelect.style.fontSize = '11px';
  filterSelect.style.padding = '2px 4px';
  filterSelect.style.marginLeft = '4px';
  filterSelect.style.width = 'calc(100% - 4px)';
  filterSelect.style.marginTop = '4px';
  
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = '-- Show all players --';
  filterSelect.appendChild(allOption);
  
  // Get current stage assignments to show relevant buildings
  const stage = (lg.stages || []).find(s => s.stage_number === currentStageNumber);
  const assignedBuildings = new Set();
  if (stage) {
    (stage.assignments || []).forEach(a => {
      if (a.building_id) assignedBuildings.add(a.building_id);
    });
  }
  
  // Add building options
  (mapData.buildings || []).forEach(b => {
    if (assignedBuildings.has(b.id)) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `${b.id}${b.name_ar ? ' - ' + b.name_ar : ''}`;
      filterSelect.appendChild(opt);
    }
  });
  
  filterRow.appendChild(filterLabel);
  filterRow.appendChild(filterSelect);
  playersPanel.appendChild(filterRow);

  const players = lg.all_players || [];
  if (!players.length){
    const none = document.createElement('div');
    none.textContent = 'No players';
    none.style.padding = '8px';
    playersPanel.appendChild(none);
    scheduleDrawConnectors();
    return;
  }

  // Container for player rows (will be filtered)
  const playersContainer = document.createElement('div');
  playersContainer.id = 'playersContainer';
  
  const renderPlayers = (filterBuildingId = '') => {
    playersContainer.innerHTML = '';
    
    // Get players assigned to the selected building
    let visiblePlayers = players;
    if (filterBuildingId && stage) {
      const assignment = stage.assignments?.find(a => a.building_id === filterBuildingId);
      if (assignment) {
        visiblePlayers = players.filter(p => assignment.player_names?.includes(p));
      } else {
        visiblePlayers = [];
      }
    }
    
    if (visiblePlayers.length === 0 && filterBuildingId) {
      const noMatch = document.createElement('div');
      noMatch.textContent = 'No players assigned to this building';
      noMatch.style.padding = '8px';
      noMatch.style.fontSize = '12px';
      noMatch.style.color = '#666';
      noMatch.style.fontStyle = 'italic';
      playersContainer.appendChild(noMatch);
      scheduleDrawConnectors();
      return;
    }
    
    visiblePlayers.forEach(p => {
      const row = document.createElement('div');
      row.className = 'players-row';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.padding = '6px';
      row.style.borderBottom = '1px dashed rgba(0,0,0,0.06)';

      const nameEl = document.createElement('div');
      nameEl.className = 'pname';
      nameEl.textContent = p;
      nameEl.style.flex = '1';
      nameEl.style.marginRight = '8px';
      nameEl.style.fontSize = '13px';
      nameEl.style.wordBreak = 'break-word';

      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Jump';
      btn.addEventListener('click', ()=> highlightPlayerAssignments(p));

      // enable drag from panel rows to buildings
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', (ev) => {
        try {
          ev.dataTransfer.setData('text/plain', JSON.stringify({ type: 'player-assign', player: p }));
        } catch (e) {}
      });

      row.appendChild(nameEl);
      row.appendChild(btn);
      playersContainer.appendChild(row);
    });
    
    scheduleDrawConnectors();
  };
  
  // Initial render
  renderPlayers();
  
  // Filter event
  filterSelect.addEventListener('change', () => {
    const buildingId = filterSelect.value;
    renderPlayers(buildingId);
    
    // Highlight the selected building if one is chosen
    if (buildingId) {
      document.querySelectorAll('.building').forEach(b => b.classList.remove('highlighted'));
      const buildingEl = Array.from(document.querySelectorAll('.building')).find(b => b.dataset.buildingId === buildingId);
      if (buildingEl) {
        buildingEl.classList.add('highlighted');
        setTimeout(() => buildingEl.classList.remove('highlighted'), 3000);
      }
    }
  });
  
  playersPanel.appendChild(playersContainer);
  playersPanel.style.display = playersPanelVisible ? 'block' : 'none';
  scheduleDrawConnectors();
}

/* ========================
   DRAW CONNECTORS (from panel)
   ======================== */
function drawConnectorsForCurrentStage(){
  if (!connectorsSvg) return;
  while (connectorsSvg.firstChild) connectorsSvg.removeChild(connectorsSvg.firstChild);

  const parentRect = layout.parentRect || (mapEl.parentElement || document.body).getBoundingClientRect();
  const mapRect = layout.mapRect || mapEl.getBoundingClientRect();

  const legion = mapData.legion_data?.[currentLegionIndex] || {};
  const stage = (legion.stages || []).find(s => s.stage_number === currentStageNumber);
  if (!stage) return;

  const playerToBuildings = {};
  (stage.assignments || []).forEach(assign => {
    (assign.player_names || []).forEach(pname => {
      playerToBuildings[pname] = playerToBuildings[pname] || [];
      playerToBuildings[pname].push(assign.building_id);
    });
  });

  if (!playersPanel || playersPanel.style.display === 'none') return;
  const rows = Array.from(playersPanel.querySelectorAll('.players-row'));
  rows.forEach(row => {
    const nameEl = row.querySelector('.pname');
    if (!nameEl) return;
    const pname = nameEl.textContent;
    if (!playerToBuildings[pname] || !playerToBuildings[pname].length) return;
    const nameRect = nameEl.getBoundingClientRect();
    const padX = 6, padY = 4;
    const rx = nameRect.left - parentRect.left - padX;
    const ry = nameRect.top - parentRect.top - padY;
    const rw = nameRect.width + padX*2;
    const rh = nameRect.height + padY*2;

    const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
    rect.setAttribute('x', rx);
    rect.setAttribute('y', ry);
    rect.setAttribute('width', rw);
    rect.setAttribute('height', rh);
    rect.setAttribute('rx', 6);
    rect.setAttribute('ry', 6);
    rect.setAttribute('fill', 'rgba(255,255,255,0.02)');
    rect.setAttribute('stroke', '#999');
    rect.setAttribute('stroke-width', '1.2');
    rect.setAttribute('opacity', '0.4');
    connectorsSvg.appendChild(rect);

    const panelRect = playersPanel.getBoundingClientRect();
    const panelIsRight = panelRect.left > (mapRect.left + mapRect.width / 2);
    const sx = panelIsRight ? rx : (rx + rw);
    const sy = ry + rh/2;

    let instanceIndex = 0;
    const total = playerToBuildings[pname].length;
    playerToBuildings[pname].forEach(buildingId => {
      const bdiv = Array.from(mapEl.querySelectorAll('.building')).find(d => d.dataset.buildingId === buildingId);
      if (!bdiv) return;
      const bRect = bdiv.getBoundingClientRect();
      const bx = bRect.left + bRect.width/2 - parentRect.left;
      const by = bRect.top + bRect.height/2 - parentRect.top;
      const color = colorForBuildingId(buildingId);

      const idx = instanceIndex++;
      const spread = Math.min(14, 6 + Math.floor(total/3));
      const offset = (idx - (total-1)/2) * spread;
      
      // Improved curve smoothing with better control points
      const dx = bx - sx;
      const dy = by - sy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const smoothness = Math.min(0.5, dist / 500); // Adaptive smoothness
      
      const midX1 = sx + dx * smoothness;
      const midX2 = bx - dx * smoothness;
      const controlY1 = sy + offset * 0.4;
      const controlY2 = by + offset * 0.4;
      
      const d = `M ${sx} ${sy} C ${midX1} ${controlY1}, ${midX2} ${controlY2}, ${bx} ${by}`;

      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', color);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', String(2.2));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('opacity', '0.6'); // Reduced opacity for less visual clutter
      connectorsSvg.appendChild(path);

      const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
      circle.setAttribute('cx', bx);
      circle.setAttribute('cy', by);
      circle.setAttribute('r', String(4.0));
      circle.setAttribute('fill', color);
      circle.setAttribute('opacity', '0.8');
      connectorsSvg.appendChild(circle);

      const anchor = document.createElementNS('http://www.w3.org/2000/svg','circle');
      anchor.setAttribute('cx', sx);
      anchor.setAttribute('cy', sy);
      anchor.setAttribute('r', String(2.5));
      anchor.setAttribute('fill', color);
      anchor.setAttribute('opacity', '0.7');
      connectorsSvg.appendChild(anchor);
    });
  });
}

/* ========================
   INTERACTIONS
   ======================== */
function mapClickHandler(ev){
  if (!mapEl) return;
  const rect = mapEl.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;

  if (clickMarker) {
    clickMarker.style.left = x + 'px';
    clickMarker.style.top = y + 'px';
    clickMarker.style.display = 'block';
    setTimeout(() => clickMarker.style.display = 'none', CONFIG.CLICK_MARKER_MS);
  }

  const { gx, gy } = gridFromScreen(x, y);
  const gxSnap = Math.round(gx);
  const gySnap = Math.round(gy);

  ensureUIElements();

  coordsContent.innerHTML = `
    <div><strong>Tile (snapped):</strong> ${gxSnap}, ${gySnap}</div>
    <div><strong>Tile (float):</strong> ${gx.toFixed(2)}, ${gy.toFixed(2)}</div>
    <div><strong>tileW:</strong> ${Math.round(layout.tileWidth)} px</div>
  `;
  coordsPanel.style.display = 'block';
  coordsPanel.dataset.gridX = gxSnap;
  coordsPanel.dataset.gridY = gySnap;

  if (tileOverlay) {
    tileOverlay.style.width = Math.round(layout.tileWidth) + 'px';
    tileOverlay.style.height = Math.round(layout.tileHeight) + 'px';
    const pos = screenFromGrid(gxSnap, gySnap);
    tileOverlay.style.left = pos.x + 'px';
    tileOverlay.style.top = pos.y + 'px';
    tileOverlay.style.transform = 'translate(-50%,-50%)';
    tileOverlay.style.display = 'block';
  }
}

/* ========================
   CONTROLS / BUILD MAP / LOAD DATA
   ======================== */
function buildStageRange(){
  const sr = el('stageRange'), sl = el('stageLabel');
  if (!sr || !mapData) return;
  const stages = mapData.legion_data?.[currentLegionIndex]?.stages || [];
  const maxStage = stages.length ? Math.max(...stages.map(s => s.stage_number)) : 1;
  sr.min = 1; sr.max = maxStage;
  if (currentStageNumber > maxStage) currentStageNumber = maxStage;
  sr.value = currentStageNumber;
  if (sl) sl.textContent = currentStageNumber;
  sr.oninput = () => { currentStageNumber = parseInt(sr.value,10) || 1; if (sl) sl.textContent = currentStageNumber; updateMapForCurrent(); updatePlayersPanel(); };
}

function buildControls(){
  const legionSelect = el('legionSelect');
  const stageRange = el('stageRange');
  const stageLabel = el('stageLabel');
  if (!mapData) return;
  if (legionSelect && Array.isArray(mapData.legion_data)){
    legionSelect.innerHTML = '';
    mapData.legion_data.forEach((lg, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = lg.legion_id;
      legionSelect.appendChild(opt);
    });
    legionSelect.value = currentLegionIndex;
    legionSelect.onchange = () => { currentLegionIndex = parseInt(legionSelect.value,10) || 0; currentStageNumber = 1; buildStageRange(); updateMapForCurrent(); updatePlayersPanel(); };
  }
  if (stageRange && stageLabel) buildStageRange();
  const refreshBtn = el('refreshBtn'); if (refreshBtn) refreshBtn.onclick = () => loadData();
  const toggleGridBtn = el('toggleGridBtn'); if (toggleGridBtn) toggleGridBtn.onclick = () => { showGrid = !showGrid; renderGrid(showGrid); };
}

function buildMap(){
  if (!mapEl || !mapData) return;
  mapEl.querySelectorAll('.building, .popup').forEach(n=>n.remove());
  popupStore.clear();

  (mapData.buildings || []).forEach(b => {
    const id = b.id || '';
    const div = document.createElement('div');
    div.className = 'building contain';
    div.dataset.buildingId = id;
    div._meta = b;

    const img = document.createElement('img');
    img.src = b.png_path || '';
    img.alt = id;
    img.style.opacity = '0';
    img.style.pointerEvents = 'auto';
    img.onload = () => { img.style.opacity = '1'; positionBuildings(); };
    img.onerror = () => { console.warn('Image failed to load:', img.src); img.style.opacity = '0'; };

    div.appendChild(img);

    const names = document.createElement('div');
    names.className = 'player-names';
    names.style.position = 'absolute';
    names.style.whiteSpace = 'normal';
    names.style.wordBreak = 'break-word';
    names.style.textAlign = 'center';
    names.style.pointerEvents = 'auto';
    div.appendChild(names);

    mapEl.appendChild(div);

    const popup = document.createElement('div');
    popup.className = 'popup';
    popup.dataset.forBuilding = id;
    popup.style.position = 'absolute';
    popup.style.display = 'none';
    popup.innerHTML = `
      <div style="text-align:right"><span class="close" role="button">✕</span></div>
      <h4 style="margin:6px 0">${escapeHtml(b.name_ar || '')} (${escapeHtml(id)})</h4>
      <div><strong>Alliance first control:</strong> ${b.points_first_alliance ?? '-'}</div>
      <div><strong>Alliance occ /min:</strong> ${b.points_occ_alliance ?? '-'}</div>
      <div><strong>Personal first control:</strong> ${b.points_first_personal ?? '-'}</div>
      <div><strong>Personal occ /min:</strong> ${b.points_occ_personal ?? '-'}</div>
      <div><strong>Bonus:</strong> ${escapeHtml(b.bonus_ar || '-')}</div>
    `;
    mapEl.appendChild(popup);
    popupStore.set(id, popup);

    img.addEventListener('click', ev => {
      const p = popupStore.get(id);
      if (!p) return;
      if (p.dataset.persistent === '1') hidePopup(p, true); else showPopupForBuilding(id, { persistent: true });
      ev.stopPropagation();
    });
    img.addEventListener('mouseenter', () => {
      const p = popupStore.get(id);
      if (p && p.dataset.persistent !== '1') showPopupForBuilding(id, { persistent: false });
    });
    img.addEventListener('mouseleave', () => {
      const p = popupStore.get(id);
      if (p && p.dataset.persistent !== '1') hidePopup(p);
    });

    const closeBtn = popup.querySelector('.close');
    if (closeBtn) closeBtn.addEventListener('click', ev => { ev.stopPropagation(); hidePopup(popup, true); });

    div.addEventListener('dragover', ev => { ev.preventDefault(); div.classList.add('drop-target'); });
    div.addEventListener('dragleave', ev => { div.classList.remove('drop-target'); });
    div.addEventListener('drop', ev => {
      ev.preventDefault(); div.classList.remove('drop-target');
      try {
        const payload = ev.dataTransfer.getData('text/plain');
        if (!payload) return;
        let obj = null;
        try { obj = JSON.parse(payload); } catch(e) { const t = payload.trim(); if (t) obj = { type:'player-assign', player: t }; }
        if (obj?.type === 'player-assign' && obj.player) {
          assignPlayerToBuilding(obj.player, id);
          updateMapForCurrent();
          autoSaveToServer();
          updatePlayersPanel();
          scheduleDrawConnectors();
          
          // Show toast confirmation
          const buildingName = meta.name_ar || id;
          showToast(`✓ ${obj.player} assigned to ${buildingName}`, 2000, 'success');
        }
      } catch (e) {
        console.warn('drop parse failed', e);
      }
    });
  });

  if (!docClickHandlerAdded){
    document.addEventListener('click', function(ev){
      const insidePopup = !!ev.target.closest('.popup');
      const insideBuilding = !!ev.target.closest('.building');
      const insidePanel = !!ev.target.closest('#playersPanel') || !!ev.target.closest('#playersToggleBtn');
      if (insidePopup || insideBuilding || insidePanel) return;
      popupStore.forEach(p => { if (p && p.dataset.persistent !== '1') hidePopup(p); });
    });
    docClickHandlerAdded = true;
  }
}

/* ========================
   TOAST NOTIFICATIONS
   ======================== */
function showToast(message, duration = 2500, type = 'success') {
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#007bff'};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    font-size: 14px;
    font-weight: 500;
    z-index: 100000;
    animation: slideInUp 0.3s ease-out;
  `;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideOutDown 0.3s ease-in';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Add CSS animations for toast
if (!document.getElementById('toast-animations')) {
  const style = document.createElement('style');
  style.id = 'toast-animations';
  style.textContent = `
    @keyframes slideInUp {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    @keyframes slideOutDown {
      from { transform: translateY(0); opacity: 1; }
      to { transform: translateY(100%); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

/* ========================
   ASSIGN / UNASSIGN / HIGHLIGHT
   ======================== */
function assignPlayerToBuilding(playerName, buildingId){
  if (!mapData) return;
  const legion = mapData.legion_data?.[currentLegionIndex];
  if (!legion) return;
  let stage = (legion.stages || []).find(s => s.stage_number === currentStageNumber);
  if (!stage){ stage = { stage_number: currentStageNumber, assignments: [] }; legion.stages = legion.stages || []; legion.stages.push(stage); }
  stage.assignments = stage.assignments || [];
  let asg = stage.assignments.find(a => a.building_id === buildingId);
  if (!asg){ asg = { building_id: buildingId, player_names: [] }; stage.assignments.push(asg); }
  if (!asg.player_names.includes(playerName)) asg.player_names.push(playerName);
}

function unassignPlayerFromBuilding(playerName, buildingId){
  if (!mapData) return;
  const legion = mapData.legion_data?.[currentLegionIndex];
  if (!legion) return;
  const stage = (legion.stages || []).find(s => s.stage_number === currentStageNumber);
  if (!stage) return;
  const asg = stage.assignments?.find(a => a.building_id === buildingId);
  if (!asg) return;
  asg.player_names = asg.player_names.filter(p => p !== playerName);
}

function highlightPlayerAssignments(playerName){
  document.querySelectorAll('.building').forEach(b=>b.classList.remove('highlighted'));
  document.querySelectorAll('.building').forEach(b=>{
    const bid = b.dataset.buildingId;
    const legion = mapData.legion_data?.[currentLegionIndex];
    const stage = (legion?.stages || []).find(s=>s.stage_number === currentStageNumber);
    const asg = stage?.assignments?.find(a=>a.building_id === bid);
    if (asg && asg.player_names?.includes(playerName)){
      b.classList.add('highlighted');
      setTimeout(()=> b.classList.remove('highlighted'), 1800);
    }
  });
}

/* ========================
   POSTMESSAGE / POLL / LOAD
   ======================== */
/* Poll/load implementation below is resource-friendly:
   - conditional requests (ETag / Last-Modified)
   - AbortController timeout
   - exponential backoff
   - skip when not visible / not focused
   - opt-in polling on mobile via window.enablePollingSafely()
*/
let lastPolledText = null;
let pollTimer = null;
let pollInFlight = false;
let lastETag = null;
let lastModified = null;
let pollBackoff = 1;
const POLL_MAX_BACKOFF = 32;
const POLL_TIMEOUT_MS = 8000;
window.MAP_FORCE_POLL = window.MAP_FORCE_POLL || false;

function computeNextDelay() {
  const base = Math.max(1000, Number(CONFIG.POLL_INTERVAL_MS) || 2500);
  const delay = base * pollBackoff;
  return Math.min(Math.max(delay, base), base * POLL_MAX_BACKOFF);
}
function scheduleNextPoll() {
  if (!CONFIG.POLL_ENABLED && !window.MAP_FORCE_POLL) return;
  const delay = computeNextDelay();
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollForServerChanges, delay);
  if (window.console && console.debug) console.debug(`[map] next poll in ${delay}ms (backoff=${pollBackoff})`);
}

async function pollForServerChanges(){
  if (!CONFIG.POLL_ENABLED && !window.MAP_FORCE_POLL) return;
  if (pollInFlight) { scheduleNextPoll(); return; }
  if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') { scheduleNextPoll(); return; }
  if (typeof document !== 'undefined' && !document.hasFocus()) { scheduleNextPoll(); return; }

  pollInFlight = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

  try {
    const headers = {};
    if (lastETag) headers['If-None-Match'] = lastETag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;

    const url = (lastETag || lastModified) ? 'foundry_map_data.json' : ('foundry_map_data.json?_=' + Date.now());
    const res = await fetch(url, { cache: 'no-cache', headers, credentials: 'same-origin', signal: controller.signal });

    if (res.status === 304) { pollBackoff = 1; return; }
    if (!res.ok) { console.warn('[map] poll response not ok', res.status); pollBackoff = Math.min(POLL_MAX_BACKOFF, pollBackoff * 2); return; }

    const etag = res.headers.get('ETag');
    const lm = res.headers.get('Last-Modified');
    if (etag) lastETag = etag;
    if (lm) lastModified = lm;

    const text = await res.text();
    if (!text) { pollBackoff = 1; return; }

    if (lastPolledText === null) { lastPolledText = text; pollBackoff = 1; return; }

    if (text !== lastPolledText){
      lastPolledText = text;
      try {
        const parsed = JSON.parse(text);
        mapData = parsed;
        window.mapData = mapData;
        console.info('poll detected change — mapData summary:', {
          buildings: (mapData?.buildings?.length) || 0,
          legions: (mapData?.legion_data?.length) || 0
        });
        computeClipFromGridSize();
        computeLayout();
        buildMap();
        positionBuildings();
        renderGrid(showGrid);
        buildControls();
        updatePlayersPanel();
        updateMapForCurrent();
        try { if (window.ModernControls && typeof window.ModernControls.refresh === 'function') window.ModernControls.refresh(); } catch(e){}
      } catch (parseErr) { console.warn('poll parse failed', parseErr); }
    }
    pollBackoff = 1;
  } catch (err) {
    if (err && err.name === 'AbortError') console.warn('[map] poll aborted (timeout)');
    else console.warn('[map] poll error', err);
    pollBackoff = Math.min(POLL_MAX_BACKOFF, pollBackoff * 2);
  } finally {
    clearTimeout(timeoutId);
    pollInFlight = false;
    scheduleNextPoll();
  }
}

// Robust loadData with timeout + safe parsing
async function loadData(){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

  try {
    const res = await fetch('foundry_map_data.json?_=' + Date.now(), { cache: 'no-cache', credentials: 'same-origin', signal: controller.signal });
    if (!res.ok) {
      console.warn('loadData fetch returned not ok:', res.status);
      mapData = mapData || { buildings: [], legion_data: [] };
    } else {
      try { mapData = await res.json(); } catch (parseErr) {
        try {
          const txt = await res.text();
          mapData = JSON.parse(txt);
        } catch(e){
          console.warn('loadData parse failed', e);
          mapData = mapData || { buildings: [], legion_data: [] };
        }
      }
      console.info('loadData fetched mapData — summary:', {
        buildings: (mapData?.buildings?.length) || 0,
        legions: (mapData?.legion_data?.length) || 0
      });
    }
  } catch (e) {
    if (e && e.name === 'AbortError') console.warn('loadData aborted (timeout)');
    else console.warn('Failed to load foundry_map_data.json', e);
    mapData = mapData || { buildings: [], legion_data: [] };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!Array.isArray(mapData.legion_data)) {
    console.warn('mapData.legion_data missing or not array — initializing empty array');
    mapData.legion_data = [];
  }

  try { window.mapData = mapData; window.currentLegionIndex = currentLegionIndex; window.currentStageNumber = currentStageNumber; } catch(e){}

  computeClipFromGridSize();
  computeLayout();
  ensureUIElements();
  buildControls();
  buildMap();
  positionBuildings();
  renderGrid(showGrid);
  updatePlayersPanel();
  if (!mapEl._hasClickHandler) {
    mapEl.addEventListener('click', mapClickHandler);
    mapEl._hasClickHandler = true;
  }
  window.addEventListener('resize', () => { computeLayout(); positionBuildings(); renderGrid(showGrid); scheduleDrawConnectors(); });
  updateMapForCurrent();

  if ((CONFIG.POLL_ENABLED || window.MAP_FORCE_POLL) && !pollTimer){
    lastPolledText = JSON.stringify(mapData);
    pollBackoff = 1;
    scheduleNextPoll();
  }

  try {
    window.mapData = mapData;
    window.currentLegionIndex = currentLegionIndex;
    window.currentStageNumber = currentStageNumber;
    if (window.ModernControls && typeof window.ModernControls.refresh === 'function') {
      setTimeout(() => { try { window.ModernControls.refresh(); } catch(e){} }, 60);
    }
  } catch (e) {}
}

// Manual refresh (safe)
window.mapRefresh = async function() {
  try {
    if (lastETag || lastModified) {
      await pollForServerChanges();
      return;
    }
    await loadData();
  } catch(e){ console.warn('[map] mapRefresh failed', e); }
};

// Opt-in polling (use with caution)
window.enablePollingSafely = function(enable, baseIntervalMs){
  if (enable) {
    window.MAP_FORCE_POLL = true;
    CONFIG.POLL_ENABLED = true;
    if (typeof baseIntervalMs === 'number' && baseIntervalMs >= CONFIG.POLL_INTERVAL_MS) CONFIG.POLL_INTERVAL_MS = baseIntervalMs;
    pollBackoff = 1;
    scheduleNextPoll();
    console.info('[map] polling enabled by user override — be careful on free hosts');
  } else {
    window.MAP_FORCE_POLL = false;
    CONFIG.POLL_ENABLED = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    console.info('[map] polling disabled by user override');
  }
};

/* ========================
   AUTOSAVE / HELPERS / API
   ======================== */
async function autoSaveToServer(){
  if (!mapData) return;
  try {
    await fetch('save_data.php', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ payload: mapData })
    });
  } catch (e) {
    console.warn('auto-save failed', e);
  }
}

function updateMapForCurrent() {
  if (!mapData || !Array.isArray(mapData.legion_data)) return;
  const legion = mapData.legion_data[currentLegionIndex] || { stages: [] };
  const stage = (legion.stages || []).find(s => s.stage_number === currentStageNumber);

  // we don't use inline badges on buildings; keep them cleared
  document.querySelectorAll('.building').forEach(div => {
    const names = div.querySelector('.player-names');
    if (names) {
      names.innerHTML = '';
      names.style.display = 'none';
    }
  });

  const note = stage && stage.notes ? stage.notes : '';
  showStageNote(note);

  updatePlayersPanel();
  scheduleDrawConnectors();
}

function showStageNote(txt){
  ensureUIElements();
  if (!stageNoteEl) return;
  if (!txt || String(txt).trim()==='') { stageNoteEl.style.display='none'; stageNoteEl.textContent=''; return; }
  stageNoteEl.textContent = txt;
  stageNoteEl.style.display = 'block';
}

window.updateMap = (legionId, stageNumber) => {
  if (!mapData) return;
  const idx = mapData.legion_data?.findIndex(l => l.legion_id === legionId);
  if (idx === -1 || idx === undefined) return;
  currentLegionIndex = idx;
  const ls = el('legionSelect'); if (ls) ls.value = idx;
  currentStageNumber = stageNumber;
  buildStageRange();
  updateMapForCurrent();
  updatePlayersPanel();
};

try { window.playersPanelVisible = playersPanelVisible; } catch(e){}

/* ========================
   INITIALIZE
   ======================== */
document.addEventListener('DOMContentLoaded', ()=> {
  try {
    ensureUIElements();
    loadData();

    try {
      if (window.matchMedia && window.matchMedia('(max-width:900px)').matches) {
        if (!document.querySelector('script[data-mobile-loader="1"]')) {
          const s = document.createElement('script');
          s.src = 'js/map.mobile.js';
          s.defer = true;
          s.setAttribute('data-mobile-loader', '1');
          document.body.appendChild(s);
        }
      }
    } catch (e) {
      console.warn('mobile loader failed', e);
    }

  } catch (err) {
    console.error('Map init failed', err);
  }
});

/* ========================
   POSTMESSAGE HANDLERS
   ======================== */
// Listen for messages from admin window
window.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  
  // Handle ping from admin (for connection testing)
  if (msg.type === 'preview-ping') {
    try {
      ev.source.postMessage({ type: 'preview-pong' }, '*');
    } catch(e) {
      console.warn('Failed to send pong', e);
    }
    return;
  }
  
  // Handle data updates from admin
  if (msg.type === 'update-data' && msg.payload) {
    try {
      mapData = msg.payload;
      window.mapData = mapData;
      console.info('Received data update via postMessage');
      computeClipFromGridSize();
      computeLayout();
      buildMap();
      positionBuildings();
      renderGrid(showGrid);
      buildControls();
      updatePlayersPanel();
      updateMapForCurrent();
      try {
        if (window.ModernControls && typeof window.ModernControls.refresh === 'function') {
          window.ModernControls.refresh();
        }
      } catch(e) {}
    } catch(err) {
      console.warn('Failed to process update-data message', err);
    }
    return;
  }
});

// Notify admin window that preview is ready
if (window.opener) {
  try {
    window.opener.postMessage({ type: 'preview-ready' }, '*');
  } catch(e) {
    console.warn('Failed to notify admin window', e);
  }
}