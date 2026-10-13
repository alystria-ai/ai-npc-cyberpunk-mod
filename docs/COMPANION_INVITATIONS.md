# Preparing companion invitations

Selecting **Invite** reserves a place in the eight-copy party and immediately
starts memory configuration and connection setup. This works while the manager
or phone pauses simulation. **Preparing memory**, **Connecting**, and **Ready to
join** describe the actual preparation state. The copy is created only after both
prerequisites finish and normal gameplay resumes.

The phone and MCM use the same queue and capacity. Phone dismissal can cancel a
pending invitation. The queue can still change a pending copy's conversation
profile (the manager no longer offers it); that invalidates the previous
preparation before starting its replacement.

## Duplicate copies

The same character or conversation profile can be in the party more than once.
Each copy has its own serial, actor and place; a copy's model and its
conversation profile are separate, so `companions.setProfile` changes only the
profile.

- **Current party** dismisses exactly the copy named by its row (`live:<serial>`).
  The other copies keep their actor, profile and seat.
- **Phone dismiss** names a character, not a copy. A copy belongs to the character
  it speaks as; a copy with no conversation profile belongs to its model. One
  request removes one copy, chosen newest first: pending invitations (the
  reservation is cancelled), then joined copies by serial. A copy already
  leaving is used only when nothing else matches, so pressing the key twice
  takes two different copies and a third press is harmless. A protected
  chauffeur driver yields to another copy of the same character, and is refused
  with the usual explanation only when it is the sole match.
- A Judy model reassigned to Panam answers to Panam on the phone, not to Judy.
  Phone Chat history and memory belong to the profile and never to a copy, so
  either copy can leave without changing them.
  Reassigning a copy while its private reply (text, voice, or an automatic comment)
  is still requested, streaming or playing retires exactly that reply: the game stops
  its audio, captions and facial animation and withdraws the request, so the bridge
  stops producing it. Replies of other copies, group rounds and other characters
  continue.
- Copies with the same profile share one prepared connection. It stays while any
  such copy remains, and is released only after the last one is gone.

## Memory and connection ownership

Preparation verifies the mod-owned character's provider memory setting. It uses
the existing persistent player ID and creates no conversation, explicit memory
record, or talked-to entry. The first actual player send records contact and
reuses this verification. Memory remains shared across saves and channels for
that player and character.

The identified private connection is opened after configuration is verified.
Its exact page and route remain retained while the engine attaches the copy and
after party membership takes over. Copies with the same conversation profile
share preparation and a private connection. Group scopes remain separately
owned; each submitted group audience still has its own context and session.

A raw game model without a conversation profile can join as a model-only
companion. An unknown assigned profile is an error; it does not silently become
a model-only companion. Configuration or connection failure keeps the invitation
pending with an error and never bypasses the spawn barrier on a timeout.

## Game and service boundary

- `mod/invitation-readiness.lua` publishes ephemeral reservation heartbeats and
  validates readiness receipts against the exact world, ticket, revision, model,
  and profile. Receipts must be fresh.
- `mod/manager-party.lua` owns reservations, cancellation and engine attachment.
  Gameplay flush is the only normal actor creation path.
- `mod/init.lua` pumps readiness and phone input even on zero-delta menu frames.
  `companions.canSpawn` guards the actual creation entry point against old menus
  or diagnostics bypassing preparation.
- `bridge/companion-invitations.mjs` owns memory and connection preparation.
  Provider completion alone cannot authorize a stale invitation.
- `bridge/party-connections.mjs` retains prepared private pages and prevents new
  background warm-up dispatch from competing with an active player request.

The files are `runtime/companion-invitations.json` and
`runtime/companion-invitations-state.json` in the installed CET mod. They carry
no API key or persistent player ID. Cancellation, profile reassignment, world
change, memory reset and service teardown fence obsolete completions. Connection
loss removes readiness. An earlier request file cannot replay an invitation in
a different Lua world.

Memory verification and transport disposal are acknowledged separately. If an
invitation is cancelled while shared verification finishes, the next invitation
or actual send still disposes any connection created before memory was enabled.
A busy route keeps that obligation pending without closing another character's
active conversation.

## What a preparing invitation waits for, and how a failure is worded

