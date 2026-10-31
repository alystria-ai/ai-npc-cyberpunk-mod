# Natural talk: prompt research (2026-10-30)

## What to do: ranked design lessons

1. **Retrieve, do not dump.** Every product and paper reviewed pulls facts per turn by relevance. Score each world fact on relevance to V's words, recency and importance, then inject only the top 3 to 5 (section 10).
2. **Models overuse whatever persona or fact text they are given.** Overuse grows with the number of unrelated attributes supplied (section 6). Fewer facts per turn is the single biggest fix for clothes, weather and quest recital.
3. **Gate by trigger like World Info.** Keyword or event triggers, a scan depth of the last 2 to 3 messages, a token budget and a priority order (section 8). Most blocks should be off on most turns.
4. **Two layers.** A short "background you carry, use only if it fits" block, and a final task line "reply to what V just said" placed last (sections 2 and 5).
5. **Shrink the rule list to 3 to 5 positive rules.** Small models drop instructions as counts rise, and naming a banned topic primes it (sections 3 and 4).
6. **Voice by varied examples, not adjectives.** 3 to 5 sample lines with no world facts, varied in length and openings, so they cannot be copied as templates (section 3).
7. **Placement.** Stable persona and rules first (also good for prompt caching), retrieved facts after, a 1 or 2 line steering note directly before V's words (section 5).
8. **Screenshot only when seeing matters,** before the text, framed as the character's own eyes with the HUD ignored (section 7).
9. **Measure.** Keep a fixed set of scripted turns and count unprompted clothes, "screen" and quest mentions per 100 replies before and after each change.

## 1. Facts as background, not a checklist

