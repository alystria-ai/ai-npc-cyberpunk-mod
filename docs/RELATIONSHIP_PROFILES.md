# Relationship conversations

A supported character (Judy, Panam, River, Kerry, Meredith) has **one** Convai
profile, the same one for every conversation, and an independent Auto / On / Off
choice, defaulting to Auto. The choice does not select a profile. It decides
whether one short paragraph, the *relationship block*, is added to the dynamic
context of that turn: affectionate delivery when it is, the ordinary note when it
is not. The character's game model, voice reference, quests, animations and
displayed name are untouched, and so is the Convai profile ID.

Until 2026-10-09 each of the five had a second, affectionate Convai profile (and a
Multilingual twin of it) that Auto/On selected. Convai's long-term memory is scoped
per character ID, so everything V said to Judy in her affectionate profile was
unknown to her ordinary profile and the other way round. With one profile there is
one continuous memory. How the block was measured against the old profiles is in
[ROMANCE_DYNAMIC_CONTEXT.md](ROMANCE_DYNAMIC_CONTEXT.md).

Saved settings take effect at the next idle conversation boundary; a reply already
in progress keeps the style it was admitted with. There is no separate
Apply-button step in the player instructions.

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
affectionate delivery must not claim a continuing romance, exclusivity, devotion,
cohabitation or another promised encounter. Rogue is excluded: her drive-in
sequence concerns Johnny using V's body, and she interrupts their intimacy.
It does not establish a V/Rogue partnership.

Completed quests, invitations, room sharing, flirting, kissing and eligibility
alone do not qualify. Unknown/absent/zero facts do not assert rejection or
friendship. Missing current-save evidence gives ordinary delivery. If the capture
is missing, stale or from another world, Auto is simply ordinary for that turn
(`reason: relationship-state-unavailable`); the conversation is never held up, and
the next turn follows the capture once a fresh one arrives. (Before 2026-10-09 this
blocked the turn, because the choice also chose the provider ID.)

On makes the delivery affectionate. It changes style without asserting that a
canonical kiss, intimate scene or quest took place. Off makes the delivery ordinary
even if native relationship history is present. Off changes delivery; it does not
erase an actually confirmed relationship: if V asks, the character acknowledges it
plainly and in her ordinary voice. Neither option writes game facts.

## The relationship block

`bridge/romance-context.mjs` builds the block from the selection frozen when the
turn was admitted (`relationshipContext(selection, channel, options)`). It is pure:
no I/O, no state, no request of its own, and no per-frame work anywhere. It fills
the same slot in the per-turn dynamic context that the old relationship note did,
after vendor memory and before the phone, natural-speech and
multilingual blocks, so it adds no request, timer or Lua code.

| Style | What the turn gets | Size |
| --- | --- | --- |
| Affectionate (Auto confirmed, or On) | the verified fact (or, for On, a statement that this is a delivery choice and proves no event); a per-character cue in the character's own manner; how to use it; limits | about 1.7 to 1.9 KB |
| Ordinary, nothing confirmed | "use your ordinary conversation style; do not assume a romance" | about 0.2 KB |
| Ordinary, relationship confirmed (Off, or no fresh capture of a confirmed save) | the same, plus: the save confirms your own relationship with V, keep your usual manner, never mention that your manner was chosen, acknowledge it plainly and honestly if asked | about 0.6 KB |

The cues are original guidance distilled from each character's reviewed biography
and speaking style, not sample lines:

| Character | Affectionate delivery |
| --- | --- |
| Judy | Understated: a dry tease, a practical offer, one honest admission that costs her something; she keeps her independence. |
| Panam | Direct and playful: teases, pushes V to rest, worry comes out sharp before soft; keeps her pride and her Aldecaldos. |
| River | Quiet, earnest, a little awkward: ordinary kindness, a small joke at his own expense, one plain sentence of care. |
| Kerry | Flirting by habit: vain little teases, compliments disguised as complaints, then one short unguarded sentence; no speeches. |
| Meredith | Her manner does not warm. A casual, knowing familiarity: a dry remark, an admission that the night was good. No consoling, no tenderness. |

