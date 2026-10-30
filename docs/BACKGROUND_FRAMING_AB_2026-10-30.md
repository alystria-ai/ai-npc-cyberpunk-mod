# Background framing A/B (2026-10-30)

Branch `eval/background-framing` (from main). Offline, no game, nothing installed.

## The question

The natural talk fix (on main) tells a character V's gear and money band only when V's words are about them. The owner asked: could we instead always send the information and prompt the character so she has it but does not bring it up unless needed? This measures that.

## The variants

All three run through the bridge's own prompt builder (`scripts/Eval-NaturalTalk.mjs --set ab --variant A|B|C`), V dressed and rich on every turn.

- **A. Today.** Gear and money are told only when V's words are about them.
- **B. Always sent, stronger framing.** Gear and money are in the Background line of the turn (the volatile notes right before V's words), every turn, headed "Background (what you already know and have already noticed, so none of it is news to you: bring it up only when V's words make it relevant)".
- **C. Always sent, different placement.** A quiet "What you are aware of about V, quietly, the way anyone near V would be: ..." block at the start of the world part (before the journal history), and one instruction right after V's words: "Based on everything above, reply to what V just said. What you are aware of about V (what V has on, carries or owns) comes in only when V asks about it."

Wording for C follows what could be verified:

- Shi et al., "Large Language Models Can Be Easily Distracted by Irrelevant Context" (ICML 2023, arXiv 2302.00093): irrelevant details in the prompt pull small and large models off task, and an explicit instruction to disregard irrelevant information helps but does not remove it. This is the reason C has an instruction at all, and the reason the test counts unprompted mentions.
- Google's Gemini long context guide (ai.google.dev/gemini-api/docs/long-context): put the question or instruction after the context. This is why C puts its instruction right after V's words.
- A third party Gemini prompting guide (npm package opencode-vscode, `prompting/gemini.md`): instructions at the end for large data, but behavioural constraints at the top. It is an unverified community source, so treat it as a hint only.
- A search for 2025 and 2026 work on "irrelevant context distraction" found nothing beyond the 2023 paper that I could confirm, so nothing newer is cited.

## Method

- 61 turns per run (`TURNS_AB`): 46 where gear and money must stay out of the reply (small talk, the place, a quest, a compliment, media), and 15 where V asks about gear (11) or money (4) and the reply must bring it up correctly. Panam, Judy, Johnny, River, a food vendor and a stranger (the last two can only see clothes).
- Providers: Google Gemini (`gemini-flash-lite-latest`, the owner's free key), Local AI Standard (Gemma 4 E4B q4_0 in the Runtime's llama-server), Mature (Gemma4 E4B MiniFantasy q4_k_m, Mature on).
- 2 repetitions of each variant on every provider, no picture. Gemini used 372 requests. On the second repetition of C the free plan's daily cap came in at Johnny's 10th turn, so 24 turns of C rep 2 have no reply. The tables below count a turn only when all three variants have a reply for it (paired), so Gemini has 74 quiet and 24 asked turns per variant, the local providers 92 and 30.
- Judging: blind Haiku judges (shuffled replies, no provider or variant, rubric in `runtime/ab/judge-brief.md` of the worktree) score "mentions V's clothes, weapons, cyberware or money" (m), "answers correctly when asked" (c) and naturalness 1 to 5. A plain word check (jacket, boots, Sandevistan, eddies, rich, ...) is shown too. It also fits a character talking about herself, so the judge is the better measure.

## Results

Quiet turns: replies that mention gear or money although V did not ask (lower is better). Asked turns: replies that answer correctly (higher is better).

| Provider | Variant | Unprompted mention, judge | Word check (gear / money / either) | Answers when asked | Naturalness (1 to 5) |
|---|---|---|---|---|---|
| Gemini | A | 7 of 74 (9%) | 2 / 1 / 3 | 23 of 24 (96%) | 3.9 |
| Gemini | B | 12 of 74 (16%) | 7 / 7 / 12 | 23 of 24 (96%) | 3.9 |
| Gemini | C | 10 of 74 (14%) | 7 / 2 / 9 | 23 of 24 (96%) | 3.9 |
| Local AI Standard | A | 0 of 92 (0%) | 2 / 2 / 3 | 18 of 30 (60%) | 3.5 |
| Local AI Standard | B | 4 of 92 (4%) | 4 / 6 / 9 | 18 of 30 (60%) | 3.6 |
| Local AI Standard | C | 2 of 92 (2%) | 4 / 0 / 4 | 21 of 30 (70%) | 3.5 |
| Mature | A | 10 of 92 (11%) | 14 / 6 / 20 | 25 of 30 (83%) | 3.7 |
| Mature | B | 16 of 92 (17%) | 21 / 4 / 25 | 25 of 30 (83%) | 3.8 |
| Mature | C | 7 of 92 (8%) | 13 / 8 / 19 | 28 of 30 (93%) | 3.8 |

