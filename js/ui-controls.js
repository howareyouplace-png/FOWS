// ui-controls.js — improved stage-time detection and always-render placeholder when missing
// - Detects admin "time_start" and many other variants
// - Always renders a .stage-time element (shows '—' when missing)
// - Syncs with legacy controls and listens for postMessage updates to refresh immediately
'use strict';

(function(){
  // Helpers
  const $ = (sel, ctx=document) => ctx.querySelector(sel);
  const el = id => document.getElementById(id);
  const safeInt = v => parseInt(v, 10) || 0;
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }
  function colorForIndex(i, total){ const hue = Math.round((i * (360 / Math.max(1,total))) % 360); return `hsl(${hue} 78% 50%)`; }

  // Wait helper (wait until mapData or map.js exists)
  function waitFor(predicate, cb, interval=120, timeout=10000){
    const start = Date.now();
    (function poll(){
      try {
        if (predicate()) return cb();
        if (Date.now() - start > timeout) return cb();
      } catch(e){}
      setTimeout(poll, interval);
    })();
  }

  // Build controls container and return handles
  function buildControlsContainer(){
    let container = document.querySelector('.controls.modern');
    if (!container){
      container = document.getElementById('modernControls') || document.createElement('div');
      container.className = 'controls modern';
      if (!document.getElementById('modernControls')){
        const ref = document.querySelector('.page-title') || document.body.firstElementChild;
        ref && ref.insertAdjacentElement('afterend', container);
      }
    }
    container.innerHTML = '';

    const left = document.createElement('div'); left.className = 'controls-left';
    const label = document.createElement('label'); label.textContent = 'Legion:'; label.style.fontWeight='600'; label.style.marginRight='6px';
    const select = document.createElement('select'); select.id = 'modernLegionSelect';
    select.style.padding = '8px 10px'; select.style.borderRadius = '8px';
    left.appendChild(label); left.appendChild(select);

    const center = document.createElement('div'); center.className = 'controls-center';
    const stagesWrap = document.createElement('div'); stagesWrap.id = 'stagesBar';
    stagesWrap.style.display = 'flex'; stagesWrap.style.gap = '8px'; stagesWrap.style.alignItems = 'center'; stagesWrap.style.justifyContent = 'center'; stagesWrap.style.overflowX = 'auto';
    center.appendChild(stagesWrap);

    const sliderRow = document.createElement('div'); sliderRow.style.display='flex'; sliderRow.style.gap='8px'; sliderRow.style.alignItems='center'; sliderRow.style.marginTop='8px';
    const range = document.createElement('input'); range.type = 'range'; range.id = 'modernStageRange'; range.min = '1'; range.value = '1'; range.style.flex = '1';
    const rangeLbl = document.createElement('div'); rangeLbl.id = 'modernStageLabel'; rangeLbl.textContent = '1'; rangeLbl.style.minWidth='28px'; rangeLbl.style.textAlign='center'; rangeLbl.style.fontWeight='700';
    sliderRow.appendChild(range); sliderRow.appendChild(rangeLbl);
    center.appendChild(sliderRow);

    const right = document.createElement('div'); right.className = 'controls-right';
    function btn(txt, title){ const b=document.createElement('button'); b.type='button'; b.className='modern-btn'; b.textContent = txt; if (title) b.title = title; return b; }
    const prev = btn('◀','Previous'); const next = btn('▶','Next'); const refresh = btn('⟳','Reload'); const toggle = btn('⛶','Toggle grid');
    const pollingBtn = btn('📡','Enable auto-refresh (5 min)'); pollingBtn.id = 'pollingEnableBtn';
    pollingBtn.style.display = 'none'; // Hidden by default, shown on mobile or when polling is off
    right.appendChild(prev); right.appendChild(next); right.appendChild(refresh); right.appendChild(toggle); right.appendChild(pollingBtn);

    container.appendChild(left); container.appendChild(center); container.appendChild(right);

    return { container, select, stagesWrap, range, rangeLbl, rightButtons: right.querySelectorAll('.modern-btn'), prev, next, refresh, toggle, pollingBtn };
  }

  // Accessors for external map data & indices
  function getMapData(){ return (typeof window.mapData !== 'undefined') ? window.mapData : (typeof mapData !== 'undefined' ? mapData : null); }
  function getCurrentLegion(){ return (typeof window.currentLegionIndex !== 'undefined') ? window.currentLegionIndex : (typeof currentLegionIndex !== 'undefined' ? currentLegionIndex : 0); }
  function setCurrentLegion(v){ if(typeof window.currentLegionIndex !== 'undefined') window.currentLegionIndex = v; if(typeof currentLegionIndex !== 'undefined') currentLegionIndex = v; }
  function getCurrentStage(){ return (typeof window.currentStageNumber !== 'undefined') ? window.currentStageNumber : (typeof currentStageNumber !== 'undefined' ? currentStageNumber : 1); }
  function setCurrentStage(v){ if(typeof window.currentStageNumber !== 'undefined') window.currentStageNumber = v; if(typeof currentStageNumber !== 'undefined') currentStageNumber = v; }

  // Time extraction utilities (robust)
  function normalizeTimeValue(v){
    if (v === undefined || v === null) return '';
    if (typeof v === 'number'){
      const mins = Math.round(v);
      if (mins <= 0) return '';
      if (mins >= 60){
        const h = Math.floor(mins / 60), m = mins % 60;
        return m === 0 ? `${h}h` : `${h}h ${m}m`;
      }
      return `${mins}m`;
    }
    if (typeof v === 'string'){
      const s = v.trim();
      if (!s) return '';
      const isoMatch = s.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?/);
      if (isoMatch){
        try {
          const dt = new Date(isoMatch[0].replace(' ','T'));
          if (!isNaN(dt.getTime())){
            const hh = String(dt.getHours()).padStart(2,'0');
            const mm = String(dt.getMinutes()).padStart(2,'0');
            return `${hh}:${mm}`;
          }
        } catch(e){}
      }
      if (/^\d{1,2}:\d{2}$/.test(s)) return s;
      const m = s.match(/^(\d+)\s*(m|min|minutes)$/i);
      if (m) return `${m[1]}m`;
      return s;
    }
    if (typeof v === 'object'){
      if (v.value) return normalizeTimeValue(v.value);
      if (v.text) return normalizeTimeValue(v.text);
      if (v.label) return normalizeTimeValue(v.label);
    }
    return '';
  }

  function findStageTime(stage){
    if (!stage || typeof stage !== 'object') return '';
    const tryKeys = ['time_start','start_time','start','starts_at','startAt','start_time_local','startTime','time','time_label','timeLabel','duration','duration_label','durationLabel','label_time','when','hour'];
    // direct keys
    for (const k of tryKeys){
      if (k in stage){
        const parsed = normalizeTimeValue(stage[k]);
        if (parsed) return parsed;
      }
    }
    // loose match keys (e.g., "Start time")
    for (const k of Object.keys(stage)){
      if (typeof k === 'string' && k.toLowerCase().replace(/\s+/g,'').includes('start')){
        const parsed = normalizeTimeValue(stage[k]);
        if (parsed) return parsed;
      }
    }
    // nested containers
    const nestedPaths = ['meta','data','attributes','details'];
    for (const p of nestedPaths){
      if (p in stage && stage[p] && typeof stage[p] === 'object'){
        for (const k of tryKeys){
          if (k in stage[p]){
            const parsed = normalizeTimeValue(stage[p][k]);
            if (parsed) return parsed;
          }
        }
        if (stage[p].label){ const pr = normalizeTimeValue(stage[p].label); if (pr) return pr; }
        if (stage[p].text){ const pr = normalizeTimeValue(stage[p].text); if (pr) return pr; }
      }
    }
    // fallback: try notes
    if (stage.notes && typeof stage.notes === 'string'){
      const m = stage.notes.match(/(\b\d{1,2}:\d{2}\b)|(\b\d+\s?m(in)?\b)/i);
      if (m) return m[0];
    }
    return '';
  }

  // Initialization once mapData exists (or timeout)
  waitFor(()=> typeof window.mapData !== 'undefined' || typeof mapData !== 'undefined', init, 120, 10000);

  function init(){
    const dom = buildControlsContainer();
    const modernLegion = dom.select;
    const stagesWrap = dom.stagesWrap;
    const stageRange = dom.range;
    const stageNum = dom.rangeLbl;
    const prevBtn = dom.prev, nextBtn = dom.next, refreshBtn = dom.refresh, toggleBtn = dom.toggle;

    // legacy shortcuts
    const legacyLegion = el('legionSelect');
    const legacyStageRange = el('stageRange');
    const legacyStageLabel = el('stageLabel');
    const legacyRefresh = el('refreshBtn');
    const legacyToggle = el('toggleGridBtn');

    // Populate legions dropdowns and render stages
    function populateLegions(){
      const md = getMapData() || {};
      const legions = Array.isArray(md.legion_data) ? md.legion_data : [];
      modernLegion.innerHTML = '';
      if (legacyLegion) legacyLegion.innerHTML = '';
      legions.forEach((lg, idx) => {
        const o = document.createElement('option'); o.value = idx; o.textContent = lg.legion_id || `Legion ${idx+1}`; modernLegion.appendChild(o);
        if (legacyLegion){
          const o2 = document.createElement('option'); o2.value = idx; o2.textContent = lg.legion_id || `Legion ${idx+1}`; legacyLegion.appendChild(o2);
        }
      });
      const cur = Math.min(Math.max(getCurrentLegion(), 0), Math.max(legions.length-1, 0));
      setCurrentLegion(cur);
      modernLegion.value = String(cur);
      if (legacyLegion) legacyLegion.value = String(cur);
      renderStagesBar();
    }

    // Render stage segments (always include a .stage-time)
    function renderStagesBar(){
      stagesWrap.innerHTML = '';
      const md = getMapData() || {};
      const lg = md.legion_data?.[getCurrentLegion()];
      const stages = lg && Array.isArray(lg.stages) ? lg.stages.slice().sort((a,b)=> (a.stage_number||0) - (b.stage_number||0)) : [];
      if (!stages.length){
        const d = document.createElement('div'); d.textContent = 'No stages'; d.style.padding='6px 10px'; d.style.color='rgba(0,0,0,0.5)';
        stagesWrap.appendChild(d);
        updateRangeFromStages([]);
        return;
      }
      stages.forEach((s, idx) => {
        const seg = document.createElement('div');
        seg.className = 'stage-segment' + (s.stage_number === getCurrentStage() ? ' active' : ' inactive');
        seg.dataset.stageNumber = s.stage_number;
        seg.style.background = s.color || colorForIndex(idx, stages.length);

        const labelDiv = document.createElement('div'); labelDiv.className = 'stage-label';
        labelDiv.innerHTML = escapeHtml(s.name || ('Stage ' + s.stage_number));
        const timeDiv = document.createElement('div'); timeDiv.className = 'stage-time';

        const found = findStageTime(s);
        if (found && String(found).trim() !== ''){
          timeDiv.textContent = found;
          timeDiv.classList.remove('empty');
        } else {
          timeDiv.textContent = '—';
          timeDiv.classList.add('empty');
        }

        seg.appendChild(labelDiv);
        seg.appendChild(timeDiv);

        seg.title = s.notes || s.name || `Stage ${s.stage_number}`;
        seg.addEventListener('click', ()=>{
          setCurrentStage(s.stage_number);
          updateStageUI();
          if (typeof updateMapForCurrent === 'function') updateMapForCurrent();
          syncLegacyStageRange();
        });

        stagesWrap.appendChild(seg);
      });

      updateRangeFromStages(stages);
    }

    // Update slider min/max from stages
    function updateRangeFromStages(stages){
      const arr = (stages && stages.length) ? stages : (getMapData()?.legion_data?.[getCurrentLegion()]?.stages || []);
      const sarr = Array.isArray(arr) && arr.length ? arr.map(x=>x.stage_number).sort((a,b)=>a-b) : [];
      if (!sarr.length){
        stageRange.min = 1; stageRange.max = 1; stageRange.value = 1; stageNum.textContent = '1';
        if (legacyStageRange){ legacyStageRange.min = 1; legacyStageRange.max = 1; legacyStageRange.value = 1; if (legacyStageLabel) legacyStageLabel.textContent='1'; }
        return;
      }
      const min = sarr[0], max = sarr[sarr.length-1];
      stageRange.min = min; stageRange.max = max;
      let cur = getCurrentStage();
      if (cur < min || cur > max){ cur = min; setCurrentStage(cur); }
      stageRange.value = cur; stageNum.textContent = String(cur);
      if (legacyStageRange){ legacyStageRange.min = min; legacyStageRange.max = max; legacyStageRange.value = cur; if (legacyStageLabel) legacyStageLabel.textContent = String(cur); }
    }

    // Update active/slider state
    function updateStageUI(){
      stagesWrap.querySelectorAll('.stage-segment').forEach(s => {
        const sn = parseInt(s.dataset.stageNumber,10);
        s.classList.toggle('active', sn === getCurrentStage());
        s.classList.toggle('inactive', sn !== getCurrentStage());
      });
      stageRange.value = getCurrentStage();
      stageNum.textContent = String(getCurrentStage());
      if (legacyStageRange){ legacyStageRange.value = getCurrentStage(); if (legacyStageLabel) legacyStageLabel.textContent = String(getCurrentStage()); }
    }

    // Wire events: selects
    modernLegion.addEventListener('change', ()=>{
      const idx = safeInt(modernLegion.value);
      setCurrentLegion(idx);
      if (legacyLegion){ legacyLegion.value = String(idx); legacyLegion.dispatchEvent(new Event('change')); }
      renderStagesBar();
      if (typeof updateMapForCurrent === 'function') updateMapForCurrent();
    });
    if (legacyLegion){
      legacyLegion.addEventListener('change', ()=>{
        const idx = safeInt(legacyLegion.value);
        setCurrentLegion(idx);
        modernLegion.value = String(idx);
        renderStagesBar();
        if (typeof updateMapForCurrent === 'function') updateMapForCurrent();
      });
    }

    // slider handlers
    stageRange.addEventListener('input', ()=>{
      const v = safeInt(stageRange.value);
      setCurrentStage(v);
      stageNum.textContent = String(v);
      updateStageUI();
      if (typeof updateMapForCurrent === 'function') updateMapForCurrent();
      if (legacyStageRange){ legacyStageRange.value = v; if (legacyStageLabel) legacyStageLabel.textContent = String(v); }
    });
    if (legacyStageRange){
      legacyStageRange.addEventListener('input', ()=>{
        const v = safeInt(legacyStageRange.value);
        setCurrentStage(v);
        stageRange.value = v;
        stageNum.textContent = String(v);
        updateStageUI();
        if (typeof updateMapForCurrent === 'function') updateMapForCurrent();
      });
    }

    // prev/next/refresh/toggle wiring
    prevBtn && prevBtn.addEventListener('click', ()=> {
      const stages = (getMapData()?.legion_data?.[getCurrentLegion()]?.stages || []).slice().sort((a,b)=>a.stage_number - b.stage_number);
      if (!stages.length) return;
      const idx = stages.findIndex(s=>s.stage_number === getCurrentStage());
      const prev = idx > 0 ? stages[idx-1].stage_number : stages[0].stage_number;
      setCurrentStage(prev); updateStageUI(); if (typeof updateMapForCurrent === 'function') updateMapForCurrent();
    });
    nextBtn && nextBtn.addEventListener('click', ()=> {
      const stages = (getMapData()?.legion_data?.[getCurrentLegion()]?.stages || []).slice().sort((a,b)=>a.stage_number - b.stage_number);
      if (!stages.length) return;
      const idx = stages.findIndex(s=>s.stage_number === getCurrentStage());
      const next = idx < stages.length-1 ? stages[idx+1].stage_number : stages[stages.length-1].stage_number;
      setCurrentStage(next); updateStageUI(); if (typeof updateMapForCurrent === 'function') updateMapForCurrent();
    });
    refreshBtn && refreshBtn.addEventListener('click', ()=> { if (typeof loadData === 'function') loadData(); if (window.ModernControls && ModernControls.refresh) ModernControls.refresh(); });
    toggleBtn && toggleBtn.addEventListener('click', ()=> { try { window.showGrid = !window.showGrid; if (typeof renderGrid === 'function') renderGrid(window.showGrid); } catch(e){} });
    
    // Polling enable button (temporary 5 min enable)
    const pollingBtn = modernControls.pollingBtn;
    let pollingTimeout = null;
    
    // Show polling button on mobile or when polling is disabled
    try {
      if ((window.matchMedia && window.matchMedia('(max-width:900px)').matches) || 
          (typeof CONFIG !== 'undefined' && !CONFIG.POLL_ENABLED && !window.MAP_FORCE_POLL)) {
        pollingBtn.style.display = '';
      }
    } catch(e) {}
    
    pollingBtn && pollingBtn.addEventListener('click', () => {
      if (typeof window.enablePollingSafely !== 'function') {
        console.warn('enablePollingSafely not available');
        return;
      }
      
      // Enable polling
      window.enablePollingSafely(true, 3000); // 3 second interval
      pollingBtn.disabled = true;
      pollingBtn.textContent = '📡 Auto-refresh ON';
      pollingBtn.style.opacity = '0.7';
      
      // Auto-disable after 5 minutes
      if (pollingTimeout) clearTimeout(pollingTimeout);
      pollingTimeout = setTimeout(() => {
        window.enablePollingSafely(false);
        pollingBtn.disabled = false;
        pollingBtn.textContent = '📡';
        pollingBtn.title = 'Enable auto-refresh (5 min)';
        pollingBtn.style.opacity = '1';
        console.info('[ui-controls] Auto-refresh disabled after 5 minutes');
      }, 5 * 60 * 1000); // 5 minutes
    });

    // legacy wiring
    if (legacyRefresh) legacyRefresh.addEventListener('click', ()=> { if (typeof loadData === 'function') loadData(); });
    if (legacyToggle) legacyToggle.addEventListener('click', ()=> { try { window.showGrid = !window.showGrid; if (typeof renderGrid === 'function') renderGrid(window.showGrid); } catch(e){} });

    // populate initially
    populateLegions();
    window.ModernControls = window.ModernControls || {};
    window.ModernControls.refresh = function(){ populateLegions(); updateStageUI(); };

    // listen for immediate updates via postMessage (e.g., admin autosave)
    window.addEventListener('message', (ev)=>{
      try{
        const m = ev.data;
        if (!m || !m.type) return;
        // When admin saves it posts {type:'update-data', payload:...}
        if (m.type === 'update-data'){
          // refresh local UI from incoming payload if structure present
          setTimeout(()=>{ try { window.ModernControls.refresh(); } catch(e){} }, 120);
        }
        // preview handshake
        if (m.type === 'request-preview-ready'){
          try { ev.source.postMessage({ type: 'preview-ready' }, ev.origin || '*'); } catch(e){}
        }
      } catch(e){}
    });

    function syncLegacyStageRange(){ try { if (legacyStageRange){ legacyStageRange.value = getCurrentStage(); if (legacyStageLabel) legacyStageLabel.textContent = String(getCurrentStage()); } } catch(e){} }
  } // end init

})();