// ============================================================================
//  builder.js — the no-code ritual builder.
//
//  The participant edits a friendly DRAFT (held in the browser), then we
//  VALIDATE it (no dead ends / no guaranteed-infinite loops) and COMPILE it
//  into the engine's format before saving. They work in easy units (minutes,
//  hex colours, step numbers); the compiler produces the precise form.
//
//  Steps carry a stable `id` ('k7') that never changes, so pointers between
//  steps survive reordering/deletion. The DISPLAY number is just the step's
//  current position; the id is what next/then/else/answer_routes reference.
// ============================================================================

// ---- module state ----
let draft = null;             // the ritual being built (null until openBuilder)
let deviceConfigs = {};       // alias -> that device's config, for the dropdowns
let nextId = 1;               // ever-increasing source of stable step ids

// ============================================================================
//  DRAFT LIFECYCLE — open the builder, confirm devices
// ============================================================================

async function openBuilder() {
  draft = { name: '', plants: {}, devices: {}, steps: [] };
  showView('builderView');
  document.getElementById('ritualNameInput').value = '';
  document.getElementById('builderMessage').textContent = '';
  selectedPlants = {};

  const plants = await (await fetch('/plants?user_id=' + currentUser.id)).json();
  const picker = document.getElementById('plantPicker');
  if (plants.length === 0) {
    picker.innerHTML = '<option value="">— no plants yet —</option>';
  } else {
    picker.innerHTML = plants.map(p => `<option value="${p.id}">🌱 ${p.name}</option>`).join('');
  }
  renderPlantDeviceRoles();     // empty to start
}


let selectedPlants = {};    // plantId -> { name, devices: [{device_id, target_type, role}] }

async function addPlantToRitual() {
  const picker = document.getElementById('plantPicker');
  const plantId = picker.value;
  if (!plantId) return;
  if (selectedPlants[plantId]) return;      // already added — ignore

  const name = picker.options[picker.selectedIndex].text.replace('🌱 ', '');
  const devices = await (await fetch('/plants/' + plantId + '/devices')).json();
  selectedPlants[plantId] = {
    name,
    devices: devices.map(d => ({ device_id: d.device_id, target_type: d.target_type, role: 'read' }))
  };
  renderPlantDeviceRoles();
}

function renderPlantDeviceRoles() {
  const box = document.getElementById('plantDeviceRoles');
  const ids = Object.keys(selectedPlants);
  if (ids.length === 0) { box.innerHTML = '<p class="muted">No plants added yet.</p>'; return; }

  box.innerHTML = ids.map(pid => {
    const p = selectedPlants[pid];
    const rows = p.devices.length === 0
      ? '<p class="muted" style="margin:4px 0">No devices attached to this plant.</p>'
      : p.devices.map((d, i) => {
          const shared = d.target_type === 'environment';
          return `<div style="margin:4px 0">
            <strong>${d.device_id}</strong>
            ${shared
              ? '<span class="muted"> — shared, read only</span>'
              : `<select onchange="setDeviceRole('${pid}', ${i}, this.value)">
                   <option value="read"  ${d.role==='read' ? 'selected':''}>read (sense)</option>
                   <option value="write" ${d.role==='write'? 'selected':''}>write (act)</option>
                 </select>`}
          </div>`;
        }).join('');
    return `<div class="step">
      <div class="step-head">
        <span class="step-num">🌱 ${p.name}</span>
        <button class="step-remove" onclick="removePlantFromRitual('${pid}')">remove</button>
      </div>
      <div class="step-body">${rows}</div>
    </div>`;
  }).join('');
}

function removePlantFromRitual(plantId) {
  delete selectedPlants[plantId];
  renderPlantDeviceRoles();
}

function setDeviceRole(plantId, deviceIndex, role) {
  selectedPlants[plantId].devices[deviceIndex].role = role;
}



