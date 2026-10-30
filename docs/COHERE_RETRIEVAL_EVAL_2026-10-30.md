# Would Cohere embeddings and reranking make the replies better? (2026-10-30)

Owner question: "Check if adding Cohere as another provider for text, but more importantly its embedding model and reranking model, would be a good option. See if adding them gives value to responses."

Branch `eval/cohere-retrieval`, offline only, the game was not touched. Scripts are in `scripts/eval-retrieval/` (no keys inside, keys are read from the keys file at run time). Everything derived from the owner's real saved memories stays in the git-ignored `scripts/eval-retrieval/local/`.

## Recommendation

**Do not add Cohere embed or rerank. Use a better local model instead, and only after one more measurement.**

1. **Cohere as a retrieval option for players with a key: no.**
   - It puts a network hop in front of every reply. Embedding alone took 375 ms median from this PC (p90 461 ms), embed plus rerank 902 ms (p90 1.1 s, worst 1.5 s). The local embedder takes 17 ms. A Gemini reply starts in about 1.0 s, so this would add 40 to 90 percent to the wait. The mod's hard memory timeout is 400 ms, so a Cohere embed alone would already have dropped the memories on 9 of 52 turns here (17 percent), and embed plus rerank on every turn.
   - It is not better than a local model we already have. Cohere embed-v5.0-pro reached recall@5 0.803 and EmbeddingGemma-300M (local, free) 0.818 on the same queries. Reranking on top made no difference to recall and only moved the best item to first place.
   - Reply quality did not change measurably (below).
   - A free trial key is 1,000 API calls a month and Cohere says trial keys are not for production or commercial use. One turn with embed and rerank is 2 calls, so that is 500 turns a month at best. A "players bring a free Cohere key" option like the Gemini one is not realistic (details in "Trial key terms").
   - It adds a cloud hop that Local AI players must never reach (never a fallback), and for Gemini and Custom players the line V says would go to a second company on every turn.
