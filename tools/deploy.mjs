// Publishes the app to GitHub Pages.
// Usage: node tools/deploy.mjs
//
// Builds a `gh-pages` commit containing ONLY the site files, taken from the
// last commit on the current branch (uncommitted edits are not published),
// and pushes just that branch to `origin`. (The source code goes to GitHub
// separately, without the private files: tools/publish-source.mjs.)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = ['index.html', 'styles.css', 'app.js', 'store.js', 'lists.js', 'blocks.js', 'images.js', 'sync.js', 'vendor', 'sw.js', 'manifest.webmanifest', 'icons'];
const BRANCH = 'gh-pages';

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();

const dirty = git(['status', '--porcelain', '--', ...SITE]);
if (dirty) {
  console.warn(`Note: these uncommitted changes will NOT be published:\n${dirty}\n`);
}

const head = git(['rev-parse', '--short', 'HEAD']);
const files = git(['ls-tree', '-r', 'HEAD', '--', ...SITE]).split('\n').filter(Boolean);
if (!files.some((line) => line.endsWith('\tindex.html'))) throw new Error('index.html is not committed');

// Build the tree in a throwaway index so the real one is untouched.
const tmp = mkdtempSync(join(tmpdir(), 'notes-deploy-'));
const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
try {
  // The service worker's VERSION is a fingerprint of the site files, so any
  // change to the app makes browsers install it as one fresh, complete set.
  const version = createHash('sha1').update(files.filter((l) => !l.endsWith('\tsw.js')).join('\n')).digest('hex').slice(0, 10);

  git(['read-tree', '--empty'], { env });
  for (const line of files) {
    const [meta, path] = line.split('\t');
    let [mode, , sha] = meta.split(' ');
    if (path === 'sw.js') {
      const src = git(['cat-file', '-p', sha]);
      const stamped = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
      if (stamped === src) throw new Error('sw.js: VERSION line not found');
      sha = git(['hash-object', '-w', '--stdin'], { input: stamped + '\n' });
    }
    git(['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`], { env });
  }
  console.log(`App version ${version}.`);
  // .nojekyll: serve files as-is, no Jekyll processing.
  const empty = git(['hash-object', '-w', '--stdin'], { input: '' });
  git(['update-index', '--add', '--cacheinfo', `100644,${empty},.nojekyll`], { env });
  const tree = git(['write-tree'], { env });

  let parent = null;
  try { parent = git(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]); } catch { /* first deploy */ }
  if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log(`Nothing new to publish (site files match ${BRANCH}).`);
  } else {
    const args = ['commit-tree', tree, '-m', `Deploy ${head}`];
    if (parent) args.push('-p', parent);
    const commit = git(args);
    git(['update-ref', `refs/heads/${BRANCH}`, commit]);
    console.log(`Built ${BRANCH} ${commit.slice(0, 7)} from ${head}.`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

execFileSync('git', ['push', 'origin', `${BRANCH}:${BRANCH}`], { stdio: 'inherit' });
console.log('Pushed. GitHub Pages updates in about a minute.');