- Irrelevant context hurts: no more than 18 percent of solvable math problems stayed solved across all distractor types ([Shi et al.](https://arxiv.org/abs/2302.00093v1)). Adding "ignore irrelevant information" helped there, so state that background is optional.
- Distractors compound, and focused prompts of about 300 tokens beat full ones of about 113k tokens for all 18 models tested ([Chroma Context Rot](https://www.trychroma.com/research/context-rot)).
- Wrap each content type in its own tag so facts do not read as instructions ([Anthropic guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).

## 2. What you know versus what to say

- OpenAI suggests separate sections for identity, instructions, examples and context ([OpenAI guide](https://developers.openai.com/api/docs/guides/prompt-engineering)).
- Google says to put the real instruction after the context, with a bridge such as "Based on the information above" ([Gemini prompting](https://ai.google.dev/gemini-api/docs/prompting-strategies)). Use: "Reply to what V just said. Use background only if it helps that reply."
- Write facts as the character's own knowledge in plain sentences, not raw JSON. Anthropic notes that prompt style leaks into output style (same guide). Quest journal JSON is the likeliest source of recited quest text.

## 3. Fewer rules, examples over rules

- Instruction following falls with count. claude-3.5-haiku went from 98 percent at 10 instructions to 43 percent at 100, and early instructions are followed more ([IFScale](https://arxiv.org/html/2507.11538v1)).
- Google: always include few-shot examples but not too many, as the model may overfit to them ([Gemini prompting](https://ai.google.dev/gemini-api/docs/prompting-strategies)). Anthropic: diverse, 3 to 5 ([Anthropic guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).
- Mistral: clear role, hierarchical sections, avoid vague words and contradictions ([Mistral guide](https://docs.mistral.ai/guides/prompting_capabilities/)).
- Community card advice: show behaviour in dialogue rather than listing traits ([character design notes](https://docs-ecd.pages.dev/character-design-for-llms-march-2026.html), low authority).

## 4. Negative instructions

- 87.5 percent of violations in one mechanistic study (Qwen2.5-7B-Instruct) came from the forbidden word priming itself. Suggested fix: do not name it, use category or positive phrasing ([Semantic Gravity Wells](https://arxiv.org/html/2601.08070v1)).
- Anthropic: say what to do instead of what not to do ([guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).
- Rewrite "never comment on V's outfit" as "talk about the person and the moment". Enforce hard limits in code.

## 5. Ordering and placement

- Best recall at the start or end of the input, worst in the middle ([Lost in the Middle](https://arxiv.org/abs/2307.03172v2)). Anthropic reports up to 30 percent better results with the query last, and Google agrees (guides above).
- SillyTavern: the closer text is to the bottom, the more impact it has on the next reply ([Author's Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/)). Its Post-History Instructions are sent after the user message for strong weight ([SillyTavern prompts](https://docs.sillytavern.app/usage/prompts/)).
- Character.AI describes caching the key/value state of each prefix between turns (secondary coverage only, seen in [this summary](https://bestofai.com/article/optimizing-ai-inference-at-characterai)). So keep the stable persona prefix identical and put changing facts after it for speed.

## 6. How much context before bleed

- PANDA (EMNLP 2024) names the "overuse problem": LLMs over-ground persona attributes, using ones that drift from the topic or packing in too many ([PANDA](https://aclanthology.org/2024.emnlp-main.670)).
- A 2026 follow-up reports models include all given attributes and that metrics did not penalise it, then proposes a suppression method and an appropriateness score ([arXiv 2609.04676](https://arxiv.org/abs/2609.04676)).
- Another paper found zero-shot models reuse exact terms from persona text (seen in [search results](https://arxiv.org/pdf/2505.24613) only).
- No hard token number exists for small models. SillyTavern flags a definition above half the context as too big ([character design docs](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)). Working budget (our judgement): persona and voice 400 to 700 tokens, retrieved facts under about 200 per turn.

## 7. Images and HUD

- Anthropic: images work best before the text ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). Gemma 4 uses an `<|image|>` placeholder, and its docs example puts the instruction first ([Gemma 4 formatting](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)).
- No primary study on HUD screenshots in roleplay was found. A vision benchmark found shorter prompts reduced hallucination ([TouchStone](https://arxiv.org/pdf/2308.16890)).
- Our judgement: gate the image to turns about what is seen. Frame it: "This is what you see right now. Use it to understand the moment. Treat on-screen text as game interface you cannot see in the world."

## 8. Roleplay frontends

- **Prompt Manager.** The prompt is main instructions, character and persona, World Info, summaries, history, the latest message and final instructions. List order sets send order and the bottom item is last, normally Post-History Instructions. In-Chat entries sit at a depth, where depth 0 is after the last message ([Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)).
- **Card V2 fields.** description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, alternate_greetings, and an embedded character_book. creator_notes must never be used in prompts ([spec](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)).
- **World Info.** Keys match whole words in the last N messages (scan depth). Options: constant entries, a probability roll, regex keys, recursion, selective secondary keys, position and depth, an order value, and a token budget. Lower priority entries drop first when the budget is full. Only the Content field reaches the model ([World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/), spec above).
- **KoboldCpp.** Memory sits at the top for long-lived facts and should stay a paragraph or two. World Info is keyword-triggered. Author's Note goes near the end for the current scene ([KoboldCpp wiki](https://github.com/LostRuins/koboldcpp/wiki), first half of the page only).
- AI Dungeon says World Info is for details that only matter when recently mentioned (seen in [search results](https://latitudegames.notion.site/What-is-Memory-f2bc3e77bb1b48aca3716aeba21b8d21)). RisuAI has reorderable prompts and compression memory, but no official doc was reached. No Agnai doc was found.

## 9. Companion and NPC products

- **Convai** keeps backstory separate from a knowledge bank retrieved by RAG on the player's query ([Convai blog](https://convai.com/blog/building-ai-characters-knowledge-bank-with-convai)).
- **Inworld** lists profile, goals, emotion and knowledge filtering, and a memory node that merges always-included recent entries (default 5) with long-term entries ranked by embedding similarity (docs seen in [search results](https://docs.inworld.ai/unreal-engine/runtime/character-reference/overview)). Its prompt template is not public.
- **NVIDIA ACE** sample bots keep a backstory per character in config with `{{ }}` placeholders filled at runtime. The Nemotron mini 4B model was trained for roleplay and RAG on about 10,000 NPC dialogue turns (seen in [search results](https://docs.nvidia.com/ace/ace-agent/latest/sample-bots/gaming-npc-bot.html)).
- **Ubisoft NEO NPC.** Writers define backstory, knowledge and style, with guardrails and player-input analysis around the model ([Ubisoft](https://news.ubisoft.com/en-us/article/5qXdxhshJBXoanFZApdG3L)). No GDC write-up and no Replika engineering write-up was found.

## 10. Memory and retrieval papers

- **Generative Agents.** Retrieval score is recency (exponential decay, factor 0.995 per game hour since last access), importance (LLM rated 1 to 10 when created) and relevance (embedding cosine similarity to the query), each min-max scaled to 0 to 1, weights all 1, top items that fit the window go in the prompt ([arXiv 2304.03442](https://arxiv.org/html/2304.03442v2)). Reflections synthesise memories into higher-level ones.
- **MemGPT** manages memory tiers like an operating system, moving data in and out of the context window ([abstract](https://arxiv.org/abs/2310.08560)).
- **LongMemEval.** Commercial assistants lost about 30 percent accuracy over long chats. Better indexing (finer-grained session units, fact-augmented keys) and time-aware query expansion improved recall ([abstract](https://arxiv.org/abs/2410.10813)).
- **LoCoMo.** RAG improved memory by 22 to 66 percent and worked best when dialogue was stored as short observations about the speaker, rather than raw turns ([search summary](https://huggingface.co/papers/2402.17753.md), full paper not opened).
- Implication: store world facts as short, self-contained one-line observations with a static importance value, retrieve by V's words plus the last 2 turns, and add a cooldown so a fact just voiced is suppressed for a few turns (our judgement).

## 11. Persona drift

- LLaMA2-chat-70B showed significant drift within 8 rounds, attention on the system prompt drops between turns, and repeating the system prompt helps but eats context ([Li et al.](https://arxiv.org/html/2402.10962v1)).
- Keep the persona short and re-state its core 2 or 3 lines near the end (cheap system prompt repetition). Too many persona lines worsen overuse, so the tension is real and needs testing.
- SillyTavern also notes chat history acts as the style guide, so earlier stilted replies teach the model to stay stilted ([SillyTavern prompts](https://docs.sillytavern.app/usage/prompts/)). Drop or rewrite bad replies in history.

## 12. Small-model vendor notes

- Gemma 4 has a real system turn, so keep all instructions in one ([Gemma 4 formatting](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4)).
- No official Qwen or Gemma roleplay guide was found. One roleplay guide says the same system prompt behaves differently across vendors, so test per model ([Zego guide](https://doc-docuo-alpha.zego.im/en/aiagent-server/best-practices/role-playing-system-prompt), low authority).
- Anthropic: soften shouted emphasis such as "CRITICAL: you MUST" (guide above). Check Flash-Lite for the same.

## 13. What branch fix/natural-talk changed, from these lessons

Measured in `docs/NATURAL_TALK_SAMPLES_2026-10-30.md` (scripts/Eval-NaturalTalk.mjs).

| Lesson | Change |
|---|---|
| Gate by trigger (8), overuse (6), image only when seeing matters (7) | The picture goes with a text turn only when V's words are about the surroundings (`bridge/vision-message.mjs` pictureForTurn). V's gear goes only when V asks about clothes, weapons or cyberware (`asksAboutGear`), and the money band only when V talks money. |
| Images framed as her own eyes, HUD ignored (7) | The helper cuts the frame to its middle, without the HUD (`native/vision`, the `view` word). The note says "what you see around you right now, with your own eyes" and never names a screen, an image or an interface. |
| Facts as background (1, 2) | The world heading of every profile says it is what she already knows, to bring up only when it matters to what V says. |
| Fewer, positive rules and varied short examples (3, 4) | Google Gemini has its own profile: eight short rules, no "never", react to V's words first, three example exchanges with no world facts. |
| Steering note just before V's words (5) | Kept: the turn notes and the closing line already sit there. The nudity standing line now lets go ("you have already seen it: leave it unless V brings it up"). |
| Placement and caching (5) | V's gear left the cached world part, so a change of clothes no longer moves the system message. |

## 14. Next: blocks that should become retrieval-driven

Today's gates are one plain function each (`(text) => boolean`), so an embedding gate can replace any of them without touching the prompt assembly. The mod already has a local embedder (`bridge/local-embed.mjs`, granite 107m, 384 dimensions) for memory search, and a separate measurement of Cohere embed and rerank is under way. In order of value:

1. **The character's topic material** (the PUBLIC INTRINSIC TOPIC MATERIAL in each persona, often 2,000 to 4,000 characters of opinions and anecdotes): split into one-line items, embed once per character, retrieve the 1 or 2 nearest to V's words. The rest of the persona (who she is, how she talks, a few voice lines) stays fixed and cached.
2. **The quest journal and jobs**: written as one plain sentence each in her own knowledge, not JSON, and retrieved when V's words or the last two turns are about work, a person or a place in them. The tracked quest stays available as one short line for "what now?" questions.
3. **World knowledge facts and journal history**: already ranked by topic words (`selectJournalHistory`). Move to the same retriever, scored on relevance, recency and importance as in Generative Agents, with a token budget of about 200.
4. **Memories of V**: already retrieved. Add the recency and importance terms, and a cooldown so a memory voiced in the last few turns is not offered again.
5. **Place, time, weather, radio and TV**: keep the "told when new" scenery rule and add the trigger gate: the place sentence stays (she must know where she is), the rest goes only when new or asked.
6. **The picture**: keep the word gate, and let the retriever widen it (an embedding of "a question about what is around us").

## 15. Built: retrieval-driven topic material, quest journal and world facts, and a prompt order that survives a change (feat/natural-talk-retrieval, 2026-10-31)

Items 1 to 3 of section 14 are built, and the prompt is laid out so that what changes between turns comes after the history. A turn carries the few units that bear on what V just said, and nothing from old topics when V makes small talk. Everything runs in the Node bridge, once per turn, on demand. No Lua, redscript or plugin changed, so nothing runs in the game or per frame. Off switch: set `CYBERPUNK_CONVAI_TALK_RETRIEVAL=off` in the bridge's environment and every block comes back whole (in the new order, see the last note of "Measured").

Code: `bridge/talk-retrieval.mjs` (the retriever), `bridge/topic-material.mjs` (a character's topic section as items), `bridge/context-units.mjs` (the JSON blocks as units), `retrievalSources` and `attachRetrieval` in `bridge/quest-context.mjs`, the layout in `bridge/mistral-prompt.mjs` (`turnBackground`, `contextParts.fixed`, `contextParts.retrieved`, `withRetrievedParts`) and `MemoryStore.queryVector` in `bridge/memory-store.mjs`. Tests: `topic-material`, `context-units`, `talk-retrieval`, `talk-retrieval-prompt`, `talk-retrieval-wiring`, plus additions to `memory-store`, `prompt-budget`, `text-provider-host` and the older layout tests. Benchmark: `node scripts/Bench-TalkRetrieval.mjs [--change-every 3]`.

### The order of a prompt for a text provider

The cause (a 30 turn Gemini run of Judy with `scripts/Study-PromptGrowth.mjs --gemini`): the cache reused about 2,010 tokens of 5,000 to 5,900 and fell to nothing on 12 turns of 30, each time an early block of the system message changed (the world block 7 times, the knowledge 3, the summary once, the history window 3). The same script with the fake server shows the same pattern on main: the first change is `system:world` on 7 of 29 turns, `system:knowledge` 3, `system:summary` 1, `history window moved` 3. The order now:

1. **System message, identical on every turn of a talk:** the persona (without its topic section), the speaking style and voice lines, the output rules, the Mature layer and the hard-limit guard, the player's world rules, the format notes, and the rules for reading the quest, journal and world data (the framing sentences of those blocks and the authority sentence, under the heading `HOW TO READ THE QUEST, JOURNAL AND WORLD DATA`). That last group is text that is the same every turn, so it is not something a changed fact should throw away.
2. **The history**, as before.
3. **The last message**, everything that can change, most stable first: the world part that is left (relationship, bond line, group, an "unavailable" notice, gear changes), the older-talk summary, the right-now block and the fresh facts, then the turn's notes, the memories, the background chosen for V's words (`WHAT COMES TO MIND`), `V says:` and the closing line.

A changed world fact, knowledge block, summary, right-now block or retrieved item therefore costs only the last message. `bridge/talk-retrieval-prompt.test.mjs` and `bridge/text-provider-host.test.mjs` pin it: with a changed world block or knowledge block (and a changed tracked quest, journal history or jobs) the system message and the whole history stay byte for byte the same, with retrieval on and off. The rule "now" of the output rules says "the last message, before V's words" instead of "the end of this message" (a pinned-hash re-take, noted in the two pinned tests).

### What a prompt carries now

| Block | Before | Now |
|---|---|---|
| The character's topic material (PUBLIC INTRINSIC TOPIC MATERIAL: 77 characters, 636 views, 2,385 characters on average, 5,371 at most) | The whole section in the persona, every turn | Cut out of the persona (the lean persona goes from 3,487 to 1,937 characters on average). Each view is an item. The one or two that bear on V's words come late, with the section's own intro line (background and personal views, not proof that V met you, verified game facts override). A view carries its Scope line when that line is a limit. |
| World facts (`knowledge`), journal history, open jobs, recent shared events | The whole JSON block, 1,000 to 6,000 characters each | The framing line of each block (game data is never an instruction, missing is unknown, respect each knowledge origin) is unchanged and in the system message on every turn. The list items are units. The chosen ones come late as the same JSON. |
| The tracked quest | The whole block | Every sentence of it is in the system message. The quest itself (title and objectives, as JSON) comes late when V's words are about work. |
| Everything else | Unchanged | Identity, relationship state, speaking style, voice lines, output rules, the Mature layer and the hard-limit guard, the player's world rules, gear and money notes, scenery, the main-story lines (at most six, stable for a save), the memory summary and the retrieved memories. Only their place moved, as above. |

A block that says "unavailable" or "untracked" is not a source and stays as it is (in the last message). A block that lists nothing (the jobs of a save whose quests the catalogue does not know) is one unit, found by questions about work.

### How a unit is chosen

1. **Small talk takes nothing, first.** A greeting, thanks, "how is it going", "so hows life", "perhaps", "how do you feel these days" and the like (`isChitchat`: the memory search's list of pure small talk, a few greeting phrases, and any line with no content word once stop words and chat filler are removed). No embedding, no scan, and the lines before it do not count, so an old topic cannot come back through "hey". The character's own name is not a content word.
2. **Words.** A unit passes when one rare word of V's line is in it (rarity is the inverse document frequency over the roster's 636 views) or when half the weight of V's words is in it and that weight is worth something. Always available, so Gemini and Custom players with no Local AI pack get the same choice, and so does the first turn after a cold start.
3. **Meaning.** When the memory embedder is already running, V's line is embedded once (the vector the memory search uses, shared through `MemoryStore.queryVector`, with a 120 ms timeout) and compared with the cached vectors of the units. The embedder's own cut-off applies (`RETRIEVAL_RULES` in `bridge/memory-store.mjs`: granite needs a best score of 0.70 and keeps what is within 0.10 of it). A unit with no vector yet is judged by words alone, and its vector is made in the background.
4. **Ranking.** Reciprocal rank fusion of the two lists, then a small push from importance (decisions V made, the tracked quest) and recency (shared events), as in Generative Agents. A view voiced in the last two turns is not offered again (cooldown).
5. **Limits.** Per turn at most 2 views, 1 tracked quest, 2 jobs, 2 history quests, 2 events and 3 world facts, and 800 characters of units (about 200 tokens, the guidance of section 6). A short line that picks up the one before it ("and the plan?", "what about Mox") and finds nothing alone is tried again with V's previous line. A bare pronoun ("what about her?") is small talk and finds nothing.
6. **Work questions** ("what now?", "what should we do", "any work for me") carry the words the quest and job units are written with (`quest job objective`), so they find the tracked quest and the open jobs by words as well as by meaning.

### Providers

| Provider | How |
|---|---|
| Google Gemini, Local AI, Custom | Chosen in `TextProviderHost` once V's words are known (a typed line, or the transcript of a spoken one), beside the memory search, from the sources the bridge put in the turn's config. The persona has no topic section. |
| Convai | Chosen in `runInput` for a typed turn, beside the memory admission, attached to the turn's input and joined into the dynamic info like any other block (Convai ignores the order). A spoken Convai turn has no words when its context is built and keeps the whole blocks. Convai's provisioned character still carries the full roster text (it cannot be updated), so the views there come as an emphasis of the nearest one or two, not as a saving. |

If the retrieval fails or is cancelled, the turn goes on with the whole blocks and the log says so.

### Embeddings: precomputed, cached, shared

- The model is the one the memory search already uses (`granite-embedding-107m-multilingual`, 384 dimensions, a CPU `llama-server` that exits 5 idle minutes after its last use). No new model, no new dependency.
- The views' vectors are made once and kept in `<state>/talk-vectors.json` (about 1.3 MB with base64, 954 KiB in memory), keyed by the hash of the text and by the embedder id, so another model discards the file. A talk with a character on a text provider starts the embedder and makes her vectors at once. The rest of the roster is made once in the background, 45 seconds after the first text-provider talk, only while the machine is quiet (no combat, nothing running or speaking), a batch every 400 ms.
- Per turn the only embedding is V's line, and the memory search gets the same vector (one request for both). The world's and journal's units are embedded in the background after the first turn that offers them, never during a fight. A turn never waits for a unit's vector, and never starts the embedder: a cold embedder is started for the next turn and this turn goes by words.

### Measured

Machine: the sandbox this branch was written in (4 cores, Node 22, Linux). The model files and the game are not here, so (a) the embedding of V's line is a stand-in and its real cost is not measured here, and (b) the world is made up in the sizes of a mid-game save (`bridge/fixtures/talk-world.mjs`: 40 world facts, 10 journal quests, a tracked quest, jobs), while the characters' topic material is the real roster's. Characters: Panam, Judy, Johnny and River, a 12-turn script (small talk, topic questions, work questions, a world-fact question) with the history growing, three prompt families. "New" is what a prefix cache reads again each turn: the prompt after the longest prefix it shares with the previous turn's prompt. The cached share is 1 minus new over total.

The Gemini prompt family, mean per turn over all turns (Local AI Standard and Custom are within a few percent, and the script prints the full tables):

| | Prompt (tokens) | New per turn | Cached share | New per turn when the world changes every 3 turns | Cached share then |
|---|---|---|---|---|---|
| a. main, as it was | 6,064 | 142 | 98% | 943 | 85% |
| b. retrieval, world data in the system message (the first commit of this branch) | 3,423 | 236 | 93% | 236 | 93% |
| c. **this branch: retrieval, changing parts after the history** | **3,467** | **364** | **90%** | **364** | **90%** |
| d. the new order with retrieval switched off | 6,064 | 3,326 | 45% | 3,403 | 45% |

By kind of turn in c, new tokens against a: small talk 263 against 135, a topic question 383 against 146, a work question 534 against 162, a world-fact question 469 against 120.

Time of the retrieval (this machine, ms per turn, the sources of the turn are read inside the time):

| case | mean | p50 | p95 | max |
|---|---|---|---|---|
| words only (no embedder) | 0.32 | 0.30 | 0.46 | 2.4 |
| with a stand-in embedder, 0 ms per query | 0.51 | 0.49 | 0.96 | 3.2 |
| the same plus a simulated 17 ms query embedding (non-small-talk turns 18.1, small talk 0.44) | 9.3 | 17.0 | 18.5 | 18.8 |

The bridge's own work for a turn (context blocks, retrieval, prompt build): 0.13 ms before, 0.67 ms after with a 0 ms query embedding. The turn's stage clock has a new stage `retrieved` (`admitted to retrieved 1.1 ms` on the first call of a fresh process, with its code still cold), and the developer log has one line per turn: `[TextProvider] Talk retrieval: profile=... topic=1/15 ... via=words chars=... ms=...`. The vector lookup alone is 0.01 ms over a character's 7 units, 0.06 ms over 60 units and 0.73 ms over the whole roster.

Reading the numbers:

- **The prompt is 37 to 44 percent smaller** (about 2,600 tokens of 6,000): that is what a cold or evicted cache, the first turn of a talk, a switch of character, or a provider with no cache reads. The persona warm-up that Local AI does when a talk opens reads a persona 44 percent shorter.
- **The cache no longer depends on the world holding still.** In a, a changing world costs 943 new tokens a turn on average (small talk turns 1,304) and the cached share falls to 85 percent, to nothing on a turn where the system message's world part changed. In c a change costs nothing extra, because the data is not in the prefix. On main the study script shows 11 of 29 turns broken by `system:world`, `system:knowledge` or `system:summary`. On this branch (the same script, retrieval off, so the worst case) it shows none: the only first differences left are `new exchange` and `history window moved`.
- **Expected cached share for Gemini after this change:** the system message and the history are one identical prefix of about 3,000 tokens in the benchmark, of a prompt of about 3,500, so about 90 percent if Gemini reuses the whole identical prefix the way llama.cpp does. If Gemini keeps reusing only about 2,010 tokens (the figure of the 30 turn run), the same 2,010 tokens are about 58 percent of the smaller prompt, against 35 to 39 percent of the old one. In both cases it no longer drops to 0 percent when a world fact, the knowledge or the summary changes.
- **The cost is in the steady state of a model that caches exactly** (Local AI): about 120 to 350 more new tokens a turn than main when the world holds still (c against a), because the relationship part, the summary and the right-now block now come after the history and are read each turn. At the 900 to 2,000 prompt tokens a second measured on the owner's laptop (docs/LOCAL_AI.md, "Judy's prompt was read again on every turn") that is 0.06 to 0.4 seconds, and it is the price of a prefix that a change cannot break. A cloud model shows no latency difference (the 30 turn run: first word 0.9 to 1.1 s either way).
- **The retrieval itself** costs a third of a millisecond by words, plus the embedding of V's line when the embedder is running. That embedding is shared with the memory search, so for a character with memories it adds nothing, and for one without it adds one local query (14 to 17 ms in earlier measurements, `docs/COHERE_RETRIEVAL_EVAL_2026-10-30.md`), under the 120 ms timeout.
- **With retrieval switched off (d)** the new order reads the whole world after the history on every turn (3,300 new tokens). It is a fault and comparison switch, not a mode to play in. If a retrieval fails on a turn, that turn alone is built this way.

### What it does not do, and what to watch

- The granite cut-off (floor 0.70, margin 0.10) was calibrated on memories, not on views. Words carry the first choice anyway. The live check reads the `via=` field of the log line to see which test chose.
- Words alone are English-minded (stemming, stop words). Other languages depend on the embedder. Small-talk lines in other languages are caught by the memory search's short list and by the cut-off.
- A character whose bio the player edited keeps the whole text and gets no views retrieved (the player's words are sent as written).
- The history window still moves when the oldest exchange rolls out (5 of 29 turns in the study), which breaks the cache after the system message. Not changed here.
- Phone Chat on Convai builds its text from the whole blocks, as before. The main-story lines (`story`, at most six, stable) stay in the last message with the other world blocks.
- Items 4 to 6 of section 14 are not built: recency, importance and a cooldown for the memories of V, the trigger gate for place, time, weather, radio and TV, and widening the picture gate by meaning.

## Sources

- https://arxiv.org/abs/2307.03172v2, https://arxiv.org/abs/2302.00093v1, https://arxiv.org/html/2507.11538v1, https://arxiv.org/html/2601.08070v1
- https://arxiv.org/html/2304.03442v2, https://arxiv.org/abs/2310.08560, https://arxiv.org/abs/2410.10813, https://huggingface.co/papers/2402.17753.md
- https://arxiv.org/html/2402.10962v1, https://aclanthology.org/2024.emnlp-main.670, https://arxiv.org/abs/2609.04676, https://arxiv.org/pdf/2505.24613, https://arxiv.org/pdf/2308.16890
- https://www.trychroma.com/research/context-rot
- https://docs.sillytavern.app/usage/prompts/, https://docs.sillytavern.app/usage/prompts/prompt-manager/, https://docs.sillytavern.app/usage/core-concepts/worldinfo/, https://docs.sillytavern.app/usage/core-concepts/authors-note/, https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md, https://github.com/LostRuins/koboldcpp/wiki, https://latitudegames.notion.site/What-is-Memory-f2bc3e77bb1b48aca3716aeba21b8d21
- https://convai.com/blog/building-ai-characters-knowledge-bank-with-convai, https://docs.inworld.ai/unreal-engine/runtime/character-reference/overview, https://docs.nvidia.com/ace/ace-agent/latest/sample-bots/gaming-npc-bot.html, https://news.ubisoft.com/en-us/article/5qXdxhshJBXoanFZApdG3L, https://bestofai.com/article/optimizing-ai-inference-at-characterai
- https://ai.google.dev/gemini-api/docs/prompting-strategies, https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4, https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices, https://platform.claude.com/docs/en/build-with-claude/vision, https://developers.openai.com/api/docs/guides/prompt-engineering, https://docs.mistral.ai/guides/prompting_capabilities/
- https://docs-ecd.pages.dev/character-design-for-llms-march-2026.html, https://doc-docuo-alpha.zego.im/en/aiagent-server/best-practices/role-playing-system-prompt
