// Walks the raw (already decompressed) BW command stream to find specific events -
// currently just "Leave Game", which is how we determine win/loss (see below).
//
// This needs a full per-action byte-length table to correctly skip over every action
// type it doesn't care about, since actions are packed back-to-back with no per-record
// delimiter. The table below (and the "each length includes the action id byte" and
// "extended commands are the same unit id width as classic, just with 2 extra padding
// bytes" conventions) is ported from ShieldBattery's jssuh
// (https://github.com/ShieldBattery/jssuh, MIT), and cross-validated during development
// by simulating full real games through the OpenBW-based engine (bw-companion/native)
// without a single byte misalignment across ~16,000 frames.

const saveLength = data => {
  if (data.length < 5) return null;
  const pos = data.indexOf(0, 5);
  return 1 + (pos === -1 ? data.length : pos);
};
const selectLength = data => {
  if (data.length < 1) return null;
  return 2 + data.readUInt8(0) * 2;
};
const extSelectLength = data => {
  if (data.length < 1) return null;
  return 2 + data.readUInt8(0) * 4;
};
const c = len => () => len;

// Each entry returns the total command length INCLUDING the action id byte, given the
// bytes that follow the action id.
const CMD_LENGTH = {
  0x05: c(1), // KEEP_ALIVE
  0x06: saveLength, // SAVE
  0x07: saveLength, // LOAD
  0x08: c(1), // RESTART
  0x09: selectLength, // SELECT
  0x0a: selectLength, // SELECTION_ADD
  0x0b: selectLength, // SELECTION_REMOVE
  0x0c: c(8), // BUILD
  0x0d: c(3), // VISION
  0x0e: c(5), // ALLIANCE
  0x0f: c(2), // GAME_SPEED
  0x10: c(1), // PAUSE
  0x11: c(1), // RESUME
  0x12: c(5), // CHEAT
  0x13: c(3), // HOTKEY
  0x14: c(10), // RIGHT_CLICK
  0x15: c(11), // TARGETED_ORDER
  0x18: c(1), // CANCEL_BUILD
  0x19: c(1), // CANCEL_MORPH
  0x1a: c(2), // STOP
  0x1b: c(1), // CARRIER_STOP
  0x1c: c(1), // REAVER_STOP
  0x1d: c(1), // ORDER_NOTHING
  0x1e: c(2), // RETURN_CARGO
  0x1f: c(3), // TRAIN
  0x20: c(3), // CANCEL_TRAIN
  0x21: c(2), // CLOAK
  0x22: c(2), // DECLOAK
  0x23: c(3), // UNIT_MORPH
  0x25: c(2), // UNSIEGE
  0x26: c(2), // SIEGE
  0x27: c(1), // TRAIN_FIGHTER
  0x28: c(2), // UNLOAD_ALL
  0x29: c(3), // UNLOAD
  0x2a: c(1), // MERGE_ARCHON
  0x2b: c(2), // HOLD_POSITION
  0x2c: c(2), // BURROW
  0x2d: c(2), // UNBURROW
  0x2e: c(1), // CANCEL_NUKE
  0x2f: c(5), // LIFTOFF
  0x30: c(2), // TECH
  0x31: c(1), // CANCEL_TECH
  0x32: c(2), // UPGRADE
  0x33: c(1), // CANCEL_UPGRADE
  0x34: c(1), // CANCEL_ADDON
  0x35: c(3), // BUILDING_MORPH
  0x36: c(1), // STIM
  0x37: c(7), // SYNC
  0x38: c(1), // VOICE_ENABLE1
  0x39: c(1), // VOICE_ENABLE2
  0x3a: c(2), // VOICE_SQUELCH1
  0x3b: c(2), // VOICE_SQUELCH2
  0x3c: c(1), // START_GAME
  0x3d: c(2), // DOWNLOAD_PERCENTAGE
  0x3e: c(6), // CHANGE_GAME_SLOT
  0x3f: c(8), // NEW_NET_PLAYER
  0x40: c(18), // JOINED_GAME
  0x41: c(3), // CHANGE_RACE
  0x42: c(2), // TEAM_GAME_TEAM
  0x43: c(2), // UMS_TEAM
  0x44: c(3), // MELEE_TEAM
  0x45: c(3), // SWAP_PLAYERS
  0x48: c(13), // SAVED_DATA
  0x54: c(1), // BRIEFING_START
  0x55: c(2), // LATENCY
  0x56: c(10), // REPLAY_SPEED
  0x57: c(2), // LEAVE_GAME
  0x58: c(5), // MINIMAP_PING
  0x5a: c(1), // MERGE_DARK_ARCHON
  0x5b: c(1), // MAKE_GAME_PUBLIC
  0x5c: c(82), // CHAT
  0x5f: c(2), // SET_TURN_RATE
  0x60: c(0xc), // RIGHT_CLICK_EXT
  0x61: c(0xd), // TARGETED_ORDER_EXT
  0x62: c(5), // UNLOAD_EXT
  0x63: extSelectLength, // SELECT_EXT
  0x64: extSelectLength, // SELECTION_ADD_EXT
  0x65: extSelectLength, // SELECTION_REMOVE_EXT
  0x66: c(4), // NEW_NETWORK_SPEED
};

