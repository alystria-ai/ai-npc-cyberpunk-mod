import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

// How old a heartbeat may be and still be a current world, how old one may be on a voice turn that is running, and how long a late heartbeat
// is still taken for the same world rather than a gone one (see lateWorld).
export const WORLD_LEASE_MS = 5000;
export const MIC_LEASE_MS = 30000;
export const LATE_WORLD_LIMIT_MS = 120000;

// CET rewrites the heartbeat in place, so a read can land on a half-written file (or, on an old
// install, in the gap of a remove and rename). Retry that short unreadable interval, never an explicit
// world transition. An empty file is the shipped placeholder, "no session yet", and returns at once, unless
// the previous poll held a ready session (held): then an empty read may be the instant between CET's truncate
// and its write, so it gets one short retry before it counts as a world change.
// No previous-world lease is extended or substituted after failure.
// `lapse` (optional object): a heartbeat that reads fine but is older than the lease is still refused (null), and is handed back in lapse.value so the
// caller can tell a game that is only late from a world that is gone.
export async function readWorldSession(path, {read = readFile, wait = delay, now = Date.now, held = false, lapse = null} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await read(path, 'utf8');
      if (typeof raw === 'string' && raw.trim() === '') {
        if (!held || attempt > 0) return null;
        await wait(15); continue;
      }
      const value = JSON.parse(raw);
      const current = now();
      const valid = value?.version === 1 && typeof value.token === 'string' && value.token.length <= 200
        && Number.isSafeInteger(value.generation) && value.generation > 0 && typeof value.ready === 'boolean'
        && Number.isFinite(value.updated) && value.updated <= current + 1000;
      if (valid && current - value.updated >= WORLD_LEASE_MS) { if (lapse) lapse.value = value; return null; }
      return valid ? value : null;
    } catch (error) {
      if (attempt === 2 || (error?.code !== 'ENOENT' && !(error instanceof SyntaxError))) return null;
      await wait(15);
    }
  }
  return null;
}

const worldKey = session => session?.ready === true ? JSON.stringify([session.token, session.generation]) : null;
export { worldKey };

// A game that stalls (a long freeze, a pause, a process the system suspended) stops rewriting its heartbeat for a while. The file still names the world the bridge
// was following, only late: that is not a world change, and resetting every route and cancelling the player's voice turn for it (live 2026-10-24: a 5 s and a
// 17 s stall each cancelled a turn) is wrong. Returns the late heartbeat when it is the same ready world as `prior` and not older than LATE_WORLD_LIMIT_MS, else null.
// The caller keeps it as the world, so every ordinary check (WORLD_LEASE_MS) still refuses it until the game writes again.
export function lateWorld(late, prior, now = Date.now()) {
  if (!late || !prior || late.ready !== true || prior.ready !== true) return null;
  if (late.token !== prior.token || late.generation !== prior.generation) return null;
  return now - late.updated < LATE_WORLD_LIMIT_MS ? late : null;
}

// The world a check should accept: a ready heartbeat younger than the lease. A voice turn that is running (`voiceTurn`) tolerates a stalled game for MIC_LEASE_MS,
// so a stall in the middle of a recording does not end it; everything else keeps the short lease.
export function worldBoundary(session, voiceTurn = false, now = Date.now()) {
  return session?.ready === true && now - session.updated < (voiceTurn ? MIC_LEASE_MS : WORLD_LEASE_MS)
    ? {worldToken: session.token, generation: session.generation} : null;
}
