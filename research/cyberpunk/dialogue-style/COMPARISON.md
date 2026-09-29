# Unblinded dialogue prompting comparison

The two added approaches did **not** improve the reviewed baseline overall in this small pilot. The baseline had the highest descriptive mean, but none produced consistently convincing personal back-and-forth. Keep the baseline for now; do not promote either experiment as a general improvement.

These are frozen judgments from one model-authored blind review of 36 replies, not a human panel or statistical test. Each character/scenario/condition has only one two-turn generation. Small differences are inconclusive. All response texts, ratings, rationales and timings are joined in [comparison.json](comparison.json). The [blind review](BLIND_REVIEW.md) and [scores](blind-scores.json) remain byte-for-byte unchanged.

## Overall descriptive results

| Condition | Mean / 100 | Name prefixes | Median spoken words | Median first text | Median complete text |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reviewed baseline | 72.29 | 8 / 12 | 30.5 | 814 ms | 1517 ms |
| Added directives | 66.46 | 4 / 12 | 25 | 903 ms | 1314 ms |
| Native few-shot | 68.44 | 0 / 12 | 27.5 | 882 ms | 1392 ms |

Baseline: reviewed biography, style description and original samples. Added directives: that baseline plus individual guidance about responding to V's social intent and adapting after clarification. Native few-shot: the same added guidance, replacing original samples with five short installed-game lines and their contexts. Prompt lengths and sample topics differ; this is not a controlled token-budget ablation.

## By character

| Character | Baseline | Added directives | Native few-shot | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Johnny | 70.00 | 65.94 | 69.38 | Added directives did not help. Native examples and baseline are effectively tied overall; all personal follow-ups still package his identity into a slogan. |
| Judy | 73.44 | 67.50 | 73.75 | Native examples and baseline are effectively tied. Baseline handled the personal continuation better; native examples handled the coffee correction better. |
| Panam | 73.44 | 65.94 | 62.19 | Baseline led in both scenarios. The native-example condition weakened the personal exchange; do not treat source quotations as an automatic fidelity gain. |

## By character and scenario

Each value is the mean of two frozen reply scores. The letter is the former anonymous label **within that group only**.

| Character / scenario | Baseline | Added directives | Native few-shot |
| --- | ---: | ---: | ---: |
| Johnny / personal-past | 69.38 (B) | 65.00 (C) | 71.88 (A) |
| Johnny / ordinary-present | 70.63 (C) | 66.88 (B) | 66.88 (A) |
| Judy / personal-past | 77.50 (A) | 70.00 (B) | 72.50 (C) |
| Judy / ordinary-present | 69.38 (B) | 65.00 (A) | 75.00 (C) |
| Panam / personal-past | 80.00 (B) | 70.63 (C) | 60.00 (A) |
| Panam / ordinary-present | 66.88 (C) | 61.25 (A) | 64.38 (B) |

## What remained unconvincing

- **Johnny's personal follow-up:** all three conditions produce a compact identity summary. The native-example answer ends with “a grudge and a loud guitar”; the directive answer says his identity is “just a reaction” to war. Brevity improved neither individuality nor the feeling that he is deciding what to share. No condition needs to ask “why?” to succeed.
- **Shared conversational templates:** all six Johnny/Judy personal follow-ups start with “Fair enough,” and all three Panam follow-ups start with “I appreciate that.” The fixed polite V follow-up partly invites acknowledgement, so repetition is an observed limitation, not proof that sessions leaked or the service ignored style fields. The run verified separate sessions and disabled memory.
- **Coffee uncertainty:** several replies assume deliberate cheating or vendor error before evidence supports it. Some then joke about a fight V never proposed; two replace the stall with a machine. None first suggests checking the receipt. Accepting V's second-turn correction is useful, but does not erase the first-turn overreaction.
- **Name-label echoes:** 12 of 36 replies begin with the character's name: eight baseline, four directive, zero native-example. This is an output-format defect, kept separate from personality scores. Samples in multiple conditions use labels, so this small count does not prove that changing the example source fixes it. No score was retroactively reduced.
- **Source fidelity has limits:** the reviewer found no major quest, romance or private-memory leak, but flagged minor invented details and biographical imprecision. No held-out quote match was detected; that is not an exhaustive proof of originality.

## Narrow next experiment, if approved

Test **Johnny only**, keeping the reviewed biography and speaking-style field unchanged. Compare the baseline against the same profile whose sample field contains two short **original multi-turn demonstrations** of choosing a small disclosure and revising an everyday assumption. Derive their delivery from inspected scenes, without copying scene lines, importing their trust state, or teaching the test answers.

Use two fresh topics, three turns each, with two independent generations per condition: 24 replies total. A third turn tests whether Johnny follows the listener's direction or repeats another identity slogan. Keep any dialogue-only formatting instruction identical in both conditions and report prefix errors separately. This targets the clearest unresolved behavior; repeating the broad three-character trial with more adjectives is not supported by these results. No follow-up API calls or production changes have been made.

## All 36 scored replies joined

Ratings are rhythm / register / personality / context / agency, each 0–4. IDs link directly to the unchanged text in the [blind packet](BLIND_SAMPLES.md) and structured comparison.

