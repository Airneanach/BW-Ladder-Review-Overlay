import zlib from 'node:zlib';

const MAX_CHUNK = 0x2000;
const REPLAY_MAGIC_CLASSIC = 0x53526572; // 'reRS' as little-endian u32 (pre-Remastered replays)
const REPLAY_MAGIC_SCR = 0x53526573; // 'seRS' as little-endian u32 (SC:R replays)

function decodeBlock(buf, pos, expectedSize, label) {
  if (pos + 8 > buf.length) throw new Error(`replay truncated reading ${label} block header`);
  const numChunks = buf.readUInt32LE(pos + 4);
  pos += 8;
  const expectedChunks = Math.ceil(expectedSize / MAX_CHUNK);
  if (numChunks !== expectedChunks) {
    throw new Error(`${label}: expected ${expectedChunks} chunks, got ${numChunks}`);
  }
  const out = Buffer.alloc(expectedSize);
  let outPos = 0;
  for (let i = 0; i < numChunks; i++) {
    const remaining = expectedSize - outPos;
    const outSize = Math.min(remaining, MAX_CHUNK);
    if (pos + 4 > buf.length) throw new Error(`${label}: truncated chunk ${i} length`);
    const inSize = buf.readUInt32LE(pos);
    pos += 4;
    if (pos + inSize > buf.length) throw new Error(`${label}: truncated chunk ${i} data`);
    const raw = buf.subarray(pos, pos + inSize);
    pos += inSize;
    if (inSize === outSize) {
      raw.copy(out, outPos);
    } else {
      // SC:R replays use zlib/deflate for compressed chunks (classic pre-Remastered
      // replays used PKWARE implode instead, which is intentionally not supported here).
      const inflated = zlib.inflateSync(raw);
      if (inflated.length !== outSize) {
        throw new Error(`${label}: chunk ${i} inflated to ${inflated.length} bytes, expected ${outSize}`);
      }
      inflated.copy(out, outPos);
    }
    outPos += outSize;
  }
  return { data: out, pos };
}

/**
 * Decodes a StarCraft: Remastered replay file's container format into its raw,
 * decompressed sections. Does not interpret header fields or commands - that's left
 * to the consumer (the OpenBW-based simulator for header/commands, jssuh-derived
 * logic elsewhere for anything higher-level).
 *
 * Ported from the block format documented/implemented by ShieldBattery's jssuh
 * (https://github.com/ShieldBattery/jssuh, MIT licensed) and cross-validated byte-for-byte
 * against real SC:R replay files.
 */
export function decodeReplayContainer(fileBuffer) {
  let pos = 0;

  const magicBlock = decodeBlock(fileBuffer, pos, 4, 'magic');
  pos = magicBlock.pos;
  const magic = magicBlock.data.readUInt32LE(0);
  if (magic !== REPLAY_MAGIC_SCR) {
    if (magic === REPLAY_MAGIC_CLASSIC) {
      throw new Error('replay is in the classic pre-Remastered format, which is not supported');
    }
    throw new Error(`not a StarCraft replay file (bad magic ${magic.toString(16)})`);
  }

  // Raw (unwrapped) 4-byte offset into the file where SC:R extension sections
  // (skins, custom colors, etc.) begin. We don't need those, but must consume
  // the field to stay aligned with the rest of the stream.
  if (pos + 4 > fileBuffer.length) throw new Error('replay truncated reading scrOffset');
  pos += 4;

  const HEADER_SIZE = 0x279; // 633 bytes, fixed size per the replay format
  const header = decodeBlock(fileBuffer, pos, HEADER_SIZE, 'header');
  pos = header.pos;

  const cmdsSizeBlock = decodeBlock(fileBuffer, pos, 4, 'cmdsSize');
  pos = cmdsSizeBlock.pos;
  const cmdsSize = cmdsSizeBlock.data.readUInt32LE(0);
  const commands = decodeBlock(fileBuffer, pos, cmdsSize, 'commands');
  pos = commands.pos;

  const chkSizeBlock = decodeBlock(fileBuffer, pos, 4, 'chkSize');
  pos = chkSizeBlock.pos;
  const chkSize = chkSizeBlock.data.readUInt32LE(0);
  const chk = decodeBlock(fileBuffer, pos, chkSize, 'chk');
  pos = chk.pos;

  return {
    header: header.data,
    commands: commands.data,
    map: chk.data,
  };
}