// lock in the name + device roles, then fetch each device's config so the
// step dropdowns can offer that device's real sensors/outputs.
async function confirmDevices() {
  const name = document.getElementById('ritualNameInput').value.trim();
  if (!name) { document.getElementById('builderMessage').textContent = 'Give the ritual a name.'; return; }
  if (Object.keys(selectedPlants).length === 0) {
    document.getElementById('builderMessage').textContent = 'Pick at least one plant.'; return;
  }
  draft.name = name;

  // record the plants involved (by id + name), for step references and framing
  draft.plants = {};
  for (const [pid, p] of Object.entries(selectedPlants)) {
    draft.plants['p' + pid] = { plant_id: Number(pid), name: p.name };
  }

  // resolve devices + roles into the engine's device header (aliases → device + role),
  // and remember which plant each device serves (for inference in steps)
  draft.devices = {};
  deviceConfigs = {};
  let n = 1;
  for (const [pid, p] of Object.entries(selectedPlants)) {
    for (const d of p.devices) {
      // one alias per device; if a device already added (shared across plants), reuse
      let alias = Object.keys(draft.devices).find(a => draft.devices[a].device_id === d.device_id);
      if (!alias) {
        alias = 'd' + (n++);
        draft.devices[alias] = { device_id: d.device_id, role: d.role, plant_id: Number(pid) };
        deviceConfigs[alias] = await (await fetch('/devices/' + d.device_id + '/config')).json();
      } else if (d.role === 'write') {
        draft.devices[alias].role = 'write';   // if any plant marks it write, it's write
      }
    }
  }
  // for each plant, gather its available sensors + outputs, remembering which
  // device provides each (so a sense/act step can infer the device from the pick)
  draft.plantIO = {};   // 'p5' -> { sensors:[{name,device_id}], outputs:[{name,device_id}] }
  for (const [pid, p] of Object.entries(selectedPlants)) {
    const sensors = [], outputs = [];
    for (const d of p.devices) {
      const cfg = await (await fetch('/devices/' + d.device_id + '/config')).json();
      (cfg.inputs || []).forEach(i => sensors.push({ name: i.name, device_id: d.device_id, interval_ms: i.interval_ms }));
      // outputs only from writable (non-shared) devices — you can't act through a shared device
      if (d.target_type !== 'environment')
        (cfg.outputs || []).forEach(o => outputs.push({ name: o.name, device_id: d.device_id }));
    }
    draft.plantIO['p' + pid] = { sensors, outputs, name: p.name };
  }
  document.getElementById('builderMessage').textContent = 'Plants confirmed. Now add steps below.';
  renderSteps();
}

// which devices can this ritual READ (sense)?  read OR write — write implies read.
function readableDevices() {
  return Object.entries(draft.devices)
    .filter(([, d]) => d.role === 'read' || d.role === 'write')
    .map(([alias, d]) => ({ alias, ...d }));
}
// which devices can this ritual WRITE (control)?  write only — these get the lock.
function writableDevices() {
  return Object.entries(draft.devices)
    .filter(([, d]) => d.role === 'write')
    .map(([alias, d]) => ({ alias, ...d }));
}

// ============================================================================
//  STEP CRUD — add / remove / edit steps in the draft
// ============================================================================

function addStep() {
  const type = document.getElementById('newStepType').value;
  const base = { id: 'k' + (nextId++), type, next: '' };   // stable id + empty exit
  if (type === 'say')   Object.assign(base, { text: '' });
  if (type === 'ask')   Object.assign(base, { text: '', options: '', timeout_min: 0, answer_routes: {}, branching: false });
  if (type === 'wait')  Object.assign(base, { minutes: 1 });
  if (type === 'act')   Object.assign(base, { plant: '', output: '', device: '', color: '#00ff00' });
  if (type === 'sense') Object.assign(base, { plant: '', sensor: '', device: '', op: '<', value: 0, then: '', else: '' });
  if (type === 'tend')   Object.assign(base, { plant: '', text: '', confirm: true });
  if (type === 'attend') Object.assign(base, { plant: '', text: '', confirm: true });
  draft.steps.push(base);
  renderSteps();
}

