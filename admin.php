<?php
// admin.php — Admin panel with visual Assignment Editor (Modal)
// Autosave-enabled admin UI: any change is persisted immediately via save_data.php
// and pushed to any open preview window via postMessage.
// Make sure config.php, save_data.php and foundry_map_data.json exist.
session_start([
    'cookie_httponly' => true,
    'cookie_samesite' => 'Lax'
]);
$config = require __DIR__ . '/config.php';
$dataFile = $config['data_file'];
$hasPost = $_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']);

function loadData($path) {
    if (!file_exists($path)) return ['buildings'=>[], 'legion_data'=>[]];
    $txt = file_get_contents($path);
    return json_decode($txt, true);
}

if ($hasPost && $_POST['action'] === 'login') {
    $pw = $_POST['password'] ?? '';
    $ok = false;
    if (!empty($config['admin_password_hash'])) {
        if (password_verify($pw, $config['admin_password_hash'])) $ok = true;
    }
    if (!$ok && !empty($config['admin_password_plain'])) {
        if (hash_equals((string)$config['admin_password_plain'], (string)$pw)) $ok = true;
    }
    if ($ok) {
        $_SESSION['admin'] = true;
    } else {
        $error = 'Wrong password';
    }
}

if ($hasPost && $_POST['action'] === 'logout') {
    session_destroy();
    header("Location: admin.php");
    exit;
}

