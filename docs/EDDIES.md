# Eddies with characters

Branch `feat/eddies` (2026-10-28). **Settings > Companion behavior > Eddies with characters**, off by default. It moves to the Gameplay section once that exists
(another branch adds it); the setting key `characterEddies` stays the same.

Money between V and the characters, the lore-friendly way: every character has money of their own as their story has it, V can borrow from them and lend
to them both ways, pay back and be paid back, by voice or by text, and every transfer asks V first with the game's own Yes/No pop-up. What a character does
follows their lore and how V stands with them now.

## Why this is not "Pay characters in eddies" again

"Pay characters in eddies" (docs removed in commit bbde2e8a, 26 Oct) was removed because it did not work in the owner's live test: "I pay you 500 eddies"
left no trace at all. Its design made that hard to see and easy to break:

* one direction only (V pays), typed lines only, and the amount had to pass a 15-language grammar before anything happened;
* the money moved **without asking**, so every rule had to be a hard gate (the lease, the mailbox shared with the drive and follow actions, the offer
  echoed exactly), and any gate that said no said nothing;
* nothing on screen showed that the feature had even looked at the line.

This design keeps what was right (the amount never comes from the model; the game checks the balance, the cap and ownership again, and reads the balance
back) and changes the rest:

* **V always confirms.** The bridge only proposes; the game shows a pop-up and moves nothing without Yes. That makes a voice turn safe too, and a
  wrong reading of V's words costs one "No", not money.
* **Its own small file and its own short watch** (`runtime/eddies-offer.json`), not the action mailbox and its lease.
* **A log line at every step**: the bridge's `[Eddies] profile=... own=... trust=... words:borrow:500 propose=loanToV:500` (or `unheard`, `about`,
  `heard=...`), the game's `Eddies: proposal person=... flow=... amount=...` and `Eddies: person=... flow=... amount=... result=done|declined|missed|failed`.

## What the player sees

* Talk about money with one of your own characters (party member, invited visitor, housemate): "can you lend me 500?", "here, take 300 eddies",
  "I'll lend you a grand", "here's the 500 I owe you", "pay me back". The character answers in their own way, and when the reply is over and you are
  free (no menu, scene, fight or text box), the pop-up asks: "Judy offers to lend you 500 eddies. Take the loan?" Yes moves the eddies with the game's
  own eddies notification; No moves nothing, and the character remembers it.
* Characters remember what is owed, both ways, and say so ("V owes you 600 eddies"). They will not lend more while V owes them much.
* Now and then a character with needs in their story asks **you** for a loan, briefly ("You need 300 eddies for motorcycle repairs"), at most once per
  session and once every three days.
* A character the game placed (story Judy in her flat) and ordinary NPCs only **talk** about money: nothing moves with them.

## The money data (`bridge/eddies-finances.mjs`)

One row per roster character (all 128 profiles) and per ordinary NPC group (40 archetypes, `npc-<base>`): `tier` (broke to rich), `cash` (what they could
lay hands on when they first deal with V), `generosity` (0 to 1), `asks` (never / rarely / sometimes), `repays` (always / usually / late / rarely), `style`
(one second-person sentence of how they handle money) and `needs` (what they might borrow for). Written from each profile text and Cyberpunk 2077 lore:
Johnny (an engram) and Alt have no wallet, Hanako and Arthur Jenkins are rich and never ask, Jackie and Paco are tight and pay late.
`bridge/eddies.test.mjs` checks every profile and archetype has a well-formed row.

A character's purse: the data's cash, varied by a per-character seed made at first contact (0.8 to 1.2 times), plus what V gave or lent them minus what
they paid out, which fades back to their usual means with a half-life of 7 days.

## How a character decides (`bridge/eddies.mjs`)

Trust, 0 to 1: 0.3, plus how V stands with them in the game (housemate +0.2, party +0.15, invited visitor +0.1), the relationship the save confirms or
the player turned on (bridge/relationship-routing.mjs: partner +0.3, casual +0.1), how long they have known V in this feature (+0.005 a day, at most +0.15),
and V's record (paid back before +0.1, owes now -0.15, said no to their ask -0.05).

* **V asks to borrow**: the most they lend is 60% of their purse times generosity times (0.5 + trust), at most 100,000. Within it: yes. Above it: they
  offer what they can (when that is at least a quarter of what V asked). No wallet, broke, no trust, or V owes them more than 30% of their purse: no,
  with the reason, in their own words.
