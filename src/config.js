// Resolves where StarCraft is, which replay to watch, and who the local player is.
//
// Precedence, loosest last: CLI flag > config.json beside the exe > autodetect.
// Everything is autodetectable except the player name, which nothing on the machine
// reliably reports - see resolvePlayerNames below.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sea from 'node:sea';
import { spawnSync } from 'node:child_process';

export const DEFAULT_PORT = 3712;

/**
 * The directory the user thinks of as "where the exe is". Under a SEA build
 * process.execPath IS the exe, so its dirname is right; under plain `node src/main.js`
 * execPath is node itself, so fall back to the project root.
 */
export function appDir() {
  if (sea.isSea()) return path.dirname(process.execPath);
  return process.cwd();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    // Accept both --key=value and --key value.
    const eq = arg.indexOf('=');
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = 'true';
  }
  return out;
}

function readConfigFile() {
  const file = path.join(appDir(), 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[config] Ignoring config.json - it is not valid JSON: ${err.message}`);
    return {};
  }
}

/**
 * StarCraft's install directory, needed because the simulator reads the real game data
 * (units.dat and friends) out of the installation's CASC storage.
 *
 * The registry is checked before the well-known paths: a player who installed to another
 * drive still has the registry key, and guessing wrong here fails late and confusingly
 * (the simulator errors deep inside CASC rather than saying "wrong folder").
 */
function detectInstallPath() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\StarCraft',
    'HKLM\\SOFTWARE\\Blizzard Entertainment\\StarCraft',
  ];
  for (const key of keys) {
    for (const value of ['InstallPath', 'GamePath']) {
      const res = spawnSync('reg', ['query', key, '/v', value], { encoding: 'utf8' });
      if (res.status !== 0 || !res.stdout) continue;
      const match = res.stdout.match(/REG_SZ\s+(.+)/);
      if (!match) continue;
      const dir = match[1].trim().replace(/[\\/]+$/, '');
      if (dir && fs.existsSync(dir)) return dir;
    }
  }
  const guesses = [
    'C:\\Program Files (x86)\\StarCraft',
    'C:\\Program Files\\StarCraft',
    'C:\\StarCraft',
  ];
  return guesses.find(dir => fs.existsSync(path.join(dir, 'Data'))) ?? null;
}

/**
 * SC:R overwrites this single file after every game rather than writing a uniquely
 * named one, which is exactly why it is the right thing to watch for ladder play.
 */
function detectLastReplayPath() {
  const candidates = [
    path.join(os.homedir(), 'Documents', 'StarCraft', 'Maps', 'Replays', 'LastReplay.rep'),
    path.join(os.homedir(), 'OneDrive', 'Documents', 'StarCraft', 'Maps', 'Replays', 'LastReplay.rep'),
  ];
  // Return the first that exists; failing that the first candidate anyway, so the
  // watcher can wait for the file to appear instead of refusing to start.
  return candidates.find(p => fs.existsSync(p)) ?? candidates[0];
}

/**
 * The one thing that cannot be autodetected. The replay records in-game account names,
 * and nothing on the machine reliably says which of them is the person watching - the
 * registry screen-name keys that used to exist are gone in Remastered, and picking the
 * host or slot 0 is wrong as often as it is right.
 *
 * Empty is a supported state, not a fatal error: the overlay still reports the match,
 * just without a win/loss or a grade, and the server logs the names it found so the
 * user can paste one into config.json.
 */
function resolvePlayerNames(raw) {
  if (Array.isArray(raw)) return raw.map(n => String(n).trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(n => n.trim()).filter(Boolean);
  return [];
}

export function loadConfig(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const file = readConfigFile();

  const installPath = flags.install ?? file.starcraftInstallPath ?? detectInstallPath();
  const lastReplayPath = flags.replay ?? file.lastReplayPath ?? detectLastReplayPath();
  const playerNames = resolvePlayerNames(
    flags.name ?? file.playerNames ?? file.myInGameNames ?? ''
  );
  const port = Number(flags.port ?? file.port ?? DEFAULT_PORT);

  return {
    installPath,
    lastReplayPath,
    playerNames,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    // Kept adjustable because it is the one real speed/detail tradeoff in the pipeline:
    // 24 frames is ~1 real-time second, which is what the grader's anchors were tuned on.
    sampleIntervalFrames: Number(flags.interval ?? file.sampleIntervalFrames ?? 24),
  };
}