$loggedIn = !empty($_SESSION['admin']);
$data = loadData($dataFile);
$extraBuildingSlots = 8;
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Admin — Foundry Battle Plan Manager</title>

  <!-- Styles -->
  <link rel="stylesheet" href="css/styles.css" />
  <link rel="stylesheet" href="css/admin.css" />
  <link rel="stylesheet" href="css/mobile.css" media="(max-width:900px)" />

  <style>
    /* Modal/backdrop */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 30030;
    }
    .modal {
      width: 860px;
      max-width: calc(100% - 40px);
      background: #fff;
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.25);
      max-height: 80vh;
      overflow: auto;
    }
    .modal h3 { margin-top:0; }
    .modal .modal-body { max-height: 60vh; overflow:auto; -webkit-overflow-scrolling: touch; padding-right:6px; }
    .player-modal-body { max-height: 56vh; overflow:auto; -webkit-overflow-scrolling: touch; padding-right:6px; }

    .assign-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
    .assign-row select, .assign-row input[type="text"] { flex:1; padding:6px; }
    .assign-row .players-list { flex:2; max-height:320px; overflow:auto; border:1px solid #eee; padding:6px; background:#fafafa; }
    .assign-row .players-list label { display:block; margin-bottom:4px; }

    .btn { padding:8px 10px; border-radius:6px; border:1px solid #cfcfcf; background:#f5f6f8; cursor:pointer; }
    .btn-primary { background:#2b7cff; color:#fff; border-color:#1e5ddc; }
    .btn-danger { background:#ff4d4d; color:#fff; border-color:#e03b3b; }
    .small { font-size:13px; color:#444; }
    .small-input { padding:6px 8px; border-radius:4px; border:1px solid #ddd; }

    .flex-row { display:flex; gap:8px; align-items:center; }
    .muted { color:#666; font-size:13px; }
    .players-list .draggable { cursor:grab; padding:6px; border:1px solid #e8eef8; border-radius:6px; background:#fff; margin-bottom:6px; }

    /* helper messages */
    .msg-inline { margin-left:10px; color: #2b7cff; font-weight:600; }
    .msg-error { margin-left:10px; color: crimson; font-weight:600; }
    
    /* JSON validation styling */
    .json-editor { width: 100%; padding: 10px; font-family: monospace; border: 2px solid #ddd; border-radius: 4px; }
    .json-editor.invalid { border-color: #ff4d4d; background-color: #fff5f5; }
    .json-editor.valid { border-color: #28a745; background-color: #f0fff4; }
    .validation-msg { margin-top: 4px; font-size: 13px; min-height: 18px; }
    .validation-msg.error { color: #ff4d4d; }
    .validation-msg.success { color: #28a745; }

    /* make forms responsive */
    @media (max-width:900px){
      .modal { width: calc(100% - 24px); max-height: 84vh; }
    }
  </style>
</head>
<body>
  <div style="max-width:1200px;margin:12px auto;">
    <h1 style="text-align:center">Admin — Foundry Battle Plan Manager</h1>

<?php if (!$loggedIn): ?>
    <div class="admin-section">
      <h3>Login</h3>
      <?php if (!empty($error)): ?><div style="color:red; margin-bottom:8px;"><?=htmlspecialchars($error)?></div><?php endif; ?>
      <form method="POST">
        <input type="hidden" name="action" value="login" />
        <label>Password: <input type="password" name="password" required></label>
        <button type="submit" class="btn">Login</button>
      </form>
      <p>Note: change password in config.php for production.</p>
    </div>
<?php else: ?>
    <form method="POST" style="float:left">
      <input type="hidden" name="action" value="logout" />
      <button type="submit" class="btn">Logout</button>
    </form>
    <div style="clear:both"></div>

    <div class="admin-section">
      <h3>Edit map data (visual editor + raw JSON)</h3>

      <div style="margin-bottom:10px" class="flex-row">
        <button id="openPreview" type="button" class="btn">Open Preview</button>
        <button id="testPreview" type="button" class="btn">Test Preview Connection</button>
        <button id="saveAllBtn" type="button" class="btn btn-primary">Save all changes (write file)</button>
        <span id="saveAllMsg" class="msg-inline"></span>
      </div>

      <h4>Raw JSON editor</h4>
      <form id="rawForm" onsubmit="return false;">
        <textarea id="jsonEditor" class="json-editor" aria-label="Map JSON editor" style="min-height:240px;"><?=htmlspecialchars(json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE))?></textarea>
        <div id="jsonValidation" class="validation-msg"></div>
        <div style="margin-top:8px">
          <button id="saveRawBtn" type="button" class="btn btn-primary">Save JSON</button>
          <span id="rawMsg" style="margin-left:12px"></span>
        </div>
      </form>

      <hr/>

      <h4>Visual buildings editor (grid coordinates & visual)</h4>
      <p class="small">Fields gridX/gridY store the isometric tile coordinates. Use the visual editor to set img_scale / img_offset_y for individual buildings.</p>

      <form id="buildingsForm" onsubmit="return false;">
        <table class="buildings-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left">
              <th style="width:10%;">ID</th>
              <th style="width:20%;">Name</th>
              <th style="width:28%;">png_path</th>
              <th style="width:8%;">gridX</th>
              <th style="width:8%;">gridY</th>
              <th style="width:10%;">Note</th>
            </tr>
          </thead>
          <tbody>
            <?php
              $existing = is_array($data['buildings']) ? $data['buildings'] : [];
              $count = count($existing);
              $total = $count + $extraBuildingSlots;
              for ($i = 0; $i < $total; $i++):
                $b = $existing[$i] ?? ['id'=>'','name_ar'=>'','png_path'=>'','gridX'=>'','gridY'=>'','note'=>''];
            ?>
            <tr>
              <td><input name="buildings[<?=$i?>][id]" value="<?=htmlspecialchars($b['id'])?>" /></td>
              <td><input name="buildings[<?=$i?>][name_ar]" value="<?=htmlspecialchars($b['name_ar'])?>" /></td>
              <td><input name="buildings[<?=$i?>][png_path]" value="<?=htmlspecialchars($b['png_path'])?>" placeholder="assets/..." /></td>
              <td><input name="buildings[<?=$i?>][gridX]" value="<?=htmlspecialchars($b['gridX'] ?? '')?>" placeholder="e.g. 0" /></td>
              <td><input name="buildings[<?=$i?>][gridY]" value="<?=htmlspecialchars($b['gridY'] ?? '')?>" placeholder="e.g. 0" /></td>
              <td><input name="buildings[<?=$i?>][note]" value="<?=htmlspecialchars($b['note'] ?? '')?>" /></td>
            </tr>
            <?php endfor; ?>
          </tbody>
        </table>

        <div style="margin-top:8px">
          <button id="updateBuildingsBtn" type="button" class="btn">Update buildings (apply and save)</button>
          <span id="buildingsMsg" style="margin-left:12px"></span>
        </div>
      </form>

      <hr/>

      <h4>Manage Legions & Stages</h4>
      <div id="legionList"></div>

      <hr/>

      <h4>CSV Import/Export</h4>
      <div style="margin-bottom:10px">
        <p class="small">Export or import player assignments as CSV. Format: Player Name, Legion ID, Stage Number, Building ID</p>
        <div class="flex-row" style="margin-bottom:8px">
          <button id="exportCSVBtn" type="button" class="btn">Export Assignments to CSV</button>
          <button id="exportPlayersCSVBtn" type="button" class="btn">Export Players to CSV</button>
        </div>
        <div class="flex-row">
          <input type="file" id="importCSVFile" accept=".csv" />
          <button id="importCSVBtn" type="button" class="btn">Import Assignments from CSV</button>
          <span id="csvMsg" style="margin-left:12px"></span>
        </div>
      </div>

      <hr/>

      <h4>Visual Editor (per-building)</h4>
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="buildingSelect" style="flex:1"></select>
        <label style="margin-left:8px;">Scale:</label>
        <input id="buildingScale" type="number" step="0.05" min="0.1" value="1.0" class="small-input" />
        <label style="margin-left:8px;">Offset Y (px):</label>
        <input id="buildingOffset" type="number" step="1" value="0" class="small-input" />
        <button id="applyVisual" class="btn btn-primary">Apply & Save</button>
      </div>
      <div style="margin-top:8px;" class="muted">Most actions auto-save and push changes instantly to the preview.</div>

    </div>

    <!-- Assignment Editor Modal -->
    <div id="assignModalBackdrop" class="modal-backdrop" role="dialog" aria-hidden="true">
      <div class="modal" id="assignModal" role="document">
        <h3 id="assignModalTitle">Manage Assignments</h3>
        <div id="assignModalBody" class="modal-body"></div>

        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
          <button id="assignAddRowBtn" class="btn">Add assignment row</button>
          <button id="assignSaveBtn" class="btn btn-primary">Save assignments</button>
          <button id="assignCancelBtn" class="btn btn-danger">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Player editor modal (scrollable body) -->
    <div id="playerEditModalBackdrop" class="modal-backdrop" role="dialog" aria-hidden="true">
      <div class="modal" id="playerEditModal" role="document" style="min-width:360px;">
        <h3 id="playerEditTitle">Edit Players</h3>
        <div id="playerEditBody" class="player-modal-body"></div>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
          <button id="playerEditClose" class="btn btn-primary">Close</button>
        </div>
      </div>
    </div>

    <!-- Add Stage Modal -->
    <div id="addStageModalBackdrop" class="modal-backdrop" role="dialog" aria-hidden="true">
      <div class="modal" id="addStageModal" role="document">
        <h3>Add Stage</h3>
        <div class="modal-body">
          <div style="margin-bottom:8px;">
            <label>Stage number: <input id="newStageNumberInput" class="small-input" /></label>
          </div>
          <div style="margin-bottom:8px;">
            <label>Start time (optional): <input id="newStageStartTimeInput" placeholder="e.g. 18:30 or 45m" class="small-input" /></label>
          </div>
          <div style="margin-bottom:8px;">
            <label>Notes (optional)</label>
            <textarea id="newStageNotesInput" rows="3" style="width:100%"></textarea>
          </div>
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
          <button id="addStageCancelBtn" class="btn">Cancel</button>
          <button id="addStageSaveBtn" class="btn btn-primary">Add Stage</button>
        </div>
      </div>
    </div>

    <script>
      // Admin client script — autosave on actions, push preview updates by postMessage.
      const rawEditor = document.getElementById('jsonEditor');
      const jsonValidation = document.getElementById('jsonValidation');
      const saveRawBtn = document.getElementById('saveRawBtn');
      const rawMsg = document.getElementById('rawMsg');
      const buildingsForm = document.getElementById('buildingsForm');
      const updateBuildingsBtn = document.getElementById('updateBuildingsBtn');
      const buildingsMsg = document.getElementById('buildingsMsg');
      const saveAllBtn = document.getElementById('saveAllBtn');
      const saveAllMsg = document.getElementById('saveAllMsg');
      const openPreview = document.getElementById('openPreview');
      const testPreview = document.getElementById('testPreview');

      const buildingSelect = document.getElementById('buildingSelect');
      const buildingScale = document.getElementById('buildingScale');
      const buildingOffset = document.getElementById('buildingOffset');
      const applyVisual = document.getElementById('applyVisual');

      const assignModalBackdrop = document.getElementById('assignModalBackdrop');
      const assignModalBody = document.getElementById('assignModalBody');
      const assignAddRowBtn = document.getElementById('assignAddRowBtn');
      const assignSaveBtn = document.getElementById('assignSaveBtn');
      const assignCancelBtn = document.getElementById('assignCancelBtn');

      const playerEditModalBackdrop = document.getElementById('playerEditModalBackdrop');
      const playerEditBody = document.getElementById('playerEditBody');
      const playerEditClose = document.getElementById('playerEditClose');

      const addStageModalBackdrop = document.getElementById('addStageModalBackdrop');
      const newStageNumberInput = document.getElementById('newStageNumberInput');
      const newStageStartTimeInput = document.getElementById('newStageStartTimeInput');
      const newStageNotesInput = document.getElementById('newStageNotesInput');
      const addStageCancelBtn = document.getElementById('addStageCancelBtn');
      const addStageSaveBtn = document.getElementById('addStageSaveBtn');

      let data = <?=json_encode($data, JSON_UNESCAPED_UNICODE)?>;
      let previewWin = null;
      let saveLock = false; // prevent concurrent saves
      let lastSavedData = JSON.stringify(data); // track changes for autosave guard

      // Validate JSON in editor
      function validateJSON(str) {
        try {
          const parsed = JSON.parse(str);
          if (!parsed.buildings || !Array.isArray(parsed.buildings)) {
            return { valid: false, error: 'Missing or invalid buildings array' };
          }
          if (!parsed.legion_data || !Array.isArray(parsed.legion_data)) {
            return { valid: false, error: 'Missing or invalid legion_data array' };
          }
          return { valid: true, parsed };
        } catch (e) {
          return { valid: false, error: e.message };
        }
      }

      // Update JSON validation UI
      function updateJSONValidation() {
        const result = validateJSON(rawEditor.value);
        if (result.valid) {
          rawEditor.classList.remove('invalid');
          rawEditor.classList.add('valid');
          jsonValidation.textContent = '✓ Valid JSON';
          jsonValidation.className = 'validation-msg success';
          saveRawBtn.disabled = false;
        } else {
          rawEditor.classList.remove('valid');
          rawEditor.classList.add('invalid');
          jsonValidation.textContent = '✗ ' + result.error;
          jsonValidation.className = 'validation-msg error';
          saveRawBtn.disabled = true;
        }
      }

      // Listen for JSON editor changes
      rawEditor.addEventListener('input', updateJSONValidation);
      
      // Initial validation
      updateJSONValidation();

      function sendToPreview(){
        if (!previewWin || previewWin.closed) return;
        try { previewWin.postMessage({ type: 'update-data', payload: data }, '*'); }
        catch(e){ console.warn('preview post failed', e); }
      }

      openPreview.onclick = () => {
        previewWin = window.open('index.html', 'map-preview');
        setTimeout(()=> sendToPreview(), 600);
      };

      // Test preview connection
      testPreview.onclick = () => {
        if (!previewWin || previewWin.closed) {
          showTransientMessage(saveAllMsg, 'Preview not open. Click "Open Preview" first.', true, 3000);
          return;
        }
        
        // Send a ping and wait for response
        let responded = false;
        const timeout = setTimeout(() => {
          if (!responded) {
            showTransientMessage(saveAllMsg, 'Preview timeout - no response received', true, 3000);
          }
        }, 3000);
        
        const handleResponse = (ev) => {
          if (ev.data && ev.data.type === 'preview-pong') {
            responded = true;
            clearTimeout(timeout);
            showTransientMessage(saveAllMsg, '✓ Preview connected successfully!', false, 2500);
            window.removeEventListener('message', handleResponse);
          }
        };
        
        window.addEventListener('message', handleResponse);
        try {
          previewWin.postMessage({ type: 'preview-ping' }, '*');
        } catch(e) {
          clearTimeout(timeout);
          showTransientMessage(saveAllMsg, 'Preview connection error: ' + e.message, true, 3000);
        }
      };

      // central save function — writes data to server and notifies preview
      async function saveToServer(payload, { showMsg = true } = {}) {
        if (saveLock) {
          // queue a retry shortly
          setTimeout(()=> saveToServer(payload, { showMsg }), 250);
          return;
        }
        
        // Guard: only save if data actually changed
        const currentDataStr = JSON.stringify(payload);
        if (currentDataStr === lastSavedData) {
          if (showMsg) showTransientMessage(saveAllMsg, 'No changes to save', false, 1400);
          return true;
        }
        
        saveLock = true;
        try {
          const resp = await fetch('save_data.php', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ payload })
          });
          const j = await resp.json();
          if (j && j.ok) {
            data = payload;
            lastSavedData = currentDataStr;
            const msg = j.message || 'Saved';
            const versionInfo = j.version ? ` (v${j.version})` : '';
            if (showMsg) showTransientMessage(saveAllMsg, msg + versionInfo, false, 1400);
            sendToPreview();
            return true;
          } else {
            const err = j && j.message ? j.message : (j && j.error ? j.error : 'save failed');
            if (showMsg) showTransientMessage(saveAllMsg, 'Error: ' + err, true, 3500);
            return false;
          }
        } catch (e) {
          console.warn('save failed', e);
          if (showMsg) showTransientMessage(saveAllMsg, 'Save error: ' + e.message, true, 3500);
          return false;
        } finally {
          saveLock = false;
        }
      }

      function showTransientMessage(el, txt, isError=false, ms=2000){
        if (!el) return;
        const prev = el.textContent;
        el.textContent = txt;
        if (isError) el.style.color = 'crimson'; else el.style.color = '';
        setTimeout(()=> { el.textContent = prev; el.style.color = ''; }, ms);
      }

      // helper: deep-clone and save
      function updateDataAndSave(localData){
        try {
          const payload = JSON.parse(JSON.stringify(localData));
          saveToServer(payload).catch(()=>{});
        } catch (e) {
          console.warn('updateDataAndSave failed', e);
        }
      }

      // Render UI (legions/stages)
      function renderLegions(){
        const container = document.getElementById('legionList');
        container.innerHTML = '';
        if (!data.legion_data) return;
        data.legion_data.forEach((lg, legionIdx) => {
          const box = document.createElement('div');
          box.style.border = '1px solid #e0e0e0';
          box.style.padding = '10px';
          box.style.marginBottom = '8px';

          const h = document.createElement('h4');
          h.textContent = lg.legion_id;
          box.appendChild(h);

          const playersRow = document.createElement('div');
          playersRow.style.display = 'flex';
          playersRow.style.justifyContent = 'space-between';
          playersRow.style.alignItems = 'center';

          const playersArea = document.createElement('div');
          playersArea.style.whiteSpace = 'pre-wrap';
          playersArea.style.flex = '1';
          playersArea.style.marginRight = '8px';
          playersArea.textContent = (lg.all_players || []).join("\n");
          playersRow.appendChild(playersArea);

          const editPlayersBtn = document.createElement('button');
          editPlayersBtn.className = 'btn';
          editPlayersBtn.textContent = 'Edit players';
          editPlayersBtn.onclick = () => openPlayersEditor(legionIdx);
          playersRow.appendChild(editPlayersBtn);

          box.appendChild(playersRow);

          const stagesDiv = document.createElement('div');
          stagesDiv.style.marginTop = '8px';
          (lg.stages || []).forEach((st, stageIdx) => {
            const stRow = document.createElement('div');
            stRow.style.display = 'flex';
            stRow.style.justifyContent = 'space-between';
            stRow.style.alignItems = 'center';
            stRow.style.padding = '6px 0';
            stRow.style.borderTop = '1px solid #f0f0f0';

            const left = document.createElement('div');
            left.innerHTML = `<strong>Stage ${st.stage_number}</strong> — <small>${st.time_start || '-'}</small><div class="muted">${st.notes || ''}</div>`;
            stRow.appendChild(left);

            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.gap = '6px';

            const manageBtn = document.createElement('button'); manageBtn.className='btn'; manageBtn.textContent='Manage assignments';
            manageBtn.onclick = ()=> openAssignmentEditor(legionIdx, stageIdx);
            right.appendChild(manageBtn);

            const editBtn = document.createElement('button'); editBtn.className='btn'; editBtn.textContent='Edit';
            editBtn.onclick = ()=> openStageEditor(legionIdx, stageIdx);
            right.appendChild(editBtn);

            const delBtn = document.createElement('button'); delBtn.className='btn btn-danger'; delBtn.textContent='Delete';
            delBtn.onclick = ()=> {
              if (!confirm('Delete stage?')) return;
              lg.stages.splice(stageIdx,1);
              updateDataAndSave(data);
              renderLegions();
            };
            right.appendChild(delBtn);

            stRow.appendChild(right);
            stagesDiv.appendChild(stRow);
          });

          const addStageRow = document.createElement('div');
          addStageRow.style.marginTop = '8px';
          addStageRow.innerHTML = `<button id="addStageBtn_${legionIdx}" class="btn">Add Stage</button>`;
          stagesDiv.appendChild(addStageRow);

          box.appendChild(stagesDiv);
          container.appendChild(box);

          document.getElementById(`addStageBtn_${legionIdx}`).onclick = () => {
            openAddStageModal(legionIdx);
          };
        });
      }

      // Players modal: scrollable, autosave on add/delete
      function openPlayersEditor(legionIdx){
        const lg = data.legion_data[legionIdx];
        playerEditModalBackdrop.style.display = 'flex';
        document.getElementById('playerEditTitle').textContent = `Edit players — ${lg.legion_id}`;
        playerEditBody.innerHTML = '';

        const list = document.createElement('div');
        list.style.maxHeight = '420px';
        list.style.overflow = 'auto';
        list.style.paddingRight = '6px';
        (lg.all_players || []).forEach((p,i)=>{
          const item = document.createElement('div');
          item.className = 'draggable';
          item.draggable = true;
          item.style.display = 'flex';
          item.style.justifyContent = 'space-between';
          item.style.alignItems = 'center';
          item.style.padding = '6px';
          const span = document.createElement('span'); span.textContent = p;
          const delBtn = document.createElement('button'); delBtn.className='btn'; delBtn.textContent='Del';
          delBtn.onclick = ()=> {
            lg.all_players.splice(i,1);
            updateDataAndSave(data);
            openPlayersEditor(legionIdx);
          };
          item.appendChild(span); item.appendChild(delBtn);
          item.addEventListener('dragstart', ev=>{
            ev.dataTransfer.setData('text/plain', JSON.stringify({ type:'player-assign', player: p, legionIdx }));
            item.classList.add('dragging');
          });
          item.addEventListener('dragend', ()=> item.classList.remove('dragging'));
          list.appendChild(item);
        });
        playerEditBody.appendChild(list);

        const addRow = document.createElement('div');
        addRow.style.marginTop = '8px';
        addRow.innerHTML = `<input id="newPlayerName" placeholder="Player name" /><button id="addPlayerBtn" class="btn">Add Player</button>`;
        playerEditBody.appendChild(addRow);

        playerEditBody.querySelector('#addPlayerBtn').onclick = ()=>{
          const v = playerEditBody.querySelector('#newPlayerName').value.trim();
          if (!v) return alert('Player required');
          lg.all_players = lg.all_players || [];
          lg.all_players.push(v);
          updateDataAndSave(data);
          openPlayersEditor(legionIdx);
        };

        setTimeout(()=> {
          const inp = playerEditBody.querySelector('#newPlayerName');
          if (inp) inp.focus();
        }, 50);

        const escHandler = (ev) => { if (ev.key === 'Escape') { playerEditModalBackdrop.style.display = 'none'; window.removeEventListener('keydown', escHandler); } };
        window.addEventListener('keydown', escHandler);

        playerEditClose.onclick = ()=> { playerEditModalBackdrop.style.display = 'none'; window.removeEventListener('keydown', escHandler); };
      }

      // Assignment editor: saving applies immediately (autosave)
      function openAssignmentEditor(legionIdx, stageIdx){
        const lg = data.legion_data[legionIdx];
        const st = lg.stages[stageIdx];
        document.getElementById('assignModalTitle').textContent = `Manage assignments — ${lg.legion_id} — Stage ${st.stage_number}`;
        assignModalBody.innerHTML = '';
        const help = document.createElement('div'); help.className='small'; help.textContent = 'Select players for each building and save.';
        assignModalBody.appendChild(help);

        function makeRow(assign = null){
          const row = document.createElement('div'); row.className='assign-row';
          const bSel = document.createElement('select'); bSel.style.minWidth='160px';
          const emptyOpt = document.createElement('option'); emptyOpt.value=''; emptyOpt.textContent='-- select building --'; bSel.appendChild(emptyOpt);
          (data.buildings||[]).forEach(b=>{ const opt=document.createElement('option'); opt.value=b.id||''; opt.textContent=`${b.id} — ${b.name_ar||''}`; bSel.appendChild(opt); });
          if (assign && assign.building_id) bSel.value = assign.building_id;
          const playersDiv = document.createElement('div'); playersDiv.className='players-list';
          (lg.all_players||[]).forEach(p=>{
            const lbl=document.createElement('label'); lbl.style.display='block';
            const cb = document.createElement('input'); cb.type='checkbox'; cb.value = p;
            if (assign && assign.player_names && assign.player_names.indexOf(p)!==-1) cb.checked = true;
            lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + p));
            playersDiv.appendChild(lbl);
          });
          const delBtn = document.createElement('button'); delBtn.className='btn btn-danger'; delBtn.textContent='Remove';
          delBtn.onclick = ()=> row.remove();
          row.appendChild(bSel); row.appendChild(playersDiv); row.appendChild(delBtn);
          return row;
        }

        (st.assignments || []).forEach(a=> assignModalBody.appendChild(makeRow(a)));
        if (!(st.assignments && st.assignments.length)) assignModalBody.appendChild(makeRow());

        assignModalBackdrop.style.display = 'flex';
        assignAddRowBtn.onclick = ()=> assignModalBody.appendChild(makeRow());
        assignCancelBtn.onclick = ()=> assignModalBackdrop.style.display = 'none';
        assignSaveBtn.onclick = ()=> {
          const rows = Array.from(assignModalBody.querySelectorAll('.assign-row'));
          const newAssignments = [];
          for (const r of rows){
            const sel = r.querySelector('select');
            if (!sel) continue;
            const building_id = sel.value || '';
            if (!building_id) continue;
            const checked = Array.from(r.querySelectorAll('input[type=checkbox]')).filter(cb=>cb.checked).map(cb=>cb.value);
            newAssignments.push({ building_id, player_names: checked });
          }
          data.legion_data[legionIdx].stages[stageIdx].assignments = newAssignments;
          updateDataAndSave(data);
          assignModalBackdrop.style.display = 'none';
        };
      }

      // Add Stage modal flow
      function openAddStageModal(legionIdx){
        newStageNumberInput.value = '';
        newStageStartTimeInput.value = '';
        newStageNotesInput.value = '';
        addStageModalBackdrop.style.display = 'flex';

        addStageCancelBtn.onclick = ()=> { addStageModalBackdrop.style.display = 'none'; };

        addStageSaveBtn.onclick = ()=> {
          const n = parseInt(newStageNumberInput.value, 10);
          if (!n) { alert('Invalid stage number'); return; }
          const lg = data.legion_data[legionIdx];
          lg.stages = lg.stages || [];
          if (lg.stages.find(s => s.stage_number === n)) { alert('Stage exists'); return; }
          const st = { stage_number: n, assignments: [], notes: newStageNotesInput.value || '' };
          if (newStageStartTimeInput.value && String(newStageStartTimeInput.value).trim() !== '') {
            st.time_start = newStageStartTimeInput.value.trim();
          }
          lg.stages.push(st);
          updateDataAndSave(data);
          addStageModalBackdrop.style.display = 'none';
          renderLegions();
        };
      }

      // Stage editor modal: edits saved immediately
      function openStageEditor(legionIdx, stageIdx){
        const lg = data.legion_data[legionIdx];
        const s = lg.stages[stageIdx];
        const title = `Edit Stage ${s.stage_number} for ${lg.legion_id}`;
        const modal = document.createElement('div'); modal.className='modal';
        modal.innerHTML = `<h3>${title}</h3>
          <div class="modal-body" style="margin-top:8px">
            <div style="margin-top:8px"><label>Start time: <input id="stageTime" value="${s.time_start || ''}" /></label></div>
            <div style="margin-top:8px"><label>Notes</label><textarea id="stageNotes" rows="4" style="width:100%">${(s.notes||'').replace(/</g,'&lt;')}</textarea></div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;"><button id="saveStageBtn" class="btn btn-primary">Save</button><button id="cancelStageBtn" class="btn">Cancel</button></div>`;
        const backdrop = document.createElement('div'); backdrop.className='modal-backdrop'; backdrop.style.zIndex='30031'; backdrop.style.display='flex';
        backdrop.appendChild(modal); document.body.appendChild(backdrop);
        backdrop.querySelector('#cancelStageBtn').onclick = ()=> { document.body.removeChild(backdrop); };
        backdrop.querySelector('#saveStageBtn').onclick = ()=> {
          s.time_start = backdrop.querySelector('#stageTime').value || '';
          s.notes = backdrop.querySelector('#stageNotes').value || '';
          updateDataAndSave(data);
          renderLegions();
          document.body.removeChild(backdrop);
        };
      }

      // Save raw JSON explicitly
      saveRawBtn.onclick = async () => {
        const validation = validateJSON(rawEditor.value);
        if (!validation.valid) {
          rawMsg.textContent = 'Cannot save: ' + validation.error;
          rawMsg.style.color = 'crimson';
          setTimeout(()=> { rawMsg.textContent = ''; rawMsg.style.color = ''; }, 3000);
          return;
        }
        try {
          const parsed = validation.parsed;
          await saveToServer(parsed, { showMsg:true });
          renderLegions();
          populateBuildingSelect();
        } catch (err) {
          rawMsg.textContent = 'Error: ' + err.message;
          rawMsg.style.color = 'crimson';
          setTimeout(()=> { rawMsg.textContent = ''; rawMsg.style.color = ''; }, 3000);
        }
      };

      // Update buildings: apply and autosave
      updateBuildingsBtn.onclick = () => {
        const formData = new FormData(buildingsForm);
        const idxs = new Set();
        for (let pair of formData.entries()){
          const name = pair[0];
          const m = name.match(/^buildings\[(\d+)\]\[(.+)\]$/);
          if (m) idxs.add(m[1]);
        }
        const newBuildings = [];
        Array.from(idxs).sort((a,b)=>a-b).forEach(i=>{
          const id = (formData.get(`buildings[${i}][id]`) || '').trim();
          const name_ar = formData.get(`buildings[${i}][name_ar]`) || '';
          const png_path = formData.get(`buildings[${i}][png_path]`) || '';
          const gridX = formData.get(`buildings[${i}][gridX]`);
          const gridY = formData.get(`buildings[${i}][gridY]`);
          const note = formData.get(`buildings[${i}][note]`) || '';

          if (id === '' && name_ar === '' && png_path === '' && (gridX === null || gridX === '') && (gridY === null || gridY === '') && note === '') {
            return;
          }
          const gx = (gridX === null || gridX === '') ? '' : (isNaN(Number(gridX)) ? gridX : Number(gridX));
          const gy = (gridY === null || gridY === '') ? '' : (isNaN(Number(gridY)) ? gridY : Number(gridY));
          const old = data.buildings ? data.buildings.find(b=>b.id === id) : {};
          const entry = Object.assign({}, old, {
            id,
            name_ar,
            png_path,
            gridX: gx,
            gridY: gy
          });
          if (note) entry.note = note;
          newBuildings.push(entry);
        });
        data.buildings = newBuildings;
        updateDataAndSave(data);
        buildingsMsg.textContent = 'Updated and saved.';
        setTimeout(()=> buildingsMsg.textContent = '', 1800);
        renderLegions();
        populateBuildingSelect();
      };

      saveAllBtn.onclick = async () => {
        const validation = validateJSON(rawEditor.value);
        if (!validation.valid) {
          saveAllMsg.textContent = 'Cannot save: ' + validation.error;
          saveAllMsg.style.color = 'crimson';
          setTimeout(()=> { saveAllMsg.textContent = ''; saveAllMsg.style.color = ''; }, 3000);
          return;
        }
        try {
          const parsed = validation.parsed;
          await saveToServer(parsed, { showMsg:true });
          renderLegions();
          populateBuildingSelect();
        } catch (err) {
          saveAllMsg.textContent = 'Error: ' + err.message;
          saveAllMsg.style.color = 'crimson';
          setTimeout(()=> { saveAllMsg.textContent = ''; saveAllMsg.style.color = ''; }, 3000);
        }
      };

      function populateBuildingSelect(){
        buildingSelect.innerHTML = '<option value="">-- select building --</option>';
        (data.buildings || []).forEach((b, i)=>{
          const opt = document.createElement('option');
          opt.value = b.id || '';
          opt.textContent = `${b.id || 'b'+i} — ${b.name_ar || ''}`;
          buildingSelect.appendChild(opt);
        });
      }

      buildingSelect.onchange = ()=>{
        const id = buildingSelect.value;
        const b = (data.buildings || []).find(bb => bb.id == id);
        if (!b) { buildingScale.value = 1.0; buildingOffset.value = 0; return; }
        buildingScale.value = typeof b.img_scale === 'number' ? b.img_scale : 1.0;
        buildingOffset.value = typeof b.img_offset_y === 'number' ? b.img_offset_y : 0;
      };

      applyVisual.onclick = ()=>{
        const id = buildingSelect.value;
        if (!id) return alert('Select building');
        const b = (data.buildings || []).find(bb => bb.id == id);
        if (!b) return alert('Building not found');
        b.img_scale = parseFloat(buildingScale.value) || 1.0;
        b.img_offset_y = parseInt(buildingOffset.value,10) || 0;
        updateDataAndSave(data);
        showTransientMessage(buildingsMsg, 'Visual saved', false, 1400);
      };

      // live parsing input -> update UI while typing (non-destructive, no auto-save)
      rawEditor.addEventListener('input', () => {
        updateJSONValidation();
        try {
          const parsed = JSON.parse(rawEditor.value);
          // Don't update data or send to preview while typing
          // Only visual feedback for validation
        } catch (e) { /* ignore until valid JSON */ }
      });

      // initial render & populate
      renderLegions();
      populateBuildingSelect();

      // Accept preview handshake
      window.addEventListener('message', ev => {
        const msg = ev.data || {};
        if (msg.type === 'preview-ready') {
          sendToPreview();
        } else if (msg.type === 'preview-pong') {
          // Handled by testPreview click handler
        }
      });

      // CSV Export/Import functionality
      document.getElementById('exportCSVBtn').onclick = () => {
        const rows = [['Player Name', 'Legion ID', 'Stage Number', 'Building ID']];
        
        (data.legion_data || []).forEach(legion => {
          (legion.stages || []).forEach(stage => {
            (stage.assignments || []).forEach(assignment => {
              (assignment.player_names || []).forEach(playerName => {
                rows.push([
                  playerName,
                  legion.legion_id,
                  stage.stage_number,
                  assignment.building_id
                ]);
              });
            });
          });
        });
        
        const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'foundry_assignments_' + new Date().toISOString().slice(0,10) + '.csv';
        link.click();
        showTransientMessage(document.getElementById('csvMsg'), 'CSV exported', false, 2000);
      };

      document.getElementById('exportPlayersCSVBtn').onclick = () => {
        const rows = [['Legion ID', 'Player Name']];
        
        (data.legion_data || []).forEach(legion => {
          (legion.all_players || []).forEach(playerName => {
            rows.push([legion.legion_id, playerName]);
          });
        });
        
        const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'foundry_players_' + new Date().toISOString().slice(0,10) + '.csv';
        link.click();
        showTransientMessage(document.getElementById('csvMsg'), 'Players CSV exported', false, 2000);
      };

      document.getElementById('importCSVBtn').onclick = () => {
        const fileInput = document.getElementById('importCSVFile');
        const file = fileInput.files[0];
        if (!file) {
          showTransientMessage(document.getElementById('csvMsg'), 'Please select a CSV file', true, 2000);
          return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const csv = e.target.result;
            const lines = csv.split('\n').map(line => {
              // Simple CSV parser (handles quoted fields)
              const regex = /("([^"]|"")*"|[^,]+|(?<=,)(?=,)|(?<=^)(?=,)|(?<=,)(?=$))/g;
              return (line.match(regex) || []).map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"'));
            }).filter(line => line.length > 0);
            
            if (lines.length < 2) {
              showTransientMessage(document.getElementById('csvMsg'), 'CSV file is empty or invalid', true, 2500);
              return;
            }
            
            // Skip header row
            const dataRows = lines.slice(1);
            let importCount = 0;
            
            dataRows.forEach(row => {
              if (row.length < 4) return;
              const [playerName, legionId, stageNumber, buildingId] = row.map(s => String(s).trim());
              if (!playerName || !legionId || !stageNumber || !buildingId) return;
              
              // Find or create legion
              let legion = data.legion_data.find(l => l.legion_id === legionId);
              if (!legion) {
                legion = { legion_id: legionId, all_players: [], stages: [] };
                data.legion_data.push(legion);
              }
              
              // Add player if not exists
              if (!legion.all_players.includes(playerName)) {
                legion.all_players.push(playerName);
              }
              
              // Find or create stage
              const stageNum = parseInt(stageNumber, 10);
              let stage = legion.stages.find(s => s.stage_number === stageNum);
              if (!stage) {
                stage = { stage_number: stageNum, assignments: [], notes: '' };
                legion.stages.push(stage);
              }
              
              // Find or create assignment
              let assignment = stage.assignments.find(a => a.building_id === buildingId);
              if (!assignment) {
                assignment = { building_id: buildingId, player_names: [] };
                stage.assignments.push(assignment);
              }
              
              // Add player to assignment if not already there
              if (!assignment.player_names.includes(playerName)) {
                assignment.player_names.push(playerName);
                importCount++;
              }
            });
            
            updateDataAndSave(data);
            renderLegions();
            rawEditor.value = JSON.stringify(data, null, 2);
            updateJSONValidation();
            showTransientMessage(document.getElementById('csvMsg'), `Imported ${importCount} assignments`, false, 2500);
            fileInput.value = '';
          } catch (err) {
            showTransientMessage(document.getElementById('csvMsg'), 'Import error: ' + err.message, true, 3000);
          }
        };
        reader.readAsText(file);
      };
    </script>

    <!-- Include mobile-only JS after admin script so mobile behavior is added only on small screens -->
    <script src="js/mobile.js" defer></script>

<?php endif; ?>
  </div>
</body>
</html>