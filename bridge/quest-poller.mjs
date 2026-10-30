// The bridge's side of the quest link's clock (docs/QUEST_PRIMITIVES.md section 4): runtime/quest-events.json is read every 500 ms, but only while a quest is active. With no quest
// there is no timer at all: it is created by `arm()` when `link.active()` is true and removed by the next `arm()` that finds it is not, so an idle service pays nothing.
// The one other case is the characters' reach-outs (section 10.7): while the link says 'reach' (reach-outs may fire and no quest runs) the events file is read every 10 seconds
// instead, to hear that the game delivered one. With nothing wanted there is no timer.
// `link` is a QuestLink (bridge/quest-link.mjs): poll() reads and handles the game's events, sync() writes the play file when the pack state changed, active() tells what is
// wanted: true (a quest, or an ending's closing rows, is waiting on the game), 'reach' (only reach-outs) or false.
export function createQuestPoller({link, intervalMs = 500, reachIntervalMs = 10000, setTimer = setInterval, clearTimer = clearInterval, stopped = () => false, onError = () => {}} = {}) {
  let timer = null, mode = null, polling = false;
  const report = error => { try { onError(error); } catch { /* a log never affects the link */ } };
  const poller = {
    /** True while the 500 ms timer (a quest) exists. */
    get armed() { return timer !== null && mode === 'quest'; },
    /** True while the slow timer (only reach-outs) exists. */
    get reachArmed() { return timer !== null && mode === 'reach'; },
    /** Starts the timer when a quest is active (500 ms) or only reach-outs are (10 s) and the service is running, stops it when not, changes its interval when the want changes. Idempotent. */
    arm() {
      let want = null;
      try { const active = stopped() ? false : link.active(); want = active === true ? 'quest' : active === 'reach' ? 'reach' : null; } catch (error) { report(error); }
      if (want !== mode && timer) { clearTimer(timer); timer = null; mode = null; }
      if (want && !timer) { timer = setTimer(() => { void poller.poll(); }, want === 'quest' ? intervalMs : reachIntervalMs); timer.unref?.(); mode = want; }
      return want !== null;
    },
    /** One poll: the game's events, then the play file. A poll still running is not started twice. */
    async poll() {
      if (polling || stopped()) return;
      polling = true;
      try { await link.poll(); await link.sync(); } catch (error) { report(error); }
      finally { polling = false; poller.arm(); }
    },
    /** The pack state may have changed: the play file follows it (a revision compare when it did not), and the timer follows the quest. Never throws, never awaited. */
    sync() {
      return Promise.resolve().then(() => link.sync()).catch(report).finally(() => poller.arm());
    },
    /** The service stops. */
    stop() { if (timer) { clearTimer(timer); timer = null; mode = null; } },
  };
  return poller;
}
