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
  draft = { name: '', devices: {}, steps: [] };       // a fresh, empty draft
  showView('builderView');
  document.getElementById('ritualNameInput').value = '';
  document.getElementById('builderMessage').textContent = '';

  // list the participant's subscribed devices, each with a role chooser
  const devices = await (await fetch('/users/' + currentUser.id + '/devices')).json();
  const box = document.getElementById('deviceRoles');
  if (devices.length === 0) {
    box.innerHTML = '<p class="muted">You have no devices yet — subscribe to one first.</p>';
    return;
  }
  box.innerHTML = devices.map(d => `
    <div class="device">
      <strong>${d.name}</strong> <span class="muted">${d.id}</span><br>
      <select id="role_${d.id}">
        <option value="none">not used</option>
        <option value="read">read (sense its values)</option>
        <option value="write">write (control its outputs)</option>
      </select>
    </div>`).join('');
}

// lock in the name + device roles, then fetch each device's config so the
// step dropdowns can offer that device's real sensors/outputs.
async function confirmDevices() {
  const name = document.getElementById('ritualNameInput').value.trim();
  if (!name) { document.getElementById('builderMessage').textContent = 'Give the ritual a name.'; return; }
  draft.name = name;

  // assign each chosen device a short alias (d1, d2, …); steps reference the alias
  draft.devices = {};
  document.querySelectorAll('[id^="role_"]').forEach(sel => {
    const deviceId = sel.id.slice(5);                 // strip the "role_" prefix
    if (sel.value === 'none') return;
    const alias = 'd' + (Object.keys(draft.devices).length + 1);
    draft.devices[alias] = { device_id: deviceId, role: sel.value };
  });

  deviceConfigs = {};
  for (const [alias, d] of Object.entries(draft.devices))
    deviceConfigs[alias] = await (await fetch('/devices/' + d.device_id + '/config')).json();

  document.getElementById('builderMessage').textContent = 'Devices confirmed. Now add steps below.';
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
  if (type === 'act')   Object.assign(base, { device: '', output: '', color: '#00ff00' });
  if (type === 'sense') Object.assign(base, { device: '', sensor: '', op: '<', value: 0, then: '', else: '' });
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
  if (field === 'device') renderSteps();
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

    if (s.type === 'act')
      fields = `
        <label>On which plant</label>
        ${deviceDropdown(s, writableDevices())}
        <label>Which output</label>
        ${outputDropdown(s)}
        <label>Colour</label>
        <input type="color" value="${s.color}" oninput="editStep('${s.id}','color',this.value)">`;

    if (s.type === 'sense') {
      const devs = readableDevices();
      fields = devs.length === 0
        ? `<p class="muted">This ritual has no readable devices. Go back, confirm a device as read or write, then add the sensor check.</p>`
        : `
          <label>On which plant</label>
          ${deviceDropdown(s, devs)}
          <label>Which sensor</label>
          ${sensorDropdown(s)}
          <label>Condition</label>
          <div style="display:flex;gap:8px">
            <select onchange="editStep('${s.id}','op',this.value)" style="flex:0 0 70px">
              ${['<','>','='].map(o => `<option ${s.op===o?'selected':''}>${o}</option>`).join('')}
            </select>
            <input type="number" value="${s.value}" oninput="editStep('${s.id}','value',this.value)" style="flex:1">
          </div>`;
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
      out.device = s.device; out.output = s.output;
      out.color = hexToRgb(s.color); out.next = sid(s.next);
    }

    if (s.type === 'sense') {
      out.device = s.device; out.sensor = s.sensor; out.op = s.op; out.value = +s.value;
      out.then = sid(s.then); out.else = sid(s.else);
      // pace a self-loop to how often this sensor actually updates
      const input = deviceConfigs[s.device] && deviceConfigs[s.device].inputs.find(i => i.name === s.sensor);
      out.min_recheck_ms = (input && input.interval_ms) || 5000;
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