function removeStep(id) {
  draft.steps = draft.steps.filter(s => s.id !== id);
  // clear any pointers that referenced the now-deleted step
  draft.steps.forEach(s => {
    if (s.next === id) s.next = '';
    if (s.then === id) s.then = '';
    if (s.else === id) s.else = '';
  });
  renderSteps();
}

// update one field of one step. Guard against a stray id (returns quietly).
function editStep(id, field, value) {
  const s = draft.steps.find(s => s.id === id);
  if (!s) return;
  s[field] = value;
  // when the answer list changes, drop routes for answers that no longer exist
  if (field === 'options' && s.answer_routes) {
    const opts = value.split(',').map(o => o.trim()).filter(Boolean);
    Object.keys(s.answer_routes).forEach(a => { if (!opts.includes(a)) delete s.answer_routes[a]; });
  }
  // device change must re-render so the dependent sensor/output dropdown updates.
  // options does NOT re-render here — that would steal focus mid-typing; the
  // options input re-renders on blur instead (see renderSteps).
  if (field === 'device' || field === 'plant') renderSteps();
}

// ============================================================================
//  RENDERING — draw the whole step list from the draft (the single source)
// ============================================================================

function renderSteps() {
  const box = document.getElementById('stepList');
  box.innerHTML = draft.steps.map(s => {
    const n = draft.steps.indexOf(s) + 1;        // display number = current position
    let fields = '';

    if (s.type === 'say')
      fields = `
        <label>Message to show</label>
        <input placeholder="e.g. Good morning. Let's check on the plant." value="${s.text}"
               oninput="editStep('${s.id}','text',this.value)">`;

    if (s.type === 'ask')
      fields = `
        <label>Question</label>
        <input placeholder="e.g. How does the plant look today?" value="${s.text}"
               oninput="editStep('${s.id}','text',this.value)">
        <label>Answers (comma separated)</label>
        <input placeholder="e.g. drooping, perky, thirsty" value="${s.options}"
               oninput="editStep('${s.id}','options',this.value)" onblur="renderSteps()">
        <label>Give up after (minutes — 0 means wait forever)</label>
        <input type="number" value="${s.timeout_min}"
               oninput="editStep('${s.id}','timeout_min',this.value)">`;

    if (s.type === 'wait')
      fields = `
        <label>Wait for (minutes)</label>
        <input type="number" value="${s.minutes}" oninput="editStep('${s.id}','minutes',this.value)">`;

    if (s.type === 'act') {
      fields = `
        <label>On which plant</label>
        ${plantDropdown(s)}
        <label>Turn on which light / output</label>
        ${ioDropdown(s, 'output')}
        <label>Colour</label>
        <input type="color" value="${s.color}" oninput="editStep('${s.id}','color',this.value)">`;
    }

    if (s.type === 'sense') {
      fields = `
        <label>Read from which plant</label>
        ${plantDropdown(s)}
        <label>Which sensor</label>
        ${ioDropdown(s, 'sensor')}
        <label>Condition</label>
        <div style="display:flex;gap:8px">
          <select onchange="editStep('${s.id}','op',this.value)" style="flex:0 0 70px">
            ${['<','>','='].map(o => `<option ${s.op===o?'selected':''}>${o}</option>`).join('')}
          </select>
          <input type="number" value="${s.value}" oninput="editStep('${s.id}','value',this.value)" style="flex:1">
        </div>`;
    }
    if (s.type === 'tend' || s.type === 'attend') {
      const verb = s.type === 'tend' ? 'do to' : 'notice about';
      const example = s.type === 'tend'
        ? 'e.g. Give Basil some water.'
        : 'e.g. Sit with Basil a moment. Notice the colour of its leaves.';
      fields = `
        <label>Which plant</label>
        ${plantDropdown(s)}
        <label>What to ask the person to ${verb} the plant</label>
        <input placeholder="${example}" value="${s.text}"
               oninput="editStep('${s.id}','text',this.value)">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:4px">
          <input type="checkbox" style="width:auto" ${s.confirm ? 'checked' : ''}
                 onchange="editStep('${s.id}','confirm',this.checked)">
          wait for them to confirm they did it
        </label>`;
    }
    return `<div class="step">
      <div class="step-head">
        <span class="step-num">${n} · ${s.type}</span>
        <button class="step-remove" onclick="removeStep('${s.id}')">remove</button>
      </div>
      <div class="step-body">${fields}</div>
      ${renderWiring(s)}
    </div>`;
  }).join('') || '<p class="muted">No steps yet — add one below.</p>';
}