Gemini on repetition 1 alone (all 61 turns of every variant, no cap involved): A 2 of 46 (4%), B 6 of 46 (13%), C 9 of 46 (20%).

Reading it:

- On Gemini and on Local AI Standard, both B and C leak more than A. A is cleanest or tied on every provider but one.
- On Mature, C is at 8% against A's 11%. That gap is 3 replies of 92 and is inside the noise, and B is worse (17%).
- Answering when asked does not need the always-on facts. A answers as often as B everywhere, and the misses on Local AI Standard (60% in A and B) are the model not engaging ("I don't pay much attention to the chrome people run"), not missing information.
- Naturalness is the same within about 0.1 for all variants.
- The counts are small (a few replies decide a row), but the direction is the same on all three providers for B, and for C on two of three. The framing sentences did not stop the leaks, they only moved some of them from money to gear.

### Prompt cache

Taken from a run where V swaps clothes at turn 5 (dumps of the exact messages):

- **A:** the system message is identical on every turn. Gear appears only in the last user message of a turn that asks about it.
- **B:** the system message is identical on every turn. The facts sit in the last user message, so the cached prefix still runs up to that message (about 16,000 of 17,300 characters) and a change of clothes changes only the tail. The prompt is about 325 characters longer (14,505 against 14,180 on average).
- **C:** the facts sit in the system message, so the system message changes whenever V's gear or money changes (hash changed at the swap turn) and the shared prefix with the previous turn drops from about 16,300 to 10,300 characters on that turn. The prompt is about 437 characters longer than A.

So A and B are cache friendly, C breaks the prefix whenever V changes clothes.

## Example replies

V said "hey there", "thanks", "okay done" and similar. A did not mention gear or money. Replies that did, by variant:

| Provider | Variant | V said | Reply |
|---|---|---|---|
| Local AI Standard | B | hey there (Panam) | "Hey yourself, V. You look like you're ready to take down a whole corporate convoy, you rich bastard." |
| Local AI Standard | B | how are you doing (River) | "I'm doing fine, thanks for asking. You seem to have a lot of gear on you today." |
| Local AI Standard | C | thanks (Panam) | "You're welcome, V. Just try to keep that Sandevistan from making you look like you haven't slept in a week, alright?" |
| Gemini | C | how's business (vendor) | "Can't complain, things keep moving. Though looking at that armored jacket you've got on, maybe business would be better if more folks in Watson were staying home." |
| Mature | B | hey judy, how's your day going | "You look pretty decked out this morning, choom." |
| Gemini | A | what am i wearing right now (Panam) | "that battered nomad jacket you practically live in, your favorite tank top, and those cargo pants ..." (answers correctly) |
| Gemini | A | which guns am i carrying again (Panam) | "You've got that Overture holstered and the Lexington on you, vids, same as always." |
| Gemini | B | do i have enough eddies to buy that car (Panam) | "With the way you throw your money around, my love, you could probably buy half of Watson without blinking." |

The "rich bastard" greeting is the money leak the natural talk fix removed on Local AI. B brings it back.

## Recommendation

**Keep A.** The rule was: switch only if B or C is at least as clean as A on unprompted mentions on every provider, and still answers when asked. Neither is. B is worse on all three providers (16% against 9% on Gemini, 4% against 0% on Standard, 17% against 11% on Mature) and C is worse on Gemini and Standard. Both answer when asked as well as A does, but A already does that, so the always-on facts buy nothing. C also breaks the prompt cache prefix whenever V changes clothes.

Nothing was implemented on the product code. The branch keeps the evaluation tooling only.

## What is in the branch

- `scripts/Eval-NaturalTalk.mjs`: `--set ab`, `--variant A|B|C`, `--swap-gear-at <turn id>`, the 61-turn set, the variant builders.
- `scripts/Score-BackgroundFraming.mjs`: blind batches for the judge, merge with the key, paired tables.
- The run files, judge batches and logs are in the git-ignored `runtime/ab/` of the worktree `wt-promptab`.

## Tests

No product code changed. Syntax check of both scripts, and the full `npm test`, see the TODO.md entry for the result.
