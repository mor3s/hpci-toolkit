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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  currentUser = await res.json();                       // { id, name }
  document.getElementById('whoami').textContent = currentUser.name;
  showView('devicesView');
  loadDevices();                                        // defined in devices.js
}