// the "where does this step go next" controls — differs by step type:
//  sense  -> two exits (if true / if false)
//  ask    -> a checkbox: all-to-one (default) OR per-answer routing
//  others -> a single "then go to"
function renderWiring(s) {
  if (s.type === 'sense')
    return `<div class="step-wiring">if true → ${nextDropdown(s,'then')} &nbsp; if false → ${nextDropdown(s,'else')}</div>`;

  if (s.type === 'ask') {
    const opts = s.options.split(',').map(o => o.trim()).filter(Boolean);
    const individual = opts.length === 0
      ? '<span class="muted">Type answers above to route them.</span>'
      : opts.map(o => `
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
            <span style="min-width:90px">"${o}" →</span>
            ${answerRouteDropdown(s, o)}
          </div>`).join('');
    return `<div class="step-wiring" style="flex-direction:column;align-items:stretch">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" style="width:auto" ${!s.branching ? 'checked' : ''}
               onchange="toggleBranching('${s.id}', this.checked)">
        all answers go to the same step
      </label>
      ${ s.branching
          ? `<div style="margin-top:8px">${individual}</div>`
          : `<div style="margin-top:8px">all answers → ${nextDropdown(s,'next')}</div>` }
    </div>`;
  }

  return `<div class="step-wiring">then go to → ${nextDropdown(s,'next')}</div>`;
}

// ============================================================================
//  DROPDOWN HELPERS — all the little <select>s the steps use
// ============================================================================

// pick a device (by alias) for an act/sense step
function deviceDropdown(s, devs) {
  return `<select onchange="editStep('${s.id}','device',this.value)">
    <option value="">— device —</option>
    ${devs.map(d => `<option value="${d.alias}" ${s.device===d.alias?'selected':''}>${d.device_id} (${d.role})</option>`).join('')}
  </select>`;
}

// pick one of the chosen device's OUTPUTS (act)
function outputDropdown(s) {
  const outs = (deviceConfigs[s.device] && deviceConfigs[s.device].outputs) || [];
  return `<select onchange="editStep('${s.id}','output',this.value)">
    <option value="">— output —</option>
    ${outs.map(o => `<option value="${o.name}" ${s.output===o.name?'selected':''}>${o.name}</option>`).join('')}
  </select>`;
}

// pick one of the chosen device's SENSORS (sense)
function sensorDropdown(s) {
  const ins = (deviceConfigs[s.device] && deviceConfigs[s.device].inputs) || [];
  return `<select onchange="editStep('${s.id}','sensor',this.value)">
    <option value="">— sensor —</option>
    ${ins.map(i => `<option value="${i.name}" ${s.sensor===i.name?'selected':''}>${i.name}</option>`).join('')}
  </select>`;
}

// a "go to" dropdown for a next/then/else pointer (offers every step + END,
// including this step itself, so a step can loop back on itself)
function nextDropdown(step, field) {
  const num = (s) => draft.steps.indexOf(s) + 1;
  const options = draft.steps.map(s => {
    const label = s.id === step.id ? `${num(s)} · ${s.type} (this step)` : `${num(s)} · ${s.type}`;
    return `<option value="${s.id}" ${step[field]===s.id?'selected':''}>${label}</option>`;
  }).join('');
  return `<select onchange="editStep('${step.id}','${field}',this.value)">
    <option value="">— choose —</option>
    ${options}
    <option value="end" ${step[field]==='end'?'selected':''}>END (finish)</option>
  </select>`;
}

