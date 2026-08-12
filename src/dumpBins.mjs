import fs from 'node:fs';
import path from 'node:path';
import { decodeReplayContainer } from './replayContainer.js';

const repPath = process.argv[2];
const outDir = process.argv[3];
const fileBuffer = fs.readFileSync(repPath);
const { header, commands, map } = decodeReplayContainer(fileBuffer);

fs.writeFileSync(path.join(outDir, 'header.bin'), header);
fs.writeFileSync(path.join(outDir, 'commands.bin'), commands);
fs.writeFileSync(path.join(outDir, 'map.bin'), map);
console.log('wrote header.bin, commands.bin, map.bin to', outDir);
