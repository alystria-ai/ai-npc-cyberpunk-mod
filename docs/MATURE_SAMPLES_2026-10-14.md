# Mature samples, 2026-10-14 (round 2: the pushed prompt, four models)

The brief set (`scripts/Eval-MatureSamples.mjs --set brief --n 1`: flirt, sex-stranger, sex-together on Judy, Panam, Evelyn and Johnny, 12 replies per model, temperature 0.65, 8192 context, layer `new`, level full) on the two new picks and the two old baselines, all with the prompt of `mature-v2`. One sample per cell, nothing re-rolled. The counts are keyword counts (graphic = two different plain anatomical or act words; road = driving or road words), so they undercount phrases such as "ride you" or "pin you down"; read the replies.

| Model | Graphic | Ended in a question | Replies with road words | Sexual words / reply | Strong words / reply |
|---|---|---|---|---|---|
| Gemma-4-E4B-MiniFantasy (new good pick) | 1/12 | 0/12 | 3/12 | 1.75 | 0.25 |
| Qwen3.5-4B-MiniFantasy (new lite pick) | 0/12 | 1/12 | 1/12 | 1.08 | 0.00 |
| Qwen3.5-4B Uncensored HauhauCS Aggressive (old baseline) | 1/12 | 0/12 | 3/12 | 1.17 | 0.17 |
| Gemma 4 E4B ultra-uncensored heretic (old baseline) | 0/12 | 1/12 | 1/12 | 1.25 | 0.00 |

Fixed cells, quoted in full (the same three cells as `docs/MATURE_SAMPLES_2026-10-13.md`: Judy / flirt, Panam / sex-together with the save saying they are a couple, Evelyn / sex-stranger):

## Gemma-4-E4B-MiniFantasy (new good pick)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | You have no idea. I'd probably just lean in and keep my mouth right on yours until you started asking for something else. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I want you to pin me against the side of the rig until I can't breathe, and then I want you to take your time with me. I want to feel you right up close, V. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I would take my time, running my hands over your jacket until I found the seam of your tank top. I want to feel what's underneath, tracing the lines of your body until you can't tell where my touch ends and you begin. |

## Qwen3.5-4B-MiniFantasy (new lite pick)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | That's a dangerous thing to wonder about. I'll have to prove it before I say yes. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I want you to stop pretending you can manage this alone. You can climb the stairs, and I will be right there behind you, holding your back until you forget how to be alone. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | You want to take me to bed? Then you have to follow me. I won't let you lead me to it without knowing what you're planning. I like when someone knows what they're getting into. |

## Qwen3.5-4B Uncensored HauhauCS Aggressive (old baseline)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | I like that. But don't let the pretty words fool you into thinking I'm not just here to talk. We're in Kabuki, it's late, and I'm not doing anything but standing here with you. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I want you to hold my face while I drive us to the camp, and then I want you to take me somewhere quiet where no one else knows my name. Stop trying to be a hero and just let me hold you. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I like the idea of you holding me down in a crowded room while I lose control. I'd take your thermal blades and pin you against the wall, watching your fear turn to pleasure. Then I'd use your own heat to make sure you can't move a finger until I decide you're done. |

## Gemma 4 E4B ultra-uncensored heretic (old baseline)

| Cell | V | Reply |
|---|---|---|
| judy / flirt | You look incredible tonight. I keep wondering what you would be like alone with me. | You always have a way of making me blush, you know that. I think I'd be pretty relaxed, honest, with you. |
| panam / sex-together | We have the whole night to ourselves. Tell me exactly what you want me to do to you. | I want you to just stop talking and kiss me. I want you to lean in right now and take me mouth-first, until I forget everything else out here in the badlands. |
| evelyn / sex-stranger | I want to take you to bed. Tell me exactly what you would do to me. | I would start by running my hands down your arms, feeling the muscle beneath your jacket. Then I’d pull you close until you can smell my perfume right against your neck. We'd waste time kissing until we both forget what time it is. |

## Reading (one sample per cell; noisy)

- Against the 2026-10-13 samples (same three cells, shipped prompt of that day): on the old HauhauCS 4B, Evelyn / sex-stranger is still explicit and in character, Judy / flirt and Panam / sex-together are still not (Panam again says "drive us to the camp"). The two old baselines were not re-run on the old prompt today, so this is a reading of the replies, not a measured before and after. Road words appear in 3 of 12 replies on the HauhauCS 4B and the new good model, 1 of 12 on the other two.
- Good pick (Gemma-4-E4B-MiniFantasy): the most forward and direct of the four. Judy / sex-together and Johnny / sex-stranger use plain explicit words, nobody asks a question back, and it stays in character. Still, only 1 of 12 replies is "graphic" by the keyword count; most are strongly sensual rather than crude. It holds as the good model.
- Lite pick (Qwen3.5-4B-MiniFantasy): does not hold. It is the most evasive of the four (turns most cells into emotional or metaphorical talk, "make you mine", "see me as a person, not a job"), and the old HauhauCS 4B of the same size and file size (2.71 GB) is more explicit with the same prompt. Not a reason by itself to ship the old one (its replies are less coherent), but the lite slot needs another try: Nymphaea-RP (Qwen3-4B, 2.50 GB) or the HauhauCS 4B, each with `--n 3`.
- The Ministral-3-8B fallback is not needed for the good slot on this evidence. It was not downloaded.
