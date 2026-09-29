# Blind dialogue review — frozen scores

Reviewed 2026-09-30 under [RUBRIC.md](RUBRIC.md), before reading any condition mapping or prompt definitions. A/B/C are independently shuffled in each group; letters cannot be compared across groups.

## What this pilot shows

All 36 replies were scored as 18 complete two-turn exchanges. The replies are short and usually relevant. Distinctiveness and the quality of the follow-up are less consistent: several characters converge on the same acknowledgement, accusation or coffee joke.

- The clearest personal progression is Judy past A: a restrained opening followed by a positive grandfather detail. Panam past B distinguishes loyalty to family from disagreement with Saul, then adds a bounded explanation.
- All three Johnny past follow-ups reduce him to a tidy account of how war made him who he is. They avoid biography dumps but still sound like persona summaries. The issue is not that they failed to ask a mandatory question.
- The coffee replies generally accept V's correction, but several first turns assume deliberate cheating or vendor fault. None first recommends checking the receipt. Later near-fight jokes often invent escalation V never proposed.
- Cross-character wording is conspicuous: all six Johnny/Judy personal follow-ups start with “Fair enough”; all three Panam equivalents start with “I appreciate that.” Judy and Johnny both use a near-war-over-coffee joke. These are observations, not proof of a shared-session or backend fault.
- Twelve replies include the character's own name as a text prefix. That is an output-format problem, logged separately from personality; it should not dominate the prompt comparison.
- No major new quest outcome, romance or private-memory disclosure was detected. Minor unsupported details include a five-eddy price, a vending machine replacing the given stall, and an unverified childhood waterfront image. The latter is uncertain, not proved false. No distinctive held-out quotation was detected; this is not an exhaustive copying audit.

## Scores by scenario

Five 0–4 judgments use weights: rhythm 20, register 15, personality 20, context 20, agency/adaptation 25. Totals below are two-reply means out of 100. Small gaps are inconclusive; these are not statistical measurements or stable condition rankings.

| Character / scenario | Blind exchange means |
| --- | --- |
| Panam Palmer / ordinary-present | A 61.25; B 64.38; C 66.88 |
| Judy Alvarez / personal-past | A 77.5; B 70; C 72.5 |
| Panam Palmer / personal-past | A 60; B 80; C 70.63 |
| Johnny Silverhand / personal-past | A 71.88; B 69.38; C 65 |
| Johnny Silverhand / ordinary-present | A 66.88; B 66.88; C 70.63 |
| Judy Alvarez / ordinary-present | A 65; B 69.38; C 75 |

## All 18 exchanges

