'use strict';
/*
 * discover_controls.js — from the platform-module-capture skill
 * (scripts/discover_controls.js, SHA-256 0ed9598e…687224), used by the
 * capture service's walk to list the controls on a screen.
 *
 * The skill's script is an IIFE run through the Chrome tool. Here it is the
 * same code as a function the service runs in the page (page.evaluate), with
 * these additions, each marked "ADDITION" below:
 *   1. Controls that are position:fixed count as visible. The original test
 *      (offsetParent !== null) is false for every fixed element, such as a ☰
 *      button pinned to the top of the screen.
 *   2. Every control also carries: sel (a CSS path, to click it again on a
 *      later visit), href (a link's full address), kind, inNav, inForm,
 *      haspopup, expanded, hint (its class and id words, for icon buttons),
 *      download and hidden.
 *   3. Links that are hidden in a menu (menus that open on hover) are listed
 *      with hidden: true. They are opened by address, never clicked.
 *   4. With opts.dialogOnly, when a dialog is open only the controls inside
 *      it are listed: the page behind a dialog cannot be clicked.
 *   5. The selector also takes [role=link], [role=treeitem] and [onclick].
 *   6. Every control also carries sortable: true for a table's sort control
 *      (inside an [aria-sort] header, or a link whose script or address sorts,
 *      such as javascript:__doPostBack('…','Sort$Title')).
 *   7. sortable is also true for any control in a table's column heading.
 *   8. sortable is also true for a section of a filter panel (a control that
 *      expands, inside an element whose class, id or label says filter).
 *   9. Every control also carries pressed (its aria-pressed): a toggle.
 *  10. A link or button in a menu also carries section: the label of the
 *      submenu it sits in ("Learning" for Learning > Training Plans).
 * Everything else (the classes, the locator order, breadth, counts) is the
 * skill's own.
 *
 * Read-only + idempotent.
 */