// ---- per-answer routing (only used when an ask is branching) ----

function toggleBranching(stepId, allSame) {
  const s = draft.steps.find(x => x.id === stepId);
  s.branching = !allSame;              // "all to one" checked == NOT branching
  if (allSame) s.answer_routes = {};   // collapsing back to one clears the routes
  renderSteps();
}

function answerRouteDropdown(step, answer) {
  const cur = (step.answer_routes && step.answer_routes[answer]) || '';
  const num = (s) => draft.steps.indexOf(s) + 1;
  const opts = draft.steps.map(s => {
    const label = s.id === step.id ? `${num(s)} · ${s.type} (this step)` : `${num(s)} · ${s.type}`;
    return `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>${label}</option>`;
  }).join('');
  return `<select onchange="setAnswerRoute('${step.id}','${answer}',this.value)">
    <option value="">— choose —</option>
    ${opts}
    <option value="end" ${cur === 'end' ? 'selected' : ''}>END (finish)</option>
  </select>`;
}

function setAnswerRoute(stepId, answer, dest) {
  const s = draft.steps.find(x => x.id === stepId);
  if (!s.answer_routes) s.answer_routes = {};
  if (dest) s.answer_routes[answer] = dest;
  else delete s.answer_routes[answer];
  // no re-render needed: the dropdown already shows the new choice
}

// ============================================================================
//  VALIDATE — catch dead ends and guaranteed-infinite loops before saving.
//  Three tiers of safety: structural dead ends (here), structural infinite
//  loops (here), and behavioural non-termination (left to the stop button —
//  undecidable, and often intentional, e.g. an open-ended vigil).
// ============================================================================
function validateDraft() {
  const problems = [];
  if (!draft.name) problems.push('The ritual needs a name.');
  if (draft.steps.length === 0) problems.push('Add at least one step.');

  const validTargets = new Set([...draft.steps.map(s => s.id), 'end']);

  // (1) every pointer must point at a real step or END
  for (const s of draft.steps) {
    const n = draft.steps.indexOf(s) + 1;

    if (s.type === 'sense') {
      if (!validTargets.has(s.then)) problems.push(`Step ${n} (sense): "if true" goes nowhere.`);
      if (!validTargets.has(s.else)) problems.push(`Step ${n} (sense): "if false" goes nowhere.`);

    } else if (s.type === 'ask' && s.branching) {
      // branching ask: every listed answer must route somewhere valid.
      // (No separate fallback check: the human can only pick a listed option,
      //  so every possible answer is covered by the routes above.)
      const opts = s.options.split(',').map(o => o.trim()).filter(Boolean);
      if (opts.length === 0) problems.push(`Step ${n} (ask): add some answers to branch on.`);
      opts.forEach(o => {
        const dest = s.answer_routes && s.answer_routes[o];
        if (!dest || !validTargets.has(dest)) problems.push(`Step ${n} (ask): answer "${o}" goes nowhere.`);
      });

    } else {
      if (!validTargets.has(s.next)) problems.push(`Step ${n} (${s.type}): "then go to" goes nowhere.`);
    }

    if (s.type === 'act'   && (!s.device || !s.output)) problems.push(`Step ${n} (act): pick a device and output.`);
    if (s.type === 'sense' && (!s.device || !s.sensor)) problems.push(`Step ${n} (sense): pick a device and sensor.`);
    if ((s.type === 'tend' || s.type === 'attend') && !s.plant)
      problems.push(`Step ${n} (${s.type}): pick a plant.`);
  }

  // (2) reachability: can we get from the start to END? (traversal, loop-safe)
  if (draft.steps.length > 0) {
    const reachable = new Set();
    const stack = [draft.steps[0].id];
    let reachesEnd = false;
    while (stack.length) {
      const id = stack.pop();
      if (id === 'end') { reachesEnd = true; continue; }
      if (reachable.has(id)) continue;            // already visited — skip (handles cycles)
      reachable.add(id);
      const s = draft.steps.find(x => x.id === id);
      if (!s) continue;
      const exits =
        s.type === 'sense'                  ? [s.then, s.else] :
        (s.type === 'ask' && s.branching)   ? [...Object.values(s.answer_routes || {}), s.next] :
                                              [s.next];
      exits.forEach(e => { if (e) stack.push(e); });
    }
    if (!reachesEnd) problems.push('No path reaches END — the ritual would never finish.');
  }

  // (3) guaranteed-infinite loop: a cycle made ONLY of single-exit steps.
  // Multi-exit steps (sense, branching ask) are escape points, so a cycle
  // containing one is allowed (it MIGHT terminate — that's the stop button's job).
  for (const start of draft.steps) {
    if (start.type === 'sense') continue;
    if (start.type === 'ask' && start.branching) continue;
    let cur = start;
    const seen = new Set();
    while (cur && cur.type !== 'sense' && !(cur.type === 'ask' && cur.branching)) {
      if (cur.next === 'end' || !cur.next) break;           // reaches end / dead-end (caught in tier 1)
      if (seen.has(cur.id)) {
        problems.push(`Steps form a loop with no condition to ever exit (near step ${draft.steps.indexOf(start)+1}). Add a sense or branching question in the loop, or point a step to END.`);
        break;
      }
      seen.add(cur.id);
      cur = draft.steps.find(s => s.id === cur.next);
    }
  }

  return problems;
}

