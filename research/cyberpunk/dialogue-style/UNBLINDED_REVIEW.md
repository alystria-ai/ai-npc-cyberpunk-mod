# Interpretation after unblinding

2026-09-30. The runner verified the frozen blind score hashes before releasing
the mapping. [BLIND_REVIEW.md](BLIND_REVIEW.md) and [blind-scores.json](blind-scores.json)
are unchanged. This document adds interpretation, not revised ratings.

## Result

There is **no evidence here to replace the reviewed baseline with either new
prompt condition**. Added interaction directions did not produce the intended
conversational depth in this small run. Native examples produced some usable
replies, but the gain was uneven and they weakened Panam's personal exchange.
This is a qualitative pilot result, not proof that either technique generally
fails or that the baseline is sufficiently good.

| Condition | Johnny | Judy | Panam | All 12 replies |
| --- | ---: | ---: | ---: | ---: |
| Reviewed baseline | 70.00 | 73.44 | 73.44 | 72.29 |
| Added interaction directions | 65.94 | 67.50 | 65.94 | 66.46 |
| Directions plus native examples | 69.38 | 73.75 | 62.19 | 68.44 |

Each character mean covers only four replies. Judy's 0.31-point native-example
edge and Johnny's 0.62-point difference are inconclusive. Panam's larger gap
has an identifiable qualitative cause in these particular outputs: the native
example condition repeats abstract security/deal language, while the baseline
distinguishes leaving camp from rejecting the family and then explains the
conflict with Saul. Example selection, prompt length and sampling are confounds.

All three conditions were comparably concise. None received an agency score
above 3/4 in this review. Removing biography dumps has not yet produced much
distinctive back-and-forth. The native condition omitted speaker-name prefixes
in all 12 replies, versus eight baseline and four direction-only replies;
that is a useful output-format observation, not evidence of better character
portrayal. The runner owns the separate format audit.

## Behaviors worth carrying forward

| Observed behavior | Exact evidence | What to preserve |
| --- | --- | --- |
| Small disclosure grows after clarification | Baseline Judy, `E-d302e03b`: family/absence first, then a positive grandfather repair detail. | Choose one relevant memory or feeling. Let the next turn change the emphasis; do not supply a dossier or manufacture a vivid history. |
| Loyalty and disagreement can coexist | Baseline Panam, `E-270868b1`: leaving camp is not rejecting her people; the second turn adds the disagreement with Saul. | Express a tension through the answer instead of reciting “proud, loyal, independent.” This is a bounded explanation, not a whole quest history. |
| Ask about the practical aim when useful | Baseline Johnny, first turn of `E-88ed515c`: refund versus making a scene. | A character can respond to V's motive rather than mechanically answering the surface question. Keep the initiative; avoid assuming theft or forcing V into a false binary. |
| Conditional social judgment | Native-example Judy, first turn of `E-d4dc3a2a`: whether approaching the vendor is likely to help. | Concrete judgment feels more individual than a universal justice slogan. Her second turn drops the dispute when V corrects the premise. |

These are candidate behaviors, not sentences to paste into profiles. A direct
small answer remains valid. Johnny does not need to demand an explanation
before every personal question. The successful native held-out evidence also
includes quietly conceding a point or withdrawing a request.

## Regressions and unresolved defects

- **Directions did not reliably govern the next turn.** Direction-only Johnny
  still pivots from a corrected coffee bill to a corporate-ledger maxim
  (`E-a7937c35`), despite the instruction to keep ordinary moments ordinary.
  Another paragraph saying the same thing is not an established solution.
- **A short persona summary is still a summary.** Every Johnny war follow-up
  compresses him into war damage, scrap, reaction or a grudge and guitar. It is
  concise but gives V little specific thought to respond to. Do not mistake
  this for earned emotional disclosure.
- **Source examples are not automatically representative.** The native Panam
  past pair (`E-91e469bd`) repeats security and corporate compromise without
  developing her personal decision. The prompting scenes were uneven, and a
  vehicle-instruction sample cannot stand for her full emotional repertoire.
- **Uncertainty turns into accusation.** Coffee replies often decide that the
  vendor cheated V before the bill is checked. The second turn may then tease
  V for almost starting a fight that the character helped invent. This is a
  present-context reasoning defect, not a missing biography fact.
- **Voices blend at the joints.** Fixed acknowledgements and coffee closing
  jokes recur across characters and conditions. Slang or one sarcastic noun
  does not repair that sameness.
- **Formatting must be assessed separately.** Speaker-name prefixes can damage
  spoken output, but stripping them would not fix shallow disclosure,
  interchangeable jokes or unsupported assumptions.

## Suggested next comparison for the parent

Keep the reviewed baseline as the control. Test a lean replacement that makes
the current conversational move and known relationship state easier to use,
instead of appending another general personality lecture. A source-grounded
two-turn example could demonstrate a changed response; one isolated punchline
cannot demonstrate adaptation. This is a hypothesis, not a proven improvement.

Use a fresh personal topic and at least a third continuation, with contrasting
user intentions such as genuine curiosity and unwanted pressure. The character
should be able to answer, ask, decline or revise without performing the same
move every time. Also retain one ambiguous everyday situation where a new fact
should reverse an initial assumption. Check more than one generation before
attributing a difference to the prompt, then have the user judge actual spoken
conversation. No new calls or production changes were made for this review.
