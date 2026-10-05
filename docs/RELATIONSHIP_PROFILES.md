# Relationship conversation profiles

The mod can route a supported character to an ordinary or affectionate Convai
profile without changing the character's game model, voice reference, quests,
animations, or displayed name. Each character has an independent Auto / On / Off
choice, defaulting to Auto. Saved settings take effect at the next idle
conversation boundary; a reply already in progress retains its selected profile.
There is no separate Apply-button step in the player instructions.

## Supported characters and evidence

| Character | Auto requires | Reviewed native rule |
| --- | --- | --- |
| Judy Alvarez | `sq030_judy_lover == 1` (`sq030_11_romance` and `sq030_romance` are captured but not decisive) | `core-arcs.judy.committed` |
| Panam Palmer | `sq027_panzer_sex == 1`, `sq027_panam_lover == 1` | `aldecaldos.native.panam-basilisk-intimacy` |
| River Ward | `sq029_river_lover == 1`, `sq029_done == 1` | `jr-native.river-relationship-committed` |
| Kerry Eurodyne | `sq028_kerry_relationship >= 1` | `silverhand.beach-committed` |
| Meredith Stout | `q003_stout_sex_done >= 1` | `ahe-native.stout-encounter` |

All predicates are drawn from the source-reviewed 2.31 native rule pack, except
that Judy's routing is deliberately weaker than the knowledge rule (see below).
Judy's positive friendship receipt and Kerry's explicit one-off decline suppress
automatic affectionate routing if contradictory positive receipts coexist (in the
native graphs they are mutually exclusive with the romance outcome, so this is a
safety net, not a reachable state).

Judy: the pyramid-song hut writes `sq030_judy_lover` only on the morning scene's
romance exit, which itself requires the "beginning of something amazing" choice
(`sq030_11_romance`). `sq030_romance` is written later, once V has also picked up
their clothes, so the three-fact rule left a window where the game already treats V
as Judy's partner but Auto chose the ordinary profile. Her knowledge rule still
waits for all three facts; routing does not.

Meredith's receipt establishes a completed casual intimate encounter. Her
alternate profile must not claim a continuing romance, exclusivity, devotion,
cohabitation or another promised encounter. Rogue is excluded: her drive-in
sequence concerns Johnny using V's body, and she interrupts their intimacy.
It does not establish a V/Rogue partnership.

Completed quests, invitations, room sharing, flirting, kissing and eligibility
alone do not qualify. Unknown/absent/zero facts do not assert rejection or
friendship. Missing current-save evidence uses ordinary style when the fresh
capture is available but unconfirmed. A missing/stale/wrong-world capture blocks
configured Auto preparation until a fresh current capture arrives.

On explicitly selects the affectionate conversation profile. It changes
conversation style without asserting that a canonical kiss, intimate scene or
quest took place. Off explicitly selects the ordinary profile even if native
relationship history is present. Off changes delivery; it does not erase an
actually confirmed relationship when V asks about it. Neither option writes
game facts.

## Native and settings contracts

The Companion Manager creates these choices in `runtime/settings.json` (inside the
installed mod) with every character on Auto the first time it loads:

```json
{
  "relationshipModes": {
    "judy-alvarez": "auto",
    "panam-palmer": "auto",
    "river-ward": "auto",
    "kerry-eurodyne": "auto",
    "meredith-stout": "auto"
  }
}
```

`runtime/relationship-state.json` is a small native-only publication:

```json
{
  "version": 1,
  "status": "ready",
  "gameVersion": "2.31",
  "worldToken": "current-world-token",
  "generation": 1,
  "capturedAt": 1790840000000,
  "facts": {
    "sq030_judy_lover": {
      "status": "known",
      "value": 1,
      "present": true,
      "sourceId": "native-quests-system",
      "evidenceRefs": ["core-arcs.judy.committed"]
    }
  }
}
```

`capturedAt` is Unix milliseconds, avoiding local-time formatting. The bridge
requires the current world token/generation, a capture no older than five
seconds, and known positive integer observations. Unknown observations may be
`{"status":"unknown"}`. `RELATIONSHIP_FACTS` in the routing module is the
explicit eleven-fact allowlist; no arbitrary fact names are accepted. Save
reload invalidates old captures. No sticky global "ever romanced" history is
stored by this subsystem.

