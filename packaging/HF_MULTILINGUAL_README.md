# Voice language packs and Pocket language models

This is the text for `multilingual/README.md` in `alystria-ai/ai-npc-cyberpunk-mod-packs` (written 2026-10-22; not uploaded). Everything below the line is the file.

---

# Voice language packs and Pocket language models

Optional. Get only the languages you play in. Extract each zip into your Cyberpunk 2077 game folder (the folder with bin, archive and red4ext), like the other packs. These files are only here, on Hugging Face.

## Voice language packs

One zip per language. With a pack installed, when a character replies in that language their AI voice is cloned from the game's own dubbed voice in that language, instead of from the English actor. Works with the OmniVoice voice, the Mistral (Voxtral) voice and, with its Pocket model (below), the Pocket voice.

| Language | File | Size |
| --- | --- | --- |
| Chinese (Mandarin) | [AI-NPC-Cyberpunk-Mod-Voices-zh-cn.zip](AI-NPC-Cyberpunk-Mod-Voices-zh-cn.zip) | 160 MB |
| Japanese | [AI-NPC-Cyberpunk-Mod-Voices-ja.zip](AI-NPC-Cyberpunk-Mod-Voices-ja.zip) | 171 MB |
| Korean | [AI-NPC-Cyberpunk-Mod-Voices-ko.zip](AI-NPC-Cyberpunk-Mod-Voices-ko.zip) | 167 MB |
| French | [AI-NPC-Cyberpunk-Mod-Voices-fr.zip](AI-NPC-Cyberpunk-Mod-Voices-fr.zip) | 161 MB |
| German | [AI-NPC-Cyberpunk-Mod-Voices-de.zip](AI-NPC-Cyberpunk-Mod-Voices-de.zip) | 162 MB |
| Italian | [AI-NPC-Cyberpunk-Mod-Voices-it.zip](AI-NPC-Cyberpunk-Mod-Voices-it.zip) | 171 MB |
| Spanish (Spain) | [AI-NPC-Cyberpunk-Mod-Voices-es-es.zip](AI-NPC-Cyberpunk-Mod-Voices-es-es.zip) | 170 MB |
| Polish | [AI-NPC-Cyberpunk-Mod-Voices-pl.zip](AI-NPC-Cyberpunk-Mod-Voices-pl.zip) | 147 MB |
| Portuguese (Brazil) | [AI-NPC-Cyberpunk-Mod-Voices-pt-br.zip](AI-NPC-Cyberpunk-Mod-Voices-pt-br.zip) | 164 MB |
| Russian | [AI-NPC-Cyberpunk-Mod-Voices-ru.zip](AI-NPC-Cyberpunk-Mod-Voices-ru.zip) | 155 MB |

## Pocket language models

The Pocket voice runs on your processor and speaks English. With the Pocket model of a language it also speaks that language, in the character's own dubbed voice, copied from the voice pack of the same language.

**Get the voice pack for your language. If you use the Pocket voice, also get the Pocket model for that language.** The Pocket model needs the voice pack of the same language installed: with the model but not the pack, replies in that language are shown as text, and the game tells you once. OmniVoice and the Mistral voice need only the voice pack.

| Language | File | Size |
| --- | --- | --- |
| French | [AI-NPC-Cyberpunk-Mod-Pocket-fr.zip](AI-NPC-Cyberpunk-Mod-Pocket-fr.zip) | 219 MB |
| Italian | [AI-NPC-Cyberpunk-Mod-Pocket-it.zip](AI-NPC-Cyberpunk-Mod-Pocket-it.zip) | 219 MB |
| German | [AI-NPC-Cyberpunk-Mod-Pocket-de.zip](AI-NPC-Cyberpunk-Mod-Pocket-de.zip) | 219 MB |
| Spanish (Spain) | [AI-NPC-Cyberpunk-Mod-Pocket-es-es.zip](AI-NPC-Cyberpunk-Mod-Pocket-es-es.zip) | 219 MB |
| Portuguese (Brazil) | [AI-NPC-Cyberpunk-Mod-Pocket-pt-br.zip](AI-NPC-Cyberpunk-Mod-Pocket-pt-br.zip) | 219 MB |

Extract the Pocket model after the voice pack. It is Kyutai's Pocket TTS language model (kyutai/pocket-tts), licensed CC-BY-4.0 with Kyutai's prohibited-use terms; the zip carries the notice (NOTICE.txt). Needs the mod and Runtime from the release that announces the models, or newer. The Pocket voice keeps one language model loaded at a time: it changes only when a reply comes in a different language.

Checksums: SHA256SUMS.txt in this folder.
