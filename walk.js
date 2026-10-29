'use strict';
/**
 * The walk: what the capture may click, and how it tells one screen from
 * another. Pure functions and functions that run inside the page; the walk
 * itself runs in capture.js.
 *
 * Three levels, chosen by the person running the capture:
 *   links    menu items, tabs and links. Navigation menus are opened to find
 *            their links, but an open menu is not a screenshot.
 *   buttons  also buttons, ⋯ menus, dropdowns, accordions and wizard steps.
 *            Each dialog and form is captured, then left without saving.
 *   all      also buttons that change data (Save, Submit, Delete, Send and
 *            similar), pressed last, after every other screen is captured.
 * At every level: never signs out, never pays, never acts as another user.
 */

// Never pressed or followed at any level: it would end the capture, act as
// someone else, or spend money.
const NEVER = /\b(sign\s?out|sign\s?off|log\s?out|log\s?off|logout|logoff|signout|end\s+session|(log|sign)\s?in\s+as|login\s+as|proxy\s+as|impersonat\w*|switch\s+(user|account)|pay|pay\s+now|make\s+(a\s+)?payment|purchase|buy|checkout|check\s?out|place\s+(an\s+)?order|order\s+now|subscribe)\b/i;

// Links and menu items: the words the page-list mode already refuses
// (capture.js DANGER), tested on the label and on the address.
const LINK_DANGER = /\b(delete|remove|deactivate|disable|archive|purge|reset|revoke|terminate|save|submit|approve|reject|decline|send|publish|unpublish|import|upload|assign|unassign|enrol+|register|request|launch|confirm)\b/i;

// Buttons that change data. Pressed only at the "all" level.
const COMMIT = /\b(delete|remove|deactivate|disable|archive|purge|reset|revoke|terminate|save|submit|approve|reject|decline|send|publish|unpublish|import|upload|assign|unassign|enrol+|enroll|register|request|launch|confirm|create|add|update|apply|finish|complete|done|ok|okay|yes|accept|invite|notify|remind|share|email|export|generate|run|start|stop|restart|sync|copy|duplicate|clone|move|transfer|merge|lock|unlock|activate|enable|mark|clear|undo|restore|follow|unfollow|like|favou?rite|join|leave|withdraw|discard|post|reply|comment|upgrade|downgrade|grant|deny|block|unblock|suspend|reopen|recall|nominate|certify|schedule|book|reserve|rate|vote|claim|redeem)\b/i;

// "Add User", "+ New report", "Create course" on a page open a form. The same
// words inside a dialog or as a form's submit button save it. "Add to ..."
// ("Add to cart", "Add to transcript") changes data.
const OPENER = /^(\+\s*)?(add|create|new)\b(?!\s+to\b)/i;

// Searching, filtering and moving between wizard steps do not change data.
const SAFE_SUBMIT = /^(search|go|find|filter|filters|apply\s+filters?|refresh|view|show|next|continue)$/i;

// Clicked never: closing, going back, printing and downloading give no new screen.
const SKIP = /^(cancel|close|dismiss|×|✕|✖|x|no\s+thanks|not\s+now|got\s+it|back|previous|prev|back\s+to\s+top|skip\s+to(\s+main)?\s+content|help|collapse\s+all)$/i;
const SKIP_ANY = /\b(download|print)\b/i;

// Class or id words that tell what a button with no name does.
const HINT_COMMIT = /(delete|trash|remove|bin\b)/i;
const HINT_OPEN = /(more|kebab|ellipsis|overflow|menu|dots|actions|caret|chevron|expand|toggle|dropdown|hamburger)/i;
// A button that opens the site's navigation menu (for example ☰ "Show
// Navigation Menu"), wherever it sits on the page.
const NAV_MENU = /(\bmenu\b|\bnavigation\b|\bnav\b|☰)/i;
const NAV_HINT = /(hamburger|navbar-toggler|menu-toggle|nav-toggle)/i;
const MORE_WORD = /(\bmore\b|\bactions\b|\boptions\b|⋯|⋮|…|▾|▼)/i;

const FILE_EXT = /\.(pdf|docx?|xlsx?|csv|pptx?|zip|rar|7z|gz|tar|mp4|mov|avi|mp3|wav|png|jpe?g|gif|svg|ics|exe|dmg|msi)$/i;

const norm = (s) => String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

function safeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

/** The words of an address, for the danger checks: path and query, separators as spaces. */
function addressWords(href) {
  try { const u = new URL(href); return safeDecode(u.pathname + ' ' + u.search).replace(/[-_/=&?.+]+/g, ' '); } catch (_) { return ''; }
}

const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=.*\d)[A-Za-z0-9_-]{16,})$/i;
const ID_VAL = /^(\d{2,}|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{12,}|(?=.*\d)[A-Za-z0-9_-]{16,}|.*\d{4,}.*)$/i;
const DROP_KEYS = /^(utm_.*|_|t|ts|time|timestamp|cache|nocache|cb|rand|r|sid|session|sessionid|token|k|key|access_token|code|state|nonce)$/i;

