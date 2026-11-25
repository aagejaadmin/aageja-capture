'use strict';
/**
 * Screenshots from documents (1.11.0).
 *
 * Takes the screenshots out of PDF files (help pages saved as PDF, release
 * notes, user guides) instead of capturing a live product. The job's screens
 * have the same shape as a live capture's, so the description step, the
 * library, the zip and the catalog are the same.
 *
 * For each file: download it (public https only, at most MAX_BYTES, must be a
 * PDF), read its images with their places on the page (poppler pdftohtml
 * -xml), keep an image when its shorter side is at least MIN_SIDE pixels, keep
 * each identical image once, and drop one that repeats on more than
 * DECOR_PAGES pages (a logo or banner) or fills the whole page (a cover).
 * Each image keeps its own size.
 *
 * Names: the folder is the document's title; the screen is the heading above
 * the image (the nearest larger-than-body text on its page or before it).
 *
 * Text: tesseract reads each image at twice its size. The lines it reads are
 * the screen's labels for the description step. Email addresses, phone
 * numbers and the Words to Hide that it reads are covered with a grey box,
 * and the screenshot gets a "check" note: text that could not be read cannot
 * be hidden, so the Library Ready screen tells the user to check the catalog.
 *
 * Nothing of the documents is kept: the downloaded files and everything
 * poppler wrote are deleted when the job ends. The links to the files are
 * held in memory only (job._creds), like a live capture's password.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { chromium } = require('playwright');
const png = require('./png-meta');
const { slug, maskString, isPrivateIp, isInternalName, ALLOW_LOCAL, CaptureError, MAX_SCREENS } = require('./capture');

const MAX_DOCS = 10;
const MAX_BYTES = 60 * 1024 * 1024;
const MIN_SIDE = 100;
const DECOR_PAGES = 3;
const MASK_FILL = '#C9CED6';

// ── Inputs ─────────────────────────────────────────────────────────────────

/** The file links from the request: an array, or one per line. */
function parseDocuments(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[\r\n]+/))
    .map((s) => String(s == null ? '' : s).trim())
    .filter((s) => s && !/^(undefined|null)$/i.test(s));
  if (list.length > MAX_DOCS) throw new CaptureError('Add at most ' + MAX_DOCS + ' files.');
  for (const s of list) {
    let u;
    try { u = new URL(s); } catch (_) { throw new CaptureError('A file link is not valid. Upload the files again.'); }
    if (u.protocol !== 'https:' && !(ALLOW_LOCAL && u.protocol === 'http:')) throw new CaptureError('A file link is not valid. Upload the files again.');
  }
  return list;
}

// ── Download ───────────────────────────────────────────────────────────────

/** dns.lookup that refuses addresses not on the public internet. */
function publicLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!ALLOW_LOCAL && (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))) {
      return cb(Object.assign(new Error('not public'), { code: 'ENOTPUBLIC' }));
    }
    if (opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/** The file's bytes. Follows up to 5 redirects; every hop is checked. */
function download(url, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new CaptureError('The file could not be downloaded.')); }
    if (u.protocol !== 'https:' && !(ALLOW_LOCAL && u.protocol === 'http:')) return reject(new CaptureError('The file could not be downloaded.'));
    if (!ALLOW_LOCAL && isInternalName(u.hostname)) return reject(new CaptureError('The file could not be downloaded.'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: publicLookup, timeout: 120000, headers: { 'User-Agent': 'AaGeJa Screenshot Library Builder' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new CaptureError('The file could not be downloaded.'));
        return resolve(download(new URL(res.headers.location, u).href, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new CaptureError('The file could not be downloaded.')); }
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.destroy(); return reject(new CaptureError('The file is larger than ' + (MAX_BYTES >> 20) + ' MB.')); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); reject(new CaptureError('The file is larger than ' + (MAX_BYTES >> 20) + ' MB.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => reject(new CaptureError('The file could not be downloaded.')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e instanceof CaptureError ? e : new CaptureError('The file could not be downloaded.')));
  });
}

const isPdf = (buf) => buf.length > 5 && buf.subarray(0, 1024).includes('%PDF-');

// ── Tools ──────────────────────────────────────────────────────────────────

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
      resolve(String(stdout || ''));
    });
  });
}

