# Multilingual packs and PocketTTS models

This is the text for `multilingual/README.md` in `alystria-ai/ai-npc-cyberpunk-mod-packs` (written 2026-10-22; not uploaded). Everything below the line is the file.

---

# Multilingual packs and PocketTTS models

Optional. Get only the languages you play in. Extract each zip into your Cyberpunk 2077 game folder (the folder with bin, archive and red4ext), like the other packs. These files are only here, on Hugging Face.

## Multilingual packs

One zip per language. With a pack installed, when a character replies in that language their AI voice is cloned from the game's own dubbed voice in that language, instead of from the English actor. Works with the OmniVoice voice, the Mistral (Voxtral) voice and, with its PocketTTS model (below), the Pocket voice.

| Language | File | Size |
| --- | --- | --- |
| Chinese (Mandarin) | [Voices-Chinese.zip](Voices-Chinese.zip) | 160 MB |
| Japanese | [Voices-Japanese.zip](Voices-Japanese.zip) | 171 MB |
| Korean | [Voices-Korean.zip](Voices-Korean.zip) | 167 MB |
| French | [Voices-French.zip](Voices-French.zip) | 161 MB |
| German | [Voices-German.zip](Voices-German.zip) | 162 MB |
| Italian | [Voices-Italian.zip](Voices-Italian.zip) | 171 MB |
| Spanish (Spain) | [Voices-Spanish.zip](Voices-Spanish.zip) | 170 MB |
| Polish | [Voices-Polish.zip](Voices-Polish.zip) | 147 MB |
| Portuguese (Brazil) | [Voices-Portuguese.zip](Voices-Portuguese.zip) | 164 MB |
| Russian | [Voices-Russian.zip](Voices-Russian.zip) | 155 MB |

## PocketTTS models

The Pocket voice runs on your processor and speaks English. With the PocketTTS model of a language it also speaks that language, in the character's own dubbed voice, copied from the voice pack of the same language.

**Get the voice pack for your language. If you use the Pocket voice, also get the PocketTTS model for that language.** The PocketTTS model needs the voice pack of the same language installed: with the model but not the pack, replies in that language are shown as text, and the game tells you once. OmniVoice and the Mistral voice need only the voice pack.

| Language | File | Size |
| --- | --- | --- |
| French | [PocketTTS-Model-French.zip](PocketTTS-Model-French.zip) | 219 MB |
| Italian | [PocketTTS-Model-Italian.zip](PocketTTS-Model-Italian.zip) | 219 MB |
| German | [PocketTTS-Model-German.zip](PocketTTS-Model-German.zip) | 219 MB |
| Spanish (Spain) | [PocketTTS-Model-Spanish.zip](PocketTTS-Model-Spanish.zip) | 219 MB |
| Portuguese (Brazil) | [PocketTTS-Model-Portuguese.zip](PocketTTS-Model-Portuguese.zip) | 219 MB |

Extract the PocketTTS model after the voice pack. It is Kyutai's Pocket TTS language model (kyutai/pocket-tts), licensed CC-BY-4.0 with Kyutai's prohibited-use terms; the zip carries the notice (NOTICE.txt). Needs the mod and Runtime from the release that announces the models, or newer. The Pocket voice keeps one language model loaded at a time: it changes only when a reply comes in a different language.
