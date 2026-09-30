# Preparing companion invitations

Selecting **Invite** reserves a place in the eight-copy party and immediately
starts memory configuration and connection setup. This works while the manager
or phone pauses simulation. **Preparing memory**, **Connecting**, and **Ready to
join** describe the actual preparation state. The copy is created only after both
prerequisites finish and normal gameplay resumes.

The phone and MCM use the same queue and capacity. Phone dismissal can cancel a
pending invitation. Changing a pending copy's conversation profile invalidates
the previous preparation before starting its replacement.

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
send the first F6 message. This Lua-only update uses **CET Reload All Mods**.

September 30 source verification: the full suite passed **983 checks**, with
zero failures or skips, including the installed MCM framework fixture. The new
modules also passed JavaScript syntax and Git whitespace checks. Live invite,
rendered settings and first-message timing acceptance remain pending.

Installation checkpoint: `9290ab3` was installed with the Lua-only installer and
all copied files passed SHA-256 comparison. The restarted bridge reported ready
memory, the same registry/identity anchor, one existing contacted character,
Convai voice mode and no startup errors. Cyberpunk was launched for the paused
Invite check. This confirms installation and service startup; the live checks
above still require the player's save and menu interaction.
