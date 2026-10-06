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