// ============================================================================
//  COMPILE — translate the friendly draft into the engine's exact format.
//  draft ids (k7) -> engine ids (s0..sN); minutes -> ms; hex -> {r,g,b};
//  comma-text -> options array; sense gets its sensor's recheck interval.
// ============================================================================
function compileDraft() {
  const idToSid = {};
  draft.steps.forEach((s, i) => idToSid[s.id] = 's' + i);
  idToSid['end'] = 'end';
  const sid = (id) => idToSid[id] || 'end';      // unknown/blank pointer -> end (safe)

  const steps = {};
  draft.steps.forEach((s, i) => {
    const out = { type: s.type };

    if (s.type === 'say') { out.text = s.text; out.next = sid(s.next); }

    if (s.type === 'ask') {
      out.text = s.text;
      out.options = s.options.split(',').map(o => o.trim()).filter(Boolean);
      out.save_as = 'answer' + i;
      out.next = sid(s.next);
      if (+s.timeout_min > 0) { out.timeout_ms = +s.timeout_min * 60000; out.on_timeout = sid(s.next); }
      if (s.branching && s.answer_routes) {       // translate each answer's route to an engine id
        out.answer_routes = {};
        for (const [ans, destId] of Object.entries(s.answer_routes)) out.answer_routes[ans] = sid(destId);
      }
    }

    if (s.type === 'wait') { out.duration_ms = +s.minutes * 60000; out.next = sid(s.next); }

    if (s.type === 'act') {
      const alias = Object.keys(draft.devices).find(a => draft.devices[a].device_id === s.device);
      out.device = alias; out.output = s.output;
      out.color = hexToRgb(s.color); out.next = sid(s.next);
      out.plant_name = draft.plantIO[s.plant] ? draft.plantIO[s.plant].name : '';
      out.device_name = s.device;                 // the device_id (nickname); fine for display
    }
    if (s.type === 'sense') {
      const alias = Object.keys(draft.devices).find(a => draft.devices[a].device_id === s.device);
      out.device = alias; out.sensor = s.sensor; out.op = s.op; out.value = +s.value;
      out.then = sid(s.then); out.else = sid(s.else);
      out.min_recheck_ms = s.min_recheck_ms || 5000;
      out.plant_name = draft.plantIO[s.plant] ? draft.plantIO[s.plant].name : '';
      out.device_name = s.device;
    }
    if (s.type === 'tend' || s.type === 'attend') {
      out.plant = s.plant;                    // plant alias, for framing/transcript
      out.plant_name = draft.plantIO[s.plant] ? draft.plantIO[s.plant].name : '';
      out.text = s.text;
      out.confirm = !!s.confirm;
      out.next = sid(s.next);
    }
    steps[idToSid[s.id]] = out;
  });
  steps['end'] = { type: 'end' };

  return { name: draft.name, devices: draft.devices, start: 's0', steps };
}