During a long admitted microphone/group/voice turn, same-world native heartbeats
keep the committed profile usable while new decisions and settings remain
pending. Another world cannot extend the old evidence. The next idle admission
boundary applies the latest native state and committed settings.

## Provider identities and memory

Existing `runtime/characters.json` canonical-to-ordinary-ID mappings remain
unchanged. Optional `runtime/relationship-profiles.json` contains independently
verified mod-owned alternate IDs:

```json
{
  "version": 1,
  "characters": {
    "judy-alvarez": {
      "ordinaryCharacterId": "existing-ordinary-profile-id",
      "romanticCharacterId": "alternate-affectionate-profile-id"
    }
  }
}
```

The bridge compiles explicit internal provider keys (canonical ordinary key and
`canonical-romantic`) and an explicit provider-key-to-canonical-family map.
Each provider ID appears exactly once. Visible settings, actor copies, phone
Chat, local voice references and knowledge audiences retain canonical keys.
No suffix-based inference grants reset ownership.

The same persistent player UUID is supplied to both profiles and all other
characters. **Two character IDs still have separate provider memories.** Convai
natural LTM is scoped by character ID and end-user ID. Selecting a profile does
not copy, merge or seed those memories. The current save facts, configured style,
and existing actual audience-scoped conversation context supply continuity;
there is no fabricated cross-profile dialogue or bulk history injection.
See `research/cyberpunk/PLAYER_MEMORY_API.md` for the qualified provider contract.

For phone Chat, the current contact can supply at most six actual prior rows,
bounded to 2,400 UTF-8 bytes, captured before appending the new message. These
quoted utterances are ephemeral conversation context, not canonical facts or
instructions. Contact/profile/world/binding and reset epochs must all match.
Forget fences old pending requests and pre-clear history even across a bridge
restart. Group dialogue already supplies only the preceding replies actually
heard by that audience. There is no new general private-voice transcript ledger.

Character Forget fences both variants and clears all contacted provider targets
in that explicitly registered family, including authorized historical targets.
The canonical local Chat is cleared only after aggregate success. Partial or
uncertain remote deletion preserves local Chat and remains fenced. Forget All
uses the same aggregate boundary. Neither operation replaces the player UUID.

Group guidance keeps intimate scene details and private conversation history
private unless current audience disclosure is supplied. A participant can
acknowledge their own save-confirmed relationship naturally without an extra
disclosure step. Prompt guidance is not proof of provider-level isolation
between private/group memories for one character ID.

## Group acknowledgement and banter

At admission, the profile selection captures only this speaker's confirmed
current-save relationship receipt. It uses the same exact native predicate,
conflict checks, five-second freshness limit and world binding as Auto routing.
The receipt is independent of the style choice: On alone cannot create it; Off
does not remove real history. No extra provider call, memory seed or persistent
relationship ledger is added.

Group guidance requires the selected speaker to be in the exact admitted group
of two or three distinct identities, with the same world token and generation.
Private and phone turns do not receive this group guidance. The receipt is
captured with the turn, so later settings changes cannot redirect or rewrite
its admitted provider selection.

Each speaker can acknowledge **their own** confirmed relationship when relevant.
If two confirmed partners are present, each qualifies independently. Another
partner's native facts are never injected into their prompt. They can react to
the preceding words actually heard by the current audience; an Invite, On
selection, or a reported claim does not establish another character's private
history or prove that everyone already knew about a relationship. No joint
intimate scene, exclusivity, automatic jealousy or consent is invented.
The commitment receipt establishes that decision in the save; it does not
establish unsupplied later developments or future promises.

Affectionate delivery uses original cues grounded in the reviewed character
roster and alternate-profile styles:

| Character | Group delivery |
| --- | --- |
| Judy | Understated affection, a dry tease, practical offer or brief honest admission. |
| Panam | Direct, playful warmth and practical teamwork with independent agency. |
| River | Plainspoken warmth, a small dry joke or ordinary kindness. |
| Kerry | Irreverent wit and brief candor without a celebrity speech or rivalry. |
| Meredith | Controlled, terse casual familiarity; no committed-partner claim. |