2. **A better local embedder: yes in principle, EmbeddingGemma-300M Q8** (already in the Local AI folder as the pack's earlier candidate). It is the one change that clearly improves retrieval and it fixes a real defect (next paragraph). The price is +231 ms per turn (248 ms against 17 ms on one thread) and 334 MB against 121 MB. That latency is a real cost under the "latency equals FPS" rule, so it should only ship if it can be hidden or measured acceptable inside a running game (see "What to build next").
3. **A defect found on the way, independent of any vendor:** the mod's cosine cut-off of 0.40 does nothing with granite. Every small talk line I tried scored above 0.40 against every stored memory, both on the synthetic pools (8 of 8 small talk lines, 44 of 44 questions) and on the owner's real memories (all 6 test lines against all 5 characters, top cosine 0.47 to 0.72). So 4 memories are put in every prompt, whatever V says. With EmbeddingGemma the same cut-off works (0 of 8 small talk lines pass, 40 of 44 real questions pass).

How strong is the evidence? Retrieval on 44 questions is solid enough for the embedder ranking (paired bootstrap, below). The reply test (15 turns, 3 variants, one blind Haiku judge) is too small to separate the variants and I do not claim it does.

## Step 1: what retrieval exists today

Surveyed in the code at HEAD 4fc1665c (a helper read it, I checked the key numbers). **Only one path uses embeddings: lasting memories of past talks.** Everything else is rules, keyword overlap, regex screens, geometry or recency.

| What | Store and size | How it is ranked | In the prompt | Providers | Latency |
|---|---|---|---|---|---|
| Lasting memories of past talks | `bridge/memory-store.mjs`, one JSON file per player and character, up to 600 records (220 characters each) with a base64 vector | cosine of V's line (clipped to 500 characters) against every vector of that character, keep cosine 0.40 or more, score = cosine + 0.05 x recency (30 day decay) + 0.03 x importance + 0.1 if pinned | at most 4 lines and 1,200 characters (about 300 tokens), under "WHAT YOU REMEMBER OF V FROM EARLIER TALKS" | text routes only (Local AI, Gemini, Custom, Mistral), never Convai (it keeps its own server side memory) | on the hot path, hard timeout 400 ms, a late answer is discarded. A cold embedder returns nothing and is warmed for the next turn (server start 2.6 to 3.4 s) |
| World and quest facts | `characters/world-knowledge.json`, 1,155 rules | rule conditions on the game snapshot, then priority plus quest, relationship and speaker bonuses plus 50 per query word hit (max 150), no embeddings | up to 8,000 characters | all providers | pure JS, no network |
| Journal history | runtime parts from the game, up to 4,096 quests | keyword overlap with the talk's words, tracked quest first | up to 6 quests, 6,000 characters | all | pure JS |
| Story knowledge | 60 rows, 25 verified | no ranking, file order, finished quests only | at most 6 lines of 160 characters | all | pure JS |
| Quest briefings | 171 reviewed quests | regex screen on V's words, then title words hit | one briefing | all | pure JS |
| Character lore claims | 10 reviewed packs, about 73 topic rows | first topic whose regex matches V's words | at most 3 claims, 4 KB | all | pure JS |
| Small stores | vendor memory (last 10 exchanges per shop), recent game dialogue (180 s), named places (geometry), persona memories (always on) | recency or geometry, nothing searched | fixed | all | pure JS |

Things the map shows that matter for this question:
- With no Local AI pack there is no embedder, so Gemini and Custom players without the pack get **no lasting memories at all** (no keyword fallback exists). A cloud embedder would be the only way for them, which is the one real argument for Cohere. It is a small group and a local embedder is a one-time download.
- The embedder is local for everyone, even Gemini players, so no turn text goes to a cloud embedder today.
- Vectors from a different embedder are rejected and re-embedded in the background (up to 600 records per character), so changing the model needs no migration code.
- Docs have drifted from the code: `docs/LOCAL_OPTION_DESIGN.md` says 2,000 records per character, `.f32` files and 5 MB, the code is 600 records, JSON with base64 and 3 MB. `docs/LOCAL_AI.md` says the embed server idles out after 90 s, the code says 300 s. A comment in `memory-store.mjs` mentions a "composer open" warm that nothing calls (UNVERIFIED as unwired, no caller found by grep).
- Real saved pools are tiny: the owner's save has 21, 9, 5, 3 and 1 memories for its five characters. With 4 of at most 21 picked, ranking quality matters little today and starts to matter when pools grow toward the 600 cap.

## Step 2: the retrieval eval

**Data.** 640 items from the repo's own stores for four speakers (Panam, Judy, Johnny, Viktor): world facts, verified story lines, quest briefings, 15 named places and 360 synthetic memories of past talks (90 per speaker, written to look like the mod's own extracted memories, `data/memories.json`). 52 queries (13 per speaker): 2 small talk, 4 past conversation, 2 fact, 1 story, 2 quest and 2 place each. Each query was written from one source item and its gold is that item plus every pooled candidate that a blind Haiku judge rated 2 (clearly relevant) out of 0 to 2. The pool was the top 6 of all 10 systems (893 pairs), so no system picked its own gold. The 8 small talk lines are scored apart: the judge rated 4 to 9 items "relevant" to lines like "how are you", which says more about the judge than about retrieval. That leaves 44 scored queries with on average 2.9 gold items.

The owner's real memories were read through the admin share only and copied to the ignored `local/` folder. They are too few and too repetitive to build queries from (most characters have under 10), so they are used only for the cut-off check above. Memories were not quoted anywhere.

