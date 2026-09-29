# Blind dialogue review

Version 1, frozen before viewing generated responses, 2026-09-30.

## What is being judged

The pilot contains 36 replies: Johnny, Judy and Panam each take part in two
two-turn exchanges under three concealed prompt conditions. One exchange asks
about sensitive personal history; the other concerns the present situation.
The complete exchange is the primary reading unit. Every reply also receives
an individual score. V is a cordial recent acquaintance: no romance, completed
quest, special trust or disclosure follows from summoning a companion.

This is a qualitative review authored by a model, not a human panel, automatic
quality measurement or ground truth. The reviewer previously authored Johnny's
research dossier. Concealing condition labels prevents deliberate condition
preference; it cannot remove that prior familiarity or general model bias.

## Native reference boundary

Held-out references are short installed English dialogue excerpts with exact
scene, actor, screenplay, localization and binary-hash provenance. They are
withheld from generation prompts. Their scene context is essential: a late
relationship conversation demonstrates delivery, not how a stranger should be
treated or which events occurred in this test.

| Character | Reserved installed scenes | What they demonstrate |
| --- | --- | --- |
| Johnny | `sq031_05_grave`; `sq011_01_kerry_mansion` | Skeptical questions, guarded admissions, brief earned commitments, backing off a request, ordinary interest and practical judgments. His swearing and political anger are variable, not a quota. See [six references](held-out/johnny.json). |
| Judy | `sq030_11_morning` | Hesitation, understated hurt, small clarifications and practical warmth. Section117 reacts to V's description of their encounter; section216 leaves V room to choose. This does not justify romantic familiarity in the test. |
| Panam | `sq027_09_new_camp_wakeup` | Direct concern changes with V's explanation: sections552/554 differ in pressure; section574 admits limited understanding and asks how to help. Full sentences and practical questions coexist with bluntness. She need not sound like Johnny. |

The Judy and Panam held-out manifests are supplied by the runner before
scoring. All generation variants, condition definitions and private mappings
remain unread until the scored sheet is frozen. Scripted subtitle fragments
are not independent conversational turns or a target sentence-length formula.
English text cannot establish accent, voice performance, emotional prosody,
lip sync or playback latency.

## Scores

Each dimension uses 0–4: **0** clear failure, **1** weak, **2** plausible but
generic/inconsistent, **3** convincing, **4** especially precise and natural
for this context. Weighted total is `sum(weight * rating / 4)` out of 100,
before the explicit penalties below. Record a short evidence-based reason;
scores are judgments, not measured probabilities.

| Dimension | Weight | Evidence to look for |
| --- | ---: | --- |
| Sentence rhythm and turn design | 20 | Spoken clauses, useful pauses, varied length, one or a few connected conversational moves. Avoid polished miniature essays, lists and redundant conclusions. Brevity alone does not earn points. |
| Register | 15 | Believable vocabulary and syntax for this character and situation. Avoid imported therapist/customer-support phrasing, decorative slang and obligatory profanity. Do not demand constant sarcasm or identical clipped grammar from all three. |
| Personality and emotional specificity | 20 | Distinct priorities and a proportionate emotional response; warmth, irritation, doubt or humor when earned. A concrete response to the object/person beats a generic manifesto or mascot catchphrase. |
| Context and epistemic fidelity | 20 | Answer the situation actually given; distinguish personal knowledge, opinion and uncertainty. Do not invent quests, romance, private disclosures, objects, threats or past shared experiences. Canonical truth can still be irrelevant or prematurely disclosed. |
| Conversational agency and adaptation | 25 | Choose what to answer, ask, defer or withhold; leave a usable opening. Turn two should respond to V's actual explanation and the character's previous reply. Avoid repeating the same gatekeeping question, dumping a biography or mechanically refusing every sensitive topic. |

An initial “why ask?” is one plausible Johnny move, **not a required answer**.
A direct, restrained answer can work equally well. After V clarifies, a small
new detail, changed tone, concrete offer or maintained but respectful boundary
can all show adaptation. A question at the end is optional. Vulnerability need
not escalate after a single reassuring sentence. Longer disclosure may be
appropriate when actually invited and earned; these scenarios do not request
an exhaustive life story.

## Failures and copying

- Record a separate factual/privacy failure for unsupported major plot,
  relationship or private-memory claims. Set context fidelity to 0 and cap
  the reply total at 49. A named canonical place or ordinary opinion is not
  automatically such a failure. Identify the exact unsupported claim.
- Do not reward quoting the game. A distinctive copied or lightly reworded
  clause receives a 15-point deduction; repeated copying receives 25 total.
  Record the matching reference. Common conversational phrases and names do
  not count. If the possible source is uncertain, flag it without a deduction.
- Canned catchphrases, repeated aphorisms, forced “choom,” and constant
  anti-corporate speeches lower register/personality scores when misplaced.
  They are not automatically copyright matches. Avoid double-counting an
  ordinary style defect as a copying penalty.

## Blind review procedure and reporting

1. Read only scenario text, held-out references and anonymized exchanges. Do
   not open runner scripts, condition definitions, prompt packets or mapping.
2. Read both turns together, then score all 36 replies in shuffled order.
   Record five ratings, penalty/flags, final total, confidence and a short reason.
3. For each of the 18 exchanges, record whether turn two adapts, repeats,
   contradicts or ignores the preceding exchange. Summarize its strengths and
   defects; do not select winners based on a favorite isolated sentence.
4. Freeze scores before unblinding. Report per-character and scenario results,
   not only a pooled mean. Preserve uncertainty and close calls.

There is only one generation per character/scenario/condition, so sampling
noise is substantial. Small score gaps are inconclusive; a five-point gap is
not a statistical threshold. No claim of general improvement, reduced
hallucination rate or best model follows from this pilot. User listening and
conversation testing remain necessary. A second independent generation should
check a promising pattern before changing production prompts.
