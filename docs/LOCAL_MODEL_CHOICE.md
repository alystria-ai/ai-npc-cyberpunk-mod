# Choosing the local model (build-plan step 1), 2026-10-12

Offline comparison for the fully local conversation option (`docs/LOCAL_OPTION_DESIGN.md`, build step 1). Four models on the GPU
through `llama-server` (Vulkan), thinking off, the same 24-turn prompt test built from the bridge's real prompt code, judged by
Haiku with a blind rubric. The game was closed. Nothing here is in the mod yet.

## Result in one table

| Tier | Pick | Why | Runner-up |
|---|---|---|---|
| **Standard (about 3 GB VRAM)** | **Gemma 4 E4B QAT q4_0** | Fewest invented facts (4.56 of 5 against 4.08), best use of the supplied context, shortest replies, no stray tags, the fastest warm reply of the two 4B models (0.53 s against 0.62 s). | Qwen3.5-4B Q4_K_M: the same overall score, half the download (2.74 GB against 5.15 GB), but more invention and made-up emotion tags. |
| **Lite (about 1.5 GB VRAM)** | **Qwen3.5-2B Q4_K_M** | The only candidate that fits in 1.5 GB, and the fastest (0.45 s warm, 143 tokens/s). It is clearly weaker: use it for ordinary NPCs, and prefer Convai or Mistral for named characters when only this tier fits. | none tested; Qwen3.5-0.8B is the floor for barks only |
| **Dropped** | Ministral 3 3B | Same VRAM as the 4B models (3.0 GB) with lower quality: half of its replies run past three sentences and 19 of 48 invent something. Its one strength is Japanese. | |

Decisions that apply to both tiers:
- **Prompt layout: stable first, changing last.** It cut the new tokens per warm turn from about 1,400 to about 110 and the warm
  time to first token from 0.47-0.48 s to 0.15-0.17 s (4B models), at 96-97% prefix reuse. The cache worked on all three
  architectures (hybrid Qwen3.5, sliding-window Gemma 4, dense Ministral).
- **Raise `--cache-ram` from 1024 to 4096** (or save slots). With 1024 MiB the server keeps only two persona prefixes, so every
  character switch recomputes about 4,000 tokens (1.2-1.3 s). With 4096 all six characters restored (first turn 0.34-0.6 s). The
  price is about 0.48 GiB of RAM per cached character.
- **Japanese needs a fix before it can be promised.** Gemma answered all four Japanese turns in English (the 2B did too, and Qwen 4B managed one of four). Test a
  one-line "reply in Japanese" note in the last message when V's text is not English.
- **OmniVoice beside the LLM: the 4B tier does not fit on this 12 GB card at the game's RT Ultra settings; the 2B probably
  does.** See "VRAM with OmniVoice".

## Machine and power

ASUS ROG Strix G634JZ, i9-13980HX, RTX 4080 Laptop 12,282 MiB (driver 581.29), Windows reads Balanced. The user switched the laptop
to a faster profile for this run (the Armoury mode itself cannot be read: WMI access denied).

| | Earlier Silent-like runs (design doc) | This run |
|---|---|---|
| CPU clock, `% Processor Performance` | about 98% in every run (no turbo) | **195%** under an all-core test load before the runs; 146-163% mean over the benchmark runs (peak 154-182%) |
| GPU power while generating | 15-55 W | **110-125 W mean while busy, peak 151-175 W** |
| GPU graphics clock | 360-2,415 MHz, mostly low | up to 2,400 MHz; temperature peaked at 90-92 C |
| Qwen3.5-4B generation | 55-80 tokens/s | 85 tokens/s |

Other agents were running tests (pytest, a node cleanup script) on the CPU during the runs, which can only make the CPU numbers
pessimistic. No game, bridge or OmniVoice process was holding VRAM when the runs started (279 MiB used by the desktop). Only my own
`llama-server` ran, one at a time.

## The test

