'use strict';
/**
 * Writes a screenshot library to a GitHub repository in ONE commit
 * (Git Data API: blobs -> tree -> commit -> move the branch).
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
  const ref = await gh('GET', '/repos/' + repo + '/git/ref/heads/' + branch, token);
  const baseSha = ref.object.sha;
  const base = await gh('GET', '/repos/' + repo + '/git/commits/' + baseSha, token);
  const tree = [];
  for (const f of files) {
    const blob = await gh('POST', '/repos/' + repo + '/git/blobs', token,
      { content: f.content.toString('base64'), encoding: 'base64' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh('POST', '/repos/' + repo + '/git/trees', token, { base_tree: base.tree.sha, tree });
  const commit = await gh('POST', '/repos/' + repo + '/git/commits', token,
    { message, tree: newTree.sha, parents: [baseSha] });
  await gh('PATCH', '/repos/' + repo + '/git/refs/heads/' + branch, token, { sha: commit.sha });
  return { commit: commit.sha };
}

module.exports = { commitFiles, readLibrary, rawUrl, treeUrl };