function discoverControls(opts) {
  opts = opts || {};
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" &&
      (el.offsetParent !== null || s.position === "fixed"); // ADDITION 1
  };
  const txt = (el) =>
    (el.getAttribute("aria-label") || el.textContent || el.value || el.title || "")
      .trim().replace(/\s+/g, " ").slice(0, 80);
  const uniq = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return null; } };

  const locator = (el) => {
    const tid = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy");
    if (tid) return { strategy: "getByTestId", value: tid, unique: uniq('[data-testid="' + CSS.escape(tid) + '"]') };
    const role = el.getAttribute("role") || ({ BUTTON: "button", A: "link", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox" }[el.tagName] || null);
    const name = txt(el);
    if (role && name) return { strategy: "getByRole", role, name, unique: null };
    if (name) return { strategy: "getByText", value: name, unique: null };
    return { strategy: null, note: "no stable locator — record null per discipline" };
  };

  const classify = (el) => {
    const t = el.tagName;
    const role = el.getAttribute("role") || "";
    const al = (el.getAttribute("aria-label") || "").toLowerCase();
    const tx = txt(el).toLowerCase();
    const hay = al + " " + tx;
    if (role === "menuitem" || el.closest("[role=menu]")) return "overflow-item";
    if (role === "tab" || el.closest("[role=tablist]")) return "tab";
    if (t === "SELECT" || role === "combobox" || el.getAttribute("aria-haspopup") === "listbox") return "dropdown";
    if (t === "DETAILS" || el.getAttribute("aria-expanded") !== null || /expand|collaps|chevron|show more|accordion/.test(hay)) return "expandable";
    if (el.getAttribute("aria-haspopup") === "menu" || /\bmore\b|options|kebab|overflow/.test(hay)) return "overflow-trigger";
    if (/step/.test(role) || el.getAttribute("aria-current") === "step" || el.closest("[class*=step],[class*=wizard],[class*=stepper]")) return "wizard-step";
    if (t === "INPUT" || t === "TEXTAREA") return "form-field";
    if (el.closest("tr,[role=row]")) return "row-action";
    if (el.closest("[role=toolbar],header,.toolbar,.actions,.action-bar")) return "toolbar";
    return "primary";
  };

  const SEL = [
    "button", "a[href]", "[role=button]", "[role=menuitem]", "[role=tab]",
    "input:not([type=hidden])", "select", "textarea", "summary",
    "[aria-haspopup]", "[aria-expanded]", "[role=combobox]",
    '[tabindex]:not([tabindex="-1"])',
    "[role=link]", "[role=treeitem]", "[onclick]" // ADDITION 5
  ].join(",");

  // ── ADDITION 2: what the walk needs to click a control again ──
  // The site's navigation. A [role=menu] on the page (a ⋯ menu) holds actions,
  // so it is not navigation; its links are still found when hidden (ADDITION 3).
  const NAV = "nav, header, aside, [role=navigation], [role=menubar], [role=banner]";
  const idOk = (id) => /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll("#" + CSS.escape(id)).length === 1;
  const cssPath = (el) => {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && e !== document.documentElement) {
      if (e.id && idOk(e.id)) { parts.unshift("#" + CSS.escape(e.id)); break; }
      let p = e.tagName.toLowerCase();
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += ":nth-of-type(" + (sib.indexOf(e) + 1) + ")";
      parts.unshift(p);
      e = e.parentElement;
    }
    return parts.join(" > ");
  };
  const kindOf = (el) => {
    const role = el.getAttribute("role") || "";
    const t = el.tagName;
    if (/^(checkbox|radio|switch|option|menuitemcheckbox|menuitemradio)$/.test(role) || (t === "INPUT" && /^(checkbox|radio)$/.test(el.type))) return "skip";
    if (t === "A" || role === "link") return "link";
    if (/^(tab|menuitem|treeitem|combobox)$/.test(role)) return role;
    if (t === "SUMMARY") return "summary";
    if (t === "SELECT") return "select";
    if ((t === "INPUT" || t === "BUTTON") && el.type === "submit" && el.form) return "submit";
    if (t === "INPUT" && /^(button|reset|image)$/.test(el.type)) return "button";
    if (t === "INPUT" || t === "TEXTAREA") return "field";
    return "button";
  };
  // ADDITION 8: a search or list page's filter panel (Cornerstone's DURATION,
  // TYPE, MODALITY...): opening its sections shows the same page.
  const FILTERS = "[class*=filter i]:not(html):not(body):not(main), [id*=filter i]:not(html):not(body):not(main), [aria-label*=filter i], [data-testid*=filter i]";
  const opens = (el) => el.getAttribute("aria-expanded") !== null || el.tagName === "SUMMARY";
  // ADDITION 7: a column heading (not a row heading): role columnheader, a th
  // in a thead, a th with scope col, or a th in the table's first row.
  const colHead = (el) => {
    const th = el.closest("th,[role=columnheader]");
    if (!th || th.closest("[role=dialog]")) return false;
    if (th.getAttribute("role") === "columnheader" || th.scope === "col" || th.closest("thead")) return true;
    const table = th.closest("table");
    return !!(table && table.rows[0] && th.parentElement === table.rows[0]);
  };
  // ADDITION 10: the menu section a link sits in ("Learning" for Learning >
  // Training Plans): the label of the control that opens the submenu, or the
  // submenu's own label. The outermost one, so a page lands in its top-level
  // area. Only a submenu counts: a list whose heading opens it (a button, or a
  // control with aria-haspopup / aria-expanded), or one nested in a list item.
  const MENU_BOX = "ul, ol, [role=menu], [role=group], [class*=submenu i], [class*=sub-menu i], [class*=dropdown i], [class*=flyout i], [class*=menu i]";
  const sectionOf = (el) => {
    let label = "";
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.matches(MENU_BOX)) {
        let head = "";
        const lb = node.getAttribute("aria-labelledby");
        if (lb) head = txt(document.getElementById(lb.split(/\s+/)[0]));
        if (!head && node.getAttribute("aria-label") && node.parentElement && node.parentElement.closest(MENU_BOX)) head = txt(node);
        if (!head) {
          let p = node.previousElementSibling;
          while (p && !txt(p)) p = p.previousElementSibling;
          const codeHead = p && p.tagName === "A" && /^\s*(#|javascript:|$)/i.test(p.getAttribute("href") || "");
          const opener = p && (p.tagName === "BUTTON" || codeHead || p.hasAttribute("aria-haspopup") || p.hasAttribute("aria-expanded"));
          const inItem = p && node.parentElement && /^(LI)$/.test(node.parentElement.tagName) || (p && node.parentElement && node.parentElement.getAttribute("role") === "menuitem");
          if (p && !p.contains(el) && (opener || inItem) && p.querySelectorAll("a, button").length <= 1) head = txt(p);
        }
        head = head.replace(/[\s>›»▸▶▾▼▴▲◂◀⌄⌃]+$/, "").trim();
        if (head && head.length <= 40 && head !== txt(el)) label = head;
      }
      if (node.matches(NAV)) break;
      node = node.parentElement;
    }
    return label;
  };
  const extra = (el, hidden) => {
    const raw = el.tagName === "A" ? (el.getAttribute("href") || "") : "";
    // The site's navigation only: a ⋯ menu on a page is not an area.
    const inMenu = !!el.closest(NAV);
    return {
      section: inMenu ? sectionOf(el) : "", // ADDITION 10
      sel: cssPath(el),
      href: raw && !/^\s*(javascript:|#|mailto:|tel:)/i.test(raw) ? el.href : "",
      kind: kindOf(el),
      inNav: !!el.closest(NAV),
      inForm: !!el.closest("form"),
      haspopup: el.getAttribute("aria-haspopup") || "",
      expanded: el.getAttribute("aria-expanded"),
      hint: ((typeof el.className === "string" ? el.className : "") + " " + (el.id || "") + " " + (el.getAttribute("data-icon") || "")).toLowerCase().slice(0, 120),
      download: el.hasAttribute("download"),
      hidden,
      sortable: !!el.closest("[aria-sort]") || /(^|[^a-z])sort/i.test(raw) || /(^|[-_\s])sort(able|ing)?([-_\s]|$)/i.test(typeof el.className === "string" ? el.className : "") ||
        colHead(el) || // ADDITION 7: a table's column heading sorts
        (!!el.closest(FILTERS) && opens(el)), // ADDITION 8: a filter panel's sections
      pressed: el.getAttribute("aria-pressed"), // ADDITION 9: a toggle
    };
  };
  // ── ADDITION 4: inside an open dialog, only the dialog ──
  const DLG = "[role=dialog], [role=alertdialog], dialog[open], [aria-modal='true'], .modal.show, .modal.in, .ui-dialog, .k-window, .ReactModal__Content";
  const dialogs = opts.dialogOnly ? [...document.querySelectorAll(DLG)].filter((d) => { const r = d.getBoundingClientRect(); const s = getComputedStyle(d); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; }) : [];
  const topDialog = dialogs.length ? dialogs[dialogs.length - 1] : null;

  const seen = new Set();
  const controls = [];
  document.querySelectorAll(SEL).forEach((el) => {
    if (!vis(el)) return;
    if (topDialog && !topDialog.contains(el)) return; // ADDITION 4
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return; // ADDITION 2: a disabled control cannot be clicked
    const r = el.getBoundingClientRect();
    const key = el.tagName + "|" + txt(el) + "|" + (r.top | 0) + "|" + (r.left | 0);
    if (seen.has(key)) return;
    seen.add(key);
    controls.push({
      tag: el.tagName,
      label: txt(el),
      controlClass: classify(el),
      inRow: !!el.closest("tr,[role=row]"),
      inDialog: !!el.closest("[role=dialog]") || !!topDialog,
      locator: locator(el),
      ...extra(el, false), // ADDITION 2
    });
  });

  // ── ADDITION 3: links hidden in menus that open on hover ──
  if (!topDialog) {
    document.querySelectorAll("a[href]").forEach((a) => {
      if (vis(a)) return;
      if (!a.closest(NAV + ", [role=menu], [class*='menu' i], [class*='nav' i], [id*='menu' i], [id*='nav' i]")) return;
      const x = extra(a, true);
      if (!x.href || seen.has("hidden|" + x.href)) return;
      seen.add("hidden|" + x.href);
      controls.push({ tag: "A", label: txt(a), controlClass: "nav-link", inRow: false, inDialog: false, locator: locator(a), ...x });
    });
  }

  const nav = [...document.querySelectorAll("nav a[href],[role=navigation] a[href],aside a[href]")]
    .filter(vis).map((a) => ({ label: txt(a), href: a.getAttribute("href") }));
  const tabs = [...document.querySelectorAll("[role=tab]")].filter(vis).map(txt).filter(Boolean);
  const steps = [...new Set(
    [...document.querySelectorAll("[aria-current=step],[class*=step],[class*=stepper] *")]
      .filter(vis).map(txt).filter((s) => s && s.length < 40)
  )];

  const byClass = controls.reduce((m, c) => { m[c.controlClass] = (m[c.controlClass] || 0) + 1; return m; }, {});

  return {
    url: location.href,
    title: document.title,
    counts: { controls: controls.length, byClass },
    controls,
    breadth: { navLinks: nav, tabs, wizardSteps: steps },
    note: "read-only DOM enumeration; re-run after opening a dialog / expanding a row / advancing a wizard step"
  };
}

module.exports = { discoverControls };