* **V gives or lends**: accepted if V has the eddies (V's balance comes with the turn), the sum is named, and they are not a rich character who never
  asks (they turn it down).
* **V pays back**: up to what V owes. **V asks for money back**: they pay what they can (all, or part and say when the rest comes); a late or rare payer
  asks for time when the loan is less than a day old.
* **The character's own move** (typed turns only, never in the same turn as V's money talk): pay V back when they have it and repay "always" or
  "usually" (30% of turns after a day), or ask V for a loan for one of their needs (4% / 8% of turns by `asks`, only with trust 0.5 or more, never while
  V owes them, cooldown 3 days, once per bridge session).

The decision is told to the character in **one volatile note** (every provider: Convai's dynamic info, Mistral, Local AI, Custom), with the rule that
eddies only change hands through the pop-up after the reply, so they never say the money already moved, and never another sum. With the setting on, the
old words-only `MONEY_NOTE` ("V is the one paying you") stays out of a named character's turn (`input.eddies.decides`), because V may borrow now;
ordinary NPCs keep it.

## Intent detection, and what it costs

No model is asked and nothing waits. A typed line is read by a few regular expressions when the context is built (well under a millisecond,
`screenWords`): reclaim, repay, borrow, lend, give, with the sum (digits, 1,000, 5k, 2 grand, €$500, "five hundred eddies", "a grand"), refusing
negations, conditions ("if", "would you ever"), the past and the future ("tomorrow", "already"). A line about something else gets **no note at all**
unless a debt is open between them (then one line of what is owed).

A spoken line's words are not known when its context is made (the context goes out with the recording, as for the drive limit note), so an own copy's
spoken turn carries a short standing note ("the most you would lend V right now is N; if V asks for more, offer that much or say no", plus what is
owed), and the bridge reads the transcript when the reply is published (`finish`) to make the proposal. No initiative on a spoken turn.

While the setting is off: the game sends no block (one boolean per turn), the bridge parses nothing, the tick does one nil check. On: the block is a
balance read and a ledger lookup per private turn; the 10 Hz tick reads the small proposal file twice a second only during the 150 s after a turn to an
own copy, and nothing otherwise.

### Languages

The intent grammar is English. A line in another of the 15 menu languages that is about money (`MONEY_WORDS` covers all of them) gets the standing
note, never a decision; a proposal then only comes from a spoken English transcript or the character's own move. Follow-up: per-language intents.

## The game half (`mod/eddies.lua`, `r6/scripts/CyberpunkConvai/Eddies.reds`)

* `block(context)`: once per private turn V sends to a named character (typed: `sendRequest`; spoken: `microphone.captureActions`), never a group
  round, a reaction, a call or Johnny in V's head. Asks `companions.ownCopy(entity, profileKey)`: `party`, `housemate`, `visitor` or nil (a
  game-placed character has no entry in the mod's list of copies). An own copy's turn carries V's balance (`TransactionSystem:GetItemQuantity`,
  `Items.money`) and arms the watch for this request id.
* The proposal (`runtime/eddies-offer.json`, written by the bridge after the reply was published) must match the watched request id, entity and
  profile, a known flow and a whole sum of 1 to 100,000. It waits until the reply is over and V is free (no reply due or playing, no combat, scene,
  dialogue choice, pause, menu, text box or phone), at most 45 s, then opens `GenericMessageNotification.Show(..., YesNo)` (the box the game uses for its
  own questions; redscript only reports the answer, it moves nothing).
* On Yes, everything is checked again: the setting, the character still one of V's copies, the debt a payback settles, V's live balance for money
  leaving V; then `TransactionSystem:GiveItem` / `RemoveItem` with `Items.money` (what vendors, the taxi and quest payments use, so the game shows its own
  eddies notification), and the balance is read back. A refusal shows one notice (`eddies-transfer`).
* **The ledger** (`runtime/eddies-ledger.json`, version 2): per character a seed, the first-contact time, the last ask and up to 40 entries
  `{flow, amount, real time, result, origin, game clock}`. It is written only when something happened. **Rollback guard**: an entry stamped later than
  the game clock of the save now loaded is forgotten for good (a load of an earlier save took those eddies back), like Street reputation's guard. The
  bridge gets totals, the faded flow and the last entry (`M.view`).