const FRAME_TO_MS = 42;

/**
 * Walks the full decompressed command stream once, calling `onCommand({ frame,
 * playerId, actionId, rest })` for every action - `rest` is the action's bytes after
 * the action id, `playerId` is the raw in-replay player id (matches the header's `id`
 * field, not necessarily a 0-based slot index; see computeMatchStats.js for how that
 * gets resolved to a slot). Shared by findLeaveGameEvents and findChatEvents below so
 * the byte-length table only has to be walked correctly in one place.
 */
export function walkCommands(commands, onCommand) {
  let pos = 0;
  while (pos < commands.length) {
    const frame = commands.readInt32LE(pos);
    pos += 4;
    const actionsSize = commands.readUInt8(pos);
    pos += 1;
    const blockEnd = pos + actionsSize;
    while (pos < blockEnd) {
      const playerId = commands.readUInt8(pos);
      const actionId = commands.readUInt8(pos + 1);
      const rest = commands.subarray(pos + 2, blockEnd);
      const lengthFn = CMD_LENGTH[actionId];
      if (!lengthFn) {
        throw new Error(`walkCommands: unknown action id ${actionId} at frame ${frame}`);
      }
      const totalLen = lengthFn(rest);
      if (totalLen == null) {
        throw new Error(`walkCommands: could not determine length of action ${actionId} at frame ${frame}`);
      }
      onCommand({ frame, playerId, actionId, rest });
      pos += 1 + totalLen; // +1 for the player id byte; totalLen already includes the action id byte
      if (pos > blockEnd) {
        throw new Error(`walkCommands: overran frame block (pos ${pos} > blockEnd ${blockEnd}) at frame ${frame}, action ${actionId}`);
      }
    }
  }
  if (pos !== commands.length) {
    throw new Error(`walkCommands: did not consume the full command stream (stopped at ${pos}, buffer is ${commands.length} bytes) - parser likely has a gap`);
  }
}

/**
 * Returns every "Leave Game" event, in the order they occur, as { frame, playerId,
 * reasonCode }. `playerId` is the raw in-replay player id (matches the `id` field of
 * players from the header, not necessarily a 0-based slot index).
 */
export function findLeaveGameEvents(commands) {
  const events = [];
  walkCommands(commands, ({ frame, playerId, actionId, rest }) => {
    if (actionId === 0x57) {
      events.push({ frame, playerId, reasonCode: rest.readInt8(0), timeSeconds: (frame * FRAME_TO_MS) / 1000 });
    }
  });
  return events;
}

// Commands that aren't a player playing: network/lobby bookkeeping, the periodic
// keep-alive/sync heartbeats, and chat. Everything else - including selections and
// hotkeys, which is what makes BW APM numbers as high as they are - counts as an
// action, matching how screp and the community's APM figures are computed.
const NON_ACTION_COMMANDS = new Set([
  0x05, // KEEP_ALIVE
  0x37, // SYNC
  0x3c, // START_GAME
  0x3d, // DOWNLOAD_PERCENTAGE
  0x3e, // CHANGE_GAME_SLOT
  0x3f, // NEW_NET_PLAYER
  0x40, // JOINED_GAME
  0x41, // CHANGE_RACE
  0x42, // TEAM_GAME_TEAM
  0x43, // UMS_TEAM
  0x44, // MELEE_TEAM
  0x45, // SWAP_PLAYERS
  0x48, // SAVED_DATA
  0x54, // BRIEFING_START
  0x55, // LATENCY
  0x56, // REPLAY_SPEED
  0x5b, // MAKE_GAME_PUBLIC
  0x5c, // CHAT
  0x5f, // SET_TURN_RATE
  0x66, // NEW_NETWORK_SPEED
]);

