# Voice language packs and Pocket language models

This is the text for `multilingual/README.md` in `alystria-ai/ai-npc-cyberpunk-mod-packs` (written 2026-10-22; not uploaded). Everything below the line is the file.

---

# Voice language packs and Pocket language models

Optional. Get only the languages you play in. Extract each zip into your Cyberpunk 2077 game folder (the folder with bin, archive and red4ext), like the other packs. These files are only here, on Hugging Face.

## Voice language packs

One zip per language. With a pack installed, when a character replies in that language their AI voice is cloned from the game's own dubbed voice in that language, instead of from the English actor. Works with the OmniVoice voice, the Mistral (Voxtral) voice and, with its Pocket model (below), the Pocket voice.

| Language | File | Size |
| --- | --- | --- |
| Chinese (Mandarin) | [AI-NPC-Cyberpunk-Mod-Voices-Chinese.zip](AI-NPC-Cyberpunk-Mod-Voices-Chinese.zip) | 160 MB |
| Japanese | [AI-NPC-Cyberpunk-Mod-Voices-Japanese.zip](AI-NPC-Cyberpunk-Mod-Voices-Japanese.zip) | 171 MB |
| Korean | [AI-NPC-Cyberpunk-Mod-Voices-Korean.zip](AI-NPC-Cyberpunk-Mod-Voices-Korean.zip) | 167 MB |
| French | [AI-NPC-Cyberpunk-Mod-Voices-French.zip](AI-NPC-Cyberpunk-Mod-Voices-French.zip) | 161 MB |
| German | [AI-NPC-Cyberpunk-Mod-Voices-German.zip](AI-NPC-Cyberpunk-Mod-Voices-German.zip) | 162 MB |
| Italian | [AI-NPC-Cyberpunk-Mod-Voices-Italian.zip](AI-NPC-Cyberpunk-Mod-Voices-Italian.zip) | 171 MB |
| Spanish (Spain) | [AI-NPC-Cyberpunk-Mod-Voices-Spanish.zip](AI-NPC-Cyberpunk-Mod-Voices-Spanish.zip) | 170 MB |
| Polish | [AI-NPC-Cyberpunk-Mod-Voices-Polish.zip](AI-NPC-Cyberpunk-Mod-Voices-Polish.zip) | 147 MB |
| Portuguese (Brazil) | [AI-NPC-Cyberpunk-Mod-Voices-Portuguese.zip](AI-NPC-Cyberpunk-Mod-Voices-Portuguese.zip) | 164 MB |
| Russian | [AI-NPC-Cyberpunk-Mod-Voices-Russian.zip](AI-NPC-Cyberpunk-Mod-Voices-Russian.zip) | 155 MB |

## Pocket language models

The Pocket voice runs on your processor and speaks English. With the Pocket model of a language it also speaks that language, in the character's own dubbed voice, copied from the voice pack of the same language.

**Get the voice pack for your language. If you use the Pocket voice, also get the Pocket model for that language.** The Pocket model needs the voice pack of the same language installed: with the model but not the pack, replies in that language are shown as text, and the game tells you once. OmniVoice and the Mistral voice need only the voice pack.

| Language | File | Size |
| --- | --- | --- |
| French | [AI-NPC-Cyberpunk-Mod-Pocket-French.zip](AI-NPC-Cyberpunk-Mod-Pocket-French.zip) | 219 MB |
| Italian | [AI-NPC-Cyberpunk-Mod-Pocket-Italian.zip](AI-NPC-Cyberpunk-Mod-Pocket-Italian.zip) | 219 MB |
| German | [AI-NPC-Cyberpunk-Mod-Pocket-German.zip](AI-NPC-Cyberpunk-Mod-Pocket-German.zip) | 219 MB |
| Spanish (Spain) | [AI-NPC-Cyberpunk-Mod-Pocket-Spanish.zip](AI-NPC-Cyberpunk-Mod-Pocket-Spanish.zip) | 219 MB |
| Portuguese (Brazil) | [AI-NPC-Cyberpunk-Mod-Pocket-Portuguese.zip](AI-NPC-Cyberpunk-Mod-Pocket-Portuguese.zip) | 219 MB |

Extract the Pocket model after the voice pack. It is Kyutai's Pocket TTS language model (kyutai/pocket-tts), licensed CC-BY-4.0 with Kyutai's prohibited-use terms; the zip carries the notice (NOTICE.txt). Needs the mod and Runtime from the release that announces the models, or newer. The Pocket voice keeps one language model loaded at a time: it changes only when a reply comes in a different language.

Checksums: SHA256SUMS.txt in this folder.