| Reply | Character / scenario | Condition | Turn | Ratings | Total | Prefix |
| --- | --- | --- | ---: | --- | ---: | --- |
| R-db312fea | Johnny / personal-past | Reviewed baseline | 1 | 3 / 3 / 3 / 3 / 3 | 75.00 | yes |
| R-d99b0146 | Johnny / personal-past | Reviewed baseline | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | yes |
| R-0d4a5bba | Johnny / personal-past | Added directives | 1 | 3 / 3 / 2 / 3 / 3 | 70.00 | yes |
| R-db418a42 | Johnny / personal-past | Added directives | 2 | 3 / 2 / 2 / 3 / 2 | 60.00 | yes |
| R-ee644d3d | Johnny / personal-past | Native few-shot | 1 | 3 / 3 / 3 / 4 / 3 | 80.00 | no |
| R-2c5f27f8 | Johnny / personal-past | Native few-shot | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | no |
| R-91b6b33d | Johnny / ordinary-present | Reviewed baseline | 1 | 3 / 3 / 3 / 3 / 3 | 75.00 | yes |
| R-137dbf95 | Johnny / ordinary-present | Reviewed baseline | 2 | 3 / 2 / 2 / 3 / 3 | 66.25 | yes |
| R-7df58a3c | Johnny / ordinary-present | Added directives | 1 | 3 / 3 / 3 / 2 / 3 | 70.00 | yes |
| R-e315efef | Johnny / ordinary-present | Added directives | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | yes |
| R-e039744b | Johnny / ordinary-present | Native few-shot | 1 | 3 / 3 / 2 / 2 / 2 | 58.75 | no |
| R-3ae48508 | Johnny / ordinary-present | Native few-shot | 2 | 3 / 3 / 3 / 3 / 3 | 75.00 | no |
| R-ca7cb470 | Judy / personal-past | Reviewed baseline | 1 | 3 / 3 / 3 / 4 / 3 | 80.00 | no |
| R-d4727c67 | Judy / personal-past | Reviewed baseline | 2 | 3 / 3 / 3 / 3 / 3 | 75.00 | no |
| R-7b32312f | Judy / personal-past | Added directives | 1 | 3 / 3 / 2 / 3 / 3 | 70.00 | no |
| R-3b562c7d | Judy / personal-past | Added directives | 2 | 3 / 3 / 2 / 3 / 3 | 70.00 | no |
| R-bc9b15b2 | Judy / personal-past | Native few-shot | 1 | 3 / 3 / 3 / 3 / 3 | 75.00 | no |
| R-42df2f2a | Judy / personal-past | Native few-shot | 2 | 3 / 3 / 2 / 3 / 3 | 70.00 | no |
| R-37a570ae | Judy / ordinary-present | Reviewed baseline | 1 | 3 / 3 / 3 / 2 / 2 | 63.75 | no |
| R-b8f92adf | Judy / ordinary-present | Reviewed baseline | 2 | 3 / 3 / 2 / 4 / 3 | 75.00 | no |
| R-cf7911c9 | Judy / ordinary-present | Added directives | 1 | 3 / 2 / 2 / 3 / 2 | 60.00 | no |
| R-c55c9b63 | Judy / ordinary-present | Added directives | 2 | 3 / 3 / 2 / 3 / 3 | 70.00 | no |
| R-0b926dcd | Judy / ordinary-present | Native few-shot | 1 | 3 / 3 / 3 / 3 / 3 | 75.00 | no |
| R-2867740d | Judy / ordinary-present | Native few-shot | 2 | 3 / 3 / 2 / 4 / 3 | 75.00 | no |
| R-686d5e38 | Panam / personal-past | Reviewed baseline | 1 | 3 / 3 / 3 / 4 / 3 | 80.00 | yes |
| R-7140e11e | Panam / personal-past | Reviewed baseline | 2 | 3 / 3 / 3 / 4 / 3 | 80.00 | yes |
| R-b5917f74 | Panam / personal-past | Added directives | 1 | 3 / 3 / 3 / 3 / 3 | 75.00 | no |
| R-2b0e8134 | Panam / personal-past | Added directives | 2 | 3 / 2 / 2 / 3 / 3 | 66.25 | no |
| R-e3f50915 | Panam / personal-past | Native few-shot | 1 | 3 / 2 / 2 / 3 / 2 | 60.00 | no |
| R-7e515162 | Panam / personal-past | Native few-shot | 2 | 3 / 2 / 2 / 3 / 2 | 60.00 | no |
| R-c776604e | Panam / ordinary-present | Reviewed baseline | 1 | 3 / 3 / 3 / 2 / 2 | 63.75 | yes |
| R-cbea12e2 | Panam / ordinary-present | Reviewed baseline | 2 | 3 / 3 / 3 / 2 / 3 | 70.00 | yes |
| R-bf3156de | Panam / ordinary-present | Added directives | 1 | 3 / 3 / 2 / 2 / 2 | 58.75 | no |
| R-4a826978 | Panam / ordinary-present | Added directives | 2 | 3 / 3 / 2 / 3 / 2 | 63.75 | no |
| R-cb5a9a2d | Panam / ordinary-present | Native few-shot | 1 | 3 / 3 / 2 / 2 / 2 | 58.75 | no |
| R-05a432ce | Panam / ordinary-present | Native few-shot | 2 | 3 / 3 / 2 / 3 / 3 | 70.00 | no |

## Integrity and limits

- Frozen score SHA256: 6ecfedf6c71facca122d5dc502a2d2da14c7709ef258bb810d0e1f5580fe66e1.
- Frozen review SHA256: 75e3c66fad361fc61d028b920dfc5244abf427c8841b6c641aecb8b4280b087c.
- The join verifies all reviewed input hashes, all 36 raw response hashes, all reply IDs, all 18 exchange mappings and score arithmetic.
- One model-authored evaluator, prior familiarity with the dossiers, small scene samples and fixed V continuations limit interpretation. There is no statistical significance claim, human preference result, voice-performance assessment or proof of long-term conversational stability.
- The one administratively interrupted reply was excluded before inspection and replaced under explicit authorization. All disposable profiles were removed. [Run and cleanup details](CLEANUP.md).