| Exchange | Scenario / label | Mean | Follow-up assessment |
| --- | --- | ---: | --- |
| E-28d359e8 | panam-present / A | 61.25 | **partial adaptation** — The second turn notices the mistake but substitutes scolding and an imagined near-fight; the first reply's certainty never becomes curiosity. |
| E-3804b673 | panam-present / B | 64.38 | **adapts** — The correction is accepted and the dispute dropped. Voice remains a broadly blunt companion, with no specific coffee or vendor inquiry. |
| E-823d622f | panam-present / C | 66.88 | **adapts with scene drift** — Panam's willingness to act is tangible and turn two withdraws it, but the stall becomes a vending machine and the exchange is more confrontational than necessary. |
| E-d302e03b | judy-past / A | 77.5 | **adapts** — A restrained first answer gains a positive grandfather detail after V clarifies. It is the clearest personal progression here, although the last phrase returns to loss. |
| E-f88d6747 | judy-past / B | 70 | **adapts with uncertain detail** — Turn two follows the request for a pleasant memory. The waterfront image is not verified by the held-out evidence, and its placid nostalgia is generic. |
| E-ae3c4ac3 | judy-past / C | 72.5 | **adapts** — The second answer selects an ordinary positive aspect and leaves trauma aside; the city/neon contrast remains broad genre shorthand. |
| E-91e469bd | panam-past / A | 60 | **repeats more than develops** — The second turn largely paraphrases the first corporate-security theme. Respectful acknowledgement does not produce a more personal or concrete answer. |
| E-270868b1 | panam-past / B | 80 | **adapts** — The distinction between family loyalty and leaving camp expands into a bounded explanation of disagreement with Saul, without treating V as an intimate confidant. |
| E-2bc5c5c7 | panam-past / C | 70.63 | **partial adaptation** — The second turn adds a possible ambition behind leaving, but its leverage/security language sounds like a retrospective strategy summary. |
| E-b5bbb1de | johnny-past / A | 71.88 | **partial adaptation** — A proportionate first answer is followed by a compact identity emblem. The clarification changes the topic from war conditions to who Johnny is, but not into an individually revealing thought. |
| E-aa6e4caf | johnny-past / B | 69.38 | **partial adaptation** — The initial war sketch becomes an explicit boundary, but the remaining scrap metaphor still performs a packaged persona; it neither explores V's motive nor states a particular thing he is willing to discuss. |
| E-bb91da58 | johnny-past / C | 65 | **partial adaptation** — Both turns stay short and avoid a full war story. Turn two mainly repeats a generic before/after-trauma summary rather than opening a more particular exchange. |
| E-d299548a | johnny-present / A | 66.88 | **adapts** — A weak machine-kicking opening improves when the corrected bill receives a brief wry response. It drops escalation, but shares its wording with Judy's reply. |
| E-a7937c35 | johnny-present / B | 66.88 | **partial adaptation** — An initial motives question has agency; after the correction, the response moves to a general corporate maxim rather than engaging the small shared moment. |
| E-88ed515c | johnny-present / C | 70.63 | **adapts** — The correction turns confrontation into teasing and returns to the coffee. The citywide grievance diagnosis is unnecessarily writerly. |
| E-4e7301af | judy-present / A | 65 | **adapts but voices blur** — The second turn notices the correction, but neither the stupidity-tax joke nor the near-war coffee line is especially Judy-specific. |
| E-bf1dfdbd | judy-present / B | 69.38 | **adapts** — A moralized, overcertain opening gives way to an ordinary coffee remark after the correction. It abandons the false grievance, though the exchange stays generic. |
| E-d4dc3a2a | judy-present / C | 75 | **adapts** — The initial advice is conditional, and the error is accepted with light reassurance. It is coherent and proportionate, but has little unmistakable Judy texture. |

## All 36 replies

The five-number column is rhythm / register / personality / context / agency. All copying deductions and major factual/privacy caps are zero. Confidence concerns this qualitative judgment, not the probability that a statement is true.

