// js/mobile.js — Mobile teams bar placed above .map-wrapper (after modern/legacy controls, before map-wrapper)
// V26-derived with targeted fixes:
// - Assign stable container IDs (data-mobile-stage-container-id) so DOM replacements are detected.
// - Snapshot now includes containerId to force updates when external code replaces stage nodes.
// - Legion change handler forces retries (clears snapshot + multiple ensureStageTimes calls) to beat race conditions.
// - Lightweight diagnostic logging guarded by DEBUG flag.
// - Retains debounced rendering, observers, gestures, and fitMapToBounds helper.

(function(){
  'use strict';

  const DEBUG = true; // set false to silence logs
  window.__mobile_debug = DEBUG;

  const MOBILE_QUERY = '(max-width:900px)';
  if (!window.matchMedia || !window.matchMedia(MOBILE_QUERY).matches) return;

  // Config
  const PREF_SEG_W = 140;
  const MIN_SEG_W = 72;
  const MAX_SEG_W = 220;
  const GAP = 10;
  const DEBOUNCE_MS = 80;
  const MIN_SCALE = 0.6, MAX_SCALE = 3.0;

  // Utilities
  const RAF = window.requestAnimationFrame?.bind(window) || (cb => setTimeout(cb,16));
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const debounce = (fn, ms=DEBOUNCE_MS) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=> fn(...a), ms); }; };

  // State
  let teamsBarEl = null;
  let teamsInnerEl = null;
  let stageNoteEl = null;
  let ro = null;
  let mo = null;
  let installed = false;
  let lastStageSnapshot = '';
  const OWN_TAG = 'mobile-owned';
  let _msc_counter = 1; // mobile-stage-container counter

  // Diagnostics helpers
  function log(...args){ if (DEBUG && console && console.log) console.log('[mobile]', ...args); }
  function trace(...args){ if (DEBUG && console && console.trace) { console.log('[mobile] TRACE', ...args); console.trace(); } }

  // Inject minimal CSS to ensure .stage-time is visible inline (mobile.css should override for visuals)
  (function injectCSS(){
    const id = 'mobile-stage-inline-fix-v3';
    if (document.getElementById(id)) return;
    const css = `
.stage-time.inline.${OWN_TAG}, .stage-time.inline {
  position: relative !important;
  display: block !important;
  margin-top: 6px !important;
  font-size: 12px !important;
  padding: 4px 8px !important;
  border-radius: 8px !important;
  background: rgba(255,255,255,0.95) !important;
  color: #000 !important;
  font-weight: 700 !important;
  box-shadow: 0 6px 18px rgba(0,0,0,0.09) !important;
  pointer-events: none !important;
  white-space: nowrap !important;
  text-align: center !important;
}
`;
    const s = document.createElement('style');
    s.id = id;
    s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  })();

  // Helpers: find insertion points
  function findControls(){
    return document.querySelector('.modern-controls')
      || document.querySelector('.modernControls')
      || document.querySelector('#modernControls')
      || document.querySelector('.legacy-controls')
      || document.querySelector('.controls-right')
      || document.querySelector('.controls') || null;
  }
  function findMapWrapper(){
    return document.querySelector('.map-wrapper') || document.getElementById('map') || null;
  }

  function insertAfter(newNode, refNode){
    if (!refNode || !refNode.parentNode) return;
    refNode.parentNode.insertBefore(newNode, refNode.nextSibling);
  }

  // Teams bar DOM
  function createTeamsBar(){
    const bar = document.createElement('div');
    bar.id = 'teamsBarMobile';
    bar.className = 'teams-bar-mobile';
    Object.assign(bar.style, {
      position: 'relative',
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 12px',
      margin: '8px 0',
      display: 'block',
      pointerEvents: 'auto',
      zIndex: 41020
    });
    const inner = document.createElement('div');
    inner.className = 'teams-inner';
    Object.assign(inner.style, {
      width: '100%',
      display: 'flex',
      flexWrap: 'wrap',
      gap: GAP + 'px',
      justifyContent: 'center',
      alignItems: 'flex-start',
      boxSizing: 'border-box',
      padding: '4px'
    });
    bar.appendChild(inner);
    return bar;
  }

  function ensureStageNotePlaced(parent, reference){
    const existing = document.querySelector('.stage-note') || document.getElementById('stageNote');
    if (existing){
      stageNoteEl = existing;
      if (stageNoteEl.parentElement !== parent) {
        try { parent.insertBefore(stageNoteEl, reference); } catch(e){}
      } else if (stageNoteEl.nextSibling !== reference) {
        try { parent.insertBefore(stageNoteEl, reference); } catch(e){}
      }
    } else {
      stageNoteEl = document.createElement('div');
      stageNoteEl.className = 'stage-note';
      stageNoteEl.textContent = '';
      try { parent.insertBefore(stageNoteEl, reference); } catch(e){ document.body.insertBefore(stageNoteEl, document.body.firstChild); }
    }
    Object.assign(stageNoteEl.style, {
      position: 'relative',
      left: 'auto',
      transform: 'none',
      margin: '6px auto',
      textAlign: 'center',
      zIndex: 41050
    });
    return stageNoteEl;
  }

  function ensureTeamsBarPlaced(){
    const mapWrapper = findMapWrapper();
    const controls = findControls();
    let existing = document.getElementById('teamsBarMobile');
    if (existing) teamsBarEl = existing;
    else teamsBarEl = createTeamsBar();

    if (mapWrapper && mapWrapper.parentNode){
      const parent = mapWrapper.parentNode;
      if (controls && controls.parentNode === parent){
        if (controls.nextSibling !== teamsBarEl) insertAfter(teamsBarEl, controls);
      } else {
        if (mapWrapper.previousSibling !== teamsBarEl) parent.insertBefore(teamsBarEl, mapWrapper);
      }
    } else {
      if (document.body.firstChild !== teamsBarEl) document.body.insertBefore(teamsBarEl, document.body.firstChild);
    }

    teamsInnerEl = teamsBarEl.querySelector('.teams-inner') || (function(){ const n = document.createElement('div'); n.className='teams-inner'; teamsBarEl.appendChild(n); return n; })();
    ensureStageNotePlaced(teamsBarEl.parentElement || document.body, teamsBarEl);
    return teamsBarEl;
  }

  // Build teams list from window.mapData
  function buildTeamsData(){
    const out = [];
    const md = window.mapData;
    if (!md || !Array.isArray(md.legion_data)) return out;
    const legion = md.legion_data?.[window.currentLegionIndex];
    if (!legion) return out;
    const stage = (legion.stages || []).find(s => s.stage_number === window.currentStageNumber);
    if (!stage) return out;
    const assignments = stage.assignments || [];
    const byB = Object.create(null);
    assignments.forEach(a => {
      const bid = a.building_id;
      if (!byB[bid]) byB[bid] = new Set();
      (a.player_names || []).forEach(p => byB[bid].add(p));
    });
    const bIndex = {};
    (md.buildings || []).forEach(b => bIndex[b.id] = b);
    Object.keys(byB).forEach(bid => {
      const players = Array.from(byB[bid]);
      const meta = bIndex[bid] || {};
      const name = meta.name_en || meta.name || bid;
      out.push({ building_id: bid, building_name: name, players });
    });
    out.sort((a,b) => a.building_name.localeCompare(b.building_name));
    return out;
  }

  // Deterministic color for building id
  function colorForBuilding(bid){
    try {
      let h=0, s = String(bid);
      for (let i=0;i<s.length;i++){ h = ((h<<5)-h) + s.charCodeAt(i); h |= 0; }
      h = Math.abs(h)%360;
      return `hsl(${h} 78% 45%)`;
    } catch(e){ return 'hsl(210 60% 50%)'; }
  }

  // Format seconds -> HH:MM:SS
  function formatSeconds(sec){
    sec = Number(sec) || 0;
    const h = Math.floor(sec/3600);
    const m = Math.floor((sec%3600)/60);
    const s = Math.floor(sec%60);
    return [h,m,s].map(x => String(x).padStart(2,'0')).join(':');
  }

  // Find stage buttons/cells in the UI
  function findStageElements(){
    const selectors = [
      '.stages-bar .stage', '.stages .stage', '.stage-segment', '.stage-button',
      '.stage', '#stagesBar', '.stagesBar', '.stagesBlock', '.stage-buttons'
    ];
    const found = [];
    selectors.forEach(sel => {
      try {
        const n = document.querySelectorAll(sel);
        if (n && n.length){
          n.forEach(x => { if (!found.includes(x)) found.push(x); });
        }
      } catch(e){}
    });
    // fallback: search for elements containing "Stage" text
    if (!found.length){
      const candidates = Array.from(document.querySelectorAll('button,div,span'));
      candidates.forEach(el => {
        if ((el.textContent||'').match(/\bStage\s*\d+\b/i)) {
          if (!found.includes(el)) found.push(el);
        }
      });
    }
    return found;
  }

  // Ensure a .stage-time exists INSIDE each stage element and populate its value
  // Modified: assigns containerId and includes containerId in snapshot to detect DOM replacement
  function ensureStageTimes(){
    const stageEls = findStageElements();
    if (!stageEls.length) { lastStageSnapshot = ''; return; }

    const md = window.mapData;
    let stageDataMap = new Map();
    try {
      if (md && Array.isArray(md.legion_data)){
        const legion = md.legion_data?.[window.currentLegionIndex] || {};
        (legion.stages || []).forEach(s => { stageDataMap.set(Number(s.stage_number), s); });
      }
    } catch(e){}

    const readResults = stageEls.map((el, idx) => {
      const container = el;

      // assign a stable container id we control so replaced DOM changes snapshot
      if (!container.dataset.mobileStageContainerId) {
        try { container.dataset.mobileStageContainerId = 'msc-' + (_msc_counter++); } catch(e){}
      }
      const containerId = container.dataset.mobileStageContainerId || ('msc-' + idx);

      // Find label and attempt to source time
      const label = container.querySelector('.stage-label');
      let src = null;
      try {
        const timerCandidates = container.querySelectorAll('.stage-timer, .timer, .countdown, .time, .stage-countdown');
        if (timerCandidates && timerCandidates.length){
          src = timerCandidates[0].textContent.trim();
        }
      } catch(e){}

      if (!src){
        const txt = (container.textContent || '').trim();
        const m = txt.match(/(\d{1,2}:\d{2}:\d{2})/);
        if (m) src = m[1];
      }

      if (!src && stageDataMap.size){
        const t = (container.textContent || '');
        const m = t.match(/Stage\s*(\d+)/i) || t.match(/Stage\s*:?(\d+)/i);
        let stageNum = m ? Number(m[1]) : (idx+1);
        const sObj = stageDataMap.get(stageNum) || stageDataMap.get(String(stageNum));
        if (sObj){
          const sec = sObj.remaining_seconds || sObj.time_left || sObj.duration_seconds || sObj.duration || sObj.seconds;
          if (typeof sec === 'number' || String(sec).match(/^\d+$/)) src = formatSeconds(sec);
          else if (typeof sObj.time === 'string') src = sObj.time;
          else if (sObj.duration && typeof sObj.duration === 'string') src = sObj.duration;
        }
      }

      src = src || '';
      const key = container.dataset.stageNumber || container.dataset.buildingId || ('stage-' + idx);
      return { container, label, idx, key, src, containerId };
    });

    // include containerId in snapshot to detect DOM replacement
    const snapshot = JSON.stringify(readResults.map(r => ({ key: r.key, src: r.src, cid: r.containerId })));
    if (snapshot === lastStageSnapshot) return;
    lastStageSnapshot = snapshot;

    // Write phase: minimal updates
    readResults.forEach(r => {
      const container = r.container;
      const label = r.label;

      try {
        const cs = getComputedStyle(container);
        if (cs.position === 'static') container.style.position = 'relative';
        container.style.overflow = 'visible';
      } catch (e){}

      // Try to find existing time element by key and move into this container if necessary
      let timeEl = document.querySelector(`[data-mobile-stage-key="${r.key}"]`);
      if (timeEl && !container.contains(timeEl)){
        try {
          if (label && label.parentElement === container){
            if (label.nextSibling) container.insertBefore(timeEl, label.nextSibling);
            else container.appendChild(timeEl);
          } else {
            container.appendChild(timeEl);
          }
          // update its container-id attribute
          timeEl.setAttribute('data-mobile-stage-container-id', r.containerId);
        } catch(e){}
        if (DEBUG) {
          log(`moved existing .stage-time key=${r.key} into containerId=${r.containerId}`);
          trace('moved-existing');
        }
      }

      // Ensure a .stage-time child exists
      timeEl = container.querySelector('.stage-time.inline.' + OWN_TAG) || container.querySelector('.stage-time.inline') || container.querySelector('.stage-time');
      if (!timeEl){
        timeEl = document.createElement('div');
        timeEl.className = 'stage-time inline ' + OWN_TAG;
        timeEl.setAttribute('data-mobile-stage-key', r.key);
        timeEl.setAttribute('data-mobile-stage-container-id', r.containerId);
        if (label && label.parentElement === container){
          if (label.nextSibling) container.insertBefore(timeEl, label.nextSibling);
          else container.appendChild(timeEl);
        } else {
          container.appendChild(timeEl);
        }
        if (DEBUG){
          log(`created .stage-time key=${r.key} containerId=${r.containerId}`);
          trace('created-timeEl');
        }
      } else {
        if (!timeEl.hasAttribute('data-mobile-stage-key')) timeEl.setAttribute('data-mobile-stage-key', r.key);
        if (!timeEl.hasAttribute('data-mobile-stage-container-id')) timeEl.setAttribute('data-mobile-stage-container-id', r.containerId);
        if (!timeEl.classList.contains(OWN_TAG)) timeEl.classList.add(OWN_TAG);
        timeEl.classList.add('inline');
      }

      if (timeEl.textContent !== r.src) timeEl.textContent = r.src;

      // Minimal inline style to ensure visibility
      Object.assign(timeEl.style, {
        display: r.src ? 'block' : 'none',
        marginTop: '6px',
        fontWeight: '700',
        fontSize: '12px',
        textAlign: 'center',
        padding: '4px 8px',
        borderRadius: '8px',
        background: 'rgba(255,255,255,0.95)',
        color: '#000',
        boxShadow: '0 6px 18px rgba(0,0,0,0.09)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap'
      });
    });
  }

  // repair observer — moves floating time elements back into their stage by key
  const installRepairObserver = (() => {
    let observer = null;
    return function(){
      if (observer) return;
      const handler = debounce((mutations) => {
        let need = false;
        const summary = [];
        for (const m of mutations){
          if (m.type === 'childList'){
            for (const n of Array.from(m.addedNodes || [])){
              if (!(n instanceof Element)) continue;
              summary.push({ added: n.tagName, classes: n.className || null });
              if (n.matches && (n.matches('.stage') || n.matches('.stage-segment') || n.matches('.stage-button') || n.matches('#stagesBar'))) { need = true; break; }
              if (n.querySelector && (n.querySelector('.stage') || n.querySelector('.stage-time'))) { need = true; break; }
            }
            if (need) break;
          } else if (m.type === 'attributes'){
            summary.push({ attrTarget: m.target && (m.target.tagName + '.' + (m.target.className||'')) });
            if (m.target && m.target.matches && (m.target.matches('.stage') || m.target.matches('.stage-time'))) { need = true; break; }
          }
        }
        if (need) {
          if (DEBUG) {
            log('repair observer detected mutations — scheduling ensureStageTimes', summary);
            trace('repair-observer-fired');
          }
          try { ensureStageTimes(); } catch(e){ /* ignore */ }
        }
      }, 100);

      observer = new MutationObserver(handler);
      observer.observe(document.documentElement || document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class','style'] });
    };
  })();

  // renderNow: performs DOM writes
  function renderNow(){
    const bar = ensureTeamsBarPlaced();
    const inner = teamsInnerEl = bar.querySelector('.teams-inner');
    if (!inner) return;

    const containerWidth = inner.clientWidth || inner.offsetWidth || (bar.clientWidth || window.innerWidth);
    const teams = buildTeamsData();

    inner.innerHTML = '';
    if (!teams.length){
      const ph = document.createElement('div');
      ph.textContent = 'No teams';
      ph.style.padding = '6px 10px';
      ph.style.opacity = '0.7';
      inner.appendChild(ph);
      RAF(ensureStageTimes);
      return;
    }

    teams.forEach(team => {
      const seg = document.createElement('div');
      seg.className = 'team-segment';
      seg.dataset.buildingId = team.building_id;
      const col = colorForBuilding(team.building_id);
      seg.style.setProperty('--team-color', col);
      seg.style.border = `2px solid ${col}`;
      seg.style.flex = `0 0 ${PREF_SEG_W}px`;
      seg.style.minWidth = MIN_SEG_W + 'px';
      seg.style.maxWidth = MAX_SEG_W + 'px';

      const title = document.createElement('div');
      title.className = 'team-title';
      title.textContent = team.building_name;
      title.style.color = col;
      title.style.fontWeight = '700';
      title.style.fontSize = '13px';
      title.style.textAlign = 'center';

      const playersWrap = document.createElement('div');
      playersWrap.className = 'team-players-row';
      Object.assign(playersWrap.style, { display:'flex', flexDirection:'column', gap:'4px', alignItems:'center', width:'100%' });

      const visible = team.players.slice(0,3);
      visible.forEach(pn => {
        const e = document.createElement('div');
        e.className = 'team-player-name';
        e.textContent = pn;
        Object.assign(e.style, { padding:'4px 8px', borderRadius:'8px', background:'rgba(0,0,0,0.03)', width:'calc(100% - 8px)', textAlign:'center' });
        playersWrap.appendChild(e);
      });
      if (team.players.length > visible.length){
        const more = document.createElement('div');
        more.className = 'team-more';
        more.textContent = `+${team.players.length - visible.length}`;
        Object.assign(more.style, { padding:'2px 6px', borderRadius:'8px', fontSize:'11px', color:'#444' });
        playersWrap.appendChild(more);
      }

      seg.appendChild(title);
      seg.appendChild(playersWrap);
      seg.addEventListener('click', () => { window.__mobile_focusTeam && window.__mobile_focusTeam(team.building_id); });
      seg.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); alert(`${team.building_name}\n\n${team.players.join('\n')}`); });

      inner.appendChild(seg);
    });

    adjustSegments(inner, containerWidth);
    RAF(ensureStageTimes);

    installRepairObserver();

    if (typeof window.__mobile_scheduleDraw === 'function') window.__mobile_scheduleDraw();
  }

  // scheduleRender wrapper
  const scheduleRender = debounce(() => { RAF(renderNow); }, DEBOUNCE_MS);

  function adjustSegments(innerEl, containerWidth){
    const segs = Array.from(innerEl.querySelectorAll('.team-segment'));
    if (!segs.length) return;
    const avail = Math.max(120, containerWidth - 8);
    const gapTotal = Math.max(0, (segs.length - 1) * GAP);
    const idealTotal = segs.length * PREF_SEG_W + gapTotal;
    if (idealTotal <= avail){
      segs.forEach(s => { s.style.flex = '0 0 auto'; s.style.minWidth = PREF_SEG_W + 'px'; s.style.maxWidth = MAX_SEG_W + 'px'; });
      return;
    }
    const per = Math.floor((avail - gapTotal) / segs.length);
    const w = clamp(per, MIN_SEG_W, MAX_SEG_W);
    segs.forEach(s => { s.style.flex = `0 0 ${w}px`; s.style.minWidth = w + 'px'; s.style.maxWidth = w + 'px'; });
  }

  // Wiring updates
  function wireUpdates(){
    if (installed) return;
    installed = true;

    // controls
    const legion = document.getElementById('legionSelect') || document.getElementById('modernLegionSelect');
    const stageRange = document.getElementById('stageRange') || document.getElementById('modernStageRange');

    if (legion) {
      legion.addEventListener('change', () => {
        // Force refresh: reset snapshot so ensureStageTimes won't skip updates
        try { lastStageSnapshot = ''; } catch(e){}
        // immediate attempt and short retries to beat race conditions
        try { ensureStageTimes(); } catch(e){}
        setTimeout(() => { try { ensureStageTimes(); } catch(e){} }, 120);
        setTimeout(() => { try { ensureStageTimes(); } catch(e){} }, 420);
        // also trigger our render pipeline
        setTimeout(() => { try { scheduleRender(); } catch(e){} }, 10);
        if (DEBUG) log('legion change: forced ensureStageTimes retries and scheduleRender');
      });
    }

    if (stageRange) stageRange.addEventListener('input', debounce(scheduleRender, DEBOUNCE_MS));

    // messages
    window.addEventListener('message', (ev) => {
      try { const m = ev.data; if (m && m.type === 'update-data') { scheduleRender(); ensureStageTimes(); } } catch(e){}
    });

    // ResizeObserver on map wrapper to react to width changes
    try {
      const wrapper = findMapWrapper();
      if (wrapper && 'ResizeObserver' in window){
        ro = new ResizeObserver(debounce(() => { scheduleRender(); }, DEBOUNCE_MS));
        ro.observe(wrapper);
      }
    } catch(e){ /* ignore */ }

    // MutationObserver on parent of map wrapper to detect DOM moves (insert/remove)
    try {
      const wrapper = findMapWrapper();
      const parent = (wrapper && wrapper.parentElement) || document.body;
      mo = new MutationObserver(debounce((mutations) => {
        scheduleRender();
      }, DEBOUNCE_MS));
      mo.observe(parent, { childList:true, subtree:true });
    } catch(e) { /* ignore */ }

    // Short polling if mapData not yet available (stop once data present)
    let pollAttempts = 0;
    const poll = () => {
      try {
        if (window.mapData && Array.isArray(window.mapData.legion_data)) { scheduleRender(); return; }
      } catch(e){}
      pollAttempts++;
      if (pollAttempts < 30) setTimeout(poll, 500);
    };
    poll();

    window.addEventListener('resize', debounce(() => { scheduleRender(); }, 120));
  }

  // fitMapToBounds helper
  function fitMapToBounds(padding = 24){
    const mapEl = document.getElementById('map'); if (!mapEl) return;
    const buildings = Array.from(mapEl.querySelectorAll('.building')); if (!buildings.length) return;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    buildings.forEach(b => { const r=b.getBoundingClientRect(); minX=Math.min(minX,r.left); minY=Math.min(minY,r.top); maxX=Math.max(maxX,r.right); maxY=Math.max(maxY,r.bottom); });
    if (!isFinite(minX)) return;
    const mapRect = mapEl.getBoundingClientRect();
    const contentW = (maxX-minX)||1, contentH=(maxY-minY)||1;
    const viewportW = mapRect.width - padding*2, viewportH = mapRect.height - padding*2;
    if (viewportW <=0 || viewportH <=0) return;
    const s = clamp(Math.min(viewportW/contentW, viewportH/contentH, 1), MIN_SCALE, MAX_SCALE);
    const scaledW = contentW * s, scaledH = contentH * s;
    const offsetX = mapRect.left + (mapRect.width - scaledW)/2 - minX * s;
    const offsetY = mapRect.top + (mapRect.height - scaledH)/2 - minY * s;
    window.__mobileScale = s; window.__mobileTx = Math.round(offsetX - mapRect.left); window.__mobileTy = Math.round(offsetY - mapRect.top);
    mapEl.style.transformOrigin = '0 0';
    mapEl.style.transform = `translate(${window.__mobileTx}px, ${window.__mobileTy}px) scale(${window.__mobileScale})`;
    if (typeof window.__mobile_scheduleDraw === 'function') window.__mobile_scheduleDraw();
  }

  // Gestures (kept)
  function installGestures(){
    const mapEl = document.getElementById('map'); if (!mapEl) return;
    let pointers = new Map(), lastPan = null, initialPinchDist = null, initialScale = null, initialCenter = null;
    const getDist = (a,b) => Math.hypot(b.x-a.x, b.y-a.y);
    const getMid = (a,b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });

    mapEl.style.touchAction = mapEl.style.touchAction || 'none';

    function onDown(e){ pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); mapEl.setPointerCapture?.(e.pointerId); if (pointers.size===1) lastPan = {x:e.clientX,y:e.clientY}; if (pointers.size===2){ const pts=Array.from(pointers.values()); initialPinchDist=getDist(pts[0],pts[1]); initialScale=window.__mobileScale||1; const mid=getMid(pts[0],pts[1]); const rect=mapEl.getBoundingClientRect(); initialCenter={elX:mid.x-rect.left, elY:mid.y-rect.top}; } }
    function onMove(e){
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if (pointers.size===1 && lastPan){
        const p = pointers.values().next().value;
        const dx = p.x - lastPan.x, dy = p.y - lastPan.y;
        lastPan = { x:p.x, y:p.y };
        window.__mobileTx = (window.__mobileTx||0) + dx;
        window.__mobileTy = (window.__mobileTy||0) + dy;
        mapEl.style.transformOrigin = mapEl.style.transformOrigin || '0 0';
        mapEl.style.transform = `translate(${window.__mobileTx}px, ${window.__mobileTy}px) scale(${window.__mobileScale||1})`;
        if (typeof window.__mobile_scheduleDraw === 'function') window.__mobile_scheduleDraw();
      } else if (pointers.size===2){
        const pts = Array.from(pointers.values());
        const dist = getDist(pts[0],pts[1]);
        if (initialPinchDist === null){
          initialPinchDist = dist;
          initialScale = window.__mobileScale || 1;
          const mid = getMid(pts[0],pts[1]); const rect = mapEl.getBoundingClientRect(); initialCenter = { elX: mid.x-rect.left, elY: mid.y-rect.top };
        } else {
          const newScale = clamp(initialScale * (dist / initialPinchDist), MIN_SCALE, MAX_SCALE);
          const rect = mapEl.getBoundingClientRect();
          const elX = initialCenter.elX, elY = initialCenter.elY;
          const oldScale = window.__mobileScale || 1;
          const oldViewportX = rect.left + (window.__mobileTx||0) + elX * oldScale;
          const oldViewportY = rect.top + (window.__mobileTy||0) + elY * oldScale;
          const txPrime = oldViewportX - rect.left - elX * newScale;
          const tyPrime = oldViewportY - rect.top - elY * newScale;
          window.__mobileTx = txPrime; window.__mobileTy = tyPrime; window.__mobileScale = newScale;
          mapEl.style.transformOrigin = mapEl.style.transformOrigin || '0 0';
          mapEl.style.transform = `translate(${window.__mobileTx}px, ${window.__mobileTy}px) scale(${newScale})`;
          if (typeof window.__mobile_scheduleDraw === 'function') window.__mobile_scheduleDraw();
        }
      }
    }
    function onUp(e){ pointers.delete(e.pointerId); if (pointers.size===0){ lastPan = null; initialPinchDist = null; initialScale = null; initialCenter = null; } }

    mapEl.addEventListener('pointerdown', onDown);
    mapEl.addEventListener('pointermove', onMove);
    mapEl.addEventListener('pointerup', onUp);
    mapEl.addEventListener('pointercancel', onUp);
    mapEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) < 1 && !e.ctrlKey) return;
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      const s = clamp((window.__mobileScale||1) * zoomFactor, MIN_SCALE, MAX_SCALE);
      window.__mobileScale = s;
      mapEl.style.transform = `translate(${window.__mobileTx||0}px, ${window.__mobileTy||0}px) scale(${s})`;
      if (typeof window.__mobile_scheduleDraw === 'function') window.__mobile_scheduleDraw();
    }, { passive:false });
  }

  // Initialize when map present (or timeout)
  (function waitAndStart(){
    const start = Date.now();
    (function poll(){
      const mapWrapper = findMapWrapper();
      if (mapWrapper){
        try {
          ensureTeamsBarPlaced();
          scheduleRender();
          wireUpdates();
          installGestures();
        } catch(e){ console.error(e); }
        return;
      }
      if (Date.now() - start > 12000){
        try { ensureTeamsBarPlaced(); scheduleRender(); wireUpdates(); installGestures(); } catch(e){}
        return;
      }
      setTimeout(poll, 80);
    })();
  })();

  // Public API
  window.__mobile_buildTeams = scheduleRender;
  window.__mobile_renderTeams = scheduleRender;
  window.__mobile_fitMapToBounds = fitMapToBounds;
  window.__mobile_focusTeam = function(bid){ window.__mobile_focused_team_building = bid; if (typeof window.__mobile_scheduleDraw === 'function') window.__mobile_scheduleDraw(); };
  window.__mobile_clearTeamFocus = function(){ window.__mobile_focused_team_building = null; if (typeof window.__mobile_scheduleDraw === 'function') window.__mobile_scheduleDraw(); };

})();