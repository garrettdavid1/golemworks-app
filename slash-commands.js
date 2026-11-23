// A golem's slash commands in its message box (README "Slash commands"): typing / lists them, filtered as you type, and a tap fills one in.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SlashCommands = factory();
})(typeof self !== "undefined" ? self : this, () => {
  const MAX_SHOWN = 60;

  /** The command name being typed: the words start with / and the caret is still in that first word; null otherwise. */
  function typing(text, caret = String(text || "").length) {
    const value = String(text || "");
    if (!value.startsWith("/")) return null;
    const head = value.slice(1, caret);
    return /^[\w.:-]*$/.test(head) && !/\s/.test(value.slice(0, caret)) ? head : null;
  }

  /** The commands for what is typed, best first: the name starts with it, then a plugin skill's own part does, then the name holds it, then its description does. */
  function matches(commands, query) {
    const q = String(query || "").toLowerCase();
    const list = Array.isArray(commands) ? commands : [];
    if (!q) return list.slice(0, MAX_SHOWN);
    const rank = (c) => {
      const name = c.name.toLowerCase();
      if (name.startsWith(q)) return 0;
      if (name.includes(":") && name.split(":").pop().startsWith(q)) return 1;
      if (name.includes(q)) return 2;
      if (String(c.description || "").toLowerCase().includes(q)) return 3;
      return -1;
    };
    return list
      .map((c, i) => ({ c, i, r: rank(c) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, MAX_SHOWN)
      .map((x) => x.c);
  }

  /** The words once a command is picked: /name and a space, anything after the name kept. */
  function fill(text, name) {
    const rest = String(text || "").replace(/^\/[\w.:-]*/, "").replace(/^\s+/, "");
    return `/${name} ${rest}`;
  }

  /** Wires a message box: / opens the list before `place`, filtered as the words change, from load() ([{ name, description, kind }]); a tap or Enter/Tab fills one in. */
  function attach(box, { load, place, onPick = () => {} }) {
    const doc = box.ownerDocument;
    const list = doc.createElement("ul");
    list.className = "slash-list";
    list.id = `slash-${Math.random().toString(36).slice(2, 10)}`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Commands");
    list.hidden = true;
    place.parentNode.insertBefore(list, place);
    box.setAttribute("aria-controls", list.id);
    box.setAttribute("aria-autocomplete", "list");
    let commands = null;
    let loading = null;
    let shown = [];
    let chosen = 0;
    let closedFor = null; // Escape closes the list until the command word changes
    let picked = null; // the name last filled in from the list, while the words still start with it

    const close = () => {
      list.hidden = true;
      shown = [];
      box.removeAttribute("aria-activedescendant");
      box.setAttribute("aria-expanded", "false");
    };
    const choose = (i, { reveal = false } = {}) => {
      chosen = i;
      for (const [n, row] of [...list.children].entries()) row.setAttribute("aria-selected", String(n === i));
      const row = list.children[i];
      if (row?.id) box.setAttribute("aria-activedescendant", row.id);
      // Only the list scrolls, and only for the arrow keys: scrollIntoView could move the page under iOS's keyboard.
      if (reveal && row) {
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
      }
    };
    const pick = (command) => {
      box.value = fill(box.value, command.name);
      close();
      closedFor = box.value;
      box.focus();
      const end = box.value.length;
      box.setSelectionRange?.(end, end);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      picked = command.name;
      onPick(command);
    };
    const draw = () => {
      const query = typing(box.value, box.selectionStart ?? box.value.length);
      if (query === null || box.disabled || closedFor === box.value) return close();
      closedFor = null;
      if (commands === null) {
        loading ||= Promise.resolve(load()).then((got) => (commands = Array.isArray(got) ? got : []), () => (commands = [])).finally(() => {
          loading = null;
          draw();
        });
        return;
      }
      if (!commands.length) return close();
      shown = matches(commands, query);
      list.replaceChildren(
        ...(shown.length
          ? shown.map((c, i) => {
              const row = doc.createElement("li");
              row.id = `${list.id}-${i}`;
              row.className = "slash-row";
              row.setAttribute("role", "option");
              row.dataset.kind = c.kind;
              const name = doc.createElement("span");
              name.className = "slash-name";
              name.textContent = `/${c.name}`;
              row.append(name);
              if (c.description) {
                const about = doc.createElement("span");
                about.className = "slash-about";
                about.textContent = c.description;
                row.append(about);
              }
              // The box keeps its focus (and the phone its keyboard) while the row is tapped.
              for (const type of ["pointerdown", "mousedown"]) row.addEventListener(type, (e) => e.preventDefault());
              row.addEventListener("click", () => pick(c));
              return row;
            })
          : [Object.assign(doc.createElement("li"), { className: "slash-none", textContent: `No command matches /${query}` })]),
      );
      list.hidden = false;
      box.setAttribute("aria-expanded", "true");
      choose(shown.length ? Math.min(chosen, shown.length - 1) : -1);
    };

    box.addEventListener("input", () => {
      chosen = 0;
      if (picked && !startsWith(box.value, picked)) picked = null;
      draw();
    });
    box.addEventListener("focus", draw);
    box.addEventListener("blur", () => setTimeout(() => doc.activeElement !== box && close(), 150));
    box.addEventListener("keydown", (e) => {
      if (list.hidden || !shown.length || e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        choose((chosen + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length, { reveal: true });
      } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(shown[chosen] || shown[0]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closedFor = box.value;
        close();
      }
    });
    /** Whether words sent now run as one of the golem's commands: its first word is one, filled in from the list or sent alone ("/compact is broken" typed by hand is a message). */
    const isCommand = (text) => {
      const name = /^\/([\w.:-]+)(?:\s|$)/.exec(String(text || "").trim())?.[1];
      if (!name || !commands?.some((c) => c.name === name)) return false;
      return name === picked || String(text).trim() === `/${name}`;
    };
    return { list, close, refresh: draw, isCommand };
  }

  /** Whether the words still start with the command name /name (alone or followed by a space). */
  const startsWith = (text, name) => text === `/${name}` || text.startsWith(`/${name} `);

  return { typing, matches, fill, attach, MAX_SHOWN };
});
