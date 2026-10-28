# Eddies with characters

Branch `feat/eddies` (2026-10-28). **Settings > Gameplay > Eddies with characters**, off by default.
(another branch adds it); the setting key `characterEddies` stays the same.

Money between V and the characters, the lore-friendly way: every character has money of their own as their story has it, V can borrow from them and lend
to them both ways, pay back and be paid back, by voice or by text, and the eddies move at once when the character agrees in their reply (no question asked,
2026-10-28 on the owner's word after the live test). What a character does follows their lore and how V stands with them now.

## Why this is not "Pay characters in eddies" again

"Pay characters in eddies" (docs removed in commit bbde2e8a, 26 Oct) was removed because it did not work in the owner's live test: "I pay you 500 eddies"
left no trace at all. Its design made that hard to see and easy to break:

* one direction only (V pays), typed lines only, and the amount had to pass a 15-language grammar before anything happened;
* the money moved **without any check by the game**, so every rule had to be a hard gate (the lease, the mailbox shared with the drive and follow actions, the offer
  echoed exactly), and any gate that said no said nothing;
* nothing on screen showed that the feature had even looked at the line.

This design keeps what was right (the amount never comes from the model; the game checks the balance, the cap and ownership again, and reads the balance
back) and changes the rest:

* **The game checks before it moves anything.** The bridge only proposes (its reading of V's words, never the model); the game re-checks the setting,
  the character, the sum, V's balance and the debt, and reads the balance back. A first design also asked V on a Yes/No pop-up; the owner dropped that
  step after the live test (it was one more thing to click per transfer), so a wrong reading of V's words now costs money where it used to cost one "No".
  The guards below are what stands between a misread line and V's wallet.
* **Its own small file and its own short watch** (`runtime/eddies-offer.json`), not the action mailbox and its lease.
* **A log line at every step**: the bridge's `[Eddies] profile=... own=... trust=... words:borrow:500 propose=loanToV:500` (or `unheard`, `about`,
  `heard=...`), the game's `Eddies: proposal person=... flow=... amount=...` and `Eddies: person=... flow=... amount=... result=done|declined|missed|failed`.

## What the player sees

* Talk about money with one of your own characters (party member, invited visitor, housemate): "can you lend me 500?", "here, take 300 eddies",
  "I'll lend you a grand", "here's the 500 I owe you", "pay me back". The character answers in their own way, and when the reply is over and you are
  free (no menu, scene, fight or text box), the eddies move: Judy lends you 500 and the game shows its own eddies notification. Nothing asks first. A
  refusal in the reply moves nothing.
* Characters remember what is owed, both ways, and say so ("V owes you 600 eddies"). They will not lend more while V owes them much.
* Now and then a character with needs in their story asks **you** for a loan, briefly ("You need 300 eddies for motorcycle repairs"), at most once per
  session and once every three days. It only asks: nothing leaves your wallet until you say so in your own words ("sure, here's 300").
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
and V's record (paid back before +0.1, owes now -0.15; a "declined" row left by the pop-up build still counts as -0.05).

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
eddies change hands the moment the character agrees in the reply, so they agree only to what they really mean to do, never say money moved when they refused, and never
name another sum. With the setting on, the
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

Money asks are understood in every language the mod supports: English (`bridge/eddies.mjs`) and 14 more (`bridge/eddies-languages.mjs` with one data file per
language in `bridge/eddies-languages/`): Czech, German, Spanish, French, Hungarian, Italian, Japanese, Korean, Polish, Portuguese (Brazilian and European),
Russian, Turkish, Ukrainian and Chinese (one grammar for both scripts, so the zh-cn and zh-tw menus are covered). The same five intents (borrow, lend,
give, repay, reclaim), by text, voice transcript and phone, with the same refusals and the same rules after the reading. Still no model call and no wait.

How a line is read (all regular expressions, about 0.1 to 1 ms for a line that is about money, two tests for one that is not):

1. English is read first (the characters and the players mix English into every language). A line with no digit and no money word in any warm language stops
   here.
2. Which language: `assessLanguage` (bridge/reply-language.mjs, tens of microseconds). A solid call for English means English only. A solid call for another
   language reads with that language and its close relatives (es, pt, it and fr; cs and pl; ru and uk), whose detections get mixed up. A call that is not solid
   (short lines, mixed lines, "choom, prestame 500") tries the warm languages whose script is in the line, the detected one first. The reading with an intent wins;
   when close relatives agree on the intent, the fuller sum wins ("dos mil": 2000, not the Portuguese "mil"); a refusal by the detected language is final.
3. The language's clauses: the line is split at punctuation, "but" words and a comma or full stop that is not inside a number (1.000, 1,5k). Per clause, the
   six intent patterns in a fixed order (reclaim, repay, lend as "do you need money", borrow, lend as an offer, give); an intent counts only with money in its
   clause or next to it (a money noun, a phrase only money fits, or a sum). The sum is the clause's own, else a filler clause after it ("Rends-moi, s'il te
   plaît, 200 euros") or the one before ("3万円、貸して"). A refusal (negation, condition, a past or future time, a joke in the clause before) drops the clause;
   a condition or time in the clause that asks stops the line ("if I lent you 500, would you pay me back?"). The first clause with a sum wins.
4. The sum, in the language's own words: digits (500, 1.000, 1 000, 1,000, 5k, €$500, 500€), digits with a scale word (2 mil, 3 тысячи, 2万, 5 соток), number words
   and compounds (doscientos, zweihundertfünfzig, cinquecento, kétszáz, pięćset, двести, 二百, 이백, quatre-vingt-dix), slang for a thousand or a hundred
   (Riese, косарь, tysiak, lucas, un kilo) and Chinese "三千五". A number word with no unit counts only with a scale word or at the end of
   a clause from 20 up; a number followed by minutes, times, bullets and the like is no sum; "a few" and "some" are no sum. At most 100,000 as before.
5. Eddies slang: each data file lists the money nouns and units players use besides "eddies" (euros, dollars, local slang).

Cost: nothing compiles inside a turn. V8 compiles a regular expression on its first run (and again per string width), so a grammar is warmed in the background
and only when it matters: `EddiesDecisions` calls `warmFor(text)` with each typed line to a named character while the setting is on, which starts warming the
language the line is in (English needs nothing; a line the detector cannot place warms nothing); a line that reaches the grammar in a language that is not
warm yet (a voice transcript, say) starts that language's warm-up too. Until a language is warm, a line in it is read as English only, never by another
language's grammar, so the first money ask in a new language can be missed once (about 0.1 to 0.3 s of a session), later ones are read. Warming is cut into
slices: a `setImmediate` step per job, a job being the first run of one small regular expression (a grammar list is 5 to 20 parts of about 70 characters, built
on first use by `bridge/eddies-regex.mjs`; `\p{L}` and `\p{N}` are written out as ranges because V8 spent about 5 ms per expression on the property class).
A whole language takes 11 to 140 ms of work in 100 to 300 slices, the worst slice 0.5 to 6 ms (measured per language by `warmLanguagesNow(codes, onSlice)`;
`eddies-languages.test.mjs` bounds it at 30 ms for a busy machine), and the event loop shows no gap beyond the Windows timer tick while a language warms.

Tuning and accuracy (`bridge/eddies-languages/<code>.cases.json`, `<code>.blind2.json`, `node scripts/Eval-EddiesLanguages.mjs [--set dev|held|blind|blind2|all] [code]`,
`bridge/eddies-languages.test.mjs`). Each language has real asks (intent and sum), near-misses (other uses of the same verbs, "I paid for dinner", "I owe you
one", "you owe me an explanation", refusals, conditions, past and future, jokes, prices, counts) and sums:

* `dev` and `held`: written with the grammar (held looked at once, then general fixes only). About 1,100 asks, 1,000 near-misses, 645 sums over the 14
  languages and Spanish: 99% of asks right (intent and sum), 0 false offers, 99.8% of sums.
* `blind`: written by a separate writer who never saw the grammar; the first run scored 59% of asks (the grammars had overfit) and fed a second tuning round
  (now 98%, so it is training data, not an exam).
* `blind2`, the exam: a fresh set by another writer who saw neither the grammars nor the cases, read once before any tuning on it, 20 asks, 20 near-misses
  and 12 sums per language. First run: **76% of asks right (214 of 280, intent and sum), 278 of 280 near-misses clean (99.3%), 165 of 168 sums**. Per
  language, asks: zh 19, ko 17, pl 17, ja 16, ru 16, de 15, it 15, cs 14, es 14, fr 14, hu 14, pt 14, tr 14, uk 14 (of 20). The two false offers (a French
  colloquial negation, "Je te prêterai pas un seul eddie", and a Korean "다시는 ... 안 줘") were fixed with general rules (a colloquial French negation after
  "je te", a Korean "never again"), after which blind2 has 0 false offers; the recall misses were left alone (they are the fresh numbers). Later changes keep
  it at 213 to 214 of 280.
* A set of English chatter and street slang that other grammars might wake ("Ten minutes later", "Toma the shot", "I'll take 5") gives no intent.

What the misses look like: the line is about money, so the character gets the standing note, but no proposal comes. The usual causes: a gift or payback
phrased without the verbs the data file knows (a bare "Tessék, kétezer" or "Voilà les cinq cents que je te devais" in some languages), a condition worded as
an offer, and colloquial or very polite forms. A fix is a pattern in `bridge/eddies-languages/<code>.mjs` plus its case in `<code>.cases.json`.

Known limits: a give or borrow clause before a debt clause wins ("Tady máš těch 500, co ti dlužím" reads as a give); a bare "vot / na / ось" presentative is
not a give cue (too many false offers); a sum over 100,000 is not read (a million); "half" and "two and a half thousand" are not sums; a negation anywhere in
the clause refuses it ("take 150 and don't whine").

## The game half (`mod/eddies.lua`)

* `block(context)`: once per private turn V sends to a named character (typed: `sendRequest`; spoken: `microphone.captureActions`), never a group
  round, a reaction, a call or Johnny in V's head. Asks `companions.ownCopy(entity, profileKey)`: `party`, `housemate`, `visitor` or nil (a
  game-placed character has no entry in the mod's list of copies). An own copy's turn carries V's balance (`TransactionSystem:GetItemQuantity`,
  `Items.money`) and arms the watch for this request id.
* The proposal (`runtime/eddies-offer.json`, written by the bridge after the reply was published) must match the watched request id, entity and
  profile, a known flow and a whole sum of 1 to 100,000. It waits until the reply is over and V is free (no reply due or playing, no combat, scene,
  dialogue choice, pause, menu, text box or phone), at most 45 s, then the transfer happens at once, in `mod/eddies.lua` `update`. There is no redscript half
  and no question: the character's agreement in the reply is the go-ahead. The offer is cleared before anything moves (one transfer per proposal), and
  the file read again is ignored (`lastRaw`, and the watch is over after the first match).
* Everything is checked first: the setting, the character still one of V's copies, the debt a payback settles, V's live balance for money leaving V,
  the sum (whole, 1 to 100,000). Then `TransactionSystem:GiveItem` / `RemoveItem` with `Items.money` (what vendors, the taxi and quest payments use), and the
  balance is read back. **The eddies notification on screen is the game's own**: the mod draws nothing for a transfer, the game's HUD reacts to the
  money item being added or removed, exactly as for a vendor or a quest reward. The mod shows only a refusal (one notice, `eddies-transfer`).
* A character that only **asks** V for a loan (its own move, proposal origin `asked`, flow `loanFromV`) moves nothing: V has agreed to nothing. The game keeps
  the time of the ask (the three-day cooldown) and no ledger entry. When V lends in a later turn, that is an ordinary proposal.
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

1. The eddies move after the reply, not during it, and not over a menu or scene (the proposal waits until V is free).
2. A loan to V: the game's own `+300` eddies notification and the balance up by 300 (`Eddies: person=judy-alvarez flow=loanToV amount=300 result=done`).
3. A gift or a loan from V: `-200` notification, balance down by exactly 200. More than V has: nothing moves and one notice says so.
4. A character refuses in its reply (no proposal): nothing moves. A character asks V for a loan: nothing moves until V offers (`... asked (nothing moves)`).
5. `companions.ownCopy` is `party` for a party member, `visitor` for an invited visitor, `housemate` for a housemate, and nil for the game's own Judy (her
   note says no eddies can change hands).
