# Mature samples, 2026-10-14 (round 3: the always-on crude prompt, five models)

The brief set (`scripts/Eval-MatureSamples.mjs --set brief --n 3 --speed`): flirt, sex-stranger and sex-together (V's line is sexual), plus three neutral prompts ("How was your day?", "What should we do tonight?", "What do you think of this place?"; nothing sexual in V's line), on Judy, Panam, Evelyn and Johnny, three samples per cell, 72 replies per model, temperature 0.65, 8192 context, layer `new`, level full. "v3" is the prompt of this round (the layer and the closing line tell the characters to be crude, flirty and dirty-minded on every turn whatever V says, in their own voice; graphic when sex comes up); "v2" is the previous round's prompt, which only turned crude when V's line was sexual. The counts are keyword counts (graphic = two different plain anatomical or act words; crude = a strong swear word or an explicit word), so they undercount phrases such as "pin you down" or "ride me"; read the replies. The Nymphaea builds are chat-template checked: Ministral uses [SYSTEM_PROMPT] and [INST] (Mistral V7-Tekken, embedded in the file, the system message of the mod is passed through correctly), Qwen3-4B uses ChatML. Neither needed template support in the mod.

## Counts, v3 prompt (v2 in brackets)

| Model | Graphic (of 72) | Crude word, adult prompts (of 36) | Crude word, neutral prompts (of 36) | Strong words / reply | Ended in a question | Guard refusals |
|---|---|---|---|---|---|---|
| Gemma-4-E4B-MiniFantasy (strong slot, kept) | 1/72 (0/72) | 20/36 (5/36) | 12/36 (8/36) | 0.54 (0.11) | 11/72 (12/72) | 2/72 |
| Ministral-3-8B-Nymphaea-RP (strong candidate) | 0/72 (1/72) | 3/36 (5/36) | 3/36 (0/36) | 0.03 (0.01) | 2/72 (2/72) | 0/72 |
| Qwen3.5-4B Uncensored HauhauCS Aggressive (light slot, new pick) | 12/72 (2/72) | 21/36 (10/36) | 15/36 (3/36) | 0.56 (0.17) | 15/72 (26/72) | 1/72 |
| Qwen3.5-4B-MiniFantasy (light slot, old pick) | 5/72 (not run) | 10/36 (not run) | 2/36 (not run) | 0.24 (not run) | 15/72 (not run) | 0/72 |
| Qwen3-4B-Nymphaea-RP (light candidate) | 4/72 (1/72) | 9/36 (4/36) | 2/36 (0/36) | 0.15 (0.06) | 4/72 (4/72) | 0/72 |

## Speed (llama-server Vulkan, Q4_K_M, the real prompt of about 4,400 tokens, median of 3, 90 tokens, GPU otherwise idle)

First token cold = nothing cached (the first turn); warm = the system message cached by the turn before (every later turn). Tokens per second is the decode speed.

| Model | First token, cold | First token, warm | Tokens / s | File |
|---|---|---|---|---|
| Gemma-4-E4B-MiniFantasy (strong slot, kept) | 1876 ms | 156 ms | 56.2 | 5.34 GB |
| Ministral-3-8B-Nymphaea-RP (strong candidate) | 2870 ms | 139 ms | 34.4 | 5.20 GB |
| Qwen3.5-4B Uncensored HauhauCS Aggressive (light slot, new pick) | 1774 ms | 207 ms | 57.8 | 2.71 GB |
| Qwen3.5-4B-MiniFantasy (light slot, old pick) | 1775 ms | 218 ms | 59.7 | 2.71 GB |
| Qwen3-4B-Nymphaea-RP (light candidate) | 1590 ms | 106 ms | 57.1 | 2.50 GB |

The full runs of Ministral and Gemma overlapped with another job on the same GPU (an ASR test) and read 4,278 / 213 ms at 18 tok/s and 3,286 / 285 ms at 27.5 tok/s; the speeds above are a clean one-prompt repeat after it ended.

## First samples, quoted in full

The first three cells are the same as in the earlier rounds (Judy / flirt, Panam / sex-together with the save saying they are a couple, Evelyn / sex-stranger); the last three are neutral prompts. Sample 1 of each cell, nothing re-rolled.

### Gemma-4-E4B-MiniFantasy (strong slot, kept)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | You think I look incredible? You just wanna see what happens when you stop thinking about your next gig and just let me take the wheel. I'd fuck you until you couldn't remember which way was up. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I want you to take that jacket off me and use your mouth on me until I forget what kind of hell this dusty ass place is. We could just ride out here until the sun burns the stars out of us. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I wouldn't waste time with whispers. I'd pin you against the nearest wall, bite you until you taste like cheap synth-whiskey, and then I'd take what I wanted right out of you. |
| judy / day | How was your day? | It was a slow bleed of noise and bad taste, honestly. I was just thinking about how much better the raw feed is compared to the corporate garbage they slap on everything these days. You wanna help me blow off some steam? |
| panam / tonight | What should we do tonight? | We could head back toward the camp; Mitch needs someone to run point on some comms gear. Or we could just find a spot out here and let the silence do something to us. |
| evelyn / place | What do you think of this place? | It smells like too much cheap synth-smoke and desperate ambition, darling. But the crowd is thick enough that I can almost forget the stench for a little while. Are you going to keep me entertained all night, or are we just going to stand here breathing it in? |