/** Title and page count from pdfinfo. */
async function pdfInfo(file) {
  const out = await run('pdfinfo', ['-enc', 'UTF-8', file], 60000);
  const title = (out.match(/^Title:\s*(.*)$/m) || [])[1] || '';
  const pages = Number((out.match(/^Pages:\s*(\d+)/m) || [])[1] || 0);
  return { title: title.trim(), pages };
}

/** "Microsoft Word - Setup Guide.docx" -> "Setup Guide". */
function cleanTitle(t) {
  return String(t || '').replace(/^Microsoft (Word|PowerPoint|Excel)\s*-\s*/i, '')
    .replace(/\.(docx?|pptx?|xlsx?|pdf|html?)$/i, '').replace(/\s+/g, ' ').trim();
}

/** A readable name from the link's file name, when it has one. */
function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (!/\.pdf$/i.test(last)) return '';
    const n = last.replace(/\.pdf$/i, '').replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    // A random id is not a name.
    if (!n || /^[a-f0-9-]{16,}$/i.test(n.replace(/\s/g, ''))) return '';
    return n;
  } catch (_) { return ''; }
}

// ── pdftohtml -xml ─────────────────────────────────────────────────────────

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (_) { return ''; }
    }
    return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
  });
}
const attr = (tag, name) => { const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"')); return m ? m[1] : ''; };

/** Pages with their images and text runs; font sizes by id. */
function parseXml(xml) {
  const fonts = {};
  for (const m of xml.matchAll(/<fontspec\b[^>]*>/g)) fonts[attr(m[0], 'id')] = Number(attr(m[0], 'size')) || 0;
  const pages = [];
  for (const part of xml.split(/<page\b/).slice(1)) {
    const head = part.slice(0, part.indexOf('>'));
    const page = { number: Number(attr(head, 'number')), width: Number(attr(head, 'width')), height: Number(attr(head, 'height')), images: [], texts: [] };
    for (const m of part.matchAll(/<image\b[^>]*>/g)) {
      page.images.push({ top: Number(attr(m[0], 'top')), left: Number(attr(m[0], 'left')), width: Number(attr(m[0], 'width')), height: Number(attr(m[0], 'height')), src: decode(attr(m[0], 'src')) });
    }
    for (const m of part.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      const inner = m[2];
      const text = decode(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      page.texts.push({ top: Number(attr(m[1], 'top')), left: Number(attr(m[1], 'left')), height: Number(attr(m[1], 'height')), size: fonts[attr(m[1], 'font')] || 0, text });
    }
    pages.push(page);
  }
  return pages;
}

/**
 * Headings: text larger than the body text (the size with the most
 * characters), joined across one line and across wrapped lines. Text that
 * repeats on more than DECOR_PAGES pages (running headers) is not a heading.
 */
function findHeadings(pages) {
  const chars = {};
  for (const p of pages) for (const t of p.texts) chars[t.size] = (chars[t.size] || 0) + t.text.length;
  const body = Number(Object.keys(chars).sort((a, b) => chars[b] - chars[a])[0] || 0);
  const min = Math.max(body * 1.25, body + 2);
  const seen = {};
  for (const p of pages) for (const t of new Set(p.texts.map((x) => x.text))) seen[t] = (seen[t] || 0) + 1;
  const out = [];
  for (const p of pages) {
    const big = p.texts.filter((t) => t.size >= min && seen[t.text] <= DECOR_PAGES && /[A-Za-z]/.test(t.text))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    let cur = null;
    for (const t of big) {
      const sameLine = cur && t.size === cur.size && Math.abs(t.top - cur.lastTop) <= 2;
      const wrapped = cur && t.size === cur.size && t.top > cur.lastTop && t.top - cur.lastTop <= t.height * 1.6;
      if (sameLine || wrapped) { cur.text += ' ' + t.text; cur.lastTop = t.top; continue; }
      cur = { page: p.number, top: t.top, lastTop: t.top, size: t.size, text: t.text };
      out.push(cur);
    }
  }
  for (const h of out) h.text = h.text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return out.filter((h) => h.text.length >= 2);
}

/** The heading just above a place in the document, and the larger one above that. */
function headingFor(headings, pageNo, top) {
  let near = -1;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.page < pageNo || (h.page === pageNo && h.top <= top)) near = i; else break;
  }
  if (near < 0) return { name: '', parent: '' };
  let parent = '';
  for (let i = near - 1; i >= 0; i--) if (headings[i].size > headings[near].size) { parent = headings[i].text; break; }
  return { name: headings[near].text, parent };
}

