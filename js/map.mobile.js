// js/map.mobile.js — Mobile connector drawing (teams bar support, efficient and robust)
// - Runs on mobile only (max-width:900px).
// - Draws connectors from the bottom-center of each team-segment to the building center.
// - When window.__mobile_focused_team_building is set, draws a single highlighted connector.
// - Debounced via requestAnimationFrame and time-throttle to avoid jank on pointermove.
// - Uses light observers (ResizeObserver + MutationObserver) but schedules redraws via __mobile_scheduleDraw.
// - Keeps a backup of desktop drawConnectorsForCurrentStage on window._desktop_drawConnectors and exposes restore API.

(function(){
  'use strict';

  const MOBILE_QUERY = '(max-width:900px)';
  if (!window.matchMedia || !window.matchMedia(MOBILE_QUERY).matches) return;

  const DRAW_DEBOUNCE_MS = 45;
  const SVG_Z = 30005;

  const $id = id => document.getElementById(id);
  const raf = window.requestAnimationFrame?.bind(window) || (cb => setTimeout(cb, 16));

  // Utility: safe query for team segments in wrapper or global
  function findTeamSegmentsScope(){
    const wrapper = document.querySelector('.map-wrapper');
    if (wrapper) {
      const segs = Array.from(wrapper.querySelectorAll('.team-segment'));
      if (segs.length) return { segs, scope: wrapper };
    }
    // fallback to global search
    const globalSegs = Array.from(document.querySelectorAll('.team-segment'));
    return { segs: globalSegs, scope: document };
  }

  // Ensure connectors SVG exists (fixed viewport overlay)
  function ensureSvg(){
    let svg = $id('connectorsSvg');
    if (svg && svg.parentElement !== document.body){
      try { document.body.appendChild(svg); } catch(e){}
    }
    svg = $id('connectorsSvg');
    if (!svg){
      svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.id = 'connectorsSvg';
      svg.setAttribute('aria-hidden','true');
      document.body.appendChild(svg);
    }
    Object.assign(svg.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: String(SVG_Z)
    });
    return svg;
  }

  const svg = ensureSvg();

  // Clear svg children and building highlights
  function clearSvgAndHighlights(){
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    try { document.querySelectorAll('.building.team-focused').forEach(el => el.classList.remove('team-focused')); } catch(e){}
  }

  // Get building center (viewport coords)
  function getBuildingCenter(buildingId){
    const mapEl = $id('map');
    if (!mapEl) return null;
    // find element with dataset.buildingId === buildingId
    const el = Array.from(mapEl.querySelectorAll('.building')).find(d => d.dataset && d.dataset.buildingId === buildingId);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, el };
  }

  // Get segment rect (bottom-center anchor) — searches in .map-wrapper first then global
  function getSegmentRectForBuilding(buildingId){
    const wrapper = document.querySelector('.map-wrapper');
    if (wrapper){
      const seg = Array.from(wrapper.querySelectorAll('.team-segment')).find(s => s.dataset && s.dataset.buildingId === buildingId);
      if (seg) return seg.getBoundingClientRect();
    }
    // fallback global
    const seg = Array.from(document.querySelectorAll('.team-segment')).find(s => s.dataset && s.dataset.buildingId === buildingId);
    return seg ? seg.getBoundingClientRect() : null;
  }

  // Draw a smooth cubic curve path and a terminal circle
  function drawConnector(sx, sy, bx, by, color = 'hsl(170 70% 45%)', width = 3){
    const midX = (sx + bx) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    const d = `M ${sx} ${sy} C ${midX} ${sy} ${midX} ${by} ${bx} ${by}`;
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', String(width));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    const circ = document.createElementNS('http://www.w3.org/2000/svg','circle');
    circ.setAttribute('cx', String(bx));
    circ.setAttribute('cy', String(by));
    circ.setAttribute('r', String(Math.max(4, Math.min(7, width + 2))));
    circ.setAttribute('fill', color);
    svg.appendChild(circ);
  }

  // Color detection helper: read inline title color or computed border color
  function colorForSegment(seg){
    try {
      if (!seg) return 'hsl(170 70% 45%)';
      const title = seg.querySelector('.team-title');
      if (title){
        const tColor = title.style.color || getComputedStyle(title).color;
        if (tColor) return tColor;
      }
      const border = seg.style.borderColor || getComputedStyle(seg).borderColor;
      if (border) return border;
    } catch(e){}
    return 'hsl(170 70% 45%)';
  }

  // Draw connectors for all visible segments
  function drawAllTeamConnectors(){
    clearSvgAndHighlights();
    const { segs } = findTeamSegmentsScope();
    if (!segs || segs.length === 0) return;
    // For performance: gather building centers map so we don't query same building many times
    const buildingCenterCache = Object.create(null);
    for (let i = 0; i < segs.length; i++){
      const seg = segs[i];
      const bid = seg.dataset && seg.dataset.buildingId;
      if (!bid) continue;
      let bcenter = buildingCenterCache[bid];
      if (typeof bcenter === 'undefined'){
        bcenter = getBuildingCenter(bid) || null;
        buildingCenterCache[bid] = bcenter;
      }
      if (!bcenter) continue;
      const rect = seg.getBoundingClientRect();
      // anchor bottom-center of segment
      const sx = rect.left + rect.width/2;
      const sy = rect.top + rect.height;
      const color = colorForSegment(seg);
      drawConnector(sx, sy, bcenter.x, bcenter.y, color, 2.6);
    }
  }

  // Draw a single focused connector (highlight)
  function drawFocusedConnector(){
    const bid = window.__mobile_focused_team_building || null;
    if (!bid){ clearSvgAndHighlights(); return; }
    clearSvgAndHighlights();
    const bcenter = getBuildingCenter(bid);
    if (!bcenter) return;
    const rect = getSegmentRectForBuilding(bid);
    let sx, sy;
    if (rect){
      sx = rect.left + rect.width/2;
      sy = rect.top + rect.height;
    } else {
      // fallback: anchor near top-left of map
      const mapEl = $id('map');
      if (!mapEl) return;
      const mr = mapEl.getBoundingClientRect();
      sx = mr.left + 12; sy = mr.top + 12;
    }
    // find segment to pick color if available
    const wrapper = document.querySelector('.map-wrapper') || document.body;
    const seg = Array.from(wrapper.querySelectorAll('.team-segment')).find(s => s.dataset && s.dataset.buildingId === bid);
    const color = colorForSegment(seg);
    drawConnector(sx, sy, bcenter.x, bcenter.y, color, 3.6);
    try { document.querySelectorAll('.building.team-focused').forEach(el => el.classList.remove('team-focused')); if (bcenter.el) bcenter.el.classList.add('team-focused'); } catch(e){}
  }

  // Throttled RAF-driven draw scheduler
  let lastTs = 0;
  let scheduled = false;
  function mobileDraw(){
    const now = Date.now();
    if (now - lastTs < DRAW_DEBOUNCE_MS){
      if (!scheduled){ scheduled = true; setTimeout(()=> { scheduled = false; mobileDraw(); }, DRAW_DEBOUNCE_MS); }
      return;
    }
    lastTs = now;
    const focused = window.__mobile_focused_team_building || null;
    if (focused) drawFocusedConnector();
    else drawAllTeamConnectors();
  }

  // Expose scheduler for other scripts
  window.__mobile_scheduleDraw = function(){ raf(mobileDraw); };

  // Replace global drawConnectorsForCurrentStage on mobile (safe backup)
  try {
    if (typeof window.drawConnectorsForCurrentStage !== 'undefined') {
      window._desktop_drawConnectors = window.drawConnectorsForCurrentStage;
    }
    window.drawConnectorsForCurrentStage = mobileDraw;
  } catch(e){ /* ignore */ }

  // Observe layout changes and schedule redraws (light)
  try {
    const ro = new ResizeObserver(()=> window.__mobile_scheduleDraw());
    const mapEl = $id('map');
    const wrapper = document.querySelector('.map-wrapper');
    const tb = wrapper ? wrapper.querySelector('.teams-inner') || wrapper.querySelector('.team-segment') : null;
    if (mapEl) ro.observe(mapEl);
    if (wrapper) ro.observe(wrapper);
    // don't observe every segment individually to avoid churn
  } catch(e){ /* ResizeObserver not available */ }

  try {
    const mo = new MutationObserver((mutations) => {
      // Only schedule a redraw; avoid heavy processing here
      window.__mobile_scheduleDraw();
    });
    const wrapper = document.querySelector('.map-wrapper') || document.body;
    // Observe children/attributes changes inside wrapper (teams or map changes)
    mo.observe(wrapper, { childList: true, subtree: true, attributes: false });
  } catch(e){ /* ignore */ }

  // initial draw
  setTimeout(()=> { try { window.__mobile_scheduleDraw(); } catch(e){} }, 160);

  // Provide restore API
  window._mobile_map_adapter = window._mobile_map_adapter || {};
  window._mobile_map_adapter.restoreDesktopDraw = function(){
    try {
      if (window._desktop_drawConnectors) {
        window.drawConnectorsForCurrentStage = window._desktop_drawConnectors;
        delete window._desktop_drawConnectors;
      }
      clearSvgAndHighlights();
    } catch(e){ console.warn('restoreDesktopDraw failed', e); }
  };

  // cleanup on unload
  window.addEventListener('beforeunload', ()=> { clearSvgAndHighlights(); });

})();