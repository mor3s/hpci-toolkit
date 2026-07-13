// ============================================================================
//  app.js — loaded FIRST. Holds the shared state every other file reads, the
//  view switcher, and login. (No build step / no modules: all the .js files
//  share one global scope, which is why functions defined in devices.js etc.
//  are reachable from here.)
// ============================================================================

// ---- shared app state (read/written across all files) ----
let currentUser   = null;    // { id, name } once logged in
let currentDevice = null;    // the device id string currently being viewed
let currentSensor = null;    // the sensor name currently graphed

// Mermaid (the ritual diagram library) — tell it not to auto-scan the page;
// we render diagrams on demand in the ritual preview.
if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'neutral' });

// ---- navigation: reveal one view, hide the rest ----
// Guarded: if an id is wrong/missing, log it instead of throwing (a throw here
// would blank the whole page, since every screen change comes through here).
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(id);
  if (!target) { console.error('showView: no view with id', id); return; }
  target.classList.add('active');
}

// ---- login: create-or-fetch the user, then go to their devices ----
async function login() {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return;
  const res = await fetch('/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  currentUser = await res.json();
  renderIdentity();
  switchTab('plants');       // start on plants (the workflow's first step)
  loadPlants();
}



function renderIdentity() {
  const bar = document.getElementById('identityBar');
  const tabs = document.getElementById('mainTabs');
  if (!currentUser) { bar.style.display = 'none'; tabs.style.display = 'none'; return; }
  bar.style.display = 'flex';
  tabs.style.display = 'flex';
  bar.innerHTML = `
    <span class="who-label">You</span>
    <span class="who-name">🧑 ${currentUser.name}</span>
    <button class="id-btn" onclick="openMe()">my devices</button>
    <button class="logout-btn" onclick="logout()">log out</button>`;
}

function logout() {
  currentUser = null;
  currentDevice = null;
  currentSensor = null;
  currentPlant = null;
  showView('loginView');
  renderIdentity();               // hides the bar + tabs
  document.getElementById('nameInput').value = '';
}

// ---- shared relationship rendering (used by rituals.js and builder preview) ----
// the three agents and their glyphs
const POLE_GLYPH = { human: '🧑', plant: '🌱', machine: '🖥️' };

// render a chain of poles as a directed tag, e.g. 🖥️ UI → 🧑 Nour → 🌱 Basil
// each pole: { type:'human'|'plant'|'machine', name:'...' }
function relationTag(chain) {
  if (!chain) return '';
  return `<span class="relation">` +
    chain.map(p => `<span class="pole pole-${p.type}">${POLE_GLYPH[p.type]} ${p.name}</span>`)
         .join('<span class="rel-arrow">→</span>') +
    `</span>`;
}

function goHome() {
  if (!currentUser) return;
  switchTab('plants');
}

function switchTab(which) {
  document.getElementById('tabPlants').classList.toggle('active', which === 'plants');
  document.getElementById('tabRituals').classList.toggle('active', which === 'rituals');
  if (which === 'plants')  { showView('plantsView'); loadPlants(); }
  if (which === 'rituals') { showView('ritualsView'); loadRuns(); }
}