The bridge's receipt rows carry, for a profile invitation in the memory state, a `stage` (`queued` for its turn when more than eight are
preparing, `memory`, `voice`); the state `connecting` is her connection opening; an error row carries an `errorKind` (`voice`, `memory`,
`connection`, `capacity`, ...) next to its English `error`. All of it is descriptive and grants nothing: only a fresh `ready` receipt that
matches the exact ticket permits a spawn. `mod/invitation-readiness.lua` turns a receipt into `{state, wait}` (`wait` is `bridge` while no
fresh receipt matches: the service is still starting or busy loading its models; the last stage it reported stands while its receipts are
late). The service is silent for a failure only after a minute (`SERVICE_TIMEOUT`, counted from its last matching receipt, or from the
request when it never answered); before that the invitation simply waits. `mod/manager-party.lua` words the wait ("Preparing {name}: waiting
for the voice model to load…") and the failure by kind, and hands the wait lines to the held loading notice
(docs/NOTIFICATIONS.md); the spawn is never delayed by showing them.

## Latency evidence and verification

The earlier measured Convai reply took approximately 19.6 seconds to start:
memory admission consumed 8.9 seconds, connection lease waiting consumed 6.0
seconds, and first provider audio followed about 2.5 seconds after transport
acquisition. Those are observations of that turn, not guaranteed provider times.

The new sequence moves memory admission and cold connection work before actor
creation. Actual sends still measure admission, transport wait, first audio and
native playback onset. Provider generation and native playback can still add
delay after a prepared companion joins.

Run `npm run test:invitations` for queue, IPC, provider-memory and retained-page
fixtures. The tests use isolated local storage and fake provider/native actors;
they do not invoke production deletion or generate GPU audio. Source and fixture
success does not establish rendered game acceptance. The live check should
invite while the menu remains open, inspect preparation feedback, resume, and
send the first private text message using the player's assigned binding. This
Lua-only update uses **CET Reload All Mods**.

September 30 source verification: the full suite passed **983 checks**, with
zero failures or skips, including the installed MCM framework fixture. The new
modules also passed JavaScript syntax and Git whitespace checks. The user also
accepted the separate Memory page and its return to organized Settings. The
paused preparation labels and cancellation path have framework/fixture coverage;
their visible progression remains a separate optional live check.

Installation checkpoint: `9290ab3` was installed with the Lua-only installer and
all copied files passed SHA-256 comparison. The restarted bridge reported ready
memory, the same registry/identity anchor, one existing contacted character,
Convai voice mode and no startup errors. Cyberpunk was launched for the paused
Invite check.

The user then confirmed Judy joined **after closing the manager**. Her first F6
turn at 07:01:04 UTC reused both the retained browser page and the SDK connection.
Measured admission was 7.8 ms, transport queue waiting 0.073 ms, first provider
audio 2,999 ms and first playable chunk 4,066 ms after transport start. The native
playback position gave an estimated onset of **4,895 ms after submission**,
compared with the earlier 19,628 ms trace. The full reply was generated in 7,143
ms while its earlier chunks were already playing. These are individual observed
turns, not a controlled provider benchmark or an assurance for every response.
The safe timing summary is in ignored `runtime/invitation-latency-live.json`.

## Invitation preparation failures

Failed invitations retain their error until the player cancels/reinvites or
explicitly changes the selected profile. Missing or stale bridge receipts cannot
turn that same failed attempt back into preparation. The phone, manager and
world notification share one failure notice per attempt.

Failure notices are never hidden by Developer mode, but they are posted only in
gameplay. The shared claim (`claimPreparationFailure`) is taken by the first
gameplay reporter, which is now always the world flush (the manager sampler and the
phone's own failure line were folded into the notice board and never reach it first). A
failure first observed while the pause menu, phone or manager is open does not
take it; those only update the in-menu banner or list, and the notice is posted
once when gameplay resumes. A failure found while the invitation is created is
queued for gameplay in the same way, and the phone does not also post it while
it is open. Only joined and failures are posted as popups, in every mode. No preparing,
connecting, ready-to-join or joining text is posted at all, so a slow preparation
is never mistaken for a failure. The Current party list shows every stage, and the
dismissed notice needs Developer mode.

Invitations made together share one merged notice (`Judy and Johnny joined
your group.`, failures beside the successes). The claim rules above are unchanged: the notice board
(`queue.board()`, see `docs/MANAGER_UI.md`, "One merged notice for invitations made together") never takes
the failure claim; failures arrive as the queue's own gameplay outcome notices and are merged there.

Hanako's reported failure was followed by a read-only provider check confirming
the correct owned profile and enabled memory. The original exception had been
discarded, so its cause is unconfirmed. Preparation now preserves a bounded
diagnostic code and stage without exposing provider responses or identifiers.

After the October 4 CET reload, the user confirmed that Hanako joins. This
accepts the retry/spawn path. The earlier discarded cause remains unknown;
no additional failure was induced just to repeat the notification check.