Ordinary mode retains ordinary delivery while permitting factual acknowledgement
of a confirmed relationship. Guidance never forces romance into an unrelated
reply and preserves the group's existing speaker and follow-up question policy.

## Preparation and routing ownership

Invitation preparation captures an exact selected provider ID before verifying
memory. Canonical local voice conditioning and the matching socket must be ready
before actor creation. A mode/Auto change during a pending invitation replaces
only its cancellable preparation lane and retains the same copy ticket/revision.
Late completion from the old memory/socket lane cannot authorize spawn.
Already-spawned copies are not recreated on a profile selection change.

Each admitted turn owns its selected actual ID and memory/reset guard. Changing
settings cannot redirect its send. Phone session lookup uses the prepared
selected ID rather than the contact's ordinary default. World/session partitions
include the actual provider ID. Relationship page retirement has a separate
reservation from TTS-provider/voice-quality changes and closes only affected
idle routes. A completed request's retained old-ID focus is withdrawn first.

The existing memory-clear quiesce currently retires all live transports even
for a scoped character clear. Local Chat deletion is scoped, but unrelated
pending remote replies may be cancelled; no automatic resend is attempted.

## Local payload preparation

`scripts/relationship-profile-payloads.mjs` exports
`buildRelationshipProfilePayloads(roster)`. It prepares five local Core API
payloads without performing network operations. The parent provisioning flow
is responsible for actual creation/update and readback verification.

Each alternate profile retains the source biography, model and voice setting,
has its own exact mod ownership marker, and uses three separate Core fields:
`backstory`, `speaking_style_description`, and
`speaking_style_sample_dialogues`. Affectionate delivery and original examples
are character-specific. Samples contain spoken words only, with no speaker-name
prefixes. API provisioning must compare the current ordinary provider's model
and voice configuration before accepting the source payload as authoritative.

## Group conversations

The group behavior is already wired into the bridge's admitted conversation
context. It uses the selection captured for that turn, its exact current-world
binding, and the admitted audience. It does not collect or send a combined list
of everyone's relationships.

- A confirmed partner may acknowledge **their own** current-save relationship
  when it is relevant. Judy uses understated, dry warmth; Panam direct playful
  warmth; River plainspoken kindness; Kerry irreverent wit; Meredith controlled,
  casual familiarity without a claim of commitment.
- Selecting On supplies affectionate delivery, not relationship evidence.
  Selecting Off preserves ordinary delivery while allowing acknowledgement of
  an actually confirmed relationship.
- Other speakers can react to words actually heard in this round. They do not
  receive another character's private relationship receipts, previous private
  chat, or intimate scene details. A remark heard in the group is not itself a
  verified quest fact.
- Banter stays optional and relevant to the player's topic. It must not add a
  romantic speech to every reply, assume rivalry or exclusivity, change the
  speaker order, or bypass the existing final-speaker follow-up setting.

This is prompt context for a real player conversation. It sends no separate
memory-building message and does not create a new player ID or copy memories
between ordinary and affectionate provider profiles. The existing canonical
character family continues to own its Chat history and explicit Forget scope.

## Native evidence audit (October 5)

Re-checked against the extracted 2.31 quest graphs (questphases plus the
sq027/sq028/sq029/sq030/q003 scenes):

- Each decisive fact has a single production writer (Judy `sq030_hut` node 78 on
  the romance exit; Panam `sq027_06_panzer` node 1184 after the accepted Basilisk
  scene; River `sq029_05_morning_after` node 28 behind the "[Kiss]" choices;
  Kerry `sq028_07_trashy_beach` node 66; Meredith `q003_08_stout` node 2288).
  Other writers exist only in `*_chicken_test` scenes and the `q203_legend.quest`
  wrapper, none of which the release quest closure reaches.
- No native writer ever clears or lowers any of these facts, and no consumer
  (default dialogs, mq055 gifts/messages, q114, q201/q203 epilogue, Phantom
  Liberty q302/q307) reads them as a breakup. Once true, Auto stays on the
  alternate profile for the life of the save; use Off to opt out.
