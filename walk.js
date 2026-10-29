'use strict';
/**
 * The walk: what the capture may click, and how it tells one screen from
 * another. The controls on a screen come from discover_controls.js (the
 * platform-module-capture skill's script); the walk itself runs in
 * capture.js.
 *
 * Three levels, chosen by the person running the capture:
 *   links    menu items, tabs and links. Navigation menus are opened to find
 *            their links, but an open menu is not a screenshot.
 *   buttons  also buttons, ⋯ menus, dropdowns, accordions and wizard steps.
 *            Each dialog and form is captured, then left without saving.
 *            A button that changes data (Delete, Send, ...) is clicked with
 *            every request that is not a plain read refused: if it opens an
 *            "Are you sure?" box, that is captured and Cancel pressed
 *            (the skill's Constraint 5); if it acts at once, nothing reaches
 *            the site.
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

 // A page that shows the site's error message instead of a screen: never
// kept, and nothing on it is opened. Tested on its headings and title.
const ERROR_PAGE = /(\ban?\s+(unexpected\s+)?error\s+(has\s+)?occurred|\berror\s+occurred\s+while\s+processing|\bsomething\s+went\s+wrong|\bpage\s+(was\s+)?not\s+found|\b404\b|\binternal\s+server\s+error|\baccess\s+denied|\bnot\s+authori[sz]ed\b|\byou\s+do\s+not\s+have\s+(permission|access)|\bforbidden\b|\bsession\s+(has\s+)?(expired|timed\s+out))/i;

const FILE_EXT = /\.(pdf|docx?|xlsx?|csv|pptx?|zip|rar|7z|gz|tar|mp4|mov|avi|mp3|wav|png|jpe?g|gif|svg|ics|exe|dmg|msi)$/i;

const norm = (s) => String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

function safeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

/** The words of an address, for the danger checks: path and query, separators as spaces. */
function addressWords(href) {
  try { const u = new URL(href); return safeDecode(u.pathname + ' ' + u.search).replace(/[-_/=&?.+]+/g, ' '); } catch (_) { return ''; }
}

const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=.*\d)[A-Za-z0-9_-]{16,})$/i;
const ID_VAL = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{12,}|(?=.*\d)[A-Za-z0-9_-]{16,}|.*\d{4,}.*)$/i;
const ID_KEY = /(^id$|_id$|Id$|^uid$|^guid$)/;
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
    if (ID_VAL.test(v) || (ID_KEY.test(k) && v)) { hasId = true; q.push(k.toLowerCase() + '=:id'); } else q.push(k.toLowerCase() + '=' + v.toLowerCase());
  }
  // Hash routes (#/users) pick a screen; a plain #section does not.
  const hash = /^#!?\//.test(u.hash) ? u.hash.replace(/\/\d+(?=\/|$)/g, () => { hasId = true; return '/:id'; }).toLowerCase() : '';
  return { pattern: u.host.toLowerCase() + segs.join('/') + (q.length ? '?' + q.join('&') : '') + hash, hasId };
}

/**
 * What a control does, from its name, the class discover_controls.js gave it
 * (tab, overflow-trigger, overflow-item, expandable, dropdown, wizard-step,
 * row-action, toolbar, primary, form-field, nav-link) and its kind:
 *   never    never clicked (sign out, pay, act as another user)
 *   skip     clicked never (close, cancel, print, download; form fields)
 *   unnamed  a button with no name and no hint
 *   nav      a link, tab or menu item
 *   reveal   a control that opens the site's navigation menu
 *   open     a button that opens something (dialog, menu, form, panel)
 *   commit   changes data
 */
function classify(c) {
  const text = c.label || '';
  const words = c.href ? addressWords(c.href) : '';
  if (NEVER.test(text) || (words && NEVER.test(words))) return 'never';
  if (c.kind === 'skip' || c.kind === 'select' || c.kind === 'field') return 'skip';
  if (SKIP.test(text) || SKIP_ANY.test(text) || c.download) return 'skip';
  // Links, tabs, tree items, and items of a menu in the navigation. Items of a
  // ⋯ menu on the page are actions, judged like buttons below.
  const navLike = c.kind === 'link' || c.kind === 'treeitem' || c.controlClass === 'tab' || c.controlClass === 'nav-link' ||
    (c.controlClass === 'overflow-item' && c.inNav);
  if (navLike) {
    if (c.href && FILE_EXT.test(c.href.split(/[?#]/)[0])) return 'skip';
    if (LINK_DANGER.test(text) || (words && LINK_DANGER.test(words))) return 'commit';
    // A tab or menu item that is a button runs code, not a page load: it is
    // judged by the button words too ("Export", "Archive").
    if (c.kind !== 'link' && COMMIT.test(text)) return 'commit';
    if (!text) return 'unnamed';
    return 'nav';
  }
  const navMenu = NAV_MENU.test(text) || NAV_HINT.test(c.hint) ||
    (c.inNav && !c.inDialog && (c.haspopup || c.expanded !== null || MORE_WORD.test(text)));
  if (!text) {
    if (HINT_COMMIT.test(c.hint)) return 'commit';
    if (navMenu) return 'reveal';
    if (HINT_OPEN.test(c.hint) || c.controlClass === 'overflow-trigger' || c.controlClass === 'expandable') return 'open';
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
  const root = top || document;
  // With a dialog open, only its own tabs tell one screen from another.
  const tabs = [...root.querySelectorAll('[role=tab][aria-selected="true"]')].filter(vis).map(txt).filter(Boolean).join('+');
  const h1 = txt([...document.querySelectorAll('h1, [role=heading][aria-level="1"]')].filter(vis)[0]);
  const bits = [...root.querySelectorAll('h1, h2, h3, h4, [role=heading], label, legend, th, button, a, [role=tab], [role=menuitem], [role=option], input, select, textarea, summary, details[open] > *')]
    .filter(vis).map((e) => (e.tagName + ':' + txt(e)).toLowerCase().replace(/\d+/g, '#')).filter((s) => s.length > 2);
  const sig = [...new Set(bits)].sort().join('|');
  return { dialog, tabs, h1, sig };
}

module.exports = { NEVER, LINK_DANGER, COMMIT, OPENER, SKIP, ERROR_PAGE, classify, ALLOWED, urlPattern, addressWords, norm, stateInPage, FILE_EXT };
