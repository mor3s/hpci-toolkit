// ============================================================================
//  rituals-engine.js — the heartbeat that advances running rituals.
//
//  A ritual is a STATE MACHINE: a graph of steps connected by next/then/else
//  pointers. An "instance" is one running walk through that graph. This engine
//  ticks once a second; each tick, every running instance executes (at most)
//  one step and advances to the next.
//
//  Key principle: the engine reads each instance FRESH from the DB every tick
//  and writes any change back. Nothing important lives only in memory, so the
//  server can restart and running rituals resume from where they were.
// ============================================================================

function makeEngine(db) {
    const now = () => Date.now();

    // A ritual refers to devices by ALIAS (e.g. "d1"), set in its header.
    // This resolves an alias to the real device_id the rest of the system uses.
    function realDevice(def, alias) {
        const d = def.devices && def.devices[alias];
        return d ? d.device_id : null;
    }

    // Append one entry to the instance's diary (ritual_events). Every step logs
    // here — this is both the research record and what the transcript renders.
    function logEvent(instanceId, stepId, type, payload) {
        db.prepare(`INSERT INTO ritual_events (instance_id, step_id, type, payload, ts)
                    VALUES (?, ?, ?, ?, ?)`)
            .run(instanceId, stepId, type, JSON.stringify(payload || {}), now());
    }

    // Write a human-readable "what's happening now" line. The live view reads
    // this; it's the present-tense companion to the past-tense event log.
    function setStatus(instanceId, text) {
        db.prepare('UPDATE ritual_instances SET status_text = ? WHERE id = ?').run(text, instanceId);
    }

    // ------------------------------------------------------------------------
    //  runStep — execute ONE step of ONE instance.
    //  Returns the id of the next step to go to, or null to STAY on this step
    //  (because we're sleeping/waiting and will retry on a future tick).
    // ------------------------------------------------------------------------
    function runStep(inst, def, step) {
        switch (step.type) {

            // SAY — show a message, then linger on it so the human can read it.
            // Mechanism: first encounter logs + sets wait_until (the linger);
            // _sayShown (computed in tick) becomes true once that time passes,
            // and only then do we advance. NOTE: this relies on wait_until being
            // 0 when we first arrive (advancing always resets it to 0), so the
            // first tick lingers rather than skipping. Fragile but correct.
            case 'say': {
                if (!inst._sayShown) {
                    logEvent(inst.id, inst.current, 'say', { text: step.text });
                    setStatus(inst.id, '🌱 ' + step.text);
                    db.prepare('UPDATE ritual_instances SET wait_until = ? WHERE id = ?')
                        .run(now() + (step.linger_ms || 4000), inst.id);
                    return null;        // stay until the linger elapses
                }
                return step.next;       // linger done — advance
            }

            // ACT — set a device output's DESIRED value (the ESP applies it later).
            case 'act': {
                const deviceId = realDevice(def, step.device);
                db.prepare(`
                  INSERT INTO output_states (device_id, output_name, desired, updated_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(device_id, output_name)
                  DO UPDATE SET desired = excluded.desired, updated_at = excluded.updated_at
                `).run(deviceId, step.output, JSON.stringify(step.color), now());
                logEvent(inst.id, inst.current, 'act', { device: deviceId, output: step.output, color: step.color });
                setStatus(inst.id, '💡 set ' + step.output);
                return step.next;
            }

            // WAIT — sleep for a fixed duration. Same pattern as say's linger:
            // set wait_until and stay; _waiting (from tick) flips true once elapsed.
            case 'wait': {
                if (!inst._waiting) {
                    db.prepare('UPDATE ritual_instances SET wait_until = ? WHERE id = ?')
                        .run(now() + step.duration_ms, inst.id);
                    setStatus(inst.id, '⏳ waiting…');
                    return null;
                }
                return step.next;
            }

            // ASK — pose a question and wait for the human (or a timeout).
            // This step is special: it must be CHECKED EVERY TICK (the tick loop
            // exempts 'ask' from the sleep-guard) so it catches an answer the
            // instant it arrives, while still honouring its timeout as a deadline.
            case 'ask': {
                const existing = db.prepare('SELECT * FROM prompts WHERE instance_id = ? AND step_id = ?')
                    .get(inst.id, inst.current);

                if (!existing) {
                    // post the question — with the open flag from the step
                    db.prepare(`INSERT INTO prompts
              (instance_id, step_id, started_by, text, options, kind, open, answered, created_at)
              VALUES (?, ?, ?, ?, ?, 'ask', ?, 0, ?)`)
                        .run(inst.id, inst.current, inst.started_by, step.text,
                            JSON.stringify(step.options || []), step.open ? 1 : 0, now());
                    logEvent(inst.id, inst.current, 'ask',
                        { text: step.text, options: step.options || [], open: !!step.open });
                    if (step.timeout_ms)
                        db.prepare('UPDATE ritual_instances SET wait_until = ? WHERE id = ?').run(now() + step.timeout_ms, inst.id);
                    setStatus(inst.id, '💬 ' + step.text);
                    return null;
                }

                if (existing.answered) {
                    const state = JSON.parse(inst.state || '{}');
                    if (step.save_as) state[step.save_as] = existing.answer;
                    db.prepare('UPDATE ritual_instances SET state = ? WHERE id = ?').run(JSON.stringify(state), inst.id);
                    logEvent(inst.id, inst.current, 'answer',
                        { text: step.text, answer: existing.answer, open: !!step.open });
                    // open answers are free text → won't match a route → fall through to next
                    const routes = step.answer_routes || {};
                    return routes[existing.answer] || step.next || 'end';
                }

                // still waiting — check timeout
                if (step.timeout_ms && inst.wait_until && now() >= inst.wait_until) {
                    logEvent(inst.id, inst.current, 'timeout', { text: step.text });
                    db.prepare('UPDATE prompts SET answered = 1 WHERE id = ?').run(existing.id);   // close it
                    return step.on_timeout || step.next || 'end';
                }
                return null;
            }

            // SENSE — read the latest value of a sensor, compare, and BRANCH.
            // Returns then/else based on the comparison. If it loops straight back
            // to itself, pace the recheck to the sensor's own interval (no point
            // checking faster than the data updates) instead of every tick.
            case 'sense': {
                const deviceId = realDevice(def, step.device);
                const row = db.prepare(
                    'SELECT value FROM readings WHERE device_id = ? AND sensor_name = ? ORDER BY ts DESC LIMIT 1'
                ).get(deviceId, step.sensor);
                const value = row ? row.value : null;

                let passed = false;
                if (value !== null) {
                    if (step.op === '<') passed = value < step.value;
                    else if (step.op === '>') passed = value > step.value;
                    else if (step.op === '=') passed = value === step.value;
                }
                logEvent(inst.id, inst.current, 'sense',
                    { device: deviceId, sensor: step.sensor, op: step.op, threshold: step.value, value, passed });
                setStatus(inst.id, '🔍 checking ' + step.sensor + (value !== null ? ' (' + value + ')' : ''));

                const nextStep = passed ? step.then : step.else;
                if (nextStep === inst.current && step.min_recheck_ms)
                    db.prepare('UPDATE ritual_instances SET wait_until = ? WHERE id = ?')
                        .run(now() + step.min_recheck_ms, inst.id);
                return nextStep;
            }
            // TEND — invite the human to ACT on the plant (UI→you→plant).
            // No confirm: show + linger + move on. Confirm: post a "done" prompt and wait.
            case 'tend': {
                const existingTend = db.prepare('SELECT * FROM prompts WHERE instance_id = ? AND step_id = ?')
                    .get(inst.id, inst.current);
                if (!existingTend) {
                    db.prepare(`INSERT INTO prompts
              (instance_id, step_id, started_by, text, options, kind, open, answered, created_at)
              VALUES (?, ?, ?, ?, ?, 'ask', 0, 0, ?)`)
                        .run(inst.id, inst.current, inst.started_by, step.text, JSON.stringify(['done']), now());
                    logEvent(inst.id, inst.current, 'tend', { text: step.text, plant_name: step.plant_name });
                    setStatus(inst.id, '🌿 ' + step.text);
                    return null;
                }
                if (existingTend.answered) {
                    logEvent(inst.id, inst.current, 'tend_confirmed',
                        { text: step.text, plant_name: step.plant_name });
                    return step.next;
                }
                return null;
            }

            // ATTEND — invite the human to PERCEIVE the plant (UI→you←plant).
            // Nothing mode: show + linger + move on. Open mode: post a text prompt, record the noticing.
            case 'attend': {
                const existingAtt = db.prepare('SELECT * FROM prompts WHERE instance_id = ? AND step_id = ?')
                    .get(inst.id, inst.current);
                if (!existingAtt) {
                    const opts = step.open ? '[]' : JSON.stringify(['done']);
                    db.prepare(`INSERT INTO prompts
              (instance_id, step_id, started_by, text, options, kind, open, answered, created_at)
              VALUES (?, ?, ?, ?, ?, 'ask', ?, 0, ?)`)
                        .run(inst.id, inst.current, inst.started_by, step.text, opts, step.open ? 1 : 0, now());
                    logEvent(inst.id, inst.current, 'attend', { text: step.text, plant_name: step.plant_name, open: !!step.open });
                    setStatus(inst.id, '👁 ' + step.text);
                    return null;
                }
                if (existingAtt.answered) {
                    logEvent(inst.id, inst.current, 'attend_noticed',
                        { text: step.text, plant_name: step.plant_name, noticed: existingAtt.answer, open: !!step.open });
                    return step.next;
                }
                return null;
            }
            // END — finish the run. (Stop-button finishes are handled in server.js.)
            case 'end':
                logEvent(inst.id, inst.current, 'end', {});
                setStatus(inst.id, '✓ finished');
                db.prepare("UPDATE ritual_instances SET status = 'done' WHERE id = ?").run(inst.id);
                return null;

            default:
                return step.next;
        }
    }

    // ------------------------------------------------------------------------
    //  tick — one heartbeat. Advance every running instance by up to one step.
    //  Each instance is wrapped in try/catch so one broken ritual fails ALONE
    //  (marked 'failed') without crashing the tick or taking the server down.
    // ------------------------------------------------------------------------
    function tick() {
        const instances = db.prepare("SELECT * FROM ritual_instances WHERE status = 'running'").all();

        for (const inst of instances) {
            try {
                const ritual = db.prepare('SELECT definition FROM rituals WHERE id = ?').get(inst.ritual_id);
                if (!ritual) continue;
                const def = JSON.parse(ritual.definition);
                const step = def.steps[inst.current];
                if (!step) { db.prepare("UPDATE ritual_instances SET status='failed' WHERE id=?").run(inst.id); continue; }

                // SLEEP-GUARD: if this instance is sleeping (wait_until in the
                // future), skip it — EXCEPT for 'ask', which must be polled every
                // tick so it catches an answer immediately (its timeout is enforced
                // inside the ask case, not by skipping).
                if (step.type !== 'ask' && inst.wait_until && now() < inst.wait_until) continue;

                // Tell runStep whether a wait/say's timer has elapsed. These flags
                // live only for this tick (inst is re-fetched fresh each time).
                inst._waiting = (step.type === 'wait' && inst.wait_until && now() >= inst.wait_until);
                inst._sayShown = (['say', 'tend', 'attend'].includes(step.type) && inst.wait_until && now() >= inst.wait_until);

                const next = runStep(inst, def, step);

                // On advancing, clear wait_until so the next step starts fresh.
                if (next)
                    db.prepare('UPDATE ritual_instances SET current = ?, wait_until = 0, updated_at = ? WHERE id = ?')
                        .run(next, now(), inst.id);

            } catch (err) {
                console.error('ritual instance', inst.id, 'failed:', err.message);
                db.prepare("UPDATE ritual_instances SET status='failed' WHERE id=?").run(inst.id);
            }
        }
    }

    return { tick };
}

module.exports = { makeEngine };