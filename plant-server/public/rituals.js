// ============================================================================
//  rituals.js — the rituals page, the live "now" section, the transcript,
//  the ritual preview (diagram + steps), and the global question prompt box.
//
//  Two scoping rules throughout: a user sees only THEIR rituals (created_by)
//  and only THEIR runs (started_by) — every fetch passes user_id.
// ============================================================================

// ---- page state ----
let runOffset      = 0;      // which page of run history we're on
let ritualOffset   = 0;      // which page of saved rituals we're on
let openInstanceId = null;   // which run's transcript is open (null = none)
let shownPromptId  = null;   // which question the prompt box currently shows

const PAGE = 4;              // rituals & runs shown per page

// ============================================================================
//  NAVIGATION
// ============================================================================
async function openRituals() {
  showView('ritualsView');
  loadRuns();
}

function eventRelationships(e) {
  const p = e.payload || {};
  const H  = { type: 'human',   name: (currentUser ? currentUser.name : 'you') };
  const UI = { type: 'machine', name: 'UI' };
  const dev = { type: 'machine', name: p.device || 'device' };
  const plant = { type: 'plant', name: p.plant_name || 'the plant' };
  const targetPole = p.target === 'human' ? H : plant;   // sense/act: plant or you

  switch (e.type) {
    case 'say':              return [[UI, H]];
    case 'ask':              return [[UI, H]];                 // posing = UI→human
    case 'answer':           return [[H, UI]];                 // answering = human→UI
    case 'sense':            return [[targetPole, dev]];       // plant/you → device
    case 'act':              return [[dev, targetPole]];       // device → plant/you
    case 'tend':             return [[UI, H]];                 // invitation only
    case 'tend_confirmed':   return [[H, plant], [H, UI]];     // acted, then reported
    case 'attend':           return [[UI, H]];                 // invitation only
    case 'attend_noticed':   return [[plant, H], [H, UI]];     // perceived, then reported
    default:                 return [];                        // start/end/timeout — no relation
  }
}





// ============================================================================
//  THE RITUALS PAGE — live section, your rituals, past runs (all paginated)
// ============================================================================
async function loadRuns() {
  await renderNowSection();

  // --- your saved rituals (paginated) ---
  const rData = await (await fetch(`/rituals?user_id=${currentUser.id}&offset=${ritualOffset}&limit=${PAGE}`)).json();
  document.getElementById('ritualDefs').innerHTML = rData.rituals.length === 0
    ? '<p class="muted">No rituals yet — build one above.</p>'
    : rData.rituals.map(r => `
        <div class="list-card clickable" onclick="openRitualPreview(${r.id})">
          <span class="label"><strong>${r.name}</strong></span>
          <span class="actions">
            <button class="small-btn" onclick="startRitual(${r.id}, event)">▶ run</button>
            <button class="icon-btn"  onclick="hideRitual(${r.id}, event)">🗑</button>
          </span>
        </div>`).join('');
  document.getElementById('ritualPager').innerHTML = pagerHtml('pageRituals', ritualOffset, rData.hasMore);

  // --- your past runs (paginated) ---
  const data = await (await fetch(`/instances?user_id=${currentUser.id}&offset=${runOffset}&limit=${PAGE}`)).json();
  document.getElementById('runList').innerHTML = data.runs.length === 0
    ? '<p class="muted">No runs yet.</p>'
    : data.runs.map(r => {
        const when = new Date(r.started_at).toLocaleString();
        const dot  = r.status === 'running' ? '🟢' : r.status === 'failed' ? '🔴' : '⚪';
        return `<div class="list-card clickable" onclick="openTranscript(${r.id})">
          <span class="label">
            <strong>${dot} ${r.ritual_name}</strong>
            <span class="muted">${when} · ${r.status}</span>
          </span>
        </div>`;
      }).join('');
  document.getElementById('runPager').innerHTML = pagerHtml('pageRuns', runOffset, data.hasMore);
}

