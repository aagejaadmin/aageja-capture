'use strict';
/**
 * Saves a screenshot library to a folder in the customer's Amazon S3 bucket.
 *
 * The customer gives a folder link and, once, lets the capture service's AWS
 * user add files there (s3:PutObject) and lets anyone read them (s3:GetObject),
 * because storyboards and slide decks open the images by link.
 *
 * check() proves both before anything is captured: it writes one small file,
 * aageja-capture-check.txt, into the folder (the same name every run, so there
 * is only ever one), then opens it without signing in.
 *
 * Nothing is deleted. A file with the same name is replaced; every other file
 * in the folder is left as it was.
 *
 * Environment:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  The capture service's own AWS user.
 *   S3_ENDPOINT, STS_ENDPOINT                 Test machine only: a stand-in S3/STS.
 */

const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

const ENDPOINT = process.env.S3_ENDPOINT || '';
const STS_ENDPOINT = process.env.STS_ENDPOINT || '';
const PROBE = 'aageja-capture-check.txt';
const EXAMPLE = 's3://your-bucket/screenshots/product-name/';

const configured = () => !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

function userError(message) { const e = new Error(message); e.userMessage = message; return e; }

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** True when the link names an S3 bucket in any of the forms AWS shows. */
function isS3Link(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch (_) { return false; }
  const h = u.hostname.toLowerCase();
  return u.protocol === 's3:' || /(^|\.)s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(h) || /^s3\.amazonaws\.com$/.test(h) ||
    (/(^|\.)console\.aws\.amazon\.com$/.test(h) && u.pathname.startsWith('/s3/'));
}

/**
 * Accepted forms:
 *   s3://bucket/folder/                                  (Copy S3 URI)
 *   https://bucket.s3.region.amazonaws.com/folder/       (Object URL)
 *   https://s3.region.amazonaws.com/bucket/folder/
 *   https://region.console.aws.amazon.com/s3/buckets/bucket?region=r&prefix=folder/
 * Returns { bucket, prefix, region } with region '' when the link has none.
 */
function parseLink(link) {
  const bad = () => userError('This is not an Amazon S3 folder link. In the S3 console, open the folder and click "Copy S3 URI". It looks like ' + EXAMPLE);
  let u;
  try { u = new URL(String(link || '').trim()); } catch (_) { throw bad(); }
  const h = u.hostname.toLowerCase();
  const segs = () => u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (_) { return s; } });
  let bucket = '', prefix = '', region = '';
  let m;
  if (u.protocol === 's3:') {
    bucket = h; prefix = segs().join('/');
  } else if ((m = h.match(/^(.+)\.s3[.-](?:([a-z0-9-]+)\.)?amazonaws\.com$/)) && !/^s3[.-]/.test(h)) {
    bucket = m[1]; region = (m[2] && m[2] !== 'dualstack') ? m[2] : ''; prefix = segs().join('/');
  } else if ((m = h.match(/^s3[.-](?:([a-z0-9-]+)\.)?amazonaws\.com$/)) || h === 's3.amazonaws.com') {
    const p = segs(); bucket = p.shift() || ''; region = (m && m[1]) || ''; prefix = p.join('/');
  } else if (/(^|\.)console\.aws\.amazon\.com$/.test(h)) {
    const p = segs();
    const i = p.findIndex((x) => x === 'buckets' || x === 'object');
    if (i < 0 || !p[i + 1]) throw bad();
    bucket = p[i + 1];
    prefix = u.searchParams.get('prefix') || '';
    region = u.searchParams.get('region') || (h.match(/^([a-z0-9-]+)\.console/) || [])[1] || '';
  } else throw bad();
  bucket = bucket.toLowerCase();
  if (!BUCKET_RE.test(bucket)) throw bad();
  if (region && !REGION_RE.test(region)) region = '';
  prefix = prefix.replace(/^\/+|\/+$/g, '');
  // A link to one file in the folder (an image or library.json) means its folder.
  if (/\.(png|jpe?g|gif|webp|json|txt)$/i.test(prefix)) prefix = prefix.split('/').slice(0, -1).join('/');
  if (prefix && (!/^[A-Za-z0-9._\/ -]+$/.test(prefix) || prefix.split('/').some((x) => x === '..' || !x.trim()))) {
    throw userError('Folder names in the library folder may use letters, numbers, spaces, dots, hyphens and underscores only.');
  }
  return { bucket, prefix, region };
}

const encKey = (k) => k.split('/').map(encodeURIComponent).join('/');

/** The link anyone can open for a file in the bucket. */
function publicUrl(t, key) {
  if (ENDPOINT) return ENDPOINT.replace(/\/+$/, '') + '/' + t.bucket + '/' + encKey(key);
  const r = t.region ? '.' + t.region : '';
  if (t.bucket.includes('.')) return 'https://s3' + r + '.amazonaws.com/' + t.bucket + '/' + encKey(key);
  return 'https://' + t.bucket + '.s3' + r + '.amazonaws.com/' + encKey(key);
}