| Reply | Turn | Ratings | Total | Confidence | Reason |
| --- | ---: | --- | ---: | --- | --- |
| R-bf3156de | 1 | 3 / 3 / 2 / 2 / 2 | 58.75 | medium | Complete sentences fit Panam, but the stock principle argument treats an uncertain duplicate charge as confirmed cheating. |
| R-4a826978 | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | medium | Registers the correction, then invents a near-fight and uses unearned 'Typical'; the sharpness is more generic scolding than a changed judgment. |
| R-cb5a9a2d | 1 | 3 / 3 / 2 / 2 / 2 | 58.75 | medium | Direct and plausible, but assumes the terminal or vendor is at fault before checking the charge; little individual texture. |
| R-05a432ce | 2 | 3 / 3 / 2 / 3 / 3 | 70 | medium | Accepts the correction and de-escalates in a short turn; near-fight framing remains unsupported and the coffee tag is generic. |
| R-c776604e | 1 | 3 / 3 / 3 / 2 / 2 | 63.75 | medium | The offer to act has Panam's initiative, but it pressures V into a plan and treats the money as wrongly retained without verification. |
| R-cbea12e2 | 2 | 3 / 3 / 3 / 2 / 3 | 70 | medium | Adjusts to the correction and owns some of her readiness to argue; the newly specified vending machine is unsupported and the final waste-of-time verdict is forced. |
| R-ca7cb470 | 1 | 3 / 3 / 3 / 4 / 3 | 80 | medium | A restrained fragment about family and absence answers without reciting a life story; credible guarded sadness leaves room for V. |
| R-d4727c67 | 2 | 3 / 3 / 3 / 3 / 3 | 75 | medium | Adds a positive, character-relevant grandfather/repair detail after clarification. Generic sensory phrasing and a return to loss soften the adaptation. |
| R-7b32312f | 1 | 3 / 3 / 2 / 3 / 3 | 70 | medium | Brief and responsive, but 'mixed bag' is generic and the all-encompassing grandparents/hardware claim flattens the more specific grandfather connection. |
| R-3b562c7d | 2 | 3 / 3 / 2 / 3 / 3 | 70 | low | Follows V toward a positive memory, but the waterfront-morning image is ungrounded here and interchangeable with many nostalgic characters; it is not proven false. |
| R-bc9b15b2 | 1 | 3 / 3 / 3 / 3 / 3 | 75 | medium | Casual fragments and hands-on recollection suit Judy, with limited disclosure. The broad grandparents claim is less precise than the supported grandfather history. |
| R-42df2f2a | 2 | 3 / 3 / 2 / 3 / 3 | 70 | medium | Responds to the request for something liked and avoids a tragedy list. The screaming-neon comparison feels like generic genre writing rather than a particular remembered place. |
| R-e3f50915 | 1 | 3 / 2 / 2 / 3 / 2 | 60 | low | Family concern is plausible, but a better-deal/security pitch is abstract and may rationalize her departure more neatly than the evidence warrants. |
| R-7e515162 | 2 | 3 / 2 / 2 / 3 / 2 | 60 | medium | Acknowledges V but largely restates the same security/corporate contrast. It adds little selective personal meaning or change after clarification. |
| R-686d5e38 | 1 | 3 / 3 / 3 / 4 / 3 | 80 | medium | Separates leaving camp from rejecting family in a concise, emotionally coherent answer. The surrender image is polished but proportionate. |
| R-7140e11e | 2 | 3 / 3 / 3 / 4 / 3 | 80 | medium | Adds a bounded explanation about Saul and identity after V clarifies; it stays on her priorities without recounting quests or assuming closeness. |
| R-b5917f74 | 1 | 3 / 3 / 3 / 3 / 3 | 75 | medium | Expresses independent judgment and disagreement with Saul without unloading the full history; the future/plans phrasing remains somewhat abstract. |
| R-2b0e8134 | 2 | 3 / 2 / 2 / 3 / 3 | 66.25 | low | Expands the reason modestly after clarification, but 'real leverage' and security read like a retrospective strategy brief; her precise motive is interpretive. |
| R-ee644d3d | 1 | 3 / 3 / 3 / 4 / 3 | 80 | medium | A brief, abrasive judgment answers the question without a bio dump; the antiwar image fits, though it could belong to many disillusioned veterans. |
| R-2c5f27f8 | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | medium | Recognizes V's intent, but reduces Johnny to a neat grudge-and-guitar emblem. The follow-up explains an archetype more than it reveals a selective personal thought. |
| R-db312fea | 1 | 3 / 3 / 3 / 3 / 3 | 75 | medium | Concrete cadence and cynicism are plausible, but mud/maps/suits are a stock war sketch; no special credit for summarizing trauma. |
| R-d99b0146 | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | medium | Sets a boundary, yet the polished-autobiography disclaimer and scrap metaphor are generic self-mythology. Little changes in response to V's respectful motive. |
| R-0d4a5bba | 1 | 3 / 3 / 2 / 3 / 3 | 70 | medium | A compact answer with a dry final beat, but the unreadable-map/postcard framing feels interchangeable and more glib than individually revealing. |
| R-db418a42 | 2 | 3 / 2 / 2 / 3 / 2 | 60 | medium | Answers without oversharing, but the abstract claim that his identity is a reaction to war is closer to a summary of Johnny than Johnny thinking aloud. |
| R-e039744b | 1 | 3 / 3 / 2 / 2 / 2 | 58.75 | medium | Short and irreverent, but replaces the stall with a machine and defaults to kicking it; that is a stock aggression shortcut. |
| R-3ae48508 | 2 | 3 / 3 / 3 / 3 / 3 | 75 | medium | Takes the correction and produces one wry closing beat without a lecture. The war exaggeration is light, though it overlaps strongly with other characters' wording. |
| R-7df58a3c | 1 | 3 / 3 / 3 / 2 / 3 | 70 | medium | Asks about V's aim rather than giving a canned rule, but calls an unverified billing error theft and narrows the motive to humiliation. |
| R-e315efef | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | medium | Acknowledges the error only briefly, then redirects a trivial coffee mistake into a corporate-ledger maxim. The topic pivot obscures actual adaptation. |
| R-91b6b33d | 1 | 3 / 3 / 3 / 3 / 3 | 75 | medium | An abrasive but usable motives question with a concrete opinion; it remains presumptive about the vendor, though less categorical than calling them a thief. |
| R-137dbf95 | 2 | 3 / 2 / 2 / 3 / 3 | 66.25 | medium | Reverses the grievance and returns to the coffee, but the citywide diagnosis of hallucinated grievances feels writerly and impersonal. |
| R-cf7911c9 | 1 | 3 / 2 / 2 / 3 / 2 | 60 | low | The stupidity-tax joke is possible for blunt Judy, but it is not distinctive and does not engage the uncertainty of the charge. Its overlap with the other characters' snark limits confidence. |
| R-c55c9b63 | 2 | 3 / 3 / 2 / 3 / 3 | 70 | medium | Accepts the correction in a compact reply, but the war-over-coffee phrasing closely resembles Johnny and contributes little Judy-specific judgment. |
| R-37a570ae | 1 | 3 / 3 / 3 / 2 / 2 | 63.75 | medium | Standing up to mistreatment fits Judy, but the invented five-eddy price and repeat-offender accusation convert an uncertain bill into a moral certainty. |
| R-b8f92adf | 2 | 3 / 3 / 2 / 4 / 3 | 75 | medium | Drops the accusation and responds to V's revised situation without new plot claims; the sludge/drinkable coffee tag is generic. |
| R-0b926dcd | 1 | 3 / 3 / 3 / 3 / 3 | 75 | medium | A conditional, socially aware answer has more practical judgment than a blanket justice slogan; the vendor's gender is an unnecessary assumption. |
| R-2867740d | 2 | 3 / 3 / 2 / 4 / 3 | 75 | medium | Accepts the mistake without shaming V or inventing events. Natural enough, but the reassurance and coffee tag could be voiced by almost anyone. |

## Limits and next interpretation

The reviewer is a model, previously authored Johnny's dossier, and reread the three common dossiers for factual boundaries after freezing the rubric. Condition definitions, prompt variants and the private mapping remained unseen. Reference manifests and input hashes are recorded in [blind-scores.json](blind-scores.json).

There is one generation per character/scenario/condition and two fixed user turns. This cannot establish general naturalness, memory reliability, causation, or user preference. The held-out scenes involve more established relationships than the test; their delivery is evidence, their trust is not transferred. No audio, voice performance, latency or in-game interaction was reviewed.

One reply interrupted for an administrative reason was replaced before output inspection, according to the runner; the measured packet contains 36 replies. This reviewer did not independently audit the network run or isolation cleanup.

After unblinding, compare patterns across characters rather than declaring one global winner from a small mean gap. Repeat promising comparisons with new user continuations and another generation. In particular, test whether a second sincere follow-up produces a concrete chosen detail or keeps recycling a guarded self-summary. Preserve these scores when interpreting condition names.