The shared rules, all kept deliberately short:

- Affection colors the reply and shows most when the moment is personal; a
  practical or unrelated question is answered in the ordinary voice first, with
  at most a few words of warmth.
- Sincerity is answered first, in the character's own words, never with a boast,
  a dismissal or a joke at V's expense.
- Never add a declaration, a pet name or a romantic speech unprompted; do not
  invent shared scenes, dates, gifts or promises; affection is not consent to a
  new intimate act.
- Meredith: never a partner, exclusivity, devotion or a promised second encounter.

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

`runtime/characters.json` maps each canonical character to its one Convai ID.
Optional `runtime/multilingual-profiles.json` adds the Multilingual twin of a
profile (see [MULTILINGUAL_PROFILES.md](MULTILINGUAL_PROFILES.md)). Those are the
only two provider IDs a character can have, and the Auto / On / Off choice never
moves a conversation between them: only the language of the player's message
does. Visible settings, actor copies, phone Chat, local voice references and
knowledge audiences all use the canonical key.

An old `runtime/relationship-profiles.json` (the five alternate IDs) is no longer
read, and `<key>-romantic` rows of `runtime/multilingual-profiles.json` are ignored.
The bridge lists no `-romantic` provider key, so Forget, the memory page and the
support report never see one. `scripts/Delete-RetiredRomanceProfiles.mjs` removes
the retired Convai characters themselves (below).

The same persistent player UUID is supplied to every profile. Convai natural LTM is
scoped by character ID and end-user ID, so with one profile per character there is
one memory for V and that character, whatever the setting. A Multilingual twin is a
separate Convai character and still has its own memory. See
`research/cyberpunk/PLAYER_MEMORY_API.md` for the qualified provider contract.

