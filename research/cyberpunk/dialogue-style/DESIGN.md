# Dialogue style pilot

Frozen before generation, 2026-09-30. This is a text-only comparison on the
current account, not a voice, lip-sync, model-training or game-performance test.

## Question

Which prompting approach best preserves Johnny, Judy and Panam's individual
voice while letting them choose what to reveal and respond naturally to V's
next turn? Knowing a biography is not the same as volunteering it in response
to any personal question.

The independent reviewer must read only RUBRIC.md, scenarios.json, held-out
references and the anonymous sample sheet until their scores are frozen.

## Fixed experiment

- Three characters and one model: fast-gemma-4-31b-it.
- Three conditions; two two-turn exchanges per character/condition: 36 replies.
- One personal-history exchange and one mundane misunderstanding that V then
  corrects. Scenarios are identical across conditions. The continuation is fixed
  rather than authored after seeing a favorable reply.
- Cordial recent acquaintances, no romance, completed quest or special trust.
- The reviewed compiled biography, knowledge/privacy boundaries and voice
  configuration are identical between conditions, apart from unique disposable
  ownership metadata. Voice playback and TTS are disabled.
- A fresh profile for each character/condition and a fresh session for each
  two-turn exchange. The second turn retains the first turn's actual response.
  Memory is disabled and read back before connecting. The synthetic benchmark
  end-user ID is reused; the mid-run policy correction below is fully recorded.
- A character-specific rotation balances which condition runs first. Calls are
  serial; no ambiguous Core mutation is retried. No deterministic sampling control is exposed by this
  tested SDK path, so one generation per cell remains a noisy small pilot.

### Conditions

1. **Reviewed baseline:** the existing research compiler's three separate fields,
   including its original examples and short-conversation/privacy instructions.
2. **Interaction directives:** baseline plus a short conversation-specific and
   character-specific direction: notice what V is doing socially, choose a
   relevant facet, allow a genuine boundary or a direct answer, and adapt after
   clarification. It does not require a question, refusal, confession or joke.
3. **Native few-shot:** the same added directions, replacing original examples
   with five brief, speaker-verified game specimens and their scene contexts.
   They teach delivery, not current-save facts or phrases to repeat.

This separates the added direction effect (2 versus 1) from changing the example
source (3 versus 2). Prompt lengths are not equal: length and example selection
can contribute to any difference. Results cannot establish that every native
example set, character or model will behave the same way.

## Grounding and held-out references

select_references.py joins selected line IDs to the installed English subtitle
resource, the scene screenplay item and the named scene actor. Each specimen
retains scene/archive identity, binary SHA256, actor and localization pointers.
It rejects a mismatched speaker or subtitle and verifies scene-disjoint splits.

Training scenes: Johnny's cinema/movie conversation, Judy's Clouds aftermath,
and Panam's vehicle demonstration. Held-out scenes: Johnny's oilfield and Kerry
mansion, Judy's lakeside morning, and Panam's camp wakeup conversation.

These are a deliberately small, uneven sample of each character's repertoire.
Judy's selected training scene contains more tension than ordinary conversation;
Panam's contains practical instruction. A weaker condition could reflect that
selection. Separate branches are never assembled into a purported canonical
dialogue, and scene relationship state must not leak into the trial. Held-out
lines are never sent as examples or target answers.

The original radio/repair-and-sitting present scenario was replaced before any
generation because it resembled the baseline examples. The frozen mundane test
uses a suspected duplicate coffee charge followed by V's factual correction.
The paper-inspired hypotheses concern turn design and restrained disclosure,
not longer biographies, forced secrecy, or literal internal reasoning steps.

Primary-source methodological research is recorded separately in
[PROMPTING_RESEARCH.md](PROMPTING_RESEARCH.md). Relevant inspected papers include
[RoleLLM](https://aclanthology.org/2024.findings-acl.878/),
[EmoCharacter](https://aclanthology.org/2025.naacl-long.316/), and
[Memory-Driven Role-Playing](https://arxiv.org/html/2603.19313v1).
Their findings motivate a test; they do not validate these exact Convai/Gemma
prompts. The last paper's supplied persona memory is not Convai long-term memory.

## Safety and reproducibility

run.mjs previews by default. --preflight builds the installed SDK and opens/closes
one owned hidden browser without reading the key or calling the provider.
--run reads only runtime/convai-key.txt and never logs it. At most one disposable
profile exists at once; each has a unique name and ownership marker, a durable
pre-dispatch receipt, verified three-field/model readback and disabled memory.

A create with an uncertain response is never repeated. Cleanup discovers the
exact unique name, verifies its ownership marker, then deletes that profile only.
Delete ambiguity is reconciled by a fresh list and never blindly retried.
--cleanup-only resumes recovery. A partial run cannot start another generation
attempt. The original durable counter capped submitted text turns at 36; the
single explicitly authorized identity-policy continuation caps them at 37.

No production profile, live game, installed bridge, real user memory, microphone,
voice worker or model dataset is changed. The headless browser runs with GPU
disabled. Raw character/session/end-user IDs and recovery state remain under the
ignored .private directory; public results use random response IDs only.

## Evaluation and reporting

### Recorded identity-policy correction

The original runner allocated a synthetic end-user UUID per two-turn pair.
After generation started, the operator asked that the same synthetic ID be
reused. At the stop, eight replies had been recorded and a ninth send was in
flight; five synthetic IDs and three disposable profiles had been allocated.
All three profiles were deleted and their absence verified before continuing.

The unmeasured in-flight reply was marked abandoned, never inspected, and
excluded from evaluation. The operator explicitly allowed one replacement send
with a 37-dispatch cap, preserving 36 measured replies and the same frozen
questions. Its two-turn exchange starts anew, so no continuation pretends to
have seen a lost first response. Already completed exchanges are preserved.
All subsequent exchanges use the first durable synthetic ID with memory
disabled and a new session per pair. This is a setup interruption, not outcome
selection or a retry of an ambiguous create/update/delete. It adds one
disposable profile to the original nine-profile plan.

### Blind review

The independent reviewer freezes the rubric before seeing generated replies,
then scores every reply and both-turn adaptation before unblinding. The sample
sheet shuffles A/B/C independently within each character/scenario group; one
letter does not consistently identify a prompt across groups.

Report first text and completed text latency separately from connection setup,
word count, unsupported biography/disclosure, repeated deflection, narration and
possible phrase recycling. Latency is client-observed network/SDK time, not an
isolated model benchmark. No best prompt is declared before that review.

One model-authored blind review is not a human panel or proof of player preference.
Small gaps are inconclusive. A promising pattern should receive fresh-topic
confirmation and user review before any production prompt change.
