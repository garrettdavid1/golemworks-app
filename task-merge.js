// Tasks merged on every reader (README "Tasks"): cleanOp and applyOp as the hub's src/tasks.js, mergeSealed for the sealed snapshot and ops, and the rollback and Stop requiring checks.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TaskMerge = factory();
})(typeof self !== "undefined" ? self : this, () => {
  "use strict";
  const PRIORITIES = ["urgent", "high", "normal", "low"];
  const STATUSES = ["todo", "doing", "waiting", "done", "canceled"];
  const CLOSED = new Set(["done", "canceled"]);
  const OPERATOR = "you";
  const OPERATOR_NAMES = new Set(["", "you", "me", "operator"]); // writers name the operator "you" before sealing; golemd maps its configured names first
  const MAX_NOTES = 20000;
  const MAX_SAY = 2000;
  const KEEP_IDS = 5000; // op ids a snapshot names and a reader keeps since its snapshot

  // As src/summary.js UNSAFE_CHARS and cleanSay: controls but the line break, invisible characters, and bidi marks and overrides.
  const UNSAFE_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  function cleanSay(value, max = MAX_SAY) {
    if (typeof value !== "string") return "";
    return value.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "").trim().slice(0, max);
  }

  // One line with what cleanSay strips (invisible and bidi characters) gone too, as golemd cleans it first.
  const line = (value, max) => (typeof value === "string" ? cleanSay(value).replace(/\s+/g, " ").trim().slice(0, max) || null : null);
  const day = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null);
  const when = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

  /** Notes keep their line breaks; everything else is one line. Unsafe characters go either way (cleanSay). */
  function notes(value) {
    if (typeof value !== "string") return null;
    return cleanSay(value, MAX_NOTES) || null;
  }

  // golemd's KEY: G-n for tasks made in Golemworks (an external task source may still mint T-n), an import's own number under its letter (T-778, D-412).
  const KEY = /^[A-Z]{1,3}-\d{1,6}$/;
  const OLD_KEY = /^T-\d{1,6}$/;
  const keysOf = (task) => [task.key, ...(Array.isArray(task.aliases) ? task.aliases : [])];
  const keyOrder = (key) => Number(/-(\d+)$/.exec(String(key || ""))?.[1] || 0);

  /** The next free G key. */
  function nextKey(tasks) {
    const used = [...tasks.values()].flatMap(keysOf).map((k) => /^G-(\d+)$/.exec(k || "")?.[1]).filter(Boolean).map(Number);
    return `G-${Math.max(0, ...used) + 1}`;
  }

  /** Made in Golemworks before G keys: a T key with no import source, which an external task source may mint too. */
  const madeAsT = (task) => OLD_KEY.test(task.key || "") && task.source?.kind !== "import";

  /** Each task made as T gets the next G key, oldest number first, its T key kept as an alias (a list from before G keys). */
  function rekeyMadeHere(tasks) {
    const old = [...tasks.values()].filter(madeAsT).sort((a, b) => keyOrder(a.key) - keyOrder(b.key));
    for (const task of old) Object.assign(task, { aliases: [...new Set([...keysOf(task).slice(1), task.key])], key: nextKey(tasks) });
    return old;
  }

  /** The fields a task may carry, cleaned; unknown ones are dropped (a newer golemd's extra field is not an error here). */
  function cleanFields(set, { create = false } = {}) {
    const out = {};
    if (!set || typeof set !== "object") return out;
    if ("title" in set || create) out.title = line(set.title, 200);
    if ("notes" in set) out.notes = notes(set.notes);
    if ("workspace" in set) out.workspace = line(set.workspace, 60);
    if ("area" in set) out.area = line(set.area, 40);
    if (PRIORITIES.includes(set.priority)) out.priority = set.priority;
    if ("due" in set) out.due = day(set.due);
    if (STATUSES.includes(set.status)) out.status = set.status;
    if ("assignee" in set) out.assignee = OPERATOR_NAMES.has(String(set.assignee || "").trim().toLowerCase()) ? OPERATOR : line(set.assignee, 60) || OPERATOR;
    if ("waitingOn" in set) out.waitingOn = set.waitingOn && typeof set.waitingOn === "object" && line(set.waitingOn.person, 60) ? { person: line(set.waitingOn.person, 60), followUp: day(set.waitingOn.followUp) } : null;
    if ("golem" in set) out.golem = set.golem && typeof set.golem === "object" && line(set.golem.name, 60) ? { workshop: line(set.golem.workshop, 60), name: line(set.golem.name, 60) } : null;
    if ("proposedDone" in set) {
      const p = set.proposedDone;
      out.proposedDone = p && typeof p === "object" && line(p.evidence, 500) ? { by: line(p.by, 60) || "a golem", evidence: line(p.evidence, 500), at: when(p.at) } : null;
    }
    // The email a task came from, on a create or an edit; an import's source only on a create.
    if ("source" in set) {
      const source = set.source && typeof set.source === "object" ? set.source : null;
      const id = (value) => (typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null);
      const account = (value) => (typeof value === "string" && /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(value) ? value : null);
      if (source?.kind === "email" && id(source.threadId)) out.source = { kind: "email", account: account(source.account), threadId: source.threadId, messageId: id(source.messageId) };
      else if (create && source?.kind === "import" && /^T-\d{1,6}$/.test(source.key || "")) out.source = { kind: "import", key: source.key, prefix: /^[A-Z]{1,3}$/.test(source.prefix || "") ? source.prefix : "T" };
      else if (!source) out.source = null;
    }
    if (create) {
      if (typeof set.key === "string" && KEY.test(set.key)) out.key = set.key;
      if (Array.isArray(set.aliases)) out.aliases = [...new Set(set.aliases.filter((k) => typeof k === "string" && OLD_KEY.test(k)))].slice(0, 20);
      out.createdBy = line(set.createdBy, 60);
      out.createdAt = when(set.createdAt);
      // A closed task seeded from a workshop keeps when and by whom.
      out.doneAt = when(set.doneAt);
      out.doneBy = line(set.doneBy, 80);
    }
    return out;
  }

  /** One op from a workshop, cleaned; null when it is not an op at all. */
  function cleanOp(raw) {
    if (!raw || typeof raw !== "object") return null;
    const opId = typeof raw.opId === "string" && raw.opId.length <= 80 ? raw.opId : null;
    const taskId = typeof raw.taskId === "string" && /^[\w-]{1,80}$/.test(raw.taskId) ? raw.taskId : null;
    if (!opId || !taskId) return null;
    const op = { opId, taskId, at: when(raw.at), by: line(raw.by, 80) || "a workshop", operator: raw.operator === true, seed: raw.seed === true };
    if (raw.create) {
      op.create = cleanFields(raw.create, { create: true });
      if (!op.create.title) return null;
    } else if (raw.set) op.set = cleanFields(raw.set);
    else return null;
    return op;
  }

  /** Same rules as golemd's applyOp: a resent create is a no-op, a taken key moves on, a golem never closes the operator's task. */
  function applyOp(tasks, op, now) {
    const at = op.at || now;
    if (op.create) {
      if (tasks.has(op.taskId)) return null;
      const keys = new Set([...tasks.values()].map((t) => t.key));
      let key = op.create.key;
      const aliases = Array.isArray(op.create.aliases) ? [...op.create.aliases] : [];
      // A create from before G keys keeps its T key as an alias and takes a G key here, in merge order, so every reader agrees.
      if (madeAsT(op.create)) aliases.push(key);
      if (!key || !KEY.test(key) || keys.has(key) || madeAsT(op.create)) key = nextKey(tasks);
      const task = { status: "todo", priority: "normal", assignee: OPERATOR, notes: null, workspace: null, area: null, due: null, waitingOn: null, golem: null, proposedDone: null, source: null, ...op.create, id: op.taskId, key, createdBy: op.create.createdBy || op.by, createdAt: op.create.createdAt || at, updatedAt: at };
      if (aliases.length) task.aliases = [...new Set(aliases)];
      else delete task.aliases;
      tasks.set(task.id, task);
      return task;
    }
    const task = tasks.get(op.taskId);
    if (!task || !op.set) return null;
    if (op.set.status && CLOSED.has(op.set.status) && task.assignee === OPERATOR && !op.operator) return null;
    if ("assignee" in op.set && task.assignee === OPERATOR && op.set.assignee !== OPERATOR && !op.operator) return null;
    if (op.seed && op.at && task.updatedAt && op.at <= task.updatedAt) return null; // a re-pairing's copy wins only when newer
    const wasClosed = CLOSED.has(task.status);
    // An import's source is its rerun key: no edit changes it.
    const { source, ...rest } = op.set;
    Object.assign(task, task.source?.kind === "import" ? rest : op.set, { updatedAt: at });
    if (op.set.status) {
      if (CLOSED.has(op.set.status)) {
        if (!wasClosed) Object.assign(task, { doneAt: at, doneBy: op.by });
        task.proposedDone = null;
      } else Object.assign(task, { doneAt: null, doneBy: null });
      if (op.set.status !== "waiting" && !("waitingOn" in op.set)) task.waitingOn = null;
    }
    return task;
  }

  /** The whole snapshot (all its parts or none), then the ops it does not cover in sealed-time order, each opId once; open(kind, id, record) gives a body or null/throws. Rev: the opened snapshot's (-1 for none); newestAt: the newest sealed op time. */
  function mergeSealed(sealed, open, { now = new Date().toISOString() } = {}) {
    const tasks = new Map();
    const seen = new Set();
    let skipped = 0;
    const opened = (kind, id, record) => {
      try {
        return open(kind, id, record) ?? null;
      } catch {
        return null;
      }
    };
    const snapshot = sealed?.snapshot && Number.isInteger(sealed.snapshot.rev) ? sealed.snapshot : null;
    let rev = -1;
    const covered = [];
    if (snapshot) {
      const parts = Array.isArray(snapshot.parts) ? snapshot.parts : [];
      const snapshotId = typeof snapshot.snapshotId === "string" && snapshot.snapshotId ? snapshot.snapshotId : null;
      const bodies = snapshotId ? parts.map((record, part) => opened("task-snapshot", `${snapshot.rev}:${snapshotId}:${part}`, record)) : [];
      // Every part names its snapshot, rev, place and count inside the seal; one part wrong, missing or mixed in from another snapshot drops the whole snapshot.
      const whole = bodies.length > 0 && bodies.every((b, part) => b && b.rev === snapshot.rev && b.snapshotId === snapshotId && b.part === part && b.parts === parts.length && Array.isArray(b.tasks));
      if (!whole) skipped += Math.max(parts.length, 1);
      else {
        rev = snapshot.rev;
        for (const body of bodies) {
          // The op ids a compaction covers: one the hub serves again after it is a replay, never applied over newer changes.
          if (Array.isArray(body.opIds)) for (const opId of body.opIds.slice(-KEEP_IDS)) if (typeof opId === "string") (seen.add(opId), covered.push(opId));
          for (const t of body.tasks) if (t && typeof t === "object" && typeof t.id === "string" && typeof t.title === "string" && !tasks.has(t.id)) tasks.set(t.id, { ...t });
        }
        // A snapshot written before G keys: its T tasks made in Golemworks take G keys before any op applies.
        rekeyMadeHere(tasks);
      }
    }
    const floor = snapshot ? snapshot.rev : -Infinity;
    const ready = [];
    for (const o of Array.isArray(sealed?.ops) ? sealed.ops : []) {
      if (!o || typeof o !== "object" || Number(o.rev) <= floor) continue; // the snapshot already holds one at or below its rev
      const body = typeof o.opId === "string" ? opened("task-op", o.opId, o.record) : null;
      // The op names its own id inside the seal: one served under another op's id is skipped.
      if (!body || body.opId !== o.opId) {
        skipped += 1;
        continue;
      }
      const op = cleanOp(body);
      if (op) ready.push(op);
    }
    // The sealed time, then the op id: the hub's outer rev never decides the order.
    ready.sort((a, b) => ((a.at || "") < (b.at || "") ? -1 : (a.at || "") > (b.at || "") ? 1 : a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0));
    let newestAt = null;
    const listed = new Set();
    for (const op of ready) {
      if (op.at && (!newestAt || op.at > newestAt)) newestAt = op.at;
      listed.add(op.opId);
      if (seen.has(op.opId)) continue;
      seen.add(op.opId);
      applyOp(tasks, op, now);
    }
    // opIds: every op opened after the snapshot, in sealed order; covered: the ones the snapshot says it holds.
    return { tasks: [...tasks.values()], skipped, rev, newestAt, opIds: [...listed], covered };
  }

  /** Rollback guard: prev is the last kept mark ({ rev, at, epoch, opIds }) or null; returns the next mark, or null when the served book is older than one already merged. */
  function advance(prev, merged, epoch) {
    const mark = { rev: merged.rev, at: merged.newestAt || "", epoch, opIds: merged.opIds.slice(-KEEP_IDS) };
    // No mark yet, or a newer account key (a reset): the count starts again.
    if (!prev || epoch > prev.epoch) return mark;
    const kept = Array.isArray(prev.opIds) ? prev.opIds : [];
    if (merged.rev < prev.rev) return null;
    if (merged.rev === prev.rev) {
      // The same snapshot: every op merged since it is still served, and nothing newer went missing.
      const served = new Set(merged.opIds);
      return kept.some((id) => !served.has(id)) || mark.at < (prev.at || "") ? null : mark;
    }
    // A newer snapshot: every op merged since the last one is still served or held in it.
    const held = new Set([...merged.covered, ...merged.opIds]);
    return kept.some((id) => !held.has(id)) ? null : mark;
  }

  /** An opened Stop requiring record (workshopId "tasks", kind "encryption-stop", id "stop") clears a sealed mark set at markedAt (ms) when it says required: false and is not older than the mark, with a minute of clock slack. */
  function stopClears(body, markedAt) {
    if (!body || typeof body !== "object" || body.required !== false || typeof body.at !== "string") return false;
    const at = Date.parse(body.at);
    return Number.isFinite(at) && at > (Number(markedAt) || 0) - 60000;
  }

  /** Gmail's web address for a task's email thread (Open email), in its account when it names one; null for any other source. */
  function mailUrl(source) {
    if (source?.kind !== "email" || !/^[A-Za-z0-9_-]{1,100}$/.test(source.threadId || "")) return null;
    return `https://mail.google.com/mail/u/0/${source.account ? `?authuser=${encodeURIComponent(source.account)}` : ""}#all/${source.threadId}`;
  }

  return { cleanOp, cleanFields, applyOp, mergeSealed, rekeyMadeHere, advance, stopClears, cleanSay, mailUrl, PRIORITIES, STATUSES, KEY, KEEP_IDS };
});
