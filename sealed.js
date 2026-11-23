// Encrypted feed on the phone (README "Encrypted feed"): opens the sealed records a keyed workshop sends and fills in what the hub can no longer read.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GolemworksSealed = factory();
})(typeof self !== "undefined" ? self : this, () => {
  const SEEN = "golemworks-sealed-seen";
  // As src/waiting.js sections: Waiting on you, golems' needs and overlords' posts above every task, then priority, kind, due or since.
  const RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
  const KIND_ORDER = ["stopped", "paused", "gate", "permission", "plan", "question", "dialog", "ask", "needs", "pr", "draft", "other", "proposed", "task", "followup"];
  const TASK_KINDS = new Set(["proposed", "task", "followup"]);
  const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

  function sections(items) {
    const order = (kind) => KIND_ORDER.indexOf(kind);
    const isTask = (item) => (TASK_KINDS.has(item.kind) ? 1 : 0);
    const ranked = [...items].sort((a, b) => isTask(a) - isTask(b) || (RANK[a.priority] ?? 2) - (RANK[b.priority] ?? 2) || order(a.kind) - order(b.kind) || String(a.due || a.since || "").localeCompare(String(b.due || b.since || "")));
    const people = new Map();
    for (const item of ranked.filter((i) => i.kind === "followup")) {
      if (!people.has(item.person)) people.set(item.person, []);
      people.get(item.person).push(item);
    }
    return {
      now: ranked.filter((i) => i.tier === "now" && i.kind !== "followup"),
      people: [...people].map(([person, list]) => ({ person, items: list })).sort((a, b) => a.person.localeCompare(b.person)),
      later: ranked.filter((i) => i.tier === "later"),
    };
  }

  // As src/waiting.js fromTasks: the operator's tasks that need the operator (today is the phone's own date).
  const SOON_DAYS = 3;
  // A task is under Now only when it fell due in the last 7 days (today included); older overdue ones stay under Later.
  const NOW_DAYS = 7;
  const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  function fromTasks(tasks, today) {
    const items = [];
    const soon = addDays(today, SOON_DAYS);
    const weekAgo = addDays(today, -(NOW_DAYS - 1));
    for (const t of tasks) {
      if (["done", "canceled"].includes(t.status)) continue;
      const base = { taskId: t.id, taskKey: t.key, title: t.title, workspace: t.workspace, priority: t.priority, since: t.createdAt };
      if (t.proposedDone) {
        items.push({ ...base, id: `task:${t.id}:proposed`, kind: "proposed", tier: "now", ask: "confirm it is done", detail: `${t.proposedDone.by}: ${t.proposedDone.evidence}` });
        continue;
      }
      if (t.status === "waiting" && t.waitingOn) {
        if (t.waitingOn.followUp && t.waitingOn.followUp > today) continue;
        items.push({ ...base, id: `task:${t.id}:followup`, kind: "followup", tier: "now", person: t.waitingOn.person, ask: `follow up with ${t.waitingOn.person}`, detail: t.waitingOn.followUp && t.waitingOn.followUp < today ? `follow-up was due ${t.waitingOn.followUp}` : null });
        continue;
      }
      if (t.assignee !== "you") continue;
      if (t.priority === "urgent" || (t.due && t.due <= soon)) {
        const recent = Boolean(t.due) && t.due >= weekAgo && t.due <= today;
        items.push({ ...base, id: `task:${t.id}`, kind: "task", tier: recent ? "now" : "later", ask: taskAsk(t, today), due: t.due });
      } else if (t.priority === "high") items.push({ ...base, id: `task:${t.id}`, kind: "task", tier: "later", ask: t.due ? `do it by ${t.due}` : "do it, high priority", due: t.due });
    }
    return items;
  }

  function taskAsk(t, today) {
    if (!t.due) return "do it, urgent";
    if (t.due < today) return `do it, overdue since ${t.due}`;
    return t.due === today ? "do it, due today" : `do it by ${t.due}`;
  }

  /** Waiting on you for an account with sealed tasks: the hub cannot read them, so any task item it sent is dropped and this device's merged list ranks in. */
  function withTasks(view, tasks, today) {
    if (!view) return view;
    const items = [...list(view.now), ...list(view.people).flatMap((p) => list(p.items)), ...list(view.later)].filter((item) => !String(item.id || "").startsWith("task:"));
    return { ...view, ...sections([...items, ...fromTasks(list(tasks), today)]) };
  }

  // As src/artifacts.js: the only links an opened Artifacts list may carry.
  const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{8,80}$/;
  const list = (value) => (Array.isArray(value) ? value : []);

  /** E: GolemworksE2E; loadKeys: async () => keys or null; storage: localStorage, keeping each record's newest seq so an older copy is caught after a reload. */
  function create({ E, loadKeys, storage = null, now = () => Date.now() }) {
    let seen = {};
    try {
      seen = JSON.parse(storage?.getItem(SEEN) || "{}") || {};
    } catch {}
    const remember = () => {
      try {
        storage?.setItem(SEEN, JSON.stringify(seen));
      } catch {}
    };

    async function keys() {
      await E.init();
      const held = await loadKeys();
      if (!held || !Object.keys(held.accountKeys || {}).length) throw Object.assign(new Error("This device isn't approved yet: approve it from another device"), { code: "no-key" });
      return held;
    }

    /** One record's body. Refuses a changed or moved record (E2EError forged) and one older than this phone has opened (rolled-back); the same seq again is the same record fetched again. */
    function open(held, accountId, workshopId, kind, id, record) {
      const { body, seq } = E.decryptRecord(held.accountKeys, { accountId, workshopId, kind, id }, record);
      const key = JSON.stringify([accountId, workshopId, kind, id]);
      if (seen[key] > seq) throw Object.assign(new Error(`an older copy of this ${kind} (seq ${seq}, newest seen ${seen[key]})`), { code: "rolled-back" });
      if (seen[key] !== seq) {
        seen[key] = seq;
        remember();
      }
      return body;
    }

    // A workshop this phone has opened sealed stays sealed: the hub cannot swap in plaintext or nothing for it unseen.
    const wasSealed = (workshopId) => seen[`sealed:${workshopId}`] === true;
    const markSealed = (workshopId) => {
      if (wasSealed(workshopId)) return;
      seen[`sealed:${workshopId}`] = true;
      remember();
    };
    // As the hub does for a plaintext ask: a valid time still ahead, else not snoozed.
    const snoozedUntil = (value) => (typeof value === "string" && Date.parse(value) > now() ? new Date(value).toISOString() : null);
    // When Not now put an ask off (G-110): any valid time, else not put off.
    const stamp = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
    const blank = (w, problem) => ({ ...w, stale: problem, overlord: null, paused: null, version: null, update: null, golems: [], usage: null, standby: [], completed: [], workspaces: null, waiting: [] });

    /** Why a sealed workshop shows nothing new, in the words Fleet puts after "Not updating:". */
    const why = (error) => (error.code === "no-key" ? "this device isn't approved yet: approve it from another device" : error.code === "rolled-back" ? "the hub served an older copy of its summary" : "its summary did not open here (changed, moved or under another key)");

    /** The feed with each sealed workshop's summary opened: its golems, asks and the rest, as the hub fills them for a plaintext one. */
    async function feed(view) {
      if (!view?.workshops?.some((w) => w.sealed || wasSealed(w.id))) return view;
      let held = null;
      let keyError = null;
      try {
        held = await keys();
      } catch (error) {
        keyError = error;
      }
      const workshops = [];
      const asks = [];
      for (const w of view.workshops) {
        if (!w.sealed && wasSealed(w.id)) {
          workshops.push(blank(w, "the hub sent it in a form Mobile here can't check, so it shows nothing from it"));
          continue;
        }
        if (!w.sealed) {
          workshops.push(w);
          asks.push(...list(view.asks).filter((a) => a.workshopId === w.id));
          continue;
        }
        let summary = null;
        let problem = null;
        if (w.sealed.summary) {
          try {
            if (keyError) throw keyError;
            summary = open(held, view.accountId, w.id, "summary", "current", w.sealed.summary);
            markSealed(w.id);
          } catch (error) {
            problem = why(error);
          }
        } else if (wasSealed(w.id)) problem = "the hub sent no summary Mobile here can check";
        const s = summary || {};
        const filled = {
          ...w,
          stale: problem || w.stale,
          overlord: s.overlord || null,
          paused: s.paused || null,
          version: s.version || null,
          update: s.update || null,
          golems: list(s.golems).map((g) => ({ ...g, steps: list(g?.steps) })),
          usage: s.usage || null,
          standby: list(s.standby),
          completed: list(s.completed),
          workspaces: s.workspaces ?? null,
          waiting: list(s.waiting),
        };
        workshops.push(filled);
        const own = list(s.asks).map((ask) => ({ ...ask, answeredAt: null, answer: null, snoozedUntil: snoozedUntil(ask?.snoozedUntil), waitedAt: stamp(ask?.waitedAt), online: w.online, stale: filled.stale, receivedAt: w.receivedAt, workshopId: w.id, workshop: w.name, overlord: s.overlord?.name || "Overlord", rank: w.rank }));
        asks.push(...own.sort((a, b) => String(b.at).localeCompare(String(a.at))));
      }
      return { ...view, workshops, asks };
    }

    /** A golem's status history: the hub's rows for a plaintext workshop, the opened record for a sealed one. */
    async function history(accountId, workshopId, golemId, got) {
      if (wasSealed(workshopId) && !got?.sealed) return [];
      if (Array.isArray(got)) return got;
      if (!got?.sealed) return [];
      return list(open(await keys(), accountId, workshopId, "history", golemId, got.sealed));
    }

    /** The Orchestrator's Quiet feed ({ golemId, entries, last }) opened, or null: none sent yet, no key here, or it does not open. */
    async function quiet(accountId, workshopId, got) {
      if (!got?.sealed) return null;
      try {
        const body = open(await keys(), accountId, workshopId, "quiet", "current", got.sealed);
        return body && Array.isArray(body.entries) ? { golemId: typeof body.golemId === "string" ? body.golemId : null, entries: body.entries.filter((e) => e && typeof e === "object" && typeof e.kind === "string"), last: body.last ?? null } : null;
      } catch {
        return null;
      }
    }

    /** One golem's slash commands ([{ name, description, kind }]) from its workshop's sealed commands record; [] when none came or it does not open. */
    async function commands(accountId, workshopId, golemId, got) {
      if (!got?.sealed) return [];
      try {
        const body = open(await keys(), accountId, workshopId, "commands", "current", got.sealed);
        const list = body?.lists?.[body?.golems?.[golemId]];
        return Array.isArray(list) ? list.filter((c) => c && typeof c.name === "string" && /^[\w.:-]{1,120}$/.test(c.name)).map((c) => ({ name: c.name, description: typeof c.description === "string" ? c.description : "", kind: c.kind === "builtin" ? "builtin" : "skill" })) : [];
      } catch {
        return [];
      }
    }

    /** The Artifacts page with each sealed workshop's list opened; one that does not open shows none. */
    async function artifacts(view) {
      if (!view?.workshops?.some((w) => w.sealed || wasSealed(w.id))) return view;
      let held = null;
      try {
        held = await keys();
      } catch {}
      return {
        ...view,
        workshops: view.workshops.map((w) => {
          if (!w.sealed?.artifacts || !held) return wasSealed(w.id) || w.sealed ? { ...w, items: [] } : w;
          try {
            const items = list(open(held, view.accountId, w.id, "artifacts", "current", w.sealed.artifacts));
            return { ...w, items: items.map((item) => ({ ...item, url: typeof item?.url === "string" && ARTIFACT_URL.test(item.url) ? item.url : null })) };
          } catch {
            return { ...w, items: [] };
          }
        }),
      };
    }

    /** A Markdown file's text: as sent for a plaintext workshop, opened for a sealed one. */
    async function artifactText(accountId, workshopId, id, got) {
      if (wasSealed(workshopId) && !got?.sealed) throw new Error("the hub sent this file's text in a form Mobile here can't check; open it on the desktop");
      if (!got?.sealed) return got;
      const body = open(await keys(), accountId, workshopId, "artifact-text", id, got.sealed);
      return { title: body?.title || null, text: typeof body?.text === "string" ? body.text : "", truncated: body?.truncated === true };
    }

    /** Waiting on you with the sealed workshops' items (from the opened feed) ranked in among the hub's. */
    function waiting(view, opened) {
      const sealedOnes = list(opened?.workshops).filter((w) => w.sealed && w.waiting?.length);
      if (!view || !sealedOnes.length) return view;
      const items = [...list(view.now), ...list(view.people).flatMap((p) => list(p.items)), ...list(view.later)];
      for (const w of sealedOnes) {
        for (const item of w.waiting) items.push({ ...item, tier: item.tier === "later" ? "later" : "now", priority: RANK[item.priority] === undefined ? "normal" : item.priority, url: typeof item.url === "string" && PR_URL.test(item.url) ? item.url : null, workshopId: w.id, workshop: w.name, online: w.online });
      }
      return { ...view, ...sections(items) };
    }

    return { feed, history, quiet, commands, artifacts, artifactText, waiting, wasSealed };
  }

  return { create, sections, fromTasks, withTasks };
});
