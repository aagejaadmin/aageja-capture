'use strict';
/**
 * The screenshot catalog: one PDF with every screenshot in the library,
 * its name and its description, then how the capture went. Made with the
 * browser the service already runs (Chromium prints to PDF); nothing leaves
 * the machine: the page is a local file and every network request is refused.
 *
 * Each screenshot is shown from its smaller JPEG copy (_thumbs/, made when
 * it was captured) when there is one, so the PDF stays small enough to share.
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The few Markdown forms the run report uses: paragraphs, - lists, **bold**, [text](link). */
function mdToHtml(md) {
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/_(.+?)_/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  const out = [];
  let list = false;
  for (const line of String(md || '').split('\n')) {
    if (/^- /.test(line)) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push('<li>' + inline(line.slice(2)) + '</li>');
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    if (line.trim()) out.push('<p>' + inline(line) + '</p>');
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

/**
 * rows: library rows { folder, filename, module, screen, description }.
 * Writes outFile. Returns true when the PDF was made.
 */
async function buildCatalogue({ dir, rows, product, client, captured, size, reportMd, outFile }) {
  const label = (r) => (r.module && r.screen && r.module.toLowerCase() !== r.screen.toLowerCase() ? r.module + ' > ' + r.screen : (r.screen || r.module));
  const img = (r) => {
    const thumb = path.join(dir, '_thumbs', r.folder, r.filename.replace(/\.png$/, '.jpg'));
    return fs.existsSync(thumb) ? path.join('_thumbs', r.folder, r.filename.replace(/\.png$/, '.jpg')) : path.join(r.folder, r.filename);
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(product)} screenshots</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0A1628; font-size: 10pt; }
  h1 { font-size: 20pt; margin: 0 0 4pt; color: #0D7377; }
  .meta { color: #5A6A7E; margin-bottom: 14pt; }
  .shot { break-inside: avoid; page-break-inside: avoid; margin: 0 0 12pt; }
  .shot h2 { font-size: 11pt; margin: 0 0 2pt; }
  .shot .file { font-size: 8pt; color: #9AAABB; margin: 0 0 3pt; }
  .shot p { margin: 0 0 5pt; line-height: 1.35; }
  .shot img { width: 100%; border: 1px solid #E4DDD0; }
  .report { break-before: page; page-break-before: always; }
  .report p, .report li { line-height: 1.4; }
</style></head><body>
<h1>${esc(product)} screenshots</h1>
<div class="meta">${client ? esc(client) + ' · ' : ''}${rows.length} screenshot${rows.length === 1 ? '' : 's'} · ${esc(size)} · captured ${esc(captured)}</div>
${rows.map((r, i) => `<div class="shot"><h2>${i + 1}. ${esc(label(r))}</h2><div class="file">${esc(r.folder + '/' + r.filename)}</div><p>${esc(r.description)}</p><img src="${esc(img(r).split(path.sep).map(encodeURIComponent).join('/'))}"></div>`).join('\n')}
${reportMd ? `<div class="report"><h1>How the capture went</h1>${mdToHtml(reportMd)}</div>` : ''}
</body></html>`;
  const htmlFile = path.join(dir, '_catalog.html');
  fs.writeFileSync(htmlFile, html);
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext();
    // Only the local files of this library; nothing else is fetched.
    await context.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto('file://' + htmlFile, { waitUntil: 'load', timeout: 120000 });
    await page.pdf({ path: outFile, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    return true;
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(htmlFile, { force: true });
  }
}

module.exports = { buildCatalogue, mdToHtml };