**Systems.** Every system ranks the speaker's own pool (about 160 items per speaker) and the cosine systems score unit vectors.
- granite: the mod's own `bridge/local-embed.mjs` class, granite-embedding-107m-multilingual Q8, 384 dimensions, one CPU thread
- embgemma: EmbeddingGemma-300M Q8, 768 dimensions, one CPU thread, with its documented query and document prefixes
- cohere-pro and cohere-fast: `embed-v5.0-pro` and `embed-v5.0-fast`, 2,048 dimensions (the current models in Cohere's docs on 30 Oct, replacing embed-v4.0). cohere-pro512 is the pro vectors cut to 512 dimensions
- granite>rerank, cohere>rerank, coherefast>rerankfast: top 50 of the embedder, reranked by `rerank-v5.0-pro` or `-fast`
- bm25 and granite+bm25: plain keyword scoring over the same pool, alone and fused with granite (a stand-in for the keyword ranking the rule engine uses for facts)

**Results** (44 questions, latency per query from this PC in India, local models warm on one thread, Cohere over the public API):

| System | recall@5 | hit@1 | hit@5 | MRR | memory | fact | story | quest | median ms | p90 ms | cost per 1,000 turns |
|---|---|---|---|---|---|---|---|---|---|---|---|
| granite (the mod today) | 0.695 | 0.750 | 0.955 | 0.831 | 0.565 | 0.833 | 0.542 | 0.623 | 17 | 24 | 0 |
| embgemma (local) | **0.818** | 0.932 | 1.000 | 0.962 | **0.662** | **0.917** | 0.854 | 0.860 | 248 | 287 | 0 |
| cohere-pro | 0.803 | 0.955 | 1.000 | 0.970 | 0.650 | 0.802 | 0.938 | 0.877 | 375 | 461 | about 0.002 (price not published) |
| cohere-pro512 | 0.711 | 0.864 | 0.977 | 0.909 | 0.605 | 0.667 | 0.729 | 0.669 | 375 | 461 | same |
| cohere-fast | 0.793 | 0.955 | 1.000 | 0.973 | 0.622 | 0.844 | 0.938 | 0.835 | 359 | 366 | about 0.002 (price not published) |
| bm25 (keywords) | 0.648 | 0.773 | 0.955 | 0.852 | 0.438 | 0.627 | 0.708 | 0.742 | under 1 | under 1 | 0 |
| granite + bm25 | 0.726 | 0.773 | 0.977 | 0.861 | 0.576 | 0.813 | 0.708 | 0.706 | under 20 | under 25 | 0 |
| granite > Cohere rerank pro | 0.769 | 0.932 | 1.000 | 0.966 | 0.608 | 0.781 | 0.875 | 0.823 | 539 | 623 | 500 |
| cohere-pro > Cohere rerank pro | 0.782 | 0.955 | 1.000 | 0.977 | 0.614 | 0.781 | 0.875 | 0.885 | 902 | 1,122 | 500 |
| cohere-fast > rerank fast | 0.773 | 0.932 | 1.000 | 0.959 | 0.649 | 0.781 | 0.687 | 0.860 | 927 | 1,027 | 500 |

Place queries scored 0.97 for every system (the place name is in the line, so keywords find it) and are left out of the table. recall@5 is the share of the gold items, at most 5 of them, found in the top 5. Memory is the only category the mod retrieves with embeddings today, but note it is searched here in a pool that also holds facts, stories and quests, which makes it a little harder than the real memory only search.

**Paired differences against granite** (2,000 bootstrap draws over the 44 questions, 95 percent interval):

| System | recall@5 | MRR |
|---|---|---|
| embgemma | +0.122 (0.058 to 0.192) | +0.131 (0.037 to 0.225) |
| cohere-pro | +0.108 (0.032 to 0.200) | +0.139 (0.052 to 0.228) |
| cohere-fast | +0.097 (0.022 to 0.179) | +0.142 (0.069 to 0.230) |
| granite > rerank | +0.073 (-0.006 to 0.155) | +0.135 (0.032 to 0.236) |
| cohere-pro > rerank | +0.086 (0.003 to 0.173) | +0.146 (0.059 to 0.246) |
| granite + bm25 | +0.031 (-0.030 to 0.093) | +0.029 (-0.053 to 0.113) |
| cohere-pro512 | +0.016 (-0.078 to 0.104) | +0.078 (-0.002 to 0.159) |

Reading it:
- Both Cohere embedders and EmbeddingGemma are clearly better than granite (about +0.1 recall@5 and +0.14 MRR). **Cohere embed is not better than the local EmbeddingGemma**, the two are within 0.02 of each other on every headline number.
- **Reranking adds nothing over a good embedder.** It lifts a weak first stage (granite) in MRR, but cohere-pro > rerank scores below cohere-pro alone in recall@5 (0.782 against 0.803). The mod injects 4 items, not one, so recall matters more than which of the 4 comes first.
- Cutting Cohere vectors to 512 dimensions loses all the gain, so a smaller store is not free.
- Cohere fast and pro are the same quality here, fast is a little quicker.
- Fusing keywords into granite helps a little, not significantly.
- The 0.40 cut-off (top-1 cosine, small talk against the 44 questions):

| System | small talk median | question median | small talk over 0.40 | questions over 0.40 |
|---|---|---|---|---|
| granite | 0.685 | 0.790 | 8 of 8 | 44 of 44 |
| embgemma | 0.307 | 0.557 | 0 of 8 | 40 of 44 |
| cohere-pro | 0.261 | 0.427 | 0 of 8 | 24 of 44 |

Cohere's cosines run lower, so 0.40 would drop 20 of 44 questions there and the cut-off would need its own value. Granite's best single cut-off is about 0.70 (92 percent accuracy) but on the real memories small talk reaches 0.72, so a higher number alone does not fix granite.

**(e) Cheap local alternatives.**
- EmbeddingGemma-300M Q8 is measured above: 334 MB, 248 ms per query on one thread (p90 287, worst 319), 1.1 s cold start, 0.29 s per document when embedding (592 texts took 171 s against 16 s for granite), so a full re-embed of 600 records takes about 3 minutes in the background.
- A local cross-encoder reranker was **not measured**: nothing was downloaded without approval. Candidates that run in llama-server (`--reranking`): bge-reranker-v2-m3 Q8_0, 582 MB, multilingual, about 568 million parameters, and jina-reranker-v1-tiny-en Q8_0, 36.7 MB, English only. From the model sizes alone I expect the big one to cost around a second or more on one CPU thread for 20 candidates (an estimate, not a measurement). Since reranking added nothing over EmbeddingGemma here, I would not spend the download.

## Do better retrieved items give better replies?

15 turns where the three variants' top 4 differ (5 memory, 3 fact, 2 story, 5 quest, picked so one variant often found the gold item and another missed it). Variants: granite (the mod today), EmbeddingGemma, and cohere-pro > rerank (the best Cohere setup). The prompt is built like the mod's: the character's profile text, then the retrieved items (4 at most, 240 characters each, 1,200 in all) under the mod's "what you remember" heading. Replies come from `gemini-flash-lite-latest` (the model of the mod's Gemini preset), temperature 0.5, one reply per cell (45 requests). A Haiku judge, blind to the variant and with the labels shuffled, scored each reply 1 to 5 on answers the question, uses the right memory and naturalness.

| Variant | gold item in its top 4 | answers the question | uses the right memory | natural | total (of 15) | best of the three |
|---|---|---|---|---|---|---|
| granite | 11 of 15 | 4.87 | 3.40 | 4.47 | 12.73 | 4 turns |
| EmbeddingGemma | 15 of 15 | 4.73 | 3.80 | 4.67 | 13.20 | 6 turns |
| cohere-pro > rerank | 15 of 15 | 4.73 | 3.67 | 4.53 | 12.93 | 5 turns |

Head to head totals: EmbeddingGemma beat granite on 8 turns and lost 6 (1 tie), cohere > rerank beat granite 7 to 5 (3 ties), cohere > rerank against EmbeddingGemma 7 to 6 (2 ties). **The direction is the expected one (the memory score is highest with the best retrieval) but the whole spread is under half a point of 15 and 15 turns cannot confirm it.** The replies are short and the strong model (Gemini) often answers well without the memory, so retrieval quality shows up only in "uses the right memory". I would not sell any of this to a player as a measurable reply improvement, only as fewer wrong or missing memories.

## Step 3: Cohere as a text provider

Cohere's OpenAI compatible endpoint exists: `https://api.cohere.ai/compatibility/v1` (chat completions with streaming, embeddings, audio transcription, no rerank). Current chat models: `command-a-plus-05-2026` (128k context) and `command-a-03-2025` (256k). Eight in-character turns each (Panam, Judy, Johnny, Viktor), streamed, from this PC:

| Model | first token median | whole reply median | notes |
|---|---|---|---|
| command-a-plus-05-2026, `reasoning_effort: none` | 552 ms | 1,309 ms | in voice, short, plain. Invented a price ("1,200 eddies") when asked what a patch job costs |
| command-a-03-2025 | 2,300 ms | 8,171 ms | much slower on a trial key, similar quality |
| gemini-flash-lite-latest (the mod's preset) | 1,009 ms | 1,202 ms | a little more lore flavour in the replies (named places and people from the profile) |

**Trap for any integration:** Command A+ thinks by default and the OpenAI endpoint returns that thinking inside the reply text. Five of eight replies were empty or full of "We need to respond as Judy Alvarez" planning, because the 160 token budget was spent on it. Setting `reasoning_effort` to `none` (the only values the endpoint accepts are `none` and `high`) fixed it. The mod's Custom provider page only takes an address, a model and a key, so a player who pasted Cohere's address would get garbage unless a preset sets that field.

Quality is serviceable and the speed is as good as Gemini's, so Cohere is a viable paid text provider. I would not add it as a free option, because of the limits below.

## Trial key terms (checked on Cohere's docs on 30 Oct 2026)

| Endpoint | Trial key | Production key |
|---|---|---|
| Chat | 20 requests a minute | 500 a minute for most models |
| Embed | 2,000 inputs a minute (the response headers on this key showed 100 calls a minute) | the same |
| Rerank | 10 requests a minute | 500 a minute |
| All calls | **1,000 API calls a month** (the headers also show `x-endpoint-monthly-call-limit: 1000`, I could not see a remaining count) | pay as you go |

- Trial calls are free and need no card. Cohere's pricing page says Trial keys "cannot be used commercially", the pricing explainer says they are "not permitted to be used for production or commercial purposes". I could not find a carve out for hobby or modding use or for software that hands the key to end users. A player using their own trial key for personal play is not the mod author running a service, but the wording does not promise it, so the mod's text should not either.
- **Practical ceiling:** 1,000 calls a month is about 1,000 chat turns, or 500 turns if each turn also needs an embed and a rerank. That is a few play sessions. Gemini's free plan covers far more, so a Cohere trial key cannot be a free text option in the same class.
- Prices (from Cohere's pages and a web search on 30 Oct, UNVERIFIED for Command A+ because third party price sites disagree): rerank 5 is $0.50 per 1,000 searches (page summary), Command A+ $2.50 per million input and $10 per million output tokens (one third party site lists $0.30 and $1.50). Embed 5 appears on the pricing page only under a Model Vault plan with no token price, so the per turn embed cost is unknown, but a query is about 20 tokens and even at the old Embed 4 price ($0.12 per million) it would be a fraction of a cent per 1,000 turns. A text turn of about 3,000 tokens in and 40 out on Command A+ would cost about $8 per 1,000 turns at $2.50 and $10.
- Cost of this eval: about 290 Cohere calls on the trial key (about 122 embed calls for 592 texts and 104 queries across both models, 164 rerank calls, about 30 chat calls), 53 Gemini calls, $0 spent. The paid key was not used.

## What to build next (if the owner wants the local improvement)

1. **Make the embedder swappable per model and give each model its own cut-off.** `memory-store.mjs` already rejects vectors of another embedder id and re-embeds in the background. Add EmbeddingGemma-300M Q8 (with its query and document prefixes) as an option in the Local AI pack and a per-model `minScore` (0.40 works for it here, granite effectively has none). Fixing the cut-off alone gives "no memories injected on small talk", which today never happens.
2. **Measure the +231 ms inside a running game before shipping**, and try to hide it: start the query embedding the moment V's line is final and let it overlap the knowledge and journal assembly that happens before the model call. The embed server runs one thread, so a second thread, a shorter query clip (V's lines are short, the clip is 500 characters) are the knobs. Do this as an owner live check of response time and FPS, not by estimate.
3. **Leave granite the default** until step 2 shows the added latency is hidden. It is 14 times faster and the quality gap only matters once a character holds more than a few dozen memories.
4. **Separate project: semantic search over the knowledge stores.** Facts and quest briefings are chosen by keyword overlap and regex today. On the same queries embeddings beat keyword ranking on facts (0.83 to 0.92 against 0.63) and on story and quest lines, so an embedded index of the rule statements would likely pick better facts, but those rules are conditional on game state and need their own design.
5. **Optional, for Gemini and Custom players without the Local AI pack** (no lasting memories at all today): a cloud embedder is the only route, and it should be a separate opt in with its own notice, off by default and never used while Local AI is the text provider. Cohere's trial limits make it a poor fit, a paid or a Gemini embedding key is a better candidate to test first. I did not evaluate that.

## Caveats

- 44 questions from a synthetic memory pool. The question text was written from the gold items, which favours embedders slightly over keyword search and does not reflect how V really speaks.
- The relevance judge is one Haiku pass and was generous (about 2.9 gold items a question, and 4 to 9 for small talk). That is why small talk is excluded from the recall numbers.
- The reply test is 15 turns, one sample per cell, one judge, Gemini only. The Local AI model (smaller) would depend more on the retrieved lines, which this test does not show.
- Latency is from one PC and one network (India), the local models ran alone on an idle machine. Under the game the local numbers will be worse.
- The mod's own memory retrieval adds recency, importance and pin terms to the cosine, which are not part of this eval.

## Files

`scripts/eval-retrieval/`: `build-items.mjs` (item pool from the repo), `make-seeds.mjs` (query seeds), `run-systems.mjs` (all systems, caches embeddings and rerank answers so a re-run costs no Cohere call), `make-judge-pool.mjs`, `score.mjs`, `analyze.mjs` (bootstrap intervals and the cut-off check), `reply-quality.mjs` (Gemini replies and blind judge files), `chat-compare.mjs` and `probe-chat.mjs` (Cohere and Gemini chat), `probe-cohere.mjs` (model names and rate headers), `real-memory-check.mjs`, `lib.mjs`. Data in `data/`: items, synthetic memories, queries. Run order: `build-items`, `make-seeds`, `run-systems`, `make-judge-pool`, judge, `score`, `analyze`, `reply-quality gen`, `pack`, judge, `score`.
