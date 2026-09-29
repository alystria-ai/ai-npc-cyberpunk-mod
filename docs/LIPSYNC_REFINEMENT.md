# Lip articulation refinement, September 29

The user describes the current mouth as working but sometimes appearing to
move mainly the lower lip/jaw. Timing was not the reported problem. Judy's
small mouth makes subtle lip deformation harder to see.

## Research that informed this change

[JALI's original research](https://www.dgp.toronto.edu/~elf/jali.html) separates
jaw movement from lip shaping and relates their intensity to speech acoustics.
The [Cyberpunk production talk](https://history.siggraph.org/wp-content/uploads/2022/08/2020-Talks-Edwards_JALI-Driven-Expressive-Facial-Animation-and-Multilingual-Speech-in-Cyberpunk-2077.pdf)
describes coarticulation, expressive controls and preserving important mouth
shapes while layering other animation. Our code uses these general principles;
it does not reproduce JALI's learned language models or full production system.

[Rhubarb's documentation](https://github.com/DanielSWolf/rhubarb-lip-sync#mouth-shapes)
explains that its output is a small set of 2D mouth poses. Applying each as a
rigid 3D pose has a quality ceiling. A round mouth, a narrow consonant, a closed
P/B/M and a lower-lip/upper-teeth F/V need different trajectories.

[NVIDIA's Audio2Face SDK](https://github.com/NVIDIA/Audio2Face-3D-SDK) is a possible
future neural route with Windows support and TensorRT/CUDA dependencies. Its
stated recommendation is at least 4 GB GPU memory; that is not a measurement
of incremental memory on this laptop. It was not installed during this change.

## Implemented

- 21 whitelisted native speech controls, using the already installed 50-control
  graph. Mouth-corner stretching is added; the two individual upper-lip raisers
  are reserved at zero. No native archive or redscript change is needed.
- Jaw, rounded lips, other lip controls and tongue contacts have separate
  anticipation/release windows. Rounded lips can prepare before the jaw moves.
- Closures reach their full target even in short cues. Quiet consonants retain
  their shape rather than being gated off by low amplitude.
- Syllable energy varies vowel opening and lip extension independently. The
  envelope is interpolated between analysis frames instead of stepping.
- Jaw opening varies by sound category while upper/lower lip shaping remains
  independent. The live v3 check then requested more opening; v4 increases
  open-mouth categories without lifting the upper lip further.
- No random facial jitter, imposed smile, gaze change or processed audio.
  Pause/cancel/unload and the actual native playback cursor retain ownership.

The native timeline still uses `local-phonetic` and adds
`articulation: coarticulated-v4` to live diagnostics. The Lua adapter whitelist
accepts only its 21 named controls and keeps the existing weight limits.

### Live correction

The first `coarticulated-v2` check exposed occasional distortion of Judy's right
upper lip. That version layered individual upper-lip raisers onto the existing
`lips_apart_up` opening. Version 3 removes the additional raisers on both sides,
while retaining jaw timing, rounding, corner movement and the existing upper
opening. The reserved channels explicitly receive zero so previous weights
cannot persist. Overlapping controls are the current hypothesis; the correction
still needs a fresh visual check before calling the distortion resolved.

The next user observation was that the mouth did not open enough. The v3 native
receipt confirmed 293 applications and cleanup over 7.32 seconds. Its emitted
jaw weights had a 0.049 active median, 0.196 95th percentile and 0.310 maximum;
both individual upper raisers were zero. Version 4 increases jaw targets for
B/C/D/E/F/H (maximum 0.40), keeps the existing energy variation, and leaves
closed P/B/M, F/V lip contact, lip shaping and timing unchanged. This is a
controlled opening adjustment, still awaiting visual acceptance.

## Verification and limits

21 affected Node tests pass after this correction, including zeroed upper
raisers and active corner delivery to the native
feature, distinct trajectories, closure/rest, unchanged audio, pause/resume,
speaker changes and cleanup. The live speech-install diagnostic accepted the
adapter without restarting/reloading the game. Visual acceptance remains a
separate in-game check; a passing test is not proof of convincing facial motion.

The recognizer still supplies nine acoustic categories, not a full phoneme
alignment or a trained 3D performance. English transcript-guided recognition
was previously measured much slower and has not replaced this low-latency path.
Emotion, smiles and blink coordination remain separate TODO items.