6. A load of a save from before a loan: the next money talk with that character no longer mentions it (`Eddies: person=... forgot=1`).
7. A spoken "can you lend me 200 eddies?" (and the same in German, Spanish, Japanese ...) to a party member: the sum the character agreed to moves, once.
8. No FPS change with the setting on and off (nothing runs per frame; the proposal read is 2 Hz for 150 s after a turn to an own copy).

## Safety rules

1. Off by default; off sends nothing, reads nothing, runs nothing.
2. The model decides nothing: the bridge decides from the money data, the ledger and V's words; the game re-checks everything and moves the money only once the character has agreed in its reply.
3. A whole sum of 1 to 100,000 (`EDDIES_CAP`, `M.CAP`), at most V's live balance for money leaving V, at most the debt for a payback.
4. One proposal per turn, matched to the turn's request id; a proposal file read again is not a second transfer.
5. Only V's own copies move money.

## Phases

1. **Built (this branch):** money data for every character and NPC group; borrow and lend both ways, gifts, paybacks; the eddies move when the character agrees, no pop-up; ledger per
   character in their prompt with the rollback guard; intent screen with no added latency; game-placed characters talk only; setting off by default.
2. **Story packs (designed, not built):** a content pack (docs/ADDON_API.md) may ship `eddies-stories.json`: per character a short arc that a character
   at a trust threshold brings up, unlocked only after that character's own quests are finished (journal state the game already sends, e.g. Panam after
   `sq027`), for example "Panam's car is held for ransom": stage 1 she asks for N eddies with the backstory; V's answer in the talk moves the story (paid: stage 2,
   she pays back over time; refused: she finds another way, stage 2b); stage notes go in the same volatile note, the proposals through the same file,
   and each stage is one ledger entry with a story id. The loader would validate the file (character keys, stage ids, sums within the cap, a quest-done
   condition) and offer at most one active story per character. Not built yet.
