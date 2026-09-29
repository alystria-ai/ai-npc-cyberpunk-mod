# Character prompting and conversation research

Research date: 2026-09-30. Scope: choosing and evaluating prompt changes for
Cyberpunk companions. This is a research and experiment-design artifact;
it does not apply provider profiles, change the bridge, or qualify live behavior.

## Decision to test

Keep the reviewed biography and knowledge boundaries. Compare the existing
three-field profile against concise, individual interaction guidance and against
dialogue demonstrations grounded in the character's delivery. The immediate
local pilot uses short installed-game reference lines; any later profile
authoring should use original examples rather than export a transcript pack.

The user's Johnny example exposes the main problem: a question about the war is
also a social approach to a guarded person. A plausible response might probe
why V is asking, offer a small answer, or set a boundary. Once V clarifies, the
next reply should respond to that clarification. Automatically reciting his
military biography misses the interaction; automatically demanding a reason
every time also misses it. These are design hypotheses, not a required script.

The immediate comparison should answer three questions:

1. Does each character make a recognizably individual conversational choice?
2. Does that choice fit the current relationship, audience and preceding turn?
3. Does the character express the choice naturally while preserving factual
   and disclosure boundaries?

## Evidence that changes the design

Only official product documentation, author research and publication records
are used below. Research claims are attributed separately from proposed mod
adaptations. No paper establishes that these prompts improve our current Convai
model or that a score predicts the player's experience.

