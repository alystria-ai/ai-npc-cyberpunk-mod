# Reply variety, clothes and "I'm here" talk

Branch `fix/talk-repetition-gear`. Code: `bridge/reply-variety.mjs`, used by `bridge/text-provider-host.mjs` for every non-Convai provider (Local AI, Gemini, Custom, the Mistral preset, add-on hosts).

## What the owner saw (31 Oct, Panam Palmer, bond level 7, Custom with the Mistral preset, Ministral 8B)

- Most replies opened with "Oh, you're still here, huh?" or "Five hundred eddies, huh?", and whole sentences came back two and three turns in a row ("I'm gonna call you a coward in front of the whole damn camp", "are you just gonna stand there looking all smug?").
- V's suit came up in most replies ("that damn suit", "more than just a suit and a prayer").
- "I'm still here, standing right beside you", "I'm right here", "you're still here, huh?" in a talk face to face.

## Causes

1. The model reads the last 8 to 11 exchanges and continues them. After three replies that open the same way the fourth does. The old check (`repeatsLine`) only fired when a whole reply was nearly one earlier line, so an opener or one sentence inside an otherwise new reply passed. The existing nudge (`FRESH_WORDS_NUDGE`) is only sent with that retry.
2. Presence was pushed from four places: the right-now sentence "You are with V in person, standing near V" (also copied right before V's words every turn), the partner tone ("you like having V near", "wants V beside her", "wanting them near"), and, on the first turn after a pause, "You last talked with V a little while ago".
3. The gear line itself is already left out of the prompt unless V's words are about clothes or gear (since 30 Oct, `gearWantedFor` in `bridge/quest-context.mjs`). Two things kept it alive: the bridge log said "Player gear: 7 items, 624 chars" on every turn even when nothing was sent (the diagnostic now says "read, not in the prompt"), and once one reply said "suit" the history carried it forward.

## What changed

- **Before the reply** (`varietyNote`): a short note right after V's words, built from her own last replies. It names the openers two or more of her last six replies share, the phrases of five words or more that two of the last four replies share (with the longest sentence of the last reply beside them when something repeats), and, when two of the last six talked about V's clothes and V did not ask and the gear did not change, "leave them out unless V asks". No request, a few hundred microseconds.
- **The exchanges shown** (`dedupeHistory`): an opener or sentence that an earlier reply in the list already had is left out of the later one in the prompt. The memory still keeps what was said. The first "Oh, you're still here, huh?" stays, the next three no longer feed the pattern. This was the part that moved the numbers, the note alone did not.
- **After the reply** (`freshenReply`): the opener she has used before, a sentence she has already said (a run of five words with two content words, or most of the four-word runs), and in a talk in person a short sentence that only announces who is here ("Still here, huh?", "I'm right here.", "You're back.") are left out when six words or more remain. No second request. A reply that is nearly one earlier reply still goes the old way (asked again, or the repeated sentence cut). The voice does not start on such a first sentence (`headRepeats` is part of the head test).
- **Presence wording**: "standing near V" is gone from the right-now sentence (it says "You are with V in person."), the copy before V's words adds "Never announce that you are here or beside V, or that V is here.", the phone-beside note says the same, and the partner tone says "V's company" and "Never announce that you are here, beside V or still around".
- **Gear**: the new note leaves clothes alone when they came up twice already. A real change of outfit still arrives as the "Changed since you last saw V" note, and asking about clothes or gear brings the line back, so noticing a new outfit is kept.

## Measured

See the captain's log entry in `TODO.md` of 31 Oct for the numbers (8 live turns each, Ministral 8B).
