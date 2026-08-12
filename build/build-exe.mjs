// Builds dist/BWLadderReview.exe - a Node single-executable application (SEA).
//
// Four steps, in order:
//   1. esbuild bundles src/main.js and everything it imports into one CommonJS file.
//      SEA takes a single script and has no module resolver, so the bundle step is not
//      optional - and bundling is also why the runtime code avoids npm dependencies.
//   2. `node --experimental-sea-config` turns that bundle plus the assets (the overlay
//      page and bwstats.exe) into a blob.
//   3. A copy of this machine's node.exe becomes the output exe.
//   4. postject injects the blob into that copy.
//
// The result is ~110MB because the whole Node runtime is inside it. That is the cost of
// shipping one file with no install step; see README.md.
//
// Usage: node build/build-exe.mjs   (or: npm run build:exe)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const distDir = path.join(root, 'dist');
const bundlePath = path.join(buildDir, 'bundle.cjs');
const blobPath = path.join(buildDir, 'sea-prep.blob');
const seaConfigPath = path.join(buildDir, 'sea-config.json');
const exePath = path.join(distDir, 'BWLadderReview.exe');
const bwstatsPath = path.join(root, 'native', 'bwstats.exe');
const overlayPath = path.join(root, 'web', 'bw-ladder-review-overlay.html');

/**
 * Runs a Node script with this same Node, without a shell.
 *
 * No shell on purpose: the tools live at paths containing spaces ("C:\Program Files\
 * nodejs\node.exe"), which cmd truncates unless every argument is hand-quoted, and passing
 * unescaped args through a shell is deprecated in Node anyway (DEP0190). Invoking the
 * tools' own JS entry points directly sidesteps both, and avoids depending on npx.
 */
function run(label, scriptPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit', cwd: root, ...opts,
  });
  if (res.status !== 0) {
    console.error(`\n[build] ${label} failed (exit ${res.status}).`);
    process.exit(1);
  }
}

// The simulator must already be built: it gets embedded, so a missing or stale one would
// produce an exe that cannot review anything.
if (!fs.existsSync(bwstatsPath)) {
  console.error(`[build] Missing ${path.relative(root, bwstatsPath)}. Run native\\build-stats.bat first.`);
  process.exit(1);
}
if (!fs.existsSync(overlayPath)) {
  console.error(`[build] Missing ${path.relative(root, overlayPath)}.`);
  process.exit(1);
}

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

console.log('[build] 1/4 bundling...');
run('esbuild', path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
  'src/main.js',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  // Matching the Node that will host the bundle; nothing here needs downlevelling.
  '--target=node20',
  // src/main.js reads import.meta.url to locate the overlay page and bwstats.exe when
  // running from source. In this CJS bundle import.meta is empty - harmless, because the
  // bundle only ever runs inside the SEA, where isSea() is true and those branches are not
  // taken (the assets come out of the blob instead). Silenced rather than left as a
  // standing warning on every build; if a future change reads import.meta outside an
  // isSea() guard, drop this flag to surface it again.
  '--log-override:empty-import-meta=silent',
  `--outfile=${path.relative(root, bundlePath)}`,
]);

console.log('[build] 2/4 generating the SEA blob...');
fs.writeFileSync(seaConfigPath, JSON.stringify({
  main: path.relative(root, bundlePath).replace(/\\/g, '/'),
  output: path.relative(root, blobPath).replace(/\\/g, '/'),
  // The two files the app needs at runtime but cannot bundle into JS: the overlay page is
  // served verbatim, and bwstats.exe is a native binary that has to be spawned.
  assets: {
    'overlay.html': path.relative(root, overlayPath).replace(/\\/g, '/'),
    'bwstats.exe': path.relative(root, bwstatsPath).replace(/\\/g, '/'),
  },
  // Off deliberately: a startup snapshot would be faster to boot but forbids the
  // top-level work main.js does (opening a socket, reading config), and boot time is
  // irrelevant for something a caster starts once per session.
  useSnapshot: false,
  useCodeCache: true,
}, null, 2) + '\n');
// Not via run(): this one is a Node flag, not a script.
{
  const res = spawnSync(process.execPath, ['--experimental-sea-config', path.relative(root, seaConfigPath)],
    { stdio: 'inherit', cwd: root });
  if (res.status !== 0) {
    console.error(`\n[build] sea-config failed (exit ${res.status}).`);
    process.exit(1);
  }
}

console.log('[build] 3/4 copying the Node runtime...');
fs.copyFileSync(process.execPath, exePath);

// The official Node build for Windows is Authenticode-signed. Injecting a blob
// invalidates that signature, and leaving a broken one behind is worse than shipping none:
// postject says "signature seems corrupted", and Windows reports a tampered binary rather
// than merely an unsigned one. So strip it before injecting.
//
// signtool ships with the Windows SDK and is not on PATH by default, so it gets located
// rather than assumed - the previous version of this script called it bare, silently
// failed to find it, and produced exactly the corrupted-signature build described above.
function findSigntool() {
  // where.exe is a real executable, so no shell is needed (and passing args through one is
  // deprecated - DEP0190).
  if (spawnSync('where', ['signtool']).status === 0) return 'signtool';
  const sdkBin = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(sdkBin)) return null;
  // Newest SDK first - any of them can strip a signature, but an ancient one is more
  // likely to predate something in the PE layout.
  const versions = fs.readdirSync(sdkBin)
    .filter(name => /^10\./.test(name))
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = path.join(sdkBin, version, 'x64', 'signtool.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const signtoolPath = findSigntool();
if (!signtoolPath) {
  console.warn('[build]     WARNING: signtool not found (install the Windows SDK). The exe will');
  console.warn('[build]              carry an invalid signature inherited from node.exe.');
} else {
  const res = spawnSync(signtoolPath, ['remove', '/s', exePath], { encoding: 'utf8' });
  if (res.status === 0) console.log('[build]     stripped the inherited Node signature');
  else console.warn(`[build]     WARNING: could not strip the Node signature: ${(res.stderr || res.stdout || '').trim()}`);
}

console.log('[build] 4/4 injecting...');
run('postject', path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), [
  path.relative(root, exePath),
  'NODE_SEA_BLOB', path.relative(root, blobPath),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log(`\n[build] Done: ${path.relative(root, exePath)} (${sizeMb} MB)`);
