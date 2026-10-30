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