| Primary source | Evidence inspected | Useful implication and transfer limit |
| --- | --- | --- |
| [Convai, Character Description](https://docs.convai.com/api-docs/convai-playground/character-customization/character-description) | Official documentation separates core description, speaking style and sample dialogue. Style includes tone, pace, formality and speech patterns. | Keep identity, delivery guidance and demonstrations separately authored. The documentation explains product controls; it is not an experiment proving that more adjectives or catchphrases produce better conversation. |
| [Wang et al., RoleLLM, Findings ACL 2024](https://aclanthology.org/2024.findings-acl.878/) | The framework separately constructs role profiles, extracts role knowledge, elicits speaking style, and tunes models. The inspected method distinguishes general interactions from role-specific questions. | Evaluate knowledge and performance of character separately. Good factual recall cannot substitute for delivery. Reported results include generated training data and fine-tuning; copying an instruction into a hosted model does not reproduce that intervention. |
| [Shao et al., Character-LLM, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.814/) | The paper trains agents using constructed experiences and emotional states and evaluates them through interviews about their memories and experiences. The publication abstract was inspected. | A personal history can influence present judgment without being narrated in full. This is evidence about a trained system, not a prompt-only result. For our characters, inventing an emotionally vivid incident would still be a factual error. |
| [Wang et al., InCharacter, ACL 2024](https://aclanthology.org/2024.acl-long.102/) and [author repository](https://github.com/Neph0s/InCharacter) | Interview-based personality assessment is compared with direct self-report. Section 5.1 reports better alignment and consistency for interviews under the studied scales and raters. | Test how a character answers a situated question, rather than whether it can describe itself as rebellious or caring. Personality-scale alignment is not a canonical diagnosis, naturalness score or substitute for scene evidence. |
| [Feng et al., EmoCharacter, NAACL 2025](https://aclanthology.org/2025.naacl-long.316/) | The publication reports single- and multi-turn emotional-fidelity evaluation across seven LLMs. Role-playing methods sometimes degrade emotional fidelity; dialogue-based in-context learning and fine-tuning improve results in their experiments. | Compare source-grounded demonstrations rather than assume a stronger persona instruction helps. The result does not establish that every example set, character, language or hosted model improves. Emotional appropriateness also cannot be reduced to positive sentiment. |
| [Xiang et al., RMTBench, Findings EMNLP 2025](https://aclanthology.org/2025.findings-emnlp.730/) | The paper's abstract and introduction motivate user-intention-driven multi-turn scenarios instead of isolated character Q&A, with 80 characters and over 8,000 dialogue rounds. | Include an ordinary present-tense exchange and a follow-up whose intent differs from the opening question. Two turns can reveal a failure to adapt; they cannot establish stability over a long relationship. |
| [Wang et al., Memory-Driven Role-Playing, Findings ACL 2026](https://aclanthology.org/2026.findings-acl.1175/); [author full text](https://arxiv.org/html/2603.19313v1) | The method separates persona anchoring, relevant-facet selection, knowledge boundaries and enactment. Sections 3, 4.5, limitations and appendices I/L were inspected. Prompt gains vary by model; Qwen3-Max's aggregate comparison is essentially unchanged. Evaluation generates one reply from fixed context, with an automatic judge calibrated against one human rater. | Try selective, bounded use of the profile, not a longer biography. The paper's persona “memory” is supplied information; it is not proof of durable Convai memory, save reconciliation or interactive group memory. Its findings do not establish repeated-turn improvement in our service. |
| [Levinson and Torreira, Timing in turn-taking, Frontiers in Psychology 2015](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.00731/full) | The article reviews and analyzes rapid human turn transitions and response planning. It treats questions, offers and other turns as actions within a sequence; prolonged gaps can themselves affect interpretation. | Review whether a response fits the preceding action and leaves a usable next turn. Human timing does not impose a 200 ms engine target or justify speaking before V finishes. Text quality, model latency and audio scheduling need separate tests. |
| [Zhou et al., PersonaEval, COLM 2025](https://openreview.net/pdf?id=drdrFhKYjP); [author full text](https://arxiv.org/html/2508.10014v1) | The benchmark tests role identification from human-authored material. Its appendix explicitly notes bias from model-based hard-case filtering. Full methods/results and that limitation were inspected; publication is corroborated by the OpenReview conference PDF record and author metadata. | Use a blinded model review as a diagnostic. Do not label its preferences human validation. Optional anonymous speaker attribution can expose generic prose, but familiar names, factual clues and the evaluator's own biases confound it. |

Access note: some publisher/PDF requests were unavailable through the browsing
tool. Where indicated, the inspected material was the official indexed abstract
or method excerpt and the authors' repository, rather than a complete PDF.
The distinctions above deliberately avoid claims beyond that material. Full
author HTML was available for the memory-driven and evaluator studies. No
large prompt template or dialogue transcript is reproduced here.

## Four authoring layers

This is a proposed organization for our existing contract, not a new API
schema. The established provider fields remain `backstory`,
`speaking_style_description` and `speaking_style_sample_dialogues`.

| Layer | Contents | Placement and constraint |
| --- | --- | --- |
| Identity | Supported history, work, values, enduring tensions, era and self-conception | Static biography. State only pre-branch facts. A summoned body does not establish a resurrection, friendship or completed quest. |
| Behavior and delivery | What the person attends to, how they disagree or repair an exchange, cadence, register, humor and emotional range | Speaking-style description plus original demonstrations. Use situational tendencies, not a mandatory question/refusal/catchphrase formula. |
| Relationship and immediate context | Present audience, recent dialogue, verified relationship state, urgent activity and the user's current conversational intention | Bounded dynamic context. A polite clarification is evidence of the current intention, not proof of exceptional trust or romance. |
| Knowledge and disclosure | What the character knows, how they learned it, uncertainty, time boundary and who may hear it | Reviewed knowledge selection and audience rules. A known secret is not an automatic disclosure. A public journal fact is not personal witnessing. |

The layer boundaries matter in concrete cases. Johnny's soldier/deserter history
belongs to identity. His reaction to V asking about it is a behavioral choice.
Whether this V has earned unusual candor belongs to the relationship context.
Which details he can substantiate, and whether he shares them in a group, belong
to knowledge and disclosure. None can be inferred from spawning Johnny.

An implementation should pass only authorized facts and the relevant recent
exchange to the speaker. It should preserve distinctions between the character's
own knowledge, information V just supplied, and facts still unknown to them.
Prompt wording is an additional behavioral guard, not a replacement for the
existing save, provenance and audience checks. A generated claim must not become
verified canon merely because it appeared in conversation history.

## Individual hypotheses for the pilot

These character interpretations come from the reviewed
[Johnny dossier](../dossiers/johnny-silverhand.json),
[Judy dossier](../dossiers/judy-alvarez.json) and
[Panam dossier](../dossiers/panam-palmer.json). The local reference packets hold
short installed-game excerpts with scene and localization provenance. The
papers above do not establish Cyberpunk canon. Late-game scene delivery may be
useful evidence of range without authorizing late-game intimacy in this test.

| Character | Choices worth testing | Delivery to preserve | Common caricature to catch |
| --- | --- | --- | --- |
| Johnny | May question the premise or motive behind a personal question; may instead give one blunt answer. Can change from defensive humor to a plain admission when the exchange warrants it. Can accept an ordinary moment without performing rebellion. | Dry attacks, concrete objects of criticism, abrupt changes in intensity, occasional quietness. Profanity carries emphasis. His remembered account can remain subjective. | Every prompt becomes an anti-corporate monologue, a polished aphorism, automatic suspicion or a compulsory “why?” A clarification must not trigger the same challenge again. |
| Judy | May notice a practical or sensory detail first. Can distinguish helpful curiosity from pressure for private history. May accept an invitation to do nothing without turning it into therapy or repair work. | Colloquial precision around her craft, small jokes, impatience when useful, tenderness without automatic confession. | Every answer returns to Evelyn, trauma, exploitation or a lecture about braindances. Small talk should not require a tragic revelation. |
| Panam | May seek a concrete plan, insist on being understood fairly, or revise an assumption after V clarifies. Can recognize Saul's responsibilities while disagreeing with him. Can relax without manufacturing a mission. | Direct and relatively articulated sentences; emphatic imperatives under pressure, straightforward warmth or teasing in calm company. | Constant anger, generic nomad proverbs, unconditional hostility toward Saul, or treating V as a proven family member before the relationship supports it. |

The target is a range of plausible choices with stable individual priorities.
It is not maximum difference between all three at every moment. They may all
agree to sit quietly; the reason they offer, the register and the amount of
explanation can still feel individual. Refusing ordinary agreement just to
create distinctiveness would make them exhausting companions.

### Johnny's war question: assess the exchange, not a required line

For the pilot's opening question, several first moves can succeed:

- A short, relevant answer that leaves room for more.
- A brief probe of V's purpose, if it fits his current attitude.
- A boundary expressed as his own choice rather than a generic policy refusal.

On the next turn, V explains that the aim is understanding and allows him to
decline. Successful adaptation could be one new supported detail, a clearer
personal stance, a softened tone, or a boundary maintained without repeating
the same interrogation. V's reassurance need not unlock a confession. A long
war chronology, a fabricated squadmate, an invented sensory memory, or an
unchanged demand that V justify the question would be concrete defects.

Neither question count nor number of disclosed facts is a success metric.
The character should recognize V's contribution and choose the next move.
The same general capacity must also work when V changes an ordinary plan,
without making that change emotionally weighty.

## Prompt candidates and demonstrations

The controlled pilot compares three conditions:

| Condition | Intervention | What the comparison can tell us |
| --- | --- | --- |
| A | Current reviewed three-field profile | Establishes how the existing material behaves on these exact exchanges. |
| B | A plus short character-specific interaction guidance | Tests whether explicitly describing conversational choices improves responsiveness and reduces generic exposition. |
| C | Same factual background, with five short, speaker-verified installed dialogue lines per character, from scenes separate from the held-out references | Tests whether source-grounded delivery examples help beyond the baseline. Single-line demonstrations may convey diction better than turn-to-turn adaptation; evaluate both separately. |

Record the actual serialized prompt and model settings. Label precisely whether
C adds to A or replaces its examples; an uncontrolled mix cannot be explained
as an isolated few-shot effect. Keep scenario facts, supported biography, memory
configuration, model, decoding settings and maximum reply budget equal where
the service allows it. Report prompt and output lengths rather than assuming
added examples are free. Do not add an external planning-model call for this
pilot; it would change both the intervention and latency.

For later example authoring, use a small range of original, situated exchanges:

1. A direct practical answer with no unnecessary follow-up question.
2. A personal subject with optional hesitation and a response to clarification.
3. A disagreement that preserves the character's stance without restarting the
   argument on every turn.
4. An ordinary social moment with humor, curiosity or acceptance.
5. A knowledge boundary handled in character without inventing missing history.

Demonstrations should show why the next turn changes. A collection of standalone
witty lines can teach a character to perform a quotation rather than listen.
Examples demonstrate possibilities; they are not memories of exchanges with V.
Avoid exact game quotations, lightly rewritten distinctive lines, unconfirmed
quest outcomes, and answer-shaped examples for the evaluation prompts.

Do not append universal rules such as “always end with a question,” “challenge
every personal question,” “never explain,” or “use a catchphrase each time.”
Likewise, a rigid two-sentence rule can damage a reply that genuinely needs more
space. Prefer a modest default length with room for the user's actual request.
Review unnecessary explanation rather than treating all length as a defect.

## What the 36-reply experiment can establish

The planned set is three characters × three conditions × two scenarios × two
character turns. Read the 18 complete exchanges as well as each of the 36
replies. The frozen [rubric](RUBRIC.md) separates rhythm, register, personality,
context fidelity and agency/adaptation; the [scenario file](scenarios.json)
fixes the relationship and immediate situation.

The comparison needs these controls and disclosures:

- Keep held-out reference scenes out of generation prompts. Freeze scoring
  before revealing condition labels. Character identity can remain available
  to the judge because correctness depends on it; hiding the prompt condition
  is the essential blind.
- Treat unsupported plot, relationship, private-memory and audience claims as
  separate hard failures. A stylish secret leak cannot be offset by good prose.
- Check whether turn two uses the clarification, repeats the earlier move,
  contradicts it, or ignores it. A plausible isolated sentence can still fail
  as the continuation of an exchange.
- Record copying or conspicuous echoes of source lines and profile examples.
  The initially proposed radio/sitting scenario overlapped existing baseline
  examples. Before generation, the experiment owner replaced it with a coffee
  stall's apparent duplicate charge and V's later correction of the mistake.
  Training references avoid war, Laguna Bend and coffee. These checks reduce
  direct overlap; they cannot prove absence of model pretraining exposure.
- Report per-character and per-scenario results, failure examples and close
  calls. One generation per cell cannot estimate reliability or support a
  statistically meaningful ranking from small score differences.
- Repeat a promising result on at least one genuinely fresh topic and another
  generation before a broad profile rollout. Then let the user hear and steer
  short real exchanges. A model-authored blind rubric is still a model judgment.

A follow-up set should add private versus group audiences, a mistaken premise,
an explicit topic change, two different trust states grounded in supplied
evidence, and longer exchanges where earlier choices must remain consistent.
Each variation should alter only the intended condition. Romance must not be
used as a shortcut for all personal disclosure.

## Boundaries and next decision

This text experiment cannot establish speech prosody, accent, lip sync,
streaming behavior, UI quality, group turn scheduling or time to first audio.
Prompt length may affect cost and response time, but there is no measured
latency benefit in this research artifact. Durable memory remains a separate
qualification problem; describing “memory” in a prompt does not prove storage
or retrieval across sessions or save branches.

Choose changes based on observed exchange-level improvements with no factual
or disclosure regression. Keep individual differences when one approach helps
Johnny but not Judy or Panam. Extend the authoring method to other characters
only after that evidence exists, retaining sparse-canon limits for minor roles.
The research supports a controlled comparison and concrete failure analysis;
it does not justify replacing all 79 profiles on theoretical appeal alone.
