'use strict';
/**
 * Writes a screenshot library to a GitHub repository in ONE commit
 * (Git Data API: blobs -> tree -> commit -> move the branch).
 *
 * The repository is the customer's: a public repository they add the capture
 * service's GitHub account to, with write access. checkTarget() confirms that
 * before anything is captured.
 *
 * Nothing is deleted. A file with the same path is replaced; every other
 * file in the folder is left as it was.
 */

const API = process.env.GITHUB_API_BASE || 'https://api.github.com';

async function gh(method, route, token, body) {
  const res = await fetch(API + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aageja-capture',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) {
    const err = new Error('GitHub ' + method + ' ' + route.split('?')[0] + ' returned ' + res.status + ': ' +
      ((json && json.message) || text.slice(0, 200)));
    err.status = res.status;
    throw err;
  }
  return json;
}

function checkRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('Repository must look like owner/name');
}
function checkBranch(branch) {
  if (!/^[A-Za-z0-9_.\/-]{1,100}$/.test(branch || '') || branch.includes('..')) throw new Error('Branch name is not valid');
}
const encPath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function rawUrl(repo, branch, filePath) {
  return 'https://raw.githubusercontent.com/' + repo + '/' + encPath(branch) + '/' + encPath(filePath);
}
function treeUrl(repo, branch, folder) {
  return 'https://github.com/' + repo + '/tree/' + encPath(branch) + (folder ? '/' + encPath(folder) : '');
}

let account = null;
/** The login of the account the token belongs to, for messages that name it. */
async function accountName(token) {
  if (account) return account;
  try { const u = await gh('GET', '/user', token); account = (u && u.login) || ''; } catch (_) { account = ''; }
  return account;
}

/**
 * Confirms the library can be saved here: the repository exists, is public,
 * the token can write to it, and the branch exists. Returns the branch to use
 * (the repository's default when none was given). Throws Error with a
 * userMessage the person running the agent can act on.
 */
async function checkTarget({ token, repo, branch }) {
  checkRepo(repo);
  const who = await accountName(token);
  const asWho = who ? ' Add the GitHub account ' + who + ' to the repository as a collaborator with write access.' : '';
  let info;
  try { info = await gh('GET', '/repos/' + repo, token); } catch (e) {
    if (e.status === 404) throw userError('The repository ' + repo + ' was not found, or the capture service cannot see it.' + asWho);
    if (e.status === 401) throw userError('The capture service could not sign in to GitHub. Its GitHub token has expired or been revoked.');
    throw userError('GitHub could not be reached to check the repository. Try again in a moment.');
  }
  if (info.private) throw userError('The repository ' + repo + ' is private. Use a public repository: storyboards and slide decks open the screenshots without signing in.');
  if (!info.permissions || !info.permissions.push) throw userError('The capture service can see ' + repo + ' but cannot write to it.' + asWho);
  const b = branch || info.default_branch || 'main';
  checkBranch(b);
  try { await gh('GET', '/repos/' + repo + '/git/ref/heads/' + encPath(b), token); } catch (e) {
    if (e.status === 404) throw userError('The repository ' + repo + ' has no branch named ' + b + '.');
    throw userError('GitHub could not be reached to check the repository. Try again in a moment.');
  }
  return b;
}

function userError(message) { const e = new Error(message); e.userMessage = message; return e; }

/** Returns the parsed library.json at <folder>/library.json, or null if there is none. */
async function readLibrary({ token, repo, branch, folder }) {
  checkRepo(repo); checkBranch(branch);
  const p = (folder ? folder + '/' : '') + 'library.json';
  try {
    const item = await gh('GET', '/repos/' + repo + '/contents/' + encPath(p) + '?ref=' + encodeURIComponent(branch), token);
    if (!item || !item.content) return null;
    return JSON.parse(Buffer.from(item.content, 'base64').toString('utf8'));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * @param {{token:string, repo:string, branch:string, files:{path:string, content:Buffer}[], message:string}} o
 * @returns {Promise<{commit:string}>}
 */
async function commitFiles({ token, repo, branch, files, message }) {
  checkRepo(repo); checkBranch(branch);
  if (!files.length) throw new Error('Nothing to write');
  const tree = [];
  for (const f of files) {
    const blob = await gh('POST', '/repos/' + repo + '/git/blobs', token,
      { content: f.content.toString('base64'), encoding: 'base64' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  // If someone else commits to the branch while this one is written, the
  // branch cannot be moved; build the commit again on top of theirs, once.
  for (let attempt = 1; ; attempt++) {
    const ref = await gh('GET', '/repos/' + repo + '/git/ref/heads/' + encPath(branch), token);
    const baseSha = ref.object.sha;
    const base = await gh('GET', '/repos/' + repo + '/git/commits/' + baseSha, token);
    const newTree = await gh('POST', '/repos/' + repo + '/git/trees', token, { base_tree: base.tree.sha, tree });
    const commit = await gh('POST', '/repos/' + repo + '/git/commits', token,
      { message, tree: newTree.sha, parents: [baseSha] });
    try {
      await gh('PATCH', '/repos/' + repo + '/git/refs/heads/' + encPath(branch), token, { sha: commit.sha });
      return { commit: commit.sha };
    } catch (e) {
      if (e.status === 422 && attempt < 2) continue;
      throw e;
    }
  }
}

/** A message the person running the agent can act on, for an error from GitHub during a save. */
function saveError(e, repo) {
  if (e && e.userMessage) return e.userMessage;
  const s = e && e.status;
  if (s === 401) return 'The capture service could not sign in to GitHub. Its GitHub token has expired or been revoked.';
  if (s === 403 || s === 404) return 'The capture service can no longer write to ' + repo + '. Check it still has write access to the repository.';
  if (s === 409 || s === 422) return 'The library folder changed while it was being saved. Run the agent again.';
  return 'GitHub did not accept the save. Try again in a moment.';
}

module.exports = { commitFiles, readLibrary, checkTarget, accountName, saveError, rawUrl, treeUrl };