Memories that exist only in a retired romantic profile (V's conversations with it)
do not move to the ordinary profile; nothing is copied or seeded. The current save
facts, the configured style and the ordinary profile's own memory supply
continuity. `runtime/player-memory.json` may still hold durable rows for retired
keys: they stay in the file as history, are not listed and are not cleared.

For phone Chat, the current contact can supply at most six actual prior rows,
bounded to 2,400 UTF-8 bytes, captured before appending the new message. These
quoted utterances are ephemeral conversation context, not canonical facts or
instructions. Contact/profile/world/binding and reset epochs must all match.
Forget fences old pending requests and pre-clear history even across a bridge
restart. Group dialogue already supplies only the preceding replies actually
heard by that audience. There is no new general private-voice transcript ledger.

Character Forget fences the character and clears every contacted live provider
target in its family (the profile and its twin), including authorized historical
targets. The canonical local Chat is cleared only after aggregate success. Partial
or uncertain remote deletion preserves local Chat and remains fenced. Forget All
uses the same aggregate boundary. Neither operation replaces the player UUID.

Group guidance keeps intimate scene details and private conversation history
private unless current audience disclosure is supplied. A participant can
acknowledge their own save-confirmed relationship naturally without an extra
disclosure step. Prompt guidance is not proof of provider-level isolation
between private/group memories for one character ID.

## Group acknowledgement and banter

At admission, the selection captures only this speaker's confirmed current-save
relationship receipt. It uses the same exact native predicate, conflict checks,
five-second freshness limit and world binding as Auto. The receipt is independent
of the style choice: On alone cannot create it; Off does not remove real history.
No extra provider call, memory seed or persistent relationship ledger is added.

Group guidance requires the selected speaker to be in the exact admitted group of
two or three distinct identities, with the same world token and generation.
Private and phone turns do not receive it. The receipt is captured with the turn,
so later settings changes cannot rewrite its admitted selection.

- Each speaker can acknowledge **their own** confirmed relationship when relevant.
  If two confirmed partners are present, each qualifies independently. Another
  partner's native facts are never injected into their prompt.
- Speakers can react to the preceding words actually heard by the current
  audience; an Invite, an On selection or a reported claim does not establish
  another character's private history or prove that everyone already knew.
- No joint intimate scene, exclusivity, automatic jealousy or consent is invented.
  The commitment receipt establishes that decision in the save; it does not
  establish unsupplied later developments or future promises.
- Affectionate delivery in a group uses short per-character wording (Judy
  understated, Panam direct and playful, River plainspoken, Kerry irreverent with
  a brief candid softening, Meredith controlled with casual familiarity and never a
  committed-partner claim). Ordinary delivery keeps the factual acknowledgement
  and no affectionate cue.
- Banter stays optional and relevant to the player's topic. It must not add a
  romantic speech to every reply, assume rivalry or exclusivity, change the
  speaker order.

This is prompt context for a real player conversation. It sends no separate
memory-building message and does not create a new player ID.

## Invitations and routing ownership

Invitation preparation captures the exact provider ID (the profile, or its twin
when the player's language calls for it) before verifying memory. Canonical local
voice conditioning and the matching socket must be ready before actor creation.
Because the Auto / On / Off choice does not change the provider ID, changing it
during a pending invitation no longer replaces or restarts anything; only a
language switch does. Already-spawned copies are never recreated by a style
change.

Each admitted turn owns its selected ID, its frozen style and its memory/reset
guard. Changing settings cannot redirect its send or rewrite its block. Phone
session lookup uses the prepared selected ID. World/session partitions include the
actual provider ID. Only a language switch retires idle routes (a style change
retires nothing); a completed request's retained old-ID focus is withdrawn first.

The existing memory-clear quiesce currently retires all live transports even
for a scoped character clear. Local Chat deletion is scoped, but unrelated
pending remote replies may be cancelled; no automatic resend is attempted.

## Retiring the old Convai characters

`node scripts/Delete-RetiredRomanceProfiles.mjs` with no argument only prints the
plan (ten characters: the five alternate profiles and their five Multilingual
twins, with the IDs taken from `runtime/relationship-profiles.json` and the
`<key>-romantic` rows of `runtime/multilingual-profiles.json`) and makes no
request. `--verify` asks Convai for each one (read-only) and checks the mod
ownership marker; `--apply` verifies all of them first, then deletes them one by
one and tidies the two local files. Deleting a Convai character also deletes its
long-term memories of every user. Nothing in the bridge depends on the deletion
having run.

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
  Liberty q302/q307) reads them as a breakup. Once true, Auto stays
  affectionate for the life of the save; use Off to opt out.
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
the `style` (`romantic` or `ordinary`), the reason and whether the save confirms
the relationship. It is rewritten only when a decision changes and holds no
provider IDs. (Older files call the style `variant`; the support report reads both.)
`runtime/bridge-latency.json` and `runtime/player-memory.json` show which provider
profile has actually been contacted.

## Verification

Focused tests cover exact/missing/conflicting receipts, explicit overrides,
wrong-world and expired evidence (ordinary, never blocked), one provider ID and
session across every style, an ignored old `relationship-profiles.json`, retired
rows in the memory registry, phone selected-ID ownership, the block text per
character, Meredith's limits, group receipts and the Forget family:

- `bridge/romance-context.test.mjs`
- `bridge/relationship-routing.test.mjs`
- `bridge/relationship-channels.test.mjs`
- `bridge/companion-relationship-readiness.test.mjs`
- `bridge/player-memory-families.test.mjs`, `bridge/player-knowledge.test.mjs`,
  `bridge/support-report.test.mjs`

These do not establish audible or live-game acceptance. The quality of the block
itself was measured against the old profiles with real Convai replies, scored
blind: see [ROMANCE_DYNAMIC_CONTEXT.md](ROMANCE_DYNAMIC_CONTEXT.md).

Live acceptance remaining: on a save with a verified supported relationship,
confirm in the game that Auto, On and Off change only the delivery (the same
character, voice and memory every time). Then use group chat with present
companions and ask a relevant question: the confirmed partner should acknowledge
their own relationship in character, without revealing private scene/chat
details or asserting an unconfirmed relationship for another participant. This
is a conversation test, not a requirement to clear real memory or modify quests.

For preparation errors and explicit retries after a profile change, see
[invitation preparation failures](COMPANION_INVITATIONS.md#invitation-preparation-failures).
