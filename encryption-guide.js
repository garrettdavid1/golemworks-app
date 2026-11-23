// Mobile's encryption nudge: the banner while anything is unencrypted, and Settings' steps for a workshop not enrolled yet.
"use strict";

const EncryptionGuide = (() => {
  const PENDING = ["committed", "approving", "revealed", "keyed"];

  /** Workshops the hub names as not enrolled (feed.encryption.ready.missing; the account's own items are not workshops). */
  const notEnrolled = (enc) => (Array.isArray(enc?.ready?.missing) ? enc.ready.missing : []).filter((m) => m && typeof m.name === "string" && m.name !== "This account" && /not enrolled/.test(m.why || "")).map((m) => m.name);

  const names = (list) => (list.length === 1 ? `${list[0]} isn't` : list.length === 2 ? `${list[0]} and ${list[1]} aren't` : `${list.length} workshops aren't`);

  /** The banner over every Mobile screen, or null: not in the desktop app, not on Settings, and gone once everything is encrypted. view: this phone's enrollment (Enroll's view()), if any. */
  function banner(enc, view, { desktop = false, screen = "fleet" } = {}) {
    if (desktop || screen === "overlords" || !enc || typeof enc !== "object" || enc.state === "required") return null;
    const go = { href: "#settings" };
    if (enc.state !== "on") return { ...go, title: "Your data isn't encrypted yet", detail: "Set it up once; it takes a minute with your computer at hand.", action: "Set up encryption" };
    if (view?.on && !view.holdsKey) return { ...go, title: "This phone is waiting for its encryption key", detail: "Until it has the key, it can't open what your workshops encrypt.", action: "Continue" };
    // A workshop that just finished is active here a moment before the hub sees its first sealed record.
    const missing = notEnrolled(enc).filter((name) => deviceState(view, name) !== "active");
    if (!missing.length) return null;
    return { ...go, title: `${names(missing)} encrypted yet`, detail: `Finish setting up encryption; it takes a minute with ${missing.length === 1 ? "that computer" : "those computers"} at hand.`, action: "Continue" };
  }

  /** Where a workshop's enrollment stands, from this phone's view: a pending state, active, or null (no request yet, or this phone cannot see it). */
  function deviceState(view, name) {
    if (view?.devices?.some((d) => d.kind === "workshop" && d.name === name)) return "active";
    return view?.waiting?.find((d) => d.kind === "workshop" && d.name === name && PENDING.includes(d.state))?.state || null;
  }

  /** Settings' steps for enrolling one workshop, each done, current or todo; guidance only, the Start and They match sheets do the work. */
  function steps(enc, view, name) {
    const on = enc?.state === "on" || enc?.state === "required";
    const state = deviceState(view, name);
    // How far along: 1 account on, 2 request made, 3 Start tapped, 4 code compared here, 5 both said They match.
    const reached = !on ? 0 : state === "active" ? 5 : state === "keyed" ? 4 : state === "approving" || state === "revealed" ? 3 : state === "committed" ? 2 : 1;
    const list = [
      { key: "account", text: "Turn encryption on for your account" },
      { key: "request", text: `On ${name}: in the Golemworks app, Settings > Account > Approve this computer (on a headless one: gw hub enroll)` },
      { key: "start", text: "Here: tap Start on its request" },
      { key: "compare", text: "Compare the 12-character code on both screens" },
      { key: "match", text: `Tap They match here. On ${name}, click They match in the app, then They match again in the small window that opens` },
    ];
    // Start leads to the code at once, so Compare is current from Start until They match here.
    return list.map((step, i) => ({ ...step, state: i < reached ? "done" : i === reached ? "current" : "todo" }));
  }

  return { banner, steps, notEnrolled, deviceState };
})();

if (typeof module !== "undefined") module.exports = EncryptionGuide;