// ============================================================================
//  SAVE — validate, then compile and POST. Refuses to save an invalid ritual.
// ============================================================================
async function saveRitual() {
  const problems = validateDraft();
  const msg = document.getElementById('saveMessage');
  if (problems.length) {
    msg.innerHTML = '⚠ Cannot save:<br>' + problems.join('<br>');
    return;
  }
  await fetch('/rituals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id, name: draft.name, definition: compileDraft() })
  });
  msg.textContent = '✓ Saved! Find it in your rituals.';
  setTimeout(() => { showView('ritualsView'); loadRuns(); }, 1000);
}



// dropdown of the plants this ritual involves
function plantDropdown(s) {
  const plants = draft.plantIO || {};
  return `<select onchange="editStep('${s.id}','plant',this.value)">
    <option value="">— plant —</option>
    ${Object.entries(plants).map(([alias, p]) =>
      `<option value="${alias}" ${s.plant===alias?'selected':''}>🌱 ${p.name}</option>`).join('')}
  </select>`;
}

// dropdown of the chosen plant's sensors (kind='sensor') or outputs (kind='output')
function ioDropdown(s, kind) {
  const p = draft.plantIO && draft.plantIO[s.plant];
  const list = p ? (kind === 'sensor' ? p.sensors : p.outputs) : [];
  const field = kind === 'sensor' ? 'sensor' : 'output';
  return `<select onchange="pickIO('${s.id}','${field}',this.value)">
    <option value="">— ${kind} —</option>
    ${list.map(x => `<option value="${x.name}" ${s[field]===x.name?'selected':''}>${x.name}</option>`).join('')}
  </select>`;
}

// picking a sensor/output also INFERS the device that provides it
function pickIO(stepId, field, value) {
  const s = draft.steps.find(x => x.id === stepId);
  s[field] = value;
  const p = draft.plantIO[s.plant];
  const list = field === 'sensor' ? p.sensors : p.outputs;
  const match = list.find(x => x.name === value);
  s.device = match ? match.device_id : '';       // the inferred device
  // for sense, also carry the sensor's recheck interval (for self-loop pacing)
  if (field === 'sensor' && match && match.interval_ms) s.min_recheck_ms = match.interval_ms;
}

// the chain of poles a step enacts, e.g. ['UI','Nour'] or ['UI','Nour','Basil']
// each pole: { type:'human'|'plant'|'machine', name:'Nour'|'Basil'|'UI'|deviceNickname }
function stepRelation(step, ctx) {
  const H = { type: 'human',   name: ctx.human || 'you' };
  const P = (n) => ({ type: 'plant', name: n || 'the plant' });
  const UI = { type: 'machine', name: 'UI' };
  const M = (n) => ({ type: 'machine', name: n || 'device' });

  switch (step.type) {
    case 'say':    return [UI, H];                       // machine → human
    case 'ask':    return [H, UI];                       // human → machine
    case 'sense':  return [P(step.plant_name), M(step.device_name)];   // plant → machine
    case 'act':    return [M(step.device_name), P(step.plant_name)];   // machine → plant
    case 'tend':   return [UI, H, P(step.plant_name)];   // UI → human → plant (full chain)
    case 'attend': return [UI, H, P(step.plant_name)];   // UI → human ← plant (full chain)
    default:       return null;
  }
}
const POLE_GLYPH = { human: '🧑', plant: '🌱', machine: '🖥️' };

function relationTag(chain) {
  if (!chain) return '';
  return `<span class="relation">` +
    chain.map(p => `<span class="pole pole-${p.type}">${POLE_GLYPH[p.type]} ${p.name}</span>`)
         .join('<span class="rel-arrow">→</span>') +
    `</span>`;
}