const clients = new Map();
function client(region) {
  const r = region || 'us-east-1';
  if (!clients.has(r)) {
    clients.set(r, new S3Client({
      region: r,
      followRegionRedirects: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(ENDPOINT ? { endpoint: ENDPOINT, forcePathStyle: true } : {}),
    }));
  }
  return clients.get(r);
}

let identity = null;
/** The ARN of the capture service's AWS user, for messages that name it. */
async function accountName() {
  if (!configured()) return '';
  if (identity !== null) return identity;
  try {
    const sts = new STSClient({ region: 'us-east-1', ...(STS_ENDPOINT ? { endpoint: STS_ENDPOINT } : {}) });
    const out = await sts.send(new GetCallerIdentityCommand({}));
    identity = out.Arn || '';
  } catch (e) {
    console.error('[s3] could not read the AWS identity: ' + String(e && e.message || e).split('\n')[0]);
    identity = '';
  }
  return identity;
}

const status = (e) => (e && e.$metadata && e.$metadata.httpStatusCode) || 0;

async function findRegion(t) {
  if (t.region) return t.region;
  try {
    const out = await client('us-east-1').send(new HeadBucketCommand({ Bucket: t.bucket }));
    if (out.BucketRegion) return out.BucketRegion;
  } catch (e) {
    const hdr = e && e.$response && e.$response.headers && e.$response.headers['x-amz-bucket-region'];
    if (hdr) return hdr;
    if (status(e) === 404) throw userError('The S3 bucket ' + t.bucket + ' was not found. Check the folder link.');
  }
  // Unknown: requests follow S3's region redirects, and links use the
  // endpoint that works for a bucket in any region.
  return '';
}

/**
 * Confirms the library can be saved here and opened by link. Returns the
 * target with its region filled in. Throws Error with a userMessage.
 */
async function checkTarget(link) {
  if (!configured()) throw userError('Saving to Amazon S3 is not set up on the capture service yet. Leave the Library Folder blank, or contact AaGeJa.');
  const t = parseLink(link);
  t.region = await findRegion(t);
  const who = await accountName();
  const folder = 's3://' + t.bucket + '/' + (t.prefix ? t.prefix + '/' : '');
  const key = (t.prefix ? t.prefix + '/' : '') + PROBE;
  try {
    await client(t.region).send(new PutObjectCommand({
      Bucket: t.bucket, Key: key, ContentType: 'text/plain; charset=utf-8', CacheControl: 'no-cache',
      Body: 'Written by the AaGeJa capture service to check it can save screenshots in this folder. It is replaced on every run and is safe to delete.\n',
    }));
  } catch (e) {
    const s = status(e);
    console.error('[s3] check write failed (' + s + '): ' + String(e && e.message || e).split('\n')[0]);
    if (s === 404) throw userError('The S3 bucket ' + t.bucket + ' was not found. Check the folder link.');
    if (s === 401 || s === 403) {
      throw userError('The capture service cannot add files to ' + folder + '. Ask your AWS administrator to let ' +
        (who || 'the AaGeJa capture user') + ' add files to this folder (s3:PutObject).');
    }
    throw userError('Amazon S3 could not be reached to check the folder. Try again in a moment.');
  }
  let r;
  try { r = await fetch(publicUrl(t, key), { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) }); } catch (_) {
    throw userError('Amazon S3 could not be reached to check the folder. Try again in a moment.');
  }
  try { await r.body?.cancel(); } catch (_) {}
  if (!r.ok) {
    throw userError('Files in ' + folder + ' cannot be opened without signing in. Storyboards and slide decks open the screenshots by link, so ask your AWS administrator to let anyone read files in this folder (s3:GetObject).');
  }
  return t;
}

/** The library.json already in the folder, read the way anyone would read it, or null. */
async function readLibrary(t) {
  const url = publicUrl(t, (t.prefix ? t.prefix + '/' : '') + 'library.json');
  const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
  // A missing file reads as 403 when anonymous readers cannot list the bucket.
  if (r.status === 404 || r.status === 403) { try { await r.body?.cancel(); } catch (_) {} return null; }
  if (!r.ok) throw Object.assign(new Error('S3 GET library.json returned ' + r.status), { status: r.status });
  try { return JSON.parse(await r.text()); } catch (_) { return null; }
}

/** @param {{path:string, content:Buffer, type:string}[]} files  paths are inside the folder. */
async function writeFiles(t, files) {
  for (const f of files) {
    await client(t.region).send(new PutObjectCommand({
      Bucket: t.bucket, Key: (t.prefix ? t.prefix + '/' : '') + f.path, Body: f.content,
      ContentType: f.type, CacheControl: 'no-cache',
    }));
  }
  return { written: files.length };
}

function saveError(e, t) {
  if (e && e.userMessage) return e.userMessage;
  const s = status(e) || (e && e.status);
  if (s === 401 || s === 403) return 'The capture service can no longer add files to s3://' + t.bucket + '/' + (t.prefix ? t.prefix + '/' : '') + '. Check it still has access.';
  return 'Amazon S3 did not accept the save. Try again in a moment.';
}

module.exports = { configured, isS3Link, parseLink, checkTarget, readLibrary, writeFiles, publicUrl, accountName, saveError, PROBE };
