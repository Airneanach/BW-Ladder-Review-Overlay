// Finding StarCraft and the replay file, shared by the GUI and the CLI.
//
// Split out of config.js so the GUI can offer the same guesses as pre-filled, editable
// values without also inheriting the CLI's config-file and argv handling.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_PORT = 3712;

/**
 * StarCraft's install directory, needed because the simulator reads real game data (units.dat
 * and friends) out of the installation's CASC storage.
 *
 * The registry is checked before the well-known paths: someone who installed to another drive
 * still has the registry key, and guessing wrong fails late and confusingly - deep inside
 * CASC rather than saying "wrong folder".
 */
export function detectInstallPath() {
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
 * SC:R overwrites this single file after every game rather than writing a uniquely named one,
 * which is exactly why it is the right thing to watch for ladder play.
 */
export function detectLastReplayPath() {
  const candidates = [
    path.join(os.homedir(), 'Documents', 'StarCraft', 'Maps', 'Replays', 'LastReplay.rep'),
    path.join(os.homedir(), 'OneDrive', 'Documents', 'StarCraft', 'Maps', 'Replays', 'LastReplay.rep'),
  ];
  // The first that exists; failing that the first candidate anyway, so a watcher can wait for
  // the file to appear rather than refusing to start.
  return candidates.find(p => fs.existsSync(p)) ?? candidates[0];
}
