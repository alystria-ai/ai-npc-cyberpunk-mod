# Voice listening feedback, October 6

The user's per-character verdicts from the report page (http://127.0.0.1:8765/), recorded as given. Columns: Pocket student 5,000 with old or new decoder, OmniVoice 16/32, each with 1/2/3 clips, plus phone-free 18 s variants.

## Page issues
- Reference page: current clips wouldn't play. Fixed in `db3ea53`: the audio route split the already-decoded path, so clip ids containing `/` never matched.

## Characters

### Adam Smasher
- His reference is too short (one 5.5 s clip), and the reference page offers no other clips. The dataset has no other Adam Smasher clips, so more must be extracted from the game's voice archives.

### Alex
- Pocket: student + new decoder with 3 clips sounds good. Student + old decoder with 3 clips sounds about the same.
- Phone-free: no difference heard.
- OmniVoice: sounds like the character, but the delivery isn't great. The user attributes this to the text and the original audio: the text doesn't mark the pauses the character would make, and OmniVoice follows the text faithfully. Not a priority.

## Ideas raised while listening
- Human-like delivery setting: prompt characters (dynamic context) to speak more like people, with pauses, "hmm", "mm" and the like, which sound good with a high-quality voice like OmniVoice. Make it an in-game setting; when on, each character responds in their own human way based on a per-character analysis (tier 1 characters at least), from their personality and, cautiously, their dialogue.