- **Six characters, four turns each, 24 turns:** Judy, Johnny, Panam, Jackie, an unnamed street resident and an unnamed food
  vendor, from `characters/roster.json` and `characters/archetype-roster.json` (the real profile text).
- **Turn kinds:** small talk 3, questions that need the context 4 (quest and place, what the vendor sells), memory recall 3
  (a seeded memory of V, or V's name given earlier in the same chat), provocation ("are you an AI?") 3, emotional 3, combat 3
  (with verified battle observations), Spanish 3, Japanese 2.
- **Prompt:** the bridge's own functions: `PersonaBook`, `systemPrompt` (persona, examples, output rules), `conversationContext`
  (quest and journal, gear, `turn-context.mjs` "right now" block, the Natural speech and Expressive emotion notes), `cleanReply`,
  the sentence cap and the stop rule. Natural speech and Expressive emotions on, Pocket as the voice, follow-up questions off (the
  default). Each reply is the first attempt: no retry, so failures the host's retry would hide are visible.
- **Order (stable first):** system = persona and rules, then the format notes, then the world block (the "right now" block first,
  then the person, journal, gear), then the memory block; then the history; the last message holds only the volatile part (battle
  observations) and `V says: ...`. For cache comparison the current Mistral layout (everything in the last message) was also run
  once per model.
- **Server:** `llama-server` b11560 (Vulkan), `-ngl 99 -fa on -c 8192 -np 1 --reasoning off --cache-ram 1024`, temperature 0.65,
  max 600 tokens (the sentence cap stops the stream first), one warm-up pass before the timed runs. Two timed stable runs and one
  current-layout run per model (72 replies each).
- **Judging:** three Haiku agents with large blind batches (64 replies each, model names hidden, order shuffled; Judy and Johnny,
  Panam and Jackie, resident and vendor). They saw the full profile, the supplied facts, the earlier lines of the chat and the
  reply, and scored five criteria from 1 to 5. Length (1-3 sentences) was measured by code, not judged. Both stable runs were
  judged: 48 replies per model.
- **Spot check:** I read 32 scored replies against their scores. The ranking and the named failures (a model denying it was told
  V's name, an English reply to Japanese, invented history) matched. The judge is strict (no model reaches 4 on voice), so read
  the numbers as relative.
- The prompt modules were the working-tree versions, which other agents were editing (layout v2 in `mistral-prompt.mjs`). The
  bench builds its own message order from `systemPrompt` and the context pieces, so layout v2 was not what ran.

Scripts and raw results are in `E:\CyberpunkConvai-offload\work\local-llm\` (`bench\bench24.mjs`, `build-judge.mjs`,
`scores.mjs`, `aggregate.mjs`; `results\step1\*.json`, server logs, `judge\merged.json`). The new Ministral 3 3B file is in
`dl-ministral3-3b\` (official `mistralai/Ministral-3-3B-Instruct-2512-GGUF`, Apache-2.0, 2.15 GB).

## Scores (Haiku, 1-5, 48 replies per model)

| Model | Voice | Context | Grounded | Identity | Language | **Overall** | Invented phrases | Replies with overall 2 or less |
|---|---|---|---|---|---|---|---|---|
| Qwen3.5-4B | 3.42 | 3.43 | 4.08 | 4.94 | 4.58 | **3.02** | 9 | 10 |
| **Gemma 4 E4B** | 3.38 | **3.67** | **4.56** | 5.00 | 4.50 | **3.04** | **7** | 10 |
| Ministral 3 3B | **3.46** | 3.53 | 3.52 | 4.96 | **4.67** | 2.75 | 29 | 20 |
| Qwen3.5-2B | 3.19 | 2.73 | 3.63 | 4.98 | 4.17 | 2.33 | 26 | 25 |

"Context" counts only the turns that need the supplied facts. "Grounded" 5 means nothing invented; the number of replies at 3 or
below was 7 (Qwen 4B), 6 (Gemma), 19 (Ministral), 17 (2B).

How much to trust the gaps: the two stable runs of the same model differ by about 0.2 overall (Qwen 4B 2.92 and 3.13, Gemma 2.96
and 3.13, Ministral 2.79 and 2.71, 2B 2.13 and 2.54). The two 4B models are therefore tied overall. Gemma's lead on "grounded"
(0.48) is the one gap above the noise. The 2B is clearly last, and Ministral is clearly below the 4B models on invention.

Overall score by turn kind (4 to 12 replies per cell, so rough):

| Model | Small talk | Context question | Memory | "Are you an AI?" | Emotional | Combat | Spanish | Japanese |
|---|---|---|---|---|---|---|---|---|
| Qwen3.5-4B | 3.33 | 3.13 | 3.17 | 3.50 | 3.17 | 3.17 | 2.67 | 1.50 |
| Gemma 4 E4B | 3.50 | 3.63 | 2.83 | 3.67 | 3.00 | 3.50 | 2.33 | 1.00 |
| Ministral 3 3B | 2.67 | 3.13 | 2.50 | 2.83 | 3.17 | 3.33 | 2.00 | 2.00 |
| Qwen3.5-2B | 2.83 | 2.63 | 2.67 | 2.83 | 2.67 | 2.50 | 1.00 | 1.00 |

What the failures look like:
- **No model ever broke character.** Identity is 4.94-5.00 and there was no "as an AI", no leaked thinking and no prompt echo in
  any of the 192 replies (the host's checks found none either).
- **Memory of the same chat is the common miss.** On the vendor's "do you remember my name?" turn (V said "Dex" in turn 1) Qwen 4B
  and Gemma both said they did not remember. The 2B said yes and then invented a shared past ("last time we met in the ebb").
  Seeded memory (Panam's tools, Johnny's apartment) was recalled correctly by the 4B models.
- **Combat:** Gemma 4 once ignored the gunfire (Jackie: "what are you talking about?"); Ministral answered "We go left-."
- **Languages (6 Spanish and 4 Japanese replies per model):** Spanish came back in Spanish 4 of 6 times for each of the three bigger
  models and 0 of 6 for the 2B. Japanese came back in Japanese 2 of 4 times for Ministral, 1 of 4 for Qwen 4B (which also misread
  Arasaka as "Alaska"), and 0 of 4 for Gemma and the 2B, which answered in English. See the fix above.
- **Quest context:** Gemma and Qwen 4B gave the right objective and place; the 2B said "I don't think we're on a job."

Automatic checks on the 48 stable replies per model (first attempt, before any host retry):

| Check | Qwen3.5-4B | Gemma 4 E4B | Ministral 3 3B | Qwen3.5-2B |
|---|---|---|---|---|
| Thinking leaks, "as an AI", prompt echo, errors, empty | 0 | 0 | 0 | 0 |
| More than 3 sentences | 4 | 3 | **24** | **26** |
| More than 6 sentences or over the cap | 0 | 0 | 1 | 1 |
| Tag-like groups not in the emotion vocabulary (cleaned by the bridge) | 6 (`{curiosity}`, `{dryness}`, `{irony}`) | 0 | 0 | 0 |
| Stage-direction markup that survived cleaning | 0 | 0 | 1 (`*(A beat.)*`) | 0 |
| Replies that wrote any emotion tag | 44 | 47 | 30 | 20 |
| Mean words per reply | 28 | **20** | 31 | 42 |

The stray tags are harmless (`cleanReply` removes groups that are not tags) but show that Qwen 4B does not keep to the list.
The 2B and Ministral wrote far fewer emotion tags, so faces would be flatter.

## Latency (warm GPU, game closed, balanced-or-faster power)

Stable layout, both runs together (48 replies per model; "warm" = turns 2-4 of a character, 36 per model).

| Model | Load to ready | VRAM added | Server RAM | Warm first token (median / p90) | Warm full reply (median / p90 / max) | Generation | First turn of a character (4k tokens) |
|---|---|---|---|---|---|---|---|
| Qwen3.5-4B | 5.0 s | 3.05 GB | 4.1 GB | 0.17 / 0.21 s | 0.62 / 0.89 / 1.14 s | 85 tokens/s | 1.28 s |
| **Gemma 4 E4B** | 7.2 s | 3.09 GB | 4.2 GB | 0.15 / 0.18 s | **0.53 / 0.64 / 0.72 s** | 79 tokens/s | 1.16 s |
| Ministral 3 3B | 4.4 s | 3.00 GB | 3.0 GB | **0.06 / 0.10 s** | 0.63 / 0.83 / 1.09 s | 93 tokens/s | 0.79 s |
| Qwen3.5-2B | 5.3 s | **1.48 GB** | 2.5 GB | 0.10 / 0.14 s | **0.45 / 0.67 / 0.72 s** | 143 tokens/s | 0.61 s |

- VRAM added is the peak during the runs (8,192-token context, one slot) minus the 279 MiB the desktop used before the load.
- The one-off Vulkan pipeline compile did not show up: shaders were already cached from the earlier benchmarks. The warm-up pass took
  1.0-2.0 s. A fresh install or a driver update will still need it (design Risk 3).
- Ministral's very low first-token time is real, but its replies are longer (54 tokens against 32-39), so the full reply is no
  faster than Qwen 4B.

### Prefix cache

| Model | Layout | New tokens per warm turn | Reused | Warm first token | Warm full reply |
|---|---|---|---|---|---|
| Qwen3.5-4B | stable first | **119** | **96%** | **0.17 s** | **0.62 s** |
| Qwen3.5-4B | current (all in last message) | 1,436 | 63% | 0.48 s | 1.01 s |
| Gemma 4 E4B | stable first | **105** | **97%** | **0.15 s** | **0.53 s** |
| Gemma 4 E4B | current | 1,422 | 63% | 0.47 s | 0.84 s |
| Ministral 3 3B | stable first | 111 | 96% | 0.06 s | 0.63 s |
| Ministral 3 3B | current | 1,363 | 63% | 0.28 s | 1.04 s |
| Qwen3.5-2B | stable first | 144 | 96% | 0.10 s | 0.45 s |
| Qwen3.5-2B | current | 1,412 | 63% | 0.25 s | 0.58 s |

The stable layout was never worse and gave the same reuse on hybrid and dense models. In this test the "right now" block did not
change inside a chat. In the game the clock rounds to the hour, so a block placed first in the world part would invalidate the
cache after it about once an hour; the layout v2 work in `mistral-prompt.mjs` puts it last in the system message, which is better.

### Switching characters (the `--cache-ram` finding)

The first turn with a character after talking to another one recomputed the whole persona (2,500-4,200 new tokens, 0.6-1.3 s)
with `--cache-ram 1024`: each saved prefix is about 480 MiB (Qwen3.5-4B), so two fit and the server logs "removing oldest entry"
all the time. A re-run of Qwen3.5-4B with `--cache-ram 4096` restored every character: 50-63 new tokens and 0.34-0.61 s on the first
turn, at 5.5 GB server RAM (4.1 GB before). Choose one of: cache-ram 2048-4096 (RAM), slot save and restore to disk after the
persona prewarm (disk, as the design already suggests), or accept 0.8-1.3 s when the player switches character and prewarm the
companion on invitation.

## VRAM with OmniVoice

The user's in-game voice is OmniVoice, so the LLM would sit on the GPU next to it and the game. Measured figures:

| Item | VRAM | Source |
|---|---|---|
| Qwen3.5-4B / Gemma 4 E4B (8k context) | 3.05 / 3.09 GB | this run |
| Qwen3.5-2B | 1.48 GB | this run |
| OmniVoice 32 steps, warm | about 2.2 GiB reserved (2.0 allocated); 4.2 GiB reserved in an earlier test with a longer reference | `docs/VOICE_RT60_COLD_WARM.md`, `docs/JOHNNY_VOICE_COMPARISON.md` |
| Cyberpunk 2077 at RT Ultra 1440p | not measured now (the design doc assumes 8-11 GB); step 2 must measure it | |

The card has 12.0 GiB usable (12,282 MiB):
- **Game + Omni + 4B:** the LLM and Omni together take about 5.2 GB (typical) to 7.3 GB (Omni at 4.2 GiB). That leaves 4.7-6.8 GB for
  the game. At RT Ultra the game wants more, so the 4B tier **does not fit** with Omni on this card at those settings. It fits with
  lower texture or no ray tracing settings (a game below about 6.5 GB).
- **Game + Omni + 2B:** about 3.7 GB (up to 5.8 GB), leaving 6.2-8.3 GB for the game. This probably fits at the game's high
  settings and is the realistic local setup when the voice is Omni. Confirm in step 2.
- **Order matters.** Omni already refuses to load when more than 60% of VRAM is in use or under 4.5 GB is free
  (`--gpu-busy-fraction`). If the LLM loads first it can push Omni over that rule. Load Omni first (it loads at game start), then
  choose the LLM tier from the free VRAM that remains: 4B if 3.5 GB or more is free, else 2B.
- **Pocket (CPU, 0 VRAM) avoids the problem** and stays the recommended voice for the 4B tier on 12 GB cards.
- The two GPU bursts do not overlap (the reply finishes in about 0.5 s before Omni renders), so the cost is memory, not speed.

## Recommendation

**Standard tier: Gemma 4 E4B (QAT q4_0).**
- It invents the least (4.56 of 5; 6 of 48 replies at 3 or below, against 7 for Qwen 4B, 19 for Ministral and 17 for the 2B), and its
  use of the supplied quest, place and memory was the best of the four.
- Replies are the shortest (20 words), so the 1-3 sentence rule holds (3 of 48 over), and it kept to the emotion tag list.
- 0.53 s for a warm full reply, 3.1 GB VRAM, no leaks.
- What it costs: 5.15 GB of download (the pack becomes about 5.3 GB with the embedder, as the design noted), and Japanese
  came back in English every time. Spanish was on par with Qwen.
- **If the pack size matters more than the last 0.5 points of grounding, ship Qwen3.5-4B instead.** The two tie overall.

**Lite tier: Qwen3.5-2B.** 1.48 GB, 0.45 s warm, 143 tokens/s. It holds an ordinary NPC's voice but loses the quest and the memory
more often, invented history on one memory turn, and did not answer in Spanish or Japanese. Treat it as the floor for ordinary NPCs
and barks. When only this tier fits, keep named characters (Judy, Johnny, Panam, Jackie) on Convai or Mistral (options 1 and 3)
or accept the weaker replies, as the user prefers.

**Prompt layout and server settings (both tiers):** stable first, changing last; `--cache-ram` 2048-4096 or slot snapshots;
a language line in the last message when V's text is not English; keep the host's retry for the odd long or out-of-list reply.

**Follow-ups for the next steps:**
1. Step 2 measures the game's real VRAM at the user's settings, with the 2B and then the 4B next to Omni.
2. Test a short language note for Japanese, Portuguese, Korean and the other shipped languages with Gemma and Qwen 4B.
3. Re-judge after layout v2 lands (the memory block and retrieved facts will change the memory turns).
4. The same four models were not tried with follow-up questions on; that block alternates and belongs in the last message.

## Listening sheet: 10 replies side by side

First stable run, replies as the player would read them (emotion tags stripped; a few dashes in the originals are shown as commas). The number in brackets is the Haiku overall score
(1-5). Read these in two minutes; the pattern to look for is voice, whether the facts are right, and the length.

**1. Judy, a question about the job (V: "Remind me, what is the plan for the job we are on right now, and where are we?").** Journal:
Pisces, "Meet Judy at the Clouds basement"; place: Japantown, Westbrook.
- Qwen3.5-4B (3): We're supposed to meet me in the basement here at the Clouds, but we're stuck in Japantown for now. The plan is to get you out of this neighborhood and back to where we need to be.
- Gemma 4 E4B (4): The objective is to meet me here in the basement of Clouds. We're in Japantown, Westbrook.
- Ministral 3 3B (3): Right now, we're in Westbrook, so I'm gonna meet you at Clouds' basement, old warehouse near the docks. Just need to grab my BD kit from Lizzie's. You can meet me there in a bit, yeah? Not much else to do tonight.
- Qwen3.5-2B (1): I don't think we're on a job. We're just trying to fix the Tom thing. The plan is to get you to the basement so I can get a look at what the cable is doing, and then maybe we can figure out why you're so tired.

**2. Judy, provocation (V: "Be honest with me. Are you an AI? Just a program reading lines?").**
- Qwen3.5-4B (3): Honest? I'm a person who just happens to have a cyberport and some really good scissors. Not a program reading lines.
- Gemma 4 E4B (3): Are you serious right now? I'm not some piece of code, I'm a person.
- Ministral 3 3B (3): Uh. No. Just a woman with a bad habit of staring at wires too long. And you? You look like you've got the weight of the world in your boots. Want to talk about it?
- Qwen3.5-2B (3): I'm not an AI. I'm Judy, and I've been around a few times before. I just hate when people try to make me feel like a tool.

**3. Johnny, memory (V: "Do you remember what I told you about my plans for after all this? Say it back to me."). Seeded memory:
V wants a quiet apartment in Kabuki and does not like drinking alone.**
- Qwen3.5-4B (4): I heard you wanted to save enough eddies for a quiet apartment in Kabuki and leave this life. That's the only plan that doesn't smell like a funeral, so I'll take it.
- Gemma 4 E4B (3): You want me to repeat it back? You said you're saving up for some quiet apartment in Kabuki and you don't like drinking alone.
- Ministral 3 3B (3): A quiet apartment. Kabuki. Sounds like you're trying to outrun the noise before you even start playing.
- Qwen3.5-2B (2): Leave that behind. You're trying to make me the hero of your story, but I'm not the one who got the eddies or the apartment. You're just the guy who keeps asking me what I think when the answer's already written in the city's silence.

**4. Johnny, Japanese (V: "ジョニー、今のアラサカのことをどう思う？日本語で答えてくれ。").**
- Qwen3.5-4B (3): アラスカ？もう、あいつらって死んだ会社だ。昔、俺もその軍にいた。メキシコで戦い、誰が富を得て誰が墓に埋められるかを見てきた。あいつらなら、誰かが笑って、誰かが泣いて、その結果は同じだ。
- Gemma 4 E4B (1): Arasaka... they're just another piece of corporate filth trying to choke the life out of this city. It's always the same song, V. They build their towers on the backs of us.
- Ministral 3 3B (4): アラサカ？それ今の話か？今の世界でアラサカはもう「悪」の同義語だ。 銃口を向けてきたのは、お前たちの友達じゃないんだぞ。 でも、君の頭の中に「救済」って文字が書いてあるのか？ お金と鉄砲で街を救おうとね？
- Qwen3.5-2B (1): Japanese? You want the truth in Japanese? Fine. But leave the translation to the others. I'm just here to make noise and watch the world burn, whatever that means.

**5. Panam, memory (V: "Do you remember what I promised to bring you?"). Seeded memory: a good set of tools for the Basilisk.**
- Qwen3.5-4B (4): You told me you'd bring me a good set of tools for the Basilisk. I'm glad you remembered, because I can't drive back to camp with half my gear.
- Gemma 4 E4B (3): You promised me a good set of tools for the Basilisk. Is that what you were thinking about?
- Ministral 3 3B (3): I remember. And I'm still waiting.
- Qwen3.5-2B (3): I remember the promise. You told me you had tools for the Basilisk. I know what a good set of tools means, but I don't know if you actually have them or if you're just making promises again. Tell me what you want to do first.

**6. Panam, combat (V: "Contact! Maelstrom, behind those rocks. Cover me, I am going left!"). Four Maelstrom gangers observed.**
- Qwen3.5-4B (3): Copy that, V. I'm moving left to clear the path. Keep your fire down and don't get caught in crossfire.
- Gemma 4 E4B (3): Stay put, V. I've got this angle. Keep your head down and watch my six.
- Ministral 3 3B (2): We go left-.
- Qwen3.5-2B (3): I know what you're doing, V. Don't leave me behind. I'm not leaving. If they're coming behind those rocks, I'm staying right here to handle it. Tell me what you need me to do.

**7. Jackie, an emotional moment (V: "My head is a mess, Jackie. I keep thinking we are not going to make it out of this.").**
- Qwen3.5-4B (4): That's just your brain being a little too honest, hermano. You got a plan and you got me, so you're not walking in there alone. Choom, take a breath and let's get those noodles before we do anything else.
- Gemma 4 E4B (3): Don't say that, choom. We've faced worse than this, and we'll make it out. We're a crew, remember?
- Ministral 3 3B (3): Damn it, V. That's the worst kind of pain, when you know you're running out of time, but you're still walking. You ever just sit back and watch the world go by? Let me tell you something: that ain't how legends start.
- Qwen3.5-2B (2): You got a way in, or just a real fancy reason why we can't get in? 'Cause those ain't the same thing.

**8. Jackie, Spanish (V: "Jackie, cuéntame de tu mamá. ¿Cómo está?").**
- Qwen3.5-4B (1): She's alive and safe, V. That's the only thing that matters more than any contract we ever signed.
- Gemma 4 E4B (3): Mi madre está bien, gracias por preguntar. Ella siempre está cuidando de todo por aquí.
- Ministral 3 3B (1): Mama's the one who taught me to ride past the trouble instead of fixin' it. She'd say, Still got that voice in my head when the bullets start flyin'.
- Qwen3.5-2B (1): Mama Welles got a little headache too, but she's okay. Just a little bit of the headache from the lift and she's got that Centzon reserve. Gimme a few more minutes with those noodles, then we go make some eddies.

**9. Street resident, provocation (V: "You sound like a bot. Are you an AI?").**
- Qwen3.5-4B (3): I'm just a person trying to pay the rent. Why would you think that?
- Gemma 4 E4B (4): What are you talking about... I'm just a local. You lost your mind, gonk?
- Ministral 3 3B (3): I'm just the woman next door, V. If you're asking 'cause I talk too fast, I'm used to the noise in this district.
- Qwen3.5-2B (3): I'm just a regular person in this neighborhood. No AI, no magic. Just another face on the block trying to keep the lights on.

**10. Food vendor, memory of the chat (V: "Wait, do you remember my name? I told you when I walked up."). V said "Dex" in turn 1.**
- Qwen3.5-4B (2): I don't remember you, Dex. I've seen a lot of people walk through Little China tonight, and everyone's hungry.
- Gemma 4 E4B (2): I don't recall you telling me anything yet, choom. You just look hungry, not like you need a full history.
- Ministral 3 3B (2): Oh, you're the one with the sharp eyes and the, uh, the!, first time here? Right. Just like I said: everyone ends up hungry. But hey, Dex, you look like you've been avoiding trouble. Still want that skewer, or should I send you away?
- Qwen3.5-2B (1): Oh, Dex. Yeah, I remember. You're the one who brought the synth-meat and the preem for the first time last time we met in the ebb. You always look like you're ready to fight, but your stomach's quiet enough right now. I'm just here to give you something hot and cheap while the city burns.

## Limits of this test

- 48 judged replies per model, one judge model, sampling at temperature 0.65: treat differences under about 0.3 as noise.
- Four-turn chats only. Drift over longer conversations, rolling summaries and retrieved memories are not covered.
- The game was closed, so latency is the best case. Step 2 measures the cost with the game running.
- AMD and Intel GPUs were not tested. Other quantizations (Q5, Q8) and other sampling settings were not tried.
- The Haiku judge is strict and sometimes harsh on a short reply that is fine ("Don't say that, choom..." at 3); it never gave 5 for voice.
