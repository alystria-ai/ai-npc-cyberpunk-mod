# Voice listening feedback, October 6

The user's per-character verdicts from the report page (http://127.0.0.1:8765/), recorded as given. Columns: Pocket student 5,000 with old or new decoder, OmniVoice 16/32, each with 1/2/3 clips, plus phone-free 18 s variants.

## Page issues
- Reference page: current clips wouldn't play. Fixed in `db3ea53`: the audio route split the already-decoded path, so clip ids containing `/` never matched.

- Phone audio: the user checked, and phone-flagged clips sound like normal ones. The phone-free columns and the phone handling come out of the report; phone clips are treated like any other.

## Characters

### Adam Smasher
- His reference is too short (one 5.5 s clip), and the reference page offers no other clips. The dataset has no other Adam Smasher clips, so more must be extracted from the game's voice archives.

### Alex
- Pocket: student + new decoder with 3 clips sounds good. Student + old decoder with 3 clips sounds about the same.
- Phone-free: no difference heard.
- OmniVoice: sounds like the character, but the delivery isn't great. The user attributes this to the text and the original audio: the text doesn't mark the pauses the character would make, and OmniVoice follows the text faithfully. Not a priority.

## Ideas raised while listening
- Human-like delivery setting: prompt characters (dynamic context) to speak more like people, with pauses, "hmm", "mm" and the like, which sound good with a high-quality voice like OmniVoice. Make it an in-game setting; when on, each character responds in their own human way based on a per-character analysis (tier 1 characters at least), from their personality and, cautiously, their dialogue.

### Carol Emeka
- New-decoder Pocket voices have a "holographic" sound effect (noticed on Carol). Likely the adversarial decoder learned hologram/holocall processing baked into some training clips. Pocket clip search uses the old decoder until this is fixed.
- Sometimes 2 clips sound better than 3.

## Decisions
- Effect-heavy clips (strongly band-limited holocall, phone and answering-machine processing, like the three examples the user heard) must be removed from training data. Acoustically clean holocall-tagged clips stay.
- The clip-set search is paused until the retrained decoder exists.
- Metric priority: ECAPA (speaker identity) is primary, PLS secondary, and WER is skipped (too slow).
- Per-character automatic search for the best clip set (which clips, and 1/2/3), scored by ECAPA, with the results offered as "Auto-best" in the picker.

### Decoder A "holographic" follow-up
- The Carol set: only decoder A sounds holographic; the pretrained decoder is normal. Removing decoder A's 200 Hz line comb made no audible difference, so the comb isn't the cause.
- The user doesn't want character effects (no DSP chains). Adam Smasher can just sound menacing, and Johnny human (his companion form is flesh). The goal is only that the holographic sound never appears unexpectedly.
- Control verdict (Carol line 0): holographic in 04 (A with pretrained highs) and 10 (A highs replaced by noise); fine in 05, 06 (A with pretrained mids 1.5–4 kHz) and 07 (A levels with pretrained phase); 09 sounds low quality; 11 and 12 a little. Conclusion: the cause is decoder A's mid-band (about 1.5–4 kHz) phase, not the highs or the 200 Hz comb.
- Confirmation set: Carol 13 (pretrained phase only in 1.5–4 kHz) still a bit holographic; Judy and Takemura 13 and 14 both OK. So phase below 1.5 kHz contributes for Carol (full-band phase swap 07 was fine). The decoder fix widens the phase anchor to 0.5–4 kHz.
- Carol 15 (pretrained phase in 0.5–4 kHz): only a faint tint at the end of "well" in line 0, the same as the pretrained decoder; line 1 clean. Fix accepted. The retrain (0.5–4 kHz phase anchor, exclusion list) goes ahead once the expanded pool lands.

## 2026-10-07
### Adam Smasher (user-chosen pool)
- The user picked 11 candidate clips by ear: 1653087655475433472, 1776711517152501760, 1876330591075450880, 1876331655187152896, 1995324830177058816, 1995048870861103104, 1995076448980328448, 1792270501449261056, 1792271201864474624, 1792275223900020748, 1792275223900020764. The search picks the count and order per engine, scored against Adam's two page lines (the user accepts the overfit). The report is updated afterwards.

### Alex (2026-10-07, final page)
- New Pocket student + decoder v2 with 3 clips sounds better than Pocket base. Subtle, but the last few percent is what makes the experience.
- OmniVoice 16 and 32 sound about the same.
- The new Pocket student has about reached OmniVoice quality; on the second line Pocket beats Omni.
- 1 clip sounds bad; 2 clips (10 s) sound about as good as 3. Never use 1 clip; at least 2.
- Omni's remaining advantage: laughs, sighs and other emotional tags (natural speech), so it isn't obsolete.
- Why Adam was switched (user): his combat dialogue sounds very different from his normal conversation, and the dataset had more combat than conversation for him, so references and targets drawn from it sounded wrong. A combat-delivery flag is being built for all voices.

### Voice report v3 (2026-10-07, after the overnight duration search)
- Overall: the custom Pocket student + decoder v2 with the searched references is "genuinely amazing", a night-and-day difference from Pocket base. At moments it matches OmniVoice and sometimes beats it, which is remarkable given the latency. No new student or decoder is needed.
- Relative quality by ear (Pocket = x): Omni 16 about 1.10-1.15x, Omni 32 about 1.15-1.25x. Omni still has the edge (up to about 15-25%), and 32 steps does sound better than 16 at moments ("genuinely feels amazing"), though 16 often gets there too.
- Messaging rule: never make OmniVoice sound worse than Pocket. Omni sounds amazing, and with the hardware it is the move; Pocket is the recommended default because it's light and fast.
- Keep Omni 32 (no harm in offering the option).
- Voice menu order: Pocket TTS (the new student + decoder v2; default, recommended), OmniVoice 16 short, OmniVoice 16 long, OmniVoice 32 short, OmniVoice 32 long. No Pocket base. (Convai cloud wasn't mentioned this time; the earlier decision keeps it last.)
- Wants v3 packaged as a shareable report: one self-contained HTML file if possible, otherwise a zip.
- Wants the voice research since the last devslot handoff packaged for the devslots: auto/best clip search, duration-based references, combat and effect cleaning, decoder v2 fine-tuning (phase anchor), the new student, metrics (ECAPA primary, PLS), findings.

### Voice report v3: final verdict (2026-10-07)
- The review is complete. Massive improvement over the original version.
- Overall by ear: Pocket = x, Omni 16 about 15-20% better, Omni 32 about 20-25% better.
- But it depends on the character. Johnny, Judy, Panam and Alex sound very good on Pocket, so the gap is even or at most about 5%. For some, Pocket beats Omni (e.g. Carol). Omni shines on the harder voices lower on the page, likely the difficult ones or those with less data.

### Product tiers (the user's vision, 2026-10-07)
- Pocket base: the cheap CPU option.
- Pocket fine-tuned (student + decoder fine-tune + auto best-clip references): an upfront cost, but good performance. Per-character models should be the default: one model trained on one character's voice. Everything is in the cloud, so many models are fine, and the user expects a massive quality boost.
- OmniVoice: expensive, needs a GPU, but less setup work (zero-shot).

### Multilingual (2026-10-07)
- Omni speaking Judy's cloned voice in Spanish, German, Japanese, Chinese and Russian, from her English reference: sounds like those languages, and the quality is good.
- Microphone in other languages: the user expects it to work. Earlier mods on Convai got no reports that non-English speech fails, so it is not treated as a blocker; confirm with one test in game.
- Lip sync with English mouth shapes for other languages: fine.