// shared "← newer / page N / older →" pager markup
function pagerHtml(fn, offset, hasMore) {
  return `<button class="back" onclick="${fn}(-1)" ${offset === 0 ? 'disabled' : ''}>← newer</button>
          <span class="muted">page ${offset / PAGE + 1}</span>
          <button class="back" onclick="${fn}(1)" ${hasMore ? '' : 'disabled'}>older →</button>`;
}
function pageRuns(dir)    { runOffset    = Math.max(0, runOffset    + dir * PAGE); loadRuns(); }
function pageRituals(dir) { ritualOffset = Math.max(0, ritualOffset + dir * PAGE); loadRuns(); }

// the live "Happening now" section — every currently-running instance.
// Uses a high limit so a running run is never missed because of paging.
async function renderNowSection() {
  const data = await (await fetch(`/instances?user_id=${currentUser.id}&limit=100`)).json();
  const running = data.runs.filter(r => r.status === 'running');
  const box = document.getElementById('nowSection');
  if (running.length === 0) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="section">
    <div class="live-section-title">✿ Happening now</div>
    ${running.map(r => `
      <div class="live-card" onclick="openTranscript(${r.id})">
        <div class="live-name">${r.ritual_name}</div>
        <div class="live-status"><span class="live-dot"></span>${r.status_text || 'starting…'}</div>
        <div style="margin-top:12px"><button class="small-btn" onclick="stopRitual(${r.id}, event)">■ stop ritual</button></div>
      </div>`).join('')}
  </div>`;
}

// ============================================================================
//  START / STOP / HIDE
//  All three pass `event` so a click on the button doesn't also trigger the
//  enclosing card's onclick (stopPropagation).
// ============================================================================
async function startRitual(ritualId, event) {
  if (event) event.stopPropagation();
  const res = await fetch('/rituals/' + ritualId + '/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: currentUser.id }) });
  if (!res.ok) { const info = await res.json(); alert(info.error || 'Could not start'); return; }  // e.g. device locked
  loadRuns();
}

async function stopRitual(instanceId, event) {
  if (event) event.stopPropagation();
  await fetch('/instances/' + instanceId + '/stop', { method: 'POST' });
  loadRuns();
}

async function hideRitual(id, event) {
  if (event) event.stopPropagation();
  if (!confirm('Remove this ritual? (Its run history is kept.)')) return;
  const res = await fetch('/rituals/' + id + '/hide', { method: 'POST' });
  if (!res.ok) { alert('Hide failed — check the server.'); return; }
  loadRuns();
}

// the badge on the Rituals button (devices page). High limit so it never
// misses a running ritual that's sitting beyond the first page of runs.
async function updateRitualBadge() {
  if (!currentUser) return;
  const data = await (await fetch(`/instances?user_id=${currentUser.id}&limit=100`)).json();
  const running = data.runs.some(r => r.status === 'running');
  const btn = document.getElementById('ritualsBtn');
  if (btn) btn.textContent = running ? 'Rituals 🟢' : 'Rituals →';
}

// ============================================================================
//  RITUAL PREVIEW — the state-machine diagram + the readable step list
// ============================================================================
async function openRitualPreview(ritualId) {
  const data = await (await fetch(`/rituals?user_id=${currentUser.id}&limit=100`)).json();
  const ritual = data.rituals.find(r => r.id === ritualId);
  if (!ritual) return;
  showView('ritualPreviewView');
  document.getElementById('previewTitle').textContent = ritual.name;

  const def  = ritual.definition;
  const devs = Object.values(def.devices || {});
  document.getElementById('previewDevices').textContent = devs.length
    ? 'Uses: ' + devs.map(d => `${d.device_id} (${d.role})`).join(', ')
    : 'A conversation-only ritual (no devices).';

  // the diagram (the shape) — Mermaid lays out the state machine for us
  const diagramBox = document.getElementById('previewDiagram');
  try {
    const { svg } = await mermaid.render('ritualGraph' + ritualId, ritualToMermaid(def));
    diagramBox.innerHTML = svg;
  } catch (e) {
    diagramBox.innerHTML = '<p class="muted">Could not draw the diagram.</p>';
    console.error('mermaid', e);
  }

  // the detail (each step in plain language)
  document.getElementById('previewSteps').innerHTML =
    Object.keys(def.steps).filter(id => id !== 'end').map((id, i) => {
      const s = def.steps[id];
      let desc = '';
      if (s.type === 'say')    desc = `<span class="voice-plant">🌱 "${s.text}"</span>`;
      if (s.type === 'ask')    desc = `<span class="voice-plant">❔ "${s.text}"</span><br><span class="muted">answers: ${(s.options||[]).join(', ')}</span>`;
      if (s.type === 'wait')   desc = `<span class="muted">⏳ wait ${Math.round(s.duration_ms/60000)} min</span>`;
      if (s.type === 'act')    desc = `<span class="muted">💡 set ${s.output} → rgb(${s.color.r},${s.color.g},${s.color.b})</span>`;
      if (s.type === 'sense')  desc = `<span class="muted">🔍 if ${s.sensor} ${s.op} ${s.value}</span>`;
      if (s.type === 'tend')   desc = `<span class="voice-plant">🌿 "${s.text}"</span>${s.confirm ? '<br><span class="muted">waits for confirmation</span>' : ''}`;
      if (s.type === 'attend') desc = `<span class="voice-plant">👁 "${s.text}"</span>${s.confirm ? '<br><span class="muted">waits for confirmation</span>' : ''}`;

      return `<div class="step">
        <div class="step-head">
          <span class="step-num">${i+1} · ${s.type}</span>
          ${relationTag(previewChain(s, def))}
        </div>
        <div class="step-body">${desc}</div>
      </div>`;
    }).join('') || '<p class="muted">This ritual has no steps.</p>';
}
function previewChain(s, def) {
  const H = { type:'human', name: currentUser ? currentUser.name : 'you' };
  const UI = { type:'machine', name:'UI' };
  const P = { type:'plant', name: s.plant_name || 'the plant' };
  const M = { type:'machine', name: s.device_name || 'device' };
  switch (s.type) {
    case 'say':    return [UI, H];
    case 'ask':    return [H, UI];
    case 'sense':  return [P, M];
    case 'act':    return [M, P];
    case 'tend':   return [UI, H, P];
    case 'attend': return [UI, H, P];
    default:       return null;
  }
}
// turn a compiled ritual into a Mermaid flowchart description.
// One arrow per exit: sense forks true/false; a branching ask forks per answer.
function ritualToMermaid(def) {
  const lines = ['flowchart TD'];                    // TD = top-down
  const label = (id) => {
    if (id === 'end') return 'endNode([finish])';     // 'end' is reserved in Mermaid — use a safe id
    const s = def.steps[id];
    const i = Object.keys(def.steps).indexOf(id) + 1;
    let txt = s.type;
    if (s.type === 'say')    txt = 'say: '  + truncate(s.text, 18);
    if (s.type === 'ask')    txt = 'ask: '  + truncate(s.text, 18);
    if (s.type === 'wait')   txt = 'wait '  + Math.round(s.duration_ms/60000) + 'm';
    if (s.type === 'act')    txt = 'set '   + s.output;
    if (s.type === 'sense')  txt = 'sense ' + s.sensor + ' ' + s.op + ' ' + s.value;
    if (s.type === 'tend')   txt = 'tend: ' + truncate(s.text, 18);
    if (s.type === 'attend') txt = 'attend: ' + truncate(s.text, 18);
    return `${id}["${i}· ${txt}<br/>(${relationText(s)})"]`;
  };

  for (const id of Object.keys(def.steps)) {
    const s = def.steps[id];
    if (id === 'end') continue;
    if (s.type === 'sense') {
      lines.push(`${label(id)} -->|true| ${label(s.then)}`);
      lines.push(`${label(id)} -->|false| ${label(s.else)}`);
    } else if (s.type === 'ask' && s.answer_routes && Object.keys(s.answer_routes).length) {
      for (const [ans, dest] of Object.entries(s.answer_routes))
        lines.push(`${label(id)} -->|${truncate(ans, 12)}| ${label(dest)}`);
      if (s.next && s.next !== 'end') lines.push(`${label(id)} -->|other| ${label(s.next)}`);
    } else {
      lines.push(`${label(id)} --> ${label(s.next)}`);
    }
  }
  return lines.join('\n');
}
function relationText(s) {
  switch (s.type) {
    case 'say':    return 'machine to you';
    case 'ask':    return 'you to machine';
    case 'sense':  return (s.target === 'human' ? 'you to machine' : 'plant to machine');
    case 'act':    return (s.target === 'human' ? 'machine to you' : 'machine to plant');
    case 'tend':   return 'you to plant';
    case 'attend': return 'plant to you';
    default: return '';
  }
}
// trim long text and strip quotes (which would break Mermaid's label syntax)
function truncate(t, n) {
  t = (t || '').replace(/"/g, "'");
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ============================================================================
//  THE TRANSCRIPT — one run's full conversation, auto-refreshing while open
// ============================================================================
async function openTranscript(instanceId) {
  openInstanceId = instanceId;
  showView('transcriptView');
  refreshTranscript();
}
let runView = 'transcript';

function setRunView(which) {
  runView = which;
  document.getElementById('transcript').style.display = which === 'transcript' ? 'block' : 'none';
  document.getElementById('swimlane').style.display   = which === 'relations'  ? 'block' : 'none';
  refreshTranscript();     // re-render whichever is showing
}
async function refreshTranscript() {
  if (openInstanceId === null) return;
  const inst   = await (await fetch('/instances/' + openInstanceId)).json();
  const events = await (await fetch('/instances/' + openInstanceId + '/events')).json();
  if (!inst) return;
  document.getElementById('transcriptTitle').textContent = inst.ritual_name;
  document.getElementById('transcriptStatus').textContent =
    inst.status === 'running' ? ('Now: ' + (inst.status_text || 'starting…')) : ('This run is ' + inst.status + '.');
  document.getElementById('transcript').innerHTML = renderTranscript(events);
  if (runView === 'relations') document.getElementById('swimlane').innerHTML = renderSwimlane(events);
}

// map a diary event to its relationship(s) — each is a [from, to] pair of pole-types.
// most events are one relationship; tend/attend confirmations are two.
// swimlane wants pole-TYPE pairs; derive them from the relationship model
function eventChains(e) {
  return eventRelationships(e).map(chain => chain.map(pole => pole.type));
}


function eventShortLabel(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'say':    return 'says';
    case 'ask':    return 'asks';
    case 'answer': return '"' + (p.answer || '') + '"';
    case 'sense':  return p.sensor;
    case 'act':    return 'set ' + p.output;
    case 'tend':            return 'tend: ' + (p.text || '');
    case 'tend_confirmed':  return 'tended';
    case 'attend':          return 'attend: ' + (p.text || '');
    case 'attend_noticed':  return 'noticed';
    default: return e.type;
  }
}

function renderSwimlane(events) {
  const laneX = { machine: 240, human: 60, plant: 420 };
  const laneColor = { human: '#5a7a52', plant: '#3d5a34', machine: '#8a7a5c' };
  const laneLabel = { human: '🧑 you', machine: '🖥️ machine', plant: '🌱 plant' };
  const W = 480, rowH = 46, topPad = 50;

  // build the flat list of relationship-rows, collapsing consecutive same-sensor senses
  const rows = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    const chains = eventChains(e);
    if (chains.length === 0) { i++; continue; }

    if (e.type === 'sense') {
      let j = i;
      while (j < events.length && events[j].type === 'sense' && events[j].payload.sensor === e.payload.sensor) j++;
      const run = events.slice(i, j);
      const last = run[run.length - 1];
      const relPair = eventChains(last)[0] || ['plant','machine'];
      rows.push({ pair: relPair,
        label: last.payload.sensor + (run.length > 1 ? ` ×${run.length}` : '') + (last.payload.passed ? ' ✓' : ' ✗') });
      i = j;
    } else {
      chains.forEach(pair => rows.push({ pair, label: eventShortLabel(e) }));
      i++;
    }
  }

  if (rows.length === 0) return '<p class="muted">No relational events in this run yet.</p>';

  const H = topPad + rows.length * rowH + 20;
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="max-width:100%;font-family:var(--sans)">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="var(--ink)"/></marker></defs>`;

  for (const lane of ['human','machine','plant']) {
    svg += `<line x1="${laneX[lane]}" y1="${topPad-10}" x2="${laneX[lane]}" y2="${H-10}"
              stroke="${laneColor[lane]}" stroke-width="1" opacity="0.3"/>`;
    svg += `<text x="${laneX[lane]}" y="${topPad-24}" text-anchor="middle" font-size="12"
              fill="${laneColor[lane]}" font-weight="600">${laneLabel[lane]}</text>`;
  }

  rows.forEach((r, idx) => {
    const y = topPad + idx * rowH;
    const from = laneX[r.pair[0]], to = laneX[r.pair[1]];
    svg += `<line x1="${from}" y1="${y}" x2="${to}" y2="${y}" stroke="var(--ink)" stroke-width="1.5" marker-end="url(#arrow)"/>`;
    svg += `<circle cx="${from}" cy="${y}" r="3" fill="${laneColor[r.pair[0]]}"/>`;
    const lx = (from + to) / 2;
    svg += `<text x="${lx}" y="${y - 6}" text-anchor="middle" font-size="11" fill="var(--bark)">${r.label}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

// render the diary, COLLAPSING runs of consecutive same-sensor sense events
// into one summary line (so a vigil's 200 checks don't flood the view).
// All events stay in the DB — this only folds the DISPLAY.
function renderTranscript(events) {
  const out = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (e.type === 'sense') {
      let j = i;
      while (j < events.length && events[j].type === 'sense' && events[j].payload.sensor === e.payload.sensor) j++;
      const run = events.slice(i, j);
      if (run.length === 1) {
        out.push(renderEvent(run[0]));
      } else {
        const last = run[run.length - 1].payload;
        const t = new Date(run[run.length - 1].ts).toLocaleTimeString();
        out.push(eventLine(
          `📈 checking ${last.sensor}… <span class="muted">${run.length}× — latest ${last.value} ${last.passed ? '✓' : '✗'}</span>`,
          'machine', t));
      }
      i = j;
    } else {
      out.push(renderEvent(e));
      i++;
    }
  }
  return out.join('') || '<p class="muted">No events yet.</p>';
}

// one event -> one styled line. The `who` decides the voice (plant/human/machine).
function renderEvent(e) {
  const t = new Date(e.ts).toLocaleTimeString();
  const p = e.payload || {};

  // the body text is event-specific (emoji + wording)
  let body;
  switch (e.type) {
    case 'say':             body = eventLine('🌱 ' + p.text, 'computer', t); break;
    case 'ask':             body = eventLine('🌱 ' + p.text + '  <span class="muted">(' + (p.options||[]).join(' / ') + ')</span>', 'computer', t); break;
    case 'answer':          body = eventLine('🧑 ' + p.answer, 'human', t); break;
    case 'act':             body = eventLine('💡 set ' + p.output + ' → rgb(' + p.color.r + ',' + p.color.g + ',' + p.color.b + ')', 'machine', t); break;
    case 'sense':           body = eventLine('📈 ' + p.sensor + ' = ' + p.value + (p.passed!==undefined ? (p.passed?' ✓':' ✗') : ''), 'machine', t); break;
    case 'tend':            body = eventLine('🌿 ' + p.text, 'computer', t); break;
    case 'tend_confirmed':  body = eventLine('🧑 done: <span class="muted">' + p.text + '</span>', 'human', t); break;
    case 'attend':          body = eventLine('👁 ' + p.text, 'computer', t); break;
    case 'attend_noticed':  body = eventLine('🧑 noticed: “' + (p.noticed || '') + '”', 'human', t); break;
    case 'timeout':         return eventLine('⏱ no answer in time', 'machine', t);
    case 'start':           return eventLine('— ritual started —', 'machine', t);
    case 'end':             return eventLine('— ritual ended —', 'machine', t);
    default:                return eventLine(e.type, 'machine', t);
  }

  // the relationship tag(s) come from the ONE source of truth
  const rels = eventRelationships(e);
  const tags = rels.map(chain =>
    `<div style="margin:-2px 0 2px 24px">${relationTag(chain)}</div>`).join('');
  return `<div>${body}${tags}</div>`;
}

// voice -> CSS class: plant (serif), human (right bubble), machine (mono)
function eventLine(text, who, time) {
  const cls = who === 'human' ? 'voice-human' : who === 'machine' ? 'voice-machine' : 'voice-plant';
  return `<div class="entry">
    <span class="${cls}">${text}</span>
    <span class="entry-time">${time}</span>
  </div>`;
}

// ============================================================================
//  THE PROMPT BOX — a pending question, shown over any view.
//  Anti-flicker: only touch the DOM when the shown question actually changes.
// ============================================================================
async function checkPrompts() {
  const box = document.getElementById('promptBox');
  if (!currentUser) { box.style.display = 'none'; shownPromptId = null; return; }
  try {
    const items = await (await fetch('/users/' + currentUser.id + '/prompts')).json();
    const question = items.find(p => p.kind === 'ask' && p.answered === 0);

    if (!question) {
      if (shownPromptId !== null) { box.style.display = 'none'; box.innerHTML = ''; shownPromptId = null; }
      return;
    }
    if (question.id === shownPromptId) return;      // same question — leave the DOM alone

    shownPromptId = question.id;
    box.style.display = 'block';
    if (question.open) {
      // open response — a text field + Send (non-empty required)
      box.innerHTML =
        `<p style="margin:0 0 8px"><strong>${question.text}</strong></p>
         <input id="openAnswer" placeholder="type your answer…" style="width:100%;margin-bottom:8px"
                onkeydown="if(event.key==='Enter')answerOpen(${question.id})">
         <button onclick="answerOpen(${question.id})">Send</button>`;
    } else {
      // choice response — one button per option
      box.innerHTML =
        `<p style="margin:0 0 8px"><strong>${question.text}</strong></p>` +
        question.options.map(o => `<button onclick="answerPrompt(${question.id}, '${o}')">${o}</button>`).join(' ');
    }
  } catch (e) {
    console.error('checkPrompts', e);
  }
}

async function answerOpen(id) {
  const val = document.getElementById('openAnswer').value.trim();
  if (!val) return;                       // non-empty required
  await fetch('/prompts/' + id + '/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: val }) });
  checkPrompts();
}

async function answerPrompt(id, answer) {
  await fetch('/prompts/' + id + '/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }) });
  checkPrompts();      // refresh immediately so the box clears/advances
}








// ============================================================================
//  TIMERS — each started once at load; each guarded to act only when relevant
// ============================================================================
setInterval(checkPrompts, 2000);                      // pending question, from any view
setInterval(updateRitualBadge, 4000);                 // the 🟢 badge on the Rituals button
setInterval(() => {                                    // refresh the rituals page while it's open
  if (document.getElementById('ritualsView').classList.contains('active')) loadRuns();
}, 3000);
setInterval(() => {                                    // keep an open transcript live
  if (openInstanceId !== null && document.getElementById('transcriptView').classList.contains('active')) refreshTranscript();
}, 2000);