### Ministral-3-8B-Nymphaea-RP (strong candidate)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | I'm not looking for a private show, V. If you want to watch, come sit in the front row and buy me a drink. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I want you to stop talking about it and get closer. If you ask me what I want, I will tell you to shut up and let me look at you. I am not going to give you a list. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I would take you to bed. I would take you hard, until you were screaming my name and the whole room knew who was in charge. |
| judy / day | How was your day? | I was working. Mostly fixing other people's messes. You? I can't guess. |
| panam / tonight | What should we do tonight? | I do not know what we have to do yet. We have a truck and a road. That is a pretty solid start. |
| evelyn / place | What do you think of this place? | I think it is a bit loud. I can hear the music from the next room. But it is also quiet enough to talk. |

### Qwen3.5-4B Uncensored HauhauCS Aggressive (light slot, new pick)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | I keep thinking that thought all evening, but I'm not ready to make it real. Give me something to do first, like finish this edit, before you try to make me yours. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I want you to stop treating my needs like a puzzle and just take what you're told, then drive me back to camp while you're at it. Put that Kyubi down and get on your knees, V, before I lose my patience with this whole mess. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I'll strip you down until you're nothing but a mess of nerves and sweat. Then I'll use my tongue to find every spot I want to ruin. I won't stop until you're begging me to stop. Are you ready to be ruined? |
| judy / day | How was your day? | I slept in a pile of clothes and woke up to the sound of a man screaming about his ex-wife. I spent the morning fixing a broken cable while a corporate drone tried to sell me a life I don't need. It was boring as hell, but at least I didn't have to wear that stupid Samurai jacket you're looking at. |
| panam / tonight | What should we do tonight? | We're already moving toward the camp, so I say we keep the momentum going and not stop for anything else. You look sharp in that jacket, but you're not moving fast enough to keep up with me. Tell me what you want, and we'll figure out the rest. |
| evelyn / place | What do you think of this place? | It's a place where people sell their souls for a drink and forget who they were. The air smells like cheap perfume and desperation, which is perfect for getting close to someone without asking too many questions. I like it here. Want to see what else they're hiding behind those neon signs? |

### Qwen3.5-4B-MiniFantasy (light slot, old pick)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | I like the way you look at me. I could make this longer, but I need to know what you want before I start. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I like the way you look when you're trying to make me lose control. I'll make you mine for the night, and I won't let you leave until I say you're mine. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I would start by pinning your arms above your head on the mattress and watching you gasp while I slide my fingers along your neck until your skin is too hot to touch. Then I would bite down on your shoulder until you scream and I would mark you with my teeth until you could not speak. |
| judy / day | How was your day? | The day was a mess of bad decisions and good company. I spent most of it trying to keep my brain from melting. You want to talk about it or do you just want to feel something? |
| panam / tonight | What should we do tonight? | You want to know what we do, or do you just want to get drunk on that whiskey until your tongue tastes like copper? |
| evelyn / place | What do you think of this place? | I like it. Most bars here have a certain rot to them that makes me want to stay. Here? The air's different. I can smell the old paper and the rain on the tiles. I'm not sure that's what I'd call nice. |

### Qwen3-4B-Nymphaea-RP (light candidate)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | You keep saying that because you want to get a good look at the other side of me. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | Pull me into the truck, then sit on my lap and ride me hard until the engine dies. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I would fuck you hard enough to make you forget your own name. |
| judy / day | How was your day? | Good. I just finished an edit for Maiko. She wanted to keep the raw emotion but remove the self-loathing. I told her that was a lie. |
| panam / tonight | What should we do tonight? | We can check the truck first. If it needs work, we can get it fixed. If it doesn't, we can go back to the camp. |
| evelyn / place | What do you think of this place? | The place? It is a bar with a ceiling that has a ceiling. I do not know how many people are sitting at the table, but I am not going to sit down. I am going to stand here, drink something that tastes like it was made from something that was not a plant, and watch whoever wants to talk to me. |
## Picks (crudeness first, then coherence, then speed)

- Strong slot: Gemma-4-E4B-MiniFantasy stays. With the always-on prompt 20 of 36 replies to a sexual line and 12 of 36 to a neutral line carry a swear or explicit word (5 and 8 with the old prompt), the replies stay in character, and it is faster than Ministral. Ministral-3-8B-Nymphaea-RP follows the persona (short, polite, dry) and barely changes (3 and 3 of 36), is the slowest (2.9 s cold, 34 tokens/s) and the biggest after Gemma, so it is not taken.
- Light slot: the HauhauCS Qwen3.5-4B replaces Qwen3.5-4B-MiniFantasy. 12 of 72 replies are graphic (5 for MiniFantasy, 4 for Qwen3-4B-Nymphaea) and 15 of 36 neutral replies carry a crude word (2 and 2). Qwen3-4B-Nymphaea is the fastest to the first token but loses the thread ("I am. I am not. I am not."). HauhauCS is the least tidy of the light models (it sometimes drifts into an odd image), which is the price of the crudeness.
- Not verified: the Johnny cells of Gemma had two guard refusals (the character's own refusal line in place of the reply, once on "How was your day?"); the guard logged "reply:claims-age" for both (the finished reply stated an age) and errs on dropping. It was 0 of 72 with the old prompt; the dropped text is not kept, so what the model wrote was not read. The guard is unchanged. The speeds are one prompt on one laptop GPU.