### Game-placed characters: talk only (safe default)

A character the game placed (story NPCs in their quest places, the game's own Judy, Panam, ...) is never one of V's copies, so its turn has no balance,
no watch and no proposal; its note says "No eddies can change hands in this conversation", with its means and what is owed (the ledger is per profile, so
a debt with V's copy of Judy is known to story Judy too). Moving money with them could cross the game's own quest scripts (Panam's and Judy's own payments,
favours paid in quests), so it stays off until a story pack defines exactly when it is allowed.

### What only the game can confirm (live check list)

1. The pop-up opens with the right text after the reply, not during it, and not over a menu or scene.
2. Yes on a loan to V: the game's `+300` eddies notification and the balance up by 300 (`Eddies: person=judy-alvarez flow=loanToV amount=300 result=done`).
3. Yes on a gift or a loan from V: `-200` notification, balance down by exactly 200.
4. No: nothing moves, and on the next money talk the character remembers ("V said no when you asked to borrow ...").
5. `companions.ownCopy` is `party` for a party member, `visitor` for an invited visitor, `housemate` for a housemate, and nil for the game's own Judy (her
   note says no eddies can change hands).
6. A load of a save from before a loan: the next money talk with that character no longer mentions it (`Eddies: person=... forgot=1`).
7. A spoken "can you lend me 200 eddies?" (English) to a party member: a pop-up for the sum the character agreed to.
8. No FPS change with the setting on and off (nothing runs per frame; the proposal read is 2 Hz for 150 s after a turn to an own copy).

## Safety rules

1. Off by default; off sends nothing, reads nothing, runs nothing.
2. The model decides nothing: the bridge decides from the money data, the ledger and V's words; the game re-checks everything; V confirms every transfer.
3. A whole sum of 1 to 100,000 (`EDDIES_CAP`, `M.CAP`), at most V's live balance for money leaving V, at most the debt for a payback.
4. One proposal per turn, matched to the turn's request id; a proposal file read again is not a second transfer.
5. Only V's own copies move money.

## Phases

1. **Built (this branch):** money data for every character and NPC group; borrow and lend both ways, gifts, paybacks; confirm pop-up; ledger per
   character in their prompt with the rollback guard; intent screen with no added latency; game-placed characters talk only; setting off by default.
2. **Story packs (designed, not built):** a content pack (docs/ADDON_API.md) may ship `eddies-stories.json`: per character a short arc that a character
   at a trust threshold brings up, unlocked only after that character's own quests are finished (journal state the game already sends, e.g. Panam after
   `sq027`), for example "Panam's car is held for ransom": stage 1 she asks for N eddies with the backstory; V's Yes/No moves the story (paid: stage 2,
   she pays back over time; refused: she finds another way, stage 2b); stage notes go in the same volatile note, the proposals through the same pop-up,
   and each stage is one ledger entry with a story id. The loader would validate the file (character keys, stage ids, sums within the cap, a quest-done
   condition) and offer at most one active story per character. Not built yet.
3. **Later:** per-language intents; deciding a spoken turn's words before the reply on the text providers (their host has the transcript when it calls
   the model); game-placed characters per story pack; a Gameplay settings section.

## Files and tests

`bridge/eddies.mjs` (screen, decisions, notes, proposal), `bridge/eddies-finances.mjs` (data), `bridge/protocol.mjs` (`eddies` on a private turn),
`bridge/turn-context.mjs` (`moneyNote` stays out when the eddies note decides), `bridge/convai-bridge.mjs` (the note in the context blocks, the proposal in
`publishResult`), `mod/eddies.lua`, `mod/companions.lua` (`ownCopy`), `mod/init.lua` (wiring), `mod/manager.lua` and `mod/manager-ui.lua` (the setting),
`mod/notices.lua` (`eddies-transfer`), `r6/scripts/CyberpunkConvai/Eddies.reds` (the pop-up), packaging lists, `localization/en.json`.

Tests: `bridge/eddies.test.mjs` (data coverage, the block, protocol, money note, amounts, the screen, means, trust, every decision, the ledger line, typed
and spoken turns, game-placed and ordinary NPCs, initiative, the cap), `bridge/eddies-lua.test.mjs` (off, the block, the pop-up flow, No, missed,
every re-check after Yes, paybacks, the rollback guard, a reload and a damaged ledger, the init wiring).