// How close together two identical commands have to be for the second to count as
// spam rather than a decision. 24 frames is one second of game time.
const REPEAT_WINDOW_FRAMES = 24;

/**
 * Counts gameplay actions per raw in-replay player id (the same id findLeaveGameEvents
 * reports - resolve it to a slot the same way, see computeMatchStats.js). Returns a Map
 * of playerId -> { actions, effectiveActions, lastActionFrame }; dividing by elapsed
 * time gives APM and EAPM respectively.
 *
 * `effectiveActions` drops repeats: the same command issued again, unchanged, within a
 * second. In practice that is almost entirely hotkey and selection spam - the habit of
 * hammering `1` between real decisions - which on this project's own replays is over
 * half of all commands, and which inflates raw APM without reflecting anything the
 * player actually did. Commands are compared on their action id plus the first few
 * payload bytes, so re-selecting the *same* group is spam while switching to a
 * different one is not.
 *
 * `lastActionFrame` exists because the replay's own frame count is not always the length
 * of the game a player actually played: a player who leaves early stops issuing commands
 * while the recording runs on. Dividing their action count by the full replay length
 * would understate their APM, so callers cap the divisor with this.
 */
export function countActionsByPlayerId(commands) {
  const byPlayer = new Map();
  walkCommands(commands, ({ frame, playerId, actionId, rest }) => {
    if (NON_ACTION_COMMANDS.has(actionId)) return;
    const entry = byPlayer.get(playerId)
      || { actions: 0, effectiveActions: 0, lastActionFrame: 0, lastKey: null, lastKeyFrame: -Infinity };
    entry.actions++;
    const key = `${actionId}:${rest.subarray(0, 4).toString('hex')}`;
    if (key !== entry.lastKey || frame - entry.lastKeyFrame > REPEAT_WINDOW_FRAMES) {
      entry.effectiveActions++;
    }
    entry.lastKey = key;
    entry.lastKeyFrame = frame;
    if (frame > entry.lastActionFrame) entry.lastActionFrame = frame;
    byPlayer.set(playerId, entry);
  });
  return byPlayer;
}

/**
 * Returns every chat message, in the order they occur, as { frame, senderSlot, text,
 * timeSeconds }. Unlike every other command, CHAT's sender is NOT the outer per-command
 * `playerId` byte - it's the first byte of the command's own payload, which is the
 * sender's 0-based SLOT index (matches the header's per-slot player table order, i.e.
 * the same "slot" computeMatchStats.js reports players under - not the raw player id).
 * This was confirmed empirically: on a real replay where the in-game chat log showed
 * two distinctly-attributed "gg"/"GG" lines from two different players, the outer
 * envelope `playerId` byte was identical (and wrong) for both recorded CHAT commands,
 * while the payload's first byte correctly matched each sender's actual slot index for
 * both messages - cross-checked further against a second replay where the payload-byte
 * sender's chat ("gg") matched the player who was independently confirmed (via
 * victory_state) to have lost that game, consistent with normal "loser says gg first"
 * etiquette. The remaining payload bytes are the message text, null-terminated within
 * the fixed 81-byte-after-action-id CHAT command length.
 */
export function findChatEvents(commands) {
  const events = [];
  walkCommands(commands, ({ frame, actionId, rest }) => {
    if (actionId === 0x5c) {
      const senderSlot = rest.readUInt8(0);
      const nullIdx = rest.indexOf(0, 1);
      const text = rest.subarray(1, nullIdx === -1 ? rest.length : nullIdx).toString('utf8');
      events.push({ frame, senderSlot, text, timeSeconds: (frame * FRAME_TO_MS) / 1000 });
    }
  });
  return events;
}
