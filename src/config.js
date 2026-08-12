// Config for the console entry point (src/main.js).
//
// Precedence, loosest last: CLI flag > config.json in the working directory > autodetect.
// The GUI does not use this - it keeps its settings in Electron's userData and shares only
// the autodetection in detect.js.

import fs from 'node:fs';
import path from 'node:path';

import { detectInstallPath, detectLastReplayPath, DEFAULT_PORT } from './detect.js';

export { DEFAULT_PORT };

/** Where a CLI run looks for config.json and writes its match history. */
export function appDir() {
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
 * The one thing that cannot be autodetected. Replays record in-game account names, and nothing
 * on the machine reliably says which of them is the person playing - the registry screen-name
 * keys that used to exist are gone in Remastered, and picking the host or slot 0 is wrong as
 * often as it is right.
 *
 * Empty is supported, not fatal: the match is still recorded, just without a win/loss or grade.
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
  const playerNames = resolvePlayerNames(flags.name ?? file.playerNames ?? file.myInGameNames ?? '');
  const port = Number(flags.port ?? file.port ?? DEFAULT_PORT);

  return {
    installPath,
    lastReplayPath,
    playerNames,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    // Adjustable because it is the one real speed/detail tradeoff in the pipeline: 24 frames is
    // about one real-time second, which is what the grader's anchors were tuned on.
    sampleIntervalFrames: Number(flags.interval ?? file.sampleIntervalFrames ?? 24),
  };
}
