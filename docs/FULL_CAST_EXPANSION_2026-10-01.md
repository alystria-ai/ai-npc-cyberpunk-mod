# Full-cast expansion — October 1

## Runtime design

Every character conditions one shared OmniVoice model. A reference does not
create another model or a training job. The registry accepts up to 128 profiles,
but the current authored cast has 79. The three accepted references retain their
exact bytes and text. Expanded configurations use version 2 and lazy preparation;
startup conditioning is limited to three profiles, with eight cached prompts.

Invite owns a cancellable preparation ticket. It verifies the existing player
memory configuration, prepares the selected speaker, reconciles its audio route,
and warms the conversation connection before granting permission to appear.
Multiple copies of one character share that preparation. Model-only copies skip
the conversation work. Preparation does not send dialogue or create memories.

Provider changes and verified missing-reference results commit between turns.
Connection reconciliation reserves admission before awaiting the transport;
new text/microphone requests wait while that reservation is owned. Cancelled
invitations, changed worlds and memory guards cannot publish late permission.

Pending spawn tickets recheck their voice receipt. Conditioning eviction or a
changed selection revokes readiness and prepares again. A controlled connection
replacement retries instead of permanently failing the ticket. Already-spawned
copies recondition lazily at speech time, avoiding a loop that defeats the cache.
Missing or unprepared references use Convai explicitly. A failed local rendering
preserves the written reply and reports the error without sending a second turn.

## Source preparation methods

The casting tools follow the native scene actor, screenplay line, dialogue event,
English localization variant, installed subtitle and winning WEM into original
PCM. They authenticate the scene JSON by reserializing the winning binary with a
pinned WolvenKit executable and comparing its complete Data tree. Archive hashes,
typed pointers, WEM gender variants and transcript agreement remain separate
checks. A filename prefix or shared voice tag cannot prove character identity.

Two shared operating-system CPU locks bound archive/decoder work. Each casting
lane has an exclusive writer lock. Publication stages complete immutable receipts
and audio before committing the directory, with bounded Windows rename retries.
No gain, EQ, denoising, trimming, concatenation or reference resampling is used.

The roster's canonical identity projection contains keys, names, aliases and
records. Biography-only edits can evolve without invalidating the original
audio; changed identity fields fail validation. Receipts preserve the historical
full-roster hash and separately report the current hash and identity fingerprint.

[Casting status](VOICE_CAST_STATUS.md) distinguishes original-source verification,
listening qualification and production promotion. A waveform check or generated
sample is not a listening verdict. Wider-cast references remain drafts until that
qualification is available. Convai remains available for unsuitable sources.

## Knowledge evidence

The native compiler now enforces both exact-value assertions and the authored
relative-pointer `expected` predicates. Earlier exports lacking recorded JSON
hashes are being freshly serialized from current winning game assets, compared
in full, and checked at every cited pointer before their bindings change.
Hashing an older unbound JSON file alone does not qualify it retroactively.

Reviewed rules distinguish facts, completed objectives, delivered messages and
player-read receipts. Audience/privacy gates and rollback tests remain required.
The larger researched quest catalog is not a claim that every outcome is already
executable. [The character coverage audit](CHARACTER_KNOWLEDGE_COVERAGE_2026-10-01.md)
records that limitation and the next intrinsic-history work.

Generic residents have separate physical sessions but share durable memory by
profile/player. The resident dossiers now state that limitation truthfully;
remembered profile-level dialogue does not establish this pedestrian's history.
The one-player-ID policy is preserved.

## Intrinsic history and disclosure

Nineteen major characters now have source-qualified public history: 244 selected
claims and 148 original spoken samples. Compilation checks 10,475 exact native
pointers and attribution fields. Each claim binds its subject independently of
the speaker, then verifies typed actor, screenplay, emitted speech event and
English text where dialogue is used. Codex narrative remains attributed when it
is speculation. Reviewed internal codex/actor aliases require exact localized
title ownership and native voice evidence; they do not change roster identity.

Private, conditional and unsupported rows stay out of the universal biography.
Johnny and Jackie additionally have a bounded private topic layer for manual
one-to-one text and phone conversations. It uses reviewed canonical author JSON
pins, retains byte-exact native evidence hashes, freezes audience/profile at
admission, and rechecks current world/reset ownership. Output is capped at three
claims and 4,096 UTF-8 bytes. Groups and automatic reactions receive no private
topic cards. Ambiguous action phrases and current gang-war questions do not
unlock personal-history material.

Painful topics permit a brief human reaction while honoring the existing
follow-up setting and V's intent. Default Off does not force a question. Topic
matching currently covers curated English forms; F7 has no private topic card
because its recognized transcript arrives after the first response begins.
Private histories for the other characters remain excluded pending their own
disclosure-aware selectors. Shared provider memory is not a hard privacy partition.

The adopted public claim/sample sets persist in profile settings and published
roster receipts. Ordinary rebuilds reject missing evidence or silent removal;
an explicit adoption cannot accidentally shrink an earlier reviewed character.
The two initial and seventeen later cloud updates preserved existing mappings,
voice/model choices and memory configurations. No character was created and no
synthetic memory was added.

## Verification and deployment boundaries

The integrated registry, worker, routing, invitation and connection gate passed
124 focused offline checks; extraction passed 28, isolated scene export passed 19,
and audition aggregation passed 16. These results cover executable ownership and
source paths. They do not establish perceived voice quality or live acceptance
of every character. Final combined verification and deployment are recorded in
the continuation handoff rather than inferred from these component results.

The combined regression gate passed 1,557 checks with the installed MCM API and
native-source gate enabled, zero failures/skips. Two extracted production-function
fixtures needed the new admission-barrier state in their mock environment;
their reaction ownership tests continue to execute the real bridge code.

After intrinsic history and reviewed aliases were integrated, the final source
gate passed 1,604 checks with zero failures/skips. The automatic-memory fixture
now supplies the real empty intrinsic selector while executing the production
admission function, preserving its no-extra-memory-call assertion.

An isolated worker generated 62 draft auditions at 32 steps, then exited. All
returned WAVs have valid frames, non-silent signal and no clipped samples.
These measurements do not establish perceived identity or naturalness, and
their elapsed times are not gameplay latency benchmarks. No draft was promoted
to the production registry or inserted into provider conversation memory.

All checkpoints are local Git commits. Private keys, provider IDs, dialogue,
raw game assets, reference audio and generated auditions remain ignored. No
publication is performed by this work.
