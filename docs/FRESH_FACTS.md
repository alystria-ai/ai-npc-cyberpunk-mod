# Fresh facts: a small model follows what it was shown last (2026-10-27)

## The problem

Live tests of 2026-10-27 (game 2.31, Local AI, the **lite** model choice, Pocket voice): a fact that had just changed reached the prompt, and the model still contradicted it.

1. **Clothes.** V wore Aguilar's suit, Alex described it correctly, V stripped fully and asked again. The bridge log said so (`[PlayerGear] ... nudity=nude changed=wearing`), the gear line said "everywhere else: nothing on", the right-now block said V is naked, and the last user message carried the change note. Alex answered "You're standing there in that suit like it's armor", and the next turn "You're still standing there in that suit".
2. **Drinks.** Flesh and Chrome read drinks stage 3 (`drinks=3`). V asked Claire Russell "am i drunk" and "do i seem drunk"; she said "Not drunk, just wired." Two causes: the wording was "V has had a lot to drink", which a small model takes for nothing worth saying, and "am i drunk" was not recognised as a question about oneself (`asksAboutSelf` knew "hungry" and "drink", not "drunk"), so the state was only in the Background line ("mention only if it matters").

A 4B model does what the talk it is shown says: its own answer a turn ago sits right above V's new words and outweighs a correct line far above it.

## The models

The Runtime's own engine, started the way the bridge starts it (`buildServerArgs` in `bridge/local-llm-server.mjs`, the profile's sampling, thinking off, the same stop strings), Vulkan on the RTX 4080 Laptop:

| Choice | File | Profile (sampling) |
| --- | --- | --- |
| Local AI lite | `Ternary-Bonsai-2-4B-Q2_0.gguf` (1.21 GB) | `local-lite`: temperature 0.45, repeat penalty 1.1, plain rules, 4 turns of history |
| Qwen 4B (the Mature lite model) | `Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf` | `mature-lite`: temperature 0.6, repeat penalty 1.05 (the Mature layer itself is not added: it has nothing to do with these facts) |

## The measurement

`scripts/fresh-facts-eval/` (no game needed). `scenarios.mjs` builds the two cases as exact prompts with the bridge's own modules (real persona text, the real context blocks, `buildMessages`); `variants.mjs` holds the variants; `run.mjs` starts the Runtime's llama-server, sends each prompt many times and stops the server; `tabulate.mjs` counts labels.

- **Clothes, 4 situations x 10 samples per variant** (40): the turn right after the change ("what am i wearing now?", "how do i look?"), and a turn *later* with the model's own wrong answer already in the history and no change note any more ("what am i wearing?", "so what do you think of my outfit?"). The truth: V is naked, only Johnny's aviators on; the suit was worn before.
- **Drinks, 2 questions x 10** (20): "am i drunk?" and "do i seem drunk?", truth: V is drunk (stage 3).
- **Judged by reading each reply** (a Haiku judge with a written rubric, not a pattern match): `wrong` = the reply says or implies the old fact (V is dressed in the suit/any clothes; V is not drunk, just tired), `acknowledges`, `neutral` (no claim). The table counts `wrong`.
- Noise: with n = 40 a rate is good to about +-8 points (the same variant measured twice gave 33% and 35%, and 0% and 3%). Only large gaps count.

### Clothes: replies that contradict the fact

