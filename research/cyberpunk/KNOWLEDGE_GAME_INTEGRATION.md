# Game adapter knowledge integration

`mod/init.lua` constructs the identity coordinator and two read-only collectors
without reading native systems at module load or `onInit`. The existing attached,
alive, non-pregame check enables collection in `onUpdate`. The reviewed collector
loads the installed `world-knowledge.json` once and requires the exact live
`GetGameVersion()` value; an absent, malformed, oversized or incompatible pack
leaves reviewed facts unavailable. The general journal collector is independent.
Each collector retains its existing bounded work and observation-age limits.

The coordinator's read-consistent `snapshot()` supplies native generation,
activation/branch token and user binding together. Both collectors use that same
plain envelope, and a second inspection after native reads or per-send capture
discards a changed world. Request `generation` remains the conversation counter;
it is never substituted for native load generation. A known native world without
a verified user binding supplies dynamic facts with unknown identity. Shared
resident templates and groups containing them also retain unknown identity.

When the optional native identity component is absent, a separate Lua lifecycle
scope supports dynamic context and anonymous transport isolation. Its token uses
a per-CET nonce and local teardown counter; it is not a campaign, branch, save or
memory identity. `runtime/world-session.json` publishes
`{version:1, token, generation, ready, updated}` with a heartbeat. Explicit
detach/death/unavailability rotates this scope and publishes `ready:false`
before releasing actor references. A brief native `paused/save-in-progress`
snapshot retains the exact native token while preventing new capture/send work.

Private text, automatic battle/loot turns, group preparation and actual group
dispatch receive new `worldKnowledge` and `journalHistory` snapshots. Audience is
the exact private profile or current group listener list. Dispatch recaptures
even when group preparation exists; a changed input can therefore invalidate
speculative generation instead of reusing stale facts. Existing battle, loot,
tracked-journal and heard-conversation fields retain their own ownership.

Microphone start and finish independently capture fresh context. Recording owns
the original world token plus local teardown guard. A different world cancels the
recording; autosave defers a requested finish until a fresh same-world capture is
possible. The bridge must use the validated finish command's input, preserving
its original request guard, rather than its retained start-time context.

The phone receives `captureBinding`, `captureWorldKnowledge`,
`captureJournalHistory` and `onDelivered` through `configure` options. Its two
knowledge callbacks share one captured bundle, with another world check before
returning history. Phone code separately recaptures the binding before publishing
the request. Delivery never obtains a new identity: the accepted reply hook
retains the original request's generation/token and phone binding.

`runtime/knowledge-phone-delivery.json` contains
`{version:1, updated, receipts:[...]}`. At most 16 deduplicated plain receipts are
retained, with request/profile/contact identifiers, phone world/binding, original
world generation/token, completion ID/sequence/time and
`source:'phone-ui', state:'accepted', partial:false, cancelled:false`. It contains
no transcript or native handles. Lua performs no ledger or cloud-memory call;
the bridge validates its original request guard before recording activity.

`abandonSession` and shutdown invalidate knowledge before NPC/native cleanup.
Changed native activation/branch tokens cancel pending conversation work without
dismissing managed actors. `convaiKnowledgeState` and `convaiWorldKnowledge`
expose the existing coordinator/collector for read-only diagnostics.

Verification uses the actual Lua adapter, microphone and group modules with
controlled native/file boundaries, plus real collector implementations. It covers
inert startup, exact version/audience/generation, bounded collection, expiration,
anonymous reload isolation, mid-capture races, teardown ordering, autosave,
phone receipts and microphone refresh/cancellation. These checks do not establish
installed native save persistence, audible delivery or cloud-memory qualification.

## Deployment boundary

`scripts/Install-DevelopmentMod.ps1` explicitly includes the four knowledge Lua
modules, the routed read-only knowledge probe and the reviewed artifact at
`characters/world-knowledge.json`. This artifact is copied to the adapter root as
`world-knowledge.json`; research output alone does not update the installed game.
The native `KnowledgeState.reds` component remains excluded from both normal and
Lua-only installs while quarantined. These source changes support anonymous
current-world context without qualifying durable identity. Installation and CET
reload are separate, explicitly performed steps.

Focused checks are available as `npm run test:knowledge`,
`npm run test:streaming` and `npm run test:research`; `npm test` retains its previous
coverage and includes the new Node suites. The public-source collector's isolated
Python tests are available as `npm run test:research:sources`.