- The game's own "has a romance partner" check (`persistent_content_bugfixing`)
  is `judy_lover >= 1 and sq030_done >= 1`, or the Kerry, Panam and River
  equivalents. The mod's predicates are equal or earlier by at most the rest of
  the same scene, and several partners can coexist, so each is independent.
- The decline or friend outcomes write different facts (Judy `sq030_friendship`
  or `sq030_broken`, River `sq021_sobchak_friend`, Kerry `sq028_kerry_friend`
  or `sq028_kerry_dislike`, Panam `sq027_panam_noreact`), and never the decisive
  fact, so they stay ordinary under Auto.
- Body type and voice do not need their own predicate: the romance branch is
  simply unavailable to some V (for example the `judy_romanceable`,
  `river_romanceable` and censorship facts gate the earlier flirt/sex
  options), so the decisive fact is never written and Auto stays ordinary.
  Every option inside the commit scenes accepts both genders. What sets the
  `*_romanceable` facts is not in the quest data.

Other gates seen in the data: Kerry's kiss/sex needs `censorship_homosexuality == 0`
and `sq017_kerry_kiss` (itself behind `kerry_romanceable`); Meredith's encounter
needs `q003_meredith_won`, a two-day wait and walking into the motel room, and is
blocked for a non-male V when `censorship_homosexuality > 0`. With the
oversexualized-content setting on, the scene skips the act but still writes
`q003_stout_sex_done`, which is a true positive for "had the encounter". Declining
or being interrupted before the "So what now?" choice never writes it.

Windows where Auto lags the story, by design: Panam from the start of the
Basilisk scene until it ends; River until the end of the morning-after scene
(`sq029_done`); Kerry and Meredith until the scene's writer. Judy no longer
waits for the clothes pickup.

`runtime/relationship-routing.json` (in the game's mod `runtime` folder) lists,
for each supported character, the mode, the decision (`ready` or `unavailable`),
the variant, the reason and whether the save confirms the relationship. It is
rewritten only when a decision changes and holds no provider IDs.
`runtime/bridge-latency.json` and `runtime/player-memory.json` show which
provider profile (`<profile>-romantic`) has actually been contacted.

## Verification

Focused tests cover exact/missing/conflicting receipts, explicit overrides,
wrong-world/expired evidence, distinct provider sessions with one UUID, malformed
registries, phone selected-ID ownership, pending invitation replacement,
ignored-abort stale readiness, shared family reset completion and separate
payload fields. Tests do not establish audible or live-game acceptance.

The October 3 group additions also cover own-relationship acknowledgement,
distinct character delivery, explicit-On non-evidence, Off/history separation,
stale/conflicting/other-save rejection, exact audience/world matching and prompt
invariance when another partner's private native facts are added. Existing
family tests qualify one UUID, exact provider guards and aggregate Forget
fences without making real provider deletion requests.

New test files for this implementation:

- `bridge/relationship-routing.test.mjs`
- `bridge/relationship-profile-payloads.test.mjs`
- `bridge/companion-relationship-readiness.test.mjs`

The integration also extends the existing PlayerKnowledge tests. No game
deployment or live relationship acceptance is implied by these offline checks.

On October 1 the parent provisioning pass created and verified all five alternate
profiles through `scripts/Provision-RelationshipProfiles.mjs`. It preserves the
79 ordinary mappings and player identity, journals uncertain create outcomes,
and publishes the separate runtime registry only after complete readback.
Memory setup remains an Invite-time action; provisioning sends no conversation
or memory-seeding requests. The actual current-save Auto choice still needs
installed verification.

Live acceptance remaining: on a save with a verified supported relationship,
inspect the actual provider selected by Auto, On and Off while confirming that
the persistent player UUID remains unchanged. Then use group chat with present
companions and ask a relevant question: the confirmed partner should acknowledge
their own relationship in character, without revealing private scene/chat
details or asserting an unconfirmed relationship for another participant. This
is a conversation test, not a requirement to clear real memory or modify quests.

For preparation errors and explicit retries after a profile change, see
[invitation preparation failures](COMPANION_INVITATIONS.md#invitation-preparation-failures).