3. **Later:** deciding a spoken turn's words before the reply on the text providers (their host has the transcript when it calls
   the model); game-placed characters per story pack; a Gameplay settings section.

## Files and tests

`bridge/eddies.mjs` (screen, decisions, notes, proposal), `bridge/eddies-finances.mjs` (data), `bridge/protocol.mjs` (`eddies` on a private turn),
`bridge/turn-context.mjs` (`moneyNote` stays out when the eddies note decides), `bridge/convai-bridge.mjs` (the note in the context blocks, the proposal in
`publishResult`), `mod/eddies.lua`, `mod/companions.lua` (`ownCopy`), `mod/init.lua` (wiring), `mod/manager.lua` and `mod/manager-ui.lua` (the setting),
`mod/notices.lua` (`eddies-transfer`), `localization/en.json`. (`r6/scripts/CyberpunkConvai/Eddies.reds`, the pop-up, was removed on 2026-10-28.)

Tests: `bridge/eddies.test.mjs` (data coverage, the block, protocol, money note, amounts, the screen, means, trust, every decision, the ledger line, typed
and spoken turns, game-placed and ordinary NPCs, initiative, the cap), `bridge/eddies-lua.test.mjs` (off, the block, the transfer at once, a character that only asks, missed,
every re-check before the eddies move, paybacks, the rollback guard, a reload and a damaged ledger, the init wiring).
