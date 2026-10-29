// The bridge's side of the quest link's clock (docs/QUEST_PRIMITIVES.md section 4): runtime/quest-events.json is read every 500 ms, but only while a quest is active. With no quest
// there is no timer at all: it is created by `arm()` when `link.active()` is true and removed by the next `arm()` that finds it is not, so an idle service pays nothing.
// `link` is a QuestLink (bridge/quest-link.mjs): poll() reads and handles the game's events, sync() writes the play file when the pack state changed, active() tells whether a
// quest (or an ending's closing rows) is waiting on the game.
export function createQuestPoller({link, intervalMs = 500, setTimer = setInterval, clearTimer = clearInterval, stopped = () => false, onError = () => {}} = {}) {
  let timer = null, polling = false;
  const report = error => { try { onError(error); } catch { /* a log never affects the link */ } };
  const poller = {
    /** True while the 500 ms timer exists. */
    get armed() { return timer !== null; },
    /** Starts the timer when a quest is active and the service is running, stops it when not. Idempotent. */
    arm() {
      let wanted = false;
      try { wanted = !stopped() && link.active() === true; } catch (error) { report(error); }
      if (wanted && !timer) { timer = setTimer(() => { void poller.poll(); }, intervalMs); timer.unref?.(); }
      else if (!wanted && timer) { clearTimer(timer); timer = null; }
      return wanted;
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
    stop() { if (timer) { clearTimer(timer); timer = null; } },
  };
  return poller;
}