// ── Reading and hiding text ────────────────────────────────────────────────

/** Words from tesseract's TSV, in native pixels (the image was read at 2x). */
function parseTsv(tsv, scale) {
  const words = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    if (!text) continue;
    words.push({
      key: c[2] + '.' + c[3] + '.' + c[4], left: Number(c[6]) / scale, top: Number(c[7]) / scale,
      width: Number(c[8]) / scale, height: Number(c[9]) / scale, conf: Number(c[10]), text,
    });
  }
  return words;
}

/** Words grouped into lines, each with its text and every word's place in it. */
function linesOf(words) {
  const by = new Map();
  for (const w of words) { if (!by.has(w.key)) by.set(w.key, []); by.get(w.key).push(w); }
  return [...by.values()].map((ws) => {
    ws.sort((a, b) => a.left - b.left);
    let text = '';
    const spans = ws.map((w) => { if (text) text += ' '; const s = text.length; text += w.text; return { w, s, e: text.length }; });
    const conf = ws.reduce((n, w) => n + w.conf, 0) / ws.length;
    return { text, spans, conf, top: Math.min(...ws.map((w) => w.top)), left: ws[0].left };
  }).sort((a, b) => a.top - b.top || a.left - b.left);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;

/** Boxes over the words that are an email, a phone number or a word to hide. */
function maskBoxes(lines, words) {
  const pats = [{ kind: 'email', re: EMAIL }, { kind: 'phone', re: PHONE }];
  for (const w of words || []) {
    if (!w) continue;
    const src = w.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    if (src) pats.push({ kind: 'word', re: new RegExp(src, 'gi') });
  }
  const hits = { email: 0, phone: 0, word: 0 };
  const boxes = [];
  for (const line of lines) {
    const marked = new Set();
    for (const { kind, re } of pats) {
      re.lastIndex = 0;
      for (const m of line.text.matchAll(re)) {
        if (kind === 'phone') { const d = m[0].replace(/\D/g, '').length; if (d < 10 || d > 15) continue; }
        const s = m.index, e = m.index + m[0].length;
        let any = false;
        for (const sp of line.spans) if (sp.s < e && sp.e > s && !marked.has(sp)) { marked.add(sp); any = true; }
        if (any) hits[kind]++;
      }
    }
    // An address the reader got slightly wrong ("name@site.con") is still an address.
    for (const sp of line.spans) {
      if (!marked.has(sp) && /[A-Za-z0-9]@[A-Za-z0-9]/.test(sp.w.text)) { marked.add(sp); hits.email++; }
    }
    for (const sp of marked) boxes.push(sp.w);
  }
  return { boxes, hits };
}

/** Lines worth giving the description step: readable, not stray marks. */
function labelLines(lines, words) {
  const out = [];
  const seen = new Set();
  for (const l of lines) {
    const t = l.text.replace(/\s+/g, ' ').trim();
    if (l.conf < 55 || (t.match(/[A-Za-z]/g) || []).length < 2) continue;
    const m = maskString(t, words).slice(0, 80);
    if (seen.has(m.toLowerCase())) continue;
    seen.add(m.toLowerCase());
    out.push(m);
  }
  return out;
}

function hiddenNote(hits) {
  const parts = [];
  if (hits.email) parts.push(hits.email + ' email address' + (hits.email === 1 ? '' : 'es'));
  if (hits.phone) parts.push(hits.phone + ' phone number' + (hits.phone === 1 ? '' : 's'));
  if (hits.word) parts.push(hits.word + ' of your words to hide');
  return parts.length ? 'Hidden: ' + parts.join(', ') + '. Check this image.' : '';
}

// ── The job ────────────────────────────────────────────────────────────────

/**
 * Runs one documents job. job is mutated as it goes so a status call sees
 * progress. urls are the file links; they are not written anywhere.
 */
async function runDocuments(job, urls, outDir) {
  const words = job.mask_words || [];
  const masker = (s) => maskString(s, words);
  const src = path.join(outDir, '_src');
  const used = new Set();
  const hashes = new Set();
  job.docs = [];
  job.progress = { done: 0, total: urls.length, current: '' };
  fs.mkdirSync(src, { recursive: true });
  let browser = null;
  let page = null;
  const canvasPage = async () => {
    if (page) return page;
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    page = await (await browser.newContext()).newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    return page;
  };
  // One file: its screenshots go into job.screens; doc says how it went.
  const readDoc = async (i, doc, dir, fallback) => {
    fs.mkdirSync(dir, { recursive: true });
    const buf = await download(urls[i]);
    if (!isPdf(buf)) throw new CaptureError('The file is not a PDF.');
    const file = path.join(dir, 'doc.pdf');
    fs.writeFileSync(file, buf);
    let info;
    try { info = await pdfInfo(file); } catch (e) {
      throw new CaptureError(/password/i.test(e.stderr || '') ? 'The PDF is protected by a password.' : 'The PDF could not be read.');
    }
    const title = masker(cleanTitle(info.title) || fallback);
    doc.name = title;
    doc.pages = info.pages;
    job.progress.current = title;
    try { await run('pdftohtml', ['-xml', '-nodrm', '-q', '-fmt', 'png', file, path.join(dir, 'x')], 5 * 60000); } catch (_) {
      throw new CaptureError('The PDF could not be read.');
    }
    const pages = parseXml(fs.readFileSync(path.join(dir, 'x.xml'), 'utf8'));
    const headings = findHeadings(pages);

    // The images worth keeping, in reading order.
    const all = [];
    for (const p of pages) {
      for (const im of p.images.sort((a, b) => a.top - b.top || a.left - b.left)) {
        // A picture behind the whole page (a cover) is not a screenshot.
        if (p.width && p.height && im.width >= p.width * 0.9 && im.height >= p.height * 0.9) continue;
        const f = path.resolve(dir, im.src);
        if (!f.startsWith(dir + path.sep) || !fs.existsSync(f)) continue;
        let b, d;
        try { b = fs.readFileSync(f); d = png.dimensions(b); } catch (_) { continue; }
        all.push({ page: p.number, top: im.top, buf: b, w: d.width, h: d.height, hash: crypto.createHash('sha1').update(b).digest('hex') });
      }
    }
    const pagesOf = {};
    for (const a of all) (pagesOf[a.hash] = pagesOf[a.hash] || new Set()).add(a.page);
    const keep = [];
    const mine = new Set();
    for (const a of all) {
      if (Math.min(a.w, a.h) < MIN_SIDE || pagesOf[a.hash].size > DECOR_PAGES || hashes.has(a.hash) || mine.has(a.hash)) continue;
      mine.add(a.hash);
      keep.push(a);
    }
    doc.found = keep.length;
    if (!keep.length) { doc.reason = 'No screenshots in this file.'; return; }
    // At most MAX_SCREENS a run: a file that does not fit waits for the next run.
    const room = MAX_SCREENS - job.screens.length;
    if (keep.length > room && job.screens.length) {
      doc.left = keep.length;
      doc.reason = 'Not read: a run takes up to ' + MAX_SCREENS + ' screenshots. Run the agent again with this file.';
      return;
    }
    const take = keep.slice(0, room);
    doc.left = keep.length - take.length;

    const folder = slug(title) || 'document-' + (i + 1);
    const pg = await canvasPage();
    for (const a of take) {
      hashes.add(a.hash);
      const h = headingFor(headings, a.page, a.top);
      const screen = masker(h.name || title);
      const b64 = a.buf.toString('base64');
      // One pass: the image at twice its size in grey, for reading, and a JPEG for the catalog.
      const prep = await pg.evaluate(async ({ b64 }) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const w = img.naturalWidth, h = img.naturalHeight;
        const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.filter = 'grayscale(1)';
        x.drawImage(img, 0, 0, c.width, c.height);
        const t = document.createElement('canvas'); t.width = w; t.height = h;
        const y = t.getContext('2d'); y.fillStyle = '#fff'; y.fillRect(0, 0, w, h); y.drawImage(img, 0, 0);
        return { ocr: c.toDataURL('image/png').split(',')[1], jpg: t.toDataURL('image/jpeg', 0.75).split(',')[1] };
      }, { b64 });
      const ocrFile = path.join(dir, 'ocr.png');
      fs.writeFileSync(ocrFile, Buffer.from(prep.ocr, 'base64'));
      let lines = [];
      try {
        const tsv = await run('tesseract', [ocrFile, 'stdout', '--psm', '11', '--dpi', '150', '-l', 'eng', 'tsv'], 120000);
        lines = linesOf(parseTsv(tsv, 2));
      } catch (e) {
        console.error('[job ' + job.id + '] text not read on one image: ' + String(e && e.message || e).split('\n')[0]);
      }
      const { boxes, hits } = maskBoxes(lines, words);
      let out = a.buf;
      let jpg = Buffer.from(prep.jpg, 'base64');
      if (boxes.length) {
        const r = await pg.evaluate(async ({ b64, boxes, fill }) => {
          const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
          const w = img.naturalWidth, h = img.naturalHeight;
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const x = c.getContext('2d'); x.drawImage(img, 0, 0); x.fillStyle = fill;
          for (const b of boxes) x.fillRect(Math.floor(b.left - 3), Math.floor(b.top - 3), Math.ceil(b.width + 6), Math.ceil(b.height + 6));
          const t = document.createElement('canvas'); t.width = w; t.height = h;
          const y = t.getContext('2d'); y.fillStyle = '#fff'; y.fillRect(0, 0, w, h); y.drawImage(c, 0, 0);
          return { png: c.toDataURL('image/png').split(',')[1], jpg: t.toDataURL('image/jpeg', 0.75).split(',')[1] };
        }, { b64, boxes: boxes.map((b) => ({ left: b.left, top: b.top, width: b.width, height: b.height })), fill: MASK_FILL });
        out = Buffer.from(r.png, 'base64');
        jpg = Buffer.from(r.jpg, 'base64');
        job.masked += boxes.length;
      }
      const base = [slug(job.product, 30) || 'product', folder, slug(screen) || 'page'].join('_');
      let filename = base + '.png';
      for (let n = 2; used.has(folder + '/' + filename); n++) filename = base + '-' + n + '.png';
      used.add(folder + '/' + filename);
      fs.mkdirSync(path.join(outDir, folder), { recursive: true });
      fs.writeFileSync(path.join(outDir, folder, filename), out);
      fs.mkdirSync(path.join(outDir, '_thumbs', folder), { recursive: true });
      fs.writeFileSync(path.join(outDir, '_thumbs', folder, filename.replace(/\.png$/, '.jpg')), jpg);
      const parent = h.parent && h.parent !== h.name && h.parent !== title ? masker(h.parent) : '';
      job.screens.push({
        folder, filename, module: title, screen, target: title + ', page ' + a.page,
        page_title: title, heading: screen, headings: parent ? [parent, screen] : [screen],
        labels: labelLines(lines, words), elements: [], source_path: title + ', page ' + a.page,
        warning: hiddenNote(hits), width: a.w, height: a.h,
      });
      doc.screenshots++;
    }
  };

  try {
    for (let i = 0; i < urls.length; i++) {
      const fallback = nameFromUrl(urls[i]) || 'Document ' + (i + 1);
      const doc = { name: masker(fallback), pages: 0, screenshots: 0, found: 0, left: 0, reason: '' };
      job.docs.push(doc);
      job.progress.current = doc.name;
      job.stage = 'reading';
      const dir = path.join(src, String(i + 1));
      try {
        await readDoc(i, doc, dir, fallback);
      } catch (e) {
        doc.reason = e instanceof CaptureError ? e.userMessage : 'The file could not be read.';
        if (!(e instanceof CaptureError)) console.error('[job ' + job.id + '] document ' + (i + 1) + ': ' + String(e && e.message || e).split('\n')[0]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      if (doc.reason && !doc.screenshots) job.not_captured.push({ target: doc.name, reason: doc.reason });
      job.progress.done = i + 1;
    }
    job.progress.current = '';
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(src, { recursive: true, force: true });
  }
}

module.exports = { runDocuments, parseDocuments, MAX_DOCS, parseXml, findHeadings, headingFor, parseTsv, linesOf, maskBoxes };
