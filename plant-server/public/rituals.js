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
      if (s.type === 'say')   desc = `<span class="voice-plant">🌱 "${s.text}"</span>`;
      if (s.type === 'ask')   desc = `<span class="voice-plant">❔ "${s.text}"</span><br><span class="muted">answers: ${(s.options||[]).join(', ')}</span>`;
      if (s.type === 'wait')  desc = `<span class="muted">⏳ wait ${Math.round(s.duration_ms/60000)} min</span>`;
      if (s.type === 'act')   desc = `<span class="muted">💡 set ${s.output} → rgb(${s.color.r},${s.color.g},${s.color.b})</span>`;
      if (s.type === 'sense') desc = `<span class="muted">🔍 if ${s.sensor} ${s.op} ${s.value}</span>`;
      return `<div class="step">
        <div class="step-head"><span class="step-num">${i+1} · ${s.type}</span></div>
        <div class="step-body">${desc}</div>
      </div>`;
    }).join('') || '<p class="muted">This ritual has no steps.</p>';
}

// turn a compiled ritual into a Mermaid flowchart description.
// One arrow per exit: sense forks true/false; a branching ask forks per answer.
function ritualToMermaid(def) {
  const lines = ['flowchart TD'];                    // TD = top-down
  const label = (id) => {
    if (id === 'end') return 'END([finish])';
    const s = def.steps[id];
    const i = Object.keys(def.steps).indexOf(id) + 1;
    let txt = s.type;
    if (s.type === 'say')   txt = 'say: '   + truncate(s.text, 20);
    if (s.type === 'ask')   txt = 'ask: '   + truncate(s.text, 20);
    if (s.type === 'wait')  txt = 'wait '   + Math.round(s.duration_ms/60000) + 'm';
    if (s.type === 'act')   txt = 'set '    + s.output;
    if (s.type === 'sense') txt = 'sense '  + s.sensor + ' ' + s.op + ' ' + s.value;
    return `${id}["${i}· ${txt}"]`;
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

async function refreshTranscript() {
  if (openInstanceId === null) return;
  const inst   = await (await fetch('/instances/' + openInstanceId)).json();
  const events = await (await fetch('/instances/' + openInstanceId + '/events')).json();
  if (!inst) return;
  document.getElementById('transcriptTitle').textContent = inst.ritual_name;
  document.getElementById('transcriptStatus').textContent =
    inst.status === 'running' ? ('Now: ' + (inst.status_text || 'starting…')) : ('This run is ' + inst.status + '.');
  document.getElementById('transcript').innerHTML = renderTranscript(events);
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
  switch (e.type) {
    case 'say':     return eventLine('🌱 ' + p.text, 'computer', t);
    case 'ask':     return eventLine('🌱 ' + p.text + '  <span class="muted">(' + (p.options || []).join(' / ') + ')</span>', 'computer', t);
    case 'answer':  return eventLine('🧑 ' + p.answer, 'human', t);
    case 'act':     return eventLine('💡 set ' + p.output + ' → rgb(' + p.color.r + ',' + p.color.g + ',' + p.color.b + ')', 'machine', t);
    case 'sense':   return eventLine('📈 ' + p.sensor + ' = ' + p.value + (p.passed !== undefined ? (p.passed ? ' ✓' : ' ✗') : ''), 'machine', t);
    case 'timeout': return eventLine('⏱ no answer in time', 'machine', t);
    case 'start':   return eventLine('— ritual started —', 'machine', t);
    case 'end':     return eventLine('— ritual ended —', 'machine', t);
    default:        return eventLine(e.type, 'machine', t);
  }
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
    if (question.id === shownPromptId) return;          // same question — leave the DOM alone

    shownPromptId = question.id;
    box.style.display = 'block';
    box.innerHTML =
      `<p style="margin:0 0 8px"><strong>${question.text}</strong></p>` +
      question.options.map(o => `<button onclick="answerPrompt(${question.id}, '${o}')">${o}</button>`).join(' ');
  } catch (e) {
    console.error('checkPrompts', e);
  }
}

async function answerPrompt(id, answer) {
  await fetch('/prompts/' + id + '/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }) });
  checkPrompts();    // refresh immediately so the box clears/advances without waiting for the poll
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