# Relationship conversation profiles

The mod can route a supported character to an ordinary or affectionate Convai
profile without changing the character's game model, voice reference, quests,
animations, or displayed name. Each character has an independent Auto / On / Off
choice, defaulting to Auto. MCM drafts do not affect routing until Apply.

## Supported characters and evidence

| Character | Auto requires | Reviewed native rule |
| --- | --- | --- |
| Judy Alvarez | `sq030_11_romance == 1`, `sq030_judy_lover == 1`, `sq030_romance == 1` | `core-arcs.judy.committed` |
| Panam Palmer | `sq027_panzer_sex == 1`, `sq027_panam_lover == 1` | `aldecaldos.native.panam-basilisk-intimacy` |
| River Ward | `sq029_river_lover == 1`, `sq029_done == 1` | `jr-native.river-relationship-committed` |
| Kerry Eurodyne | `sq028_kerry_relationship >= 1` | `silverhand.beach-committed` |
| Meredith Stout | `q003_stout_sex_done >= 1` | `ahe-native.stout-encounter` |

All predicates are drawn from the source-reviewed 2.31 native rule pack. Judy's
positive friendship receipt and Kerry's explicit one-off decline suppress
automatic affectionate routing if contradictory positive receipts coexist.

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

Committed `runtime/settings.json` includes:

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
