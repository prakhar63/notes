// Publishes the app's source code to GitHub as `main`, minus the private files.
// Usage: node tools/publish-source.mjs            (build and push)
//        node tools/publish-source.mjs --dry-run  (list what would be published)
//
// Local `main` keeps its full history, private files included, and is never pushed.
// Instead this builds a snapshot commit of the last local commit without PRIVATE,
// on a local branch `public`, each snapshot on top of the previous one, and pushes
// that branch to GitHub's `main`. Uncommitted edits are not published.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRIVATE = ['PRD.docx', 'CLAUDE.md', 'docs/'];
const BRANCH = 'public';
const REMOTE_BRANCH = 'main';
const dryRun = process.argv.includes('--dry-run');

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
const isPrivate = (path) => PRIVATE.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

const head = git(['rev-parse', '--short', 'HEAD']);
const subject = git(['log', '-1', '--format=%s', 'HEAD']);
const all = git(['ls-tree', '-r', 'HEAD']).split('\n').filter(Boolean);
const files = all.filter((line) => !isPrivate(line.split('\t')[1]));
const left = all.length - files.length;

const dirty = git(['status', '--porcelain']);
if (dirty) console.warn(`Note: uncommitted changes will NOT be published:\n${dirty}\n`);

if (dryRun) {
  console.log(files.map((l) => l.split('\t')[1]).join('\n'));
  console.log(`\n${files.length} files would be published; ${left} private files left out.`);
  process.exit(0);
}

// Build the tree in a throwaway index so the real one is untouched.
const tmp = mkdtempSync(join(tmpdir(), 'notes-source-'));
const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
try {
  git(['read-tree', '--empty'], { env });
  for (const line of files) {
    const [meta, path] = line.split('\t');
    const [mode, , sha] = meta.split(' ');
    git(['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`], { env });
  }
  const tree = git(['write-tree'], { env });

  // Last guard: nothing private may be in the tree.
  const published = git(['ls-tree', '-r', '--name-only', tree]).split('\n');
  const leak = published.filter(isPrivate);
  if (leak.length) throw new Error(`Refusing to publish private files: ${leak.join(', ')}`);

  let parent = null;
  try { parent = git(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]); } catch { /* first publish */ }
  if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log(`Nothing new to publish (source matches ${BRANCH}).`);
  } else {
    const args = ['commit-tree', tree, '-m', `${subject}\n\nSnapshot of ${head}.`];
    if (parent) args.push('-p', parent);
    const commit = git(args);
    git(['update-ref', `refs/heads/${BRANCH}`, commit]);
    console.log(`Built ${BRANCH} ${commit.slice(0, 7)} from ${head} (${files.length} files, ${left} private left out).`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

execFileSync('git', ['push', 'origin', `${BRANCH}:${REMOTE_BRANCH}`], { stdio: 'inherit' });
console.log(`Pushed to GitHub ${REMOTE_BRANCH}.`);