| Variant | Lite wrong | Qwen 4B wrong |
| --- | --- | --- |
| Before (what shipped 2026-10-27): change note in the notes, the gear line, the nudity cue | **15/40 = 38%** | **12/40 = 30%** |
| Blunt line `[RIGHT NOW, TRUE: ...]` right before V's words | 10/40 = 25% | 0/40 |
| The same, plain wording ("Right now V is completely naked...") | 12/40 = 30% | 1/40 |
| The same, after V's line | 11/40 = 28% | 1/40 |
| Old exchange left out of the history | 9/40 = 23% | 6/40 = 15% |
| Blunt line + old exchange left out | 27/80 = 34% | 1/40 |
| Blunt line + the old exchange's question annotated ("that was when V still wore the suit") | 8/40 = 20% | 0/40 |
| Blunt line + the same fact in the closing line + old exchange left out | 10/40 = 25% | n/a |
| Short line ("V is naked.") + old exchange left out | 12/40 = 30% | n/a |
| Blunt line twice (before and after V's words) + old exchange left out | 8/40 = 20% | n/a |
| Fact at the end of the system message + blunt line | 14/40 = 35% | n/a |
| Fact at the end of the system message + old exchange left out | 12/40 = 30% | n/a |
| **Fact at the very TOP of the system message** + blunt line | 4/40 = 10% | 1/40 |
| **Top + blunt line + old exchange left out** | **1/80 = 1%** | 0/40 |
| **End of the system message + blunt line + old exchange left out** | **3/40 = 8%** | n/a |
| **The implementation** (the row above, built by the real code path) | **3/80 = 4%** | **4/80 = 5%** |

What it says: Qwen 4B is fixed by the blunt line alone (30% to 0-3%). The lite model is not: no single change helped beyond noise; it needs the fact at both ends of the prompt **and** its own contradicting answer gone from the history.

### Drinks: replies that deny it

| Variant | Lite wrong | Qwen 4B wrong |
| --- | --- | --- |
| Before: "V has had a lot to drink." (Background line, or the asked sentences in the right-now block) | 2/20 = 10% | 1/20 = 5% |
| Blunt line `[RIGHT NOW, TRUE: V is drunk: slurring, unsteady on their feet, reeking of booze.]` | 0/20 | 2/20 |
| Plain line ("Right now V is clearly drunk...") | 0/20 | 0/20 |
| Vivid wording only ("V is drunk: slurring, unsteady on their feet, reeking of booze.") | 0/20 | 0/20 |
| Vivid + blunt line | 0/20 | 0/20 |
| Top + vivid + blunt line | 1/20 | 0/20 |
| **The implementation** (vivid wording, "am i drunk" recognised, fresh line at both ends) | **0/40** | **1/40 = 3%** |

The live "Not drunk, just wired" was **not** reproduced at that rate offline (10% and 5% before): the live prompt also carried Claire's long history and the game's other notes. The change is cheap and moved both models to about zero, but the next live test is the real check.

### Cost

No extra model call. The prompt grows by about 60 tokens on a turn that has a fresh fact (the fact twice) and shrinks by one exchange (60 to 100 tokens) when the old claim is dropped: measured 2,572 to 2,585 tokens (clothes, lite) and 2,138 to 2,238 (drinks, lite, where the asked sentences also moved into the right-now block). Nothing is added on a turn without a fresh fact.

The prefix cache decides where the second copy goes (lite model, 2.6k-token prompt, idle 4080, median of 6; the Qwen 4B numbers are 59 / 802 / 233):

| What changed in the prompt | Lite | Qwen 4B |
| --- | --- | --- |
| Nothing (warm cache) | 66 ms | 59 ms |
| The very first token of the system message | 1,390 ms | 802 ms |
| The end of the system message (where the fresh line goes) | 381 ms | 233 ms |

The top of the system message won the accuracy table by a hair (1% against 4 to 8%) but throws the whole cache away: about a second more on an idle card, several seconds on a card the game keeps busy, and a hybrid model also loses its checkpoints. So the second copy goes to the end of the system message, after the right-now block, which changes anyway: the cost is the history and the new user message being read again (about 0.3 s on an idle card), on the turn the fact appears and the turn it goes away.

## What the code does

`bridge/fresh-facts.mjs` (pure string work) and the callers:

1. **The facts.** `gearFresh` (`bridge/player-gear.mjs`) turns what changed since the character last saw V (the same memory as the change note, `bridge/gear-memory.mjs`) into blunt sentences: `V is completely naked, only Johnny's aviators on. V is not wearing Aguilar's suit anymore.` (topless, dressed in other things, the weapon in hand, the equipped weapons and the cyberware are worded the same way). While V is topless or naked and V's words ask about clothes or themself (`asksAboutClothes`, `asksAboutSelf`), the clothes fact is said again even with no change, because the character's own wrong answer is by then in the history. The turn context (`bridge/turn-context.mjs`, `describeTurnContext(...).fresh`) gives V's state from the other mods (drink, injuries, tiredness) in the same way, **only when V asks about themself**: told on a change it would turn "mention only if it matters" into a recital.
2. **The block.** `bridge/quest-context.mjs` adds one `fresh` block at the end of the context (`freshBlock`): the labelled text `TRUE RIGHT NOW: ...` for the joined context (Convai gets it in its dynamic info), plain `facts` and a `drop` pattern for the text providers.
3. **The prompt** (`bridge/mistral-prompt.mjs`, Mistral, Local AI and Custom, every profile): `TRUE RIGHT NOW: <facts>` ends the system message; `[RIGHT NOW, TRUE: <facts>]` goes right before V's words (before the closing line, in a profile that puts the turn's notes after V's line); the history exchanges whose reply matches `drop` are not sent (they stay in the character's memory). Nothing on a reaction.
4. **The drop pattern** (clothes only): the words of the items V no longer wears (not the ones still worn) plus the clothing words that are not worn now (suit, jacket, shirt, pants, outfit, clothes, ...). A reply about the jacket V still wears is kept.
5. **Drink wording** (`bridge/mod-state.mjs`): stage 2 "V is tipsy: loose, a little loud, smelling of booze.", stage 3 "V is drunk: slurring, unsteady on their feet, reeking of booze.", a stranger "V looks drunk and smells of booze." (`docs/DYNAMIC_INFO.md`). "drunk", "sober", "tipsy", "buzzed", "plastered" and "hammered" now count as asking about oneself.

Facts only: no sentence tells the character how to react, nudity included (owner decision 2026-10-27). The mod's fixed hard limits are unchanged.

Tests: `bridge/fresh-facts.test.mjs` (the exact live sequences, both ends of the prompt, the drop, the weapon and cyberware facts, strangers, reactions, the switch, drinks, the notes-after layout, the unchanged prompt without a fresh fact).

## What to look for in the next live test (lite model, Local AI)

1. Wear the suit (Wardrobe Outfit slot), ask "what am i wearing?", take it all off, ask "what am i wearing now?" and then "how do i look?": the answer must say naked/nothing on, never the suit. Bridge log: `[PlayerGear] ... changed=wearing`; the support report's prompt shows `TRUE RIGHT NOW:` last in the system message and `[RIGHT NOW, TRUE:` before `V says:`.
2. A turn or two later, still naked, "what do you think of my outfit?": no suit, no jacket.
3. Drink (Flesh and Chrome, drinks 3): "am i drunk" and "do i seem drunk" must be answered as drunk; ask something else (no question about oneself): no fresh line.
4. Draw or holster a weapon and ask what V holds.
5. Latency: the turn where a fact appears and the one after may take about 0.3 s more on a card with room to spare, nothing else.