/**
 * The kind of page an address shows, with record numbers replaced, so
 * /users/123 and /users/456 count as one screen. Keeps query values that pick
 * a screen (routename=Admin/Users) and replaces ones that pick a record.
 */
function urlPattern(href) {
  let u;
  try { u = new URL(href); } catch (_) { return { pattern: String(href || ''), hasId: false }; }
  let hasId = false;
  const segs = u.pathname.split('/').map((s) => {
    if (s && ID_SEG.test(safeDecode(s))) { hasId = true; return ':id'; }
    return s.toLowerCase();
  });
  const q = [];
  for (const [k, v] of [...u.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (DROP_KEYS.test(k)) continue;
    if (ID_VAL.test(v)) { hasId = true; q.push(k.toLowerCase() + '=:id'); } else q.push(k.toLowerCase() + '=' + v.toLowerCase());
  }
  // Hash routes (#/users) pick a screen; a plain #section does not.
  const hash = /^#!?\//.test(u.hash) ? u.hash.replace(/\/\d+(?=\/|$)/g, () => { hasId = true; return '/:id'; }).toLowerCase() : '';
  return { pattern: u.host.toLowerCase() + segs.join('/') + (q.length ? '?' + q.join('&') : '') + hash, hasId };
}

/**
 * What a control does, from its name, its kind and where it is:
 *   never    never clicked (sign out, pay, act as another user)
 *   skip     clicked never (close, cancel, print, download; form fields)
 *   unnamed  a button with no name and no hint
 *   nav      a link, tab or menu item
 *   reveal   a control in the navigation that opens a menu
 *   open     a button that opens something (dialog, menu, form, panel)
 *   commit   changes data
 */
function classify(c) {
  const text = c.label || '';
  const words = c.href ? addressWords(c.href) : '';
  if (NEVER.test(text) || (words && NEVER.test(words))) return 'never';
  if (c.kind === 'skip') return 'skip';
  if (SKIP.test(text) || SKIP_ANY.test(text) || c.download) return 'skip';
  if (c.kind === 'link' || c.kind === 'menuitem' || c.kind === 'treeitem' || c.kind === 'tab') {
    if (c.href && FILE_EXT.test(c.href.split(/[?#]/)[0])) return 'skip';
    if (LINK_DANGER.test(text) || (words && LINK_DANGER.test(words))) return 'commit';
    if (!text) return 'unnamed';
    return 'nav';
  }
  const navMenu = NAV_MENU.test(text) || NAV_HINT.test(c.hint) ||
    (c.inNav && !c.inDialog && (c.haspopup || c.expanded !== null || MORE_WORD.test(text)));
  if (!text) {
    if (HINT_COMMIT.test(c.hint)) return 'commit';
    if (navMenu) return 'reveal';
    if (HINT_OPEN.test(c.hint)) return 'open';
    return 'unnamed';
  }
  if (OPENER.test(text) && !c.inDialog && c.kind !== 'submit') return 'open';
  if (COMMIT.test(text) || HINT_COMMIT.test(c.hint)) return 'commit';
  if (c.kind === 'submit' && !SAFE_SUBMIT.test(text)) return 'commit';
  if (navMenu) return 'reveal';
  return 'open';
}

/** What each level clicks. */
const ALLOWED = {
  links: new Set(['nav', 'reveal']),
  buttons: new Set(['nav', 'reveal', 'open']),
  all: new Set(['nav', 'reveal', 'open', 'commit']),
};

/**
 * Runs in the page. Every control the walk might click, in the open dialog
 * only when one is open. Links in the navigation that are hidden (menus that
 * open on hover) are listed too, marked hidden: they are opened by address,
 * never clicked.
 */
function candidatesInPage() {
  const DLG = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"], .modal.show, .modal.in, .ui-dialog, .k-window, .ReactModal__Content';
  const NAV = 'nav, header, aside, [role=navigation], [role=menubar], [role=menu], [role=tablist], [role=banner]';
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    return true;
  };
  const dialogs = [...document.querySelectorAll(DLG)].filter(vis);
  const top = dialogs.length ? dialogs[dialogs.length - 1] : null;
  const root = top || document;
  const SEL = 'a, [role=link], button, [role=button], input[type=button], input[type=submit], input[type=checkbox], input[type=radio], [role=switch], [role=checkbox], [role=radio], [role=option], summary, [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=treeitem], [role=combobox], [onclick], [aria-haspopup]:not(input):not(select)';
  const idOk = (id) => /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;
  const cssPath = (el) => {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && e !== document.documentElement) {
      if (e.id && idOk(e.id)) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let p = e.tagName.toLowerCase();
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(p);
      e = e.parentElement;
    }
    return parts.join(' > ');
  };
  const labelOf = (el) => {
    let t = el.getAttribute('aria-label') || '';
    if (!t) { const lb = el.getAttribute('aria-labelledby'); if (lb) t = lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' '); }
    if (!t) t = el.innerText || el.textContent || '';
    if (!t.trim()) t = el.getAttribute('title') || el.value || '';
    if (!t.trim()) { const img = el.querySelector('img[alt]'); if (img) t = img.alt; }
    return t.replace(/\s+/g, ' ').trim().replace(/\s*\(?\d+\)?$/, '').replace(/^[\s:•·|-]+|[\s:•·|-]+$/g, '').slice(0, 60);
  };
  const kindOf = (el) => {
    const role = el.getAttribute('role');
    const tag = el.tagName;
    if (/^(checkbox|radio|switch|option|menuitemcheckbox|menuitemradio)$/.test(role || '') || (tag === 'INPUT' && /^(checkbox|radio)$/.test(el.type))) return 'skip';
    if (tag === 'A' || role === 'link') return 'link';
    if (role === 'tab' || role === 'menuitem' || role === 'treeitem' || role === 'combobox') return role;
    if (tag === 'SUMMARY') return 'summary';
    if ((tag === 'INPUT' || tag === 'BUTTON') && el.type === 'submit' && el.form) return 'submit';
    return 'button';
  };
  const all = [...root.querySelectorAll(SEL)];
  const set = new Set(all);
  const out = [];
  for (const el of all) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    // The innermost clickable thing, so a link inside a clickable row is the link.
    if ([...el.querySelectorAll(SEL)].some((c) => set.has(c) && c !== el)) continue;
    const tag = el.tagName;
    const shown = vis(el);
    const inNav = !!el.closest(NAV);
    const rawHref = tag === 'A' ? (el.getAttribute('href') || '') : '';
    const href = rawHref && !/^\s*(javascript:|#|mailto:|tel:)/i.test(rawHref) ? el.href : '';
    // A hidden link is kept only when it sits in a menu (one that opens on hover).
    if (!shown && !(href && (inNav || el.closest('[class*="menu" i], [class*="nav" i], [id*="menu" i], [id*="nav" i]')))) continue;
    out.push({
      sel: cssPath(el), label: labelOf(el), kind: kindOf(el), href,
      mail: /^\s*(mailto:|tel:)/i.test(rawHref),
      target: el.getAttribute('target') || '', download: el.hasAttribute('download'),
      inDialog: !!top, inForm: !!el.closest('form'), inNav,
      haspopup: el.getAttribute('aria-haspopup') || '', expanded: el.getAttribute('aria-expanded'),
      hint: ((el.className && typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('data-icon') || '')).toLowerCase().slice(0, 120),
      hidden: !shown,
    });
    if (out.length >= 250) break;
  }
  return out;
}

/** Runs in the page. What tells this screen from others: the open dialog, the chosen tabs, the heading, and a summary of what is on screen. */
function stateInPage() {
  const DLG = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"], .modal.show, .modal.in, .ui-dialog, .k-window, .ReactModal__Content';
  const vis = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && !el.closest('[aria-hidden="true"]');
  };
  const txt = (el) => (el ? (el.getAttribute('aria-label') || el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const dialogs = [...document.querySelectorAll(DLG)].filter(vis);
  const top = dialogs.length ? dialogs[dialogs.length - 1] : null;
  let dialog = '';
  if (top) {
    const lb = top.getAttribute('aria-labelledby');
    dialog = top.getAttribute('aria-label') || (lb ? txt(document.getElementById(lb.split(/\s+/)[0])) : '') ||
      txt(top.querySelector('h1, h2, h3, h4, [role=heading], .modal-title, .ui-dialog-title, legend, strong, b')) || 'dialog';
  }
  const tabs = [...document.querySelectorAll('[role=tab][aria-selected="true"]')].filter(vis).map(txt).filter(Boolean).join('+');
  const h1 = txt([...document.querySelectorAll('h1, [role=heading][aria-level="1"]')].filter(vis)[0]);
  const root = top || document;
  const bits = [...root.querySelectorAll('h1, h2, h3, h4, [role=heading], label, legend, th, button, a, [role=tab], [role=menuitem], [role=option], input, select, textarea, summary, details[open] > *')]
    .filter(vis).map((e) => (e.tagName + ':' + txt(e)).toLowerCase().replace(/\d+/g, '#')).filter((s) => s.length > 2);
  const sig = [...new Set(bits)].sort().join('|');
  return { dialog, tabs, h1, sig };
}

module.exports = { NEVER, LINK_DANGER, COMMIT, OPENER, SKIP, classify, ALLOWED, urlPattern, addressWords, norm, candidatesInPage, stateInPage, FILE_EXT };
