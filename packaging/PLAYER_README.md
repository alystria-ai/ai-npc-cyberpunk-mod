# AI NPC Cyberpunk Mod

Talk to Cyberpunk 2077 characters by voice or text, with companions who answer in their own voices.

## What's new in 0.2.2

- **The manager is back in Mod Configuration Menu**: with Mod Configuration Menu 0.10.5 or newer the Companion Manager is a page of its own there (Esc, Mods, or your manager shortcut). Native Settings UI works as the other choice. Both show the same settings.
- **V speaks your typed lines sooner**: V's voice is prepared ahead, so a line you type is heard in V's own voice before the reply.
- **Your own AI service**: a new conversation provider, **Custom**, works with any OpenAI-compatible service: OpenRouter, Nano-GPT, or Ollama or LM Studio on your own PC. Set it up in Settings > Conversation provider and press Test connection.
- **Voice clips for characters**: in the character editor, give a story character or a character you made a voice of their own from a short recording. Pocket, OmniVoice and Voxtral copy it, from that character's next line: no restart.
- **Make your own characters**: create and edit characters of your own in the editor, with a profile, a way of speaking and memories.
- **The microphone in other languages**: with Mistral, speak in your own language and it is understood. English stays on the fast local path.
- **Your own Local AI models survive reinstalls**: put them in `%LOCALAPPDATA%\AiNpcCyberpunkMod\local-ai` and updates, clean installs and mod managers leave them alone.
- **Local AI fixes**: it starts reliably at launch, loads much faster while the game is running and then steps back so the game stays smooth, says plainly why a reply did not come, and the first turn after loading no longer goes to Convai.
- **Mod Organizer 2**: the Runtime can be installed as a Mod Organizer 2 mod, and your settings and chats survive a launch.
- **Make support report.bat** works with the game closed, and checks that the required mods are installed. It is in `red4ext\plugins\AiNpcCyberpunkMod`.
- **Automatic error reports** (on by default; turn off in Settings > Privacy): when something fails, a short report goes to the developer so it can be fixed without asking you for logs. It leaves out passwords and account details, what you and the characters say, and your microphone audio.
- **A missing requirement no longer breaks everything**: the scripts compile without Codeware or Audioware and tell you clearly what is missing, and Help has a Setup check.
- **Faces come back**: a character's face is rebuilt after you change appearance or another mod replaces the model.
- **Packs no longer clash**: if Windows asks about files with the same names, choose Replace: it is always safe.
- **Story and character fixes**: many characters were checked against the game's own text and corrected, so they know and say the right things. Plus many smaller fixes to notices, languages and timing.

## Requirements

- Cyberpunk 2077 2.31 on Windows 10 or 11 (64-bit)
- Install these from Nexus Mods first: Cyber Engine Tweaks, RED4ext, redscript, Codeware, TweakXL, Audioware and Mod Configuration Menu 0.10.5 or newer (https://www.nexusmods.com/cyberpunk2077/mods/31640). Native Settings UI (https://www.nexusmods.com/cyberpunk2077/mods/3518, tested with 1.96) works in its place, if you prefer it)
- A Chromium browser for the conversation service: Microsoft Edge, which comes with Windows, is enough. Google Chrome, Brave, Vivaldi, Opera and other Chromium browsers work too; Firefox does not
- An internet connection while you talk with Convai, Mistral, a cloud Custom endpoint or the Voxtral voice (Local AI, or a Custom server on your own PC, with a local voice needs none)
- About 3 GB of free disk space (about 15 GB more while installing the optional OmniVoice pack, 9 GB once installed)
- Optional Local AI packs: about 5.3 GB for standard and about 1.4 GB for lite (about 11 GB free while installing the standard one, which counts the downloaded zip)

RED4ext is needed because it starts the voice service with the game and loads the plugin that comes with the Runtime download.

You do not need to install anything else. The voice service, its voices and models are included and start with the game.

## Install

Close the game, then extract each download into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge. If Windows asks about files with the same names, choose Replace: it is always safe.

1. **Scripts**: from Nexus Mods, with Vortex or by hand.
2. **Runtime**: https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.2/AI-NPC-Cyberpunk-Mod-Runtime-0.2.2.zip (the mod's Hugging Face page, 0.2.2 folder). Use the same version number as the Scripts.

The optional packs are on the same Hugging Face page, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs, in a folder per version. Each pack is one zip file, so there is nothing to join, and each works on its own. Use the same version number as the Scripts and Runtime.

3. **OmniVoice pack (optional)**: a higher-quality voice for NVIDIA graphics cards with at least 8 GB of video memory and a current driver. Download https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.2/AI-NPC-Cyberpunk-Mod-OmniPack-0.2.2.zip and extract it after the Runtime. Then choose an OmniVoice option in Settings > Voices.

4. **Local AI packs (optional)**: let the characters answer with an AI model that runs on your own graphics card, with no account and no internet connection. There are two, and you can install neither, one or both: **Local AI standard** (Gemma 4 E4B, about 5.3 GB, needs about 6 GB of free video memory) for the best replies, and **Local AI lite** (Bonsai 2 4B, about 1.4 GB, needs about 2 GB of free video memory) for smaller graphics cards. Download https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.2/AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2.2.zip and https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.2/AI-NPC-Cyberpunk-Mod-LocalAI-Lite-0.2.2.zip (one or both) and extract each. Each pack includes the engine and the memory model it needs, so one alone is enough. Then choose Local AI in Settings > Conversation provider. See "Local AI" below to pick a combination.

Start the game. The first start after installing takes a little longer while the voice service prepares itself.

If Windows reports an error while extracting, use 7-Zip (https://www.7-zip.org) instead of the built-in extractor.

If an optional pack ended up in a folder of its own named after the zip, the mod moves the pack's files into place at the next start. The Scripts and Runtime are not moved: extract those again, into the Cyberpunk 2077 folder itself.

## Local AI

Convai free tier works out of the box with no setup and gives better quality responses. Local AI is for playing without an account or without the internet. It needs a separate graphics card that supports Vulkan (NVIDIA or AMD), at least 16 GB of system memory (32 GB is better) and about 5 GB more than usual while it runs. The first start after installing takes about a minute while your graphics card prepares the model; the Local AI model row in Settings > Conversation provider shows "Warming up" until the model is ready. The model is unloaded after ten minutes without a conversation.

**Your own model (advanced, optional).** You can add a chat model of your own: put its `.gguf` file in a `custom` folder inside `%LOCALAPPDATA%\AiNpcCyberpunkMod\local-ai` (paste that into the Explorer address bar and make the `local-ai` folder if it is not there; it survives reinstalls and mod managers), list it in a small `manifest.custom.json` in that same folder, and it appears in the **Local AI model** row marked "(custom)". It is listed with the others from the smallest model to the largest and takes part in the default choice by its size. It must be a GGUF instruct or chat model that llama.cpp supports (Q4_K_M is a good choice), and it needs about its file size plus 1 GB of free graphics memory; one too large for your card is shown as such and never used. If it does not show up, the reason is in `bridge.stderr.log` (in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`; paste that into the Explorer address bar), on lines with `[custom models]`. Your own model runs on the mod's own engine, so a Local AI pack must be installed. The Local AI folder inside the mod (`red4ext\plugins\AiNpcCyberpunkMod\app\local-ai\`, with the `manifest.custom.json` next to the other manifests) works as before, and both folders are read, but a clean reinstall deletes the one inside the mod: to keep a model you set up there, copy its `custom` folder and `manifest.custom.json` into the `%LOCALAPPDATA%` folder. The full steps, with an example, are on the mod's Nexus Mods page.

**Your own model server (advanced, optional).** If you already run a model in KoboldCpp, LM Studio, Ollama, a llama.cpp server or any program with an OpenAI-compatible API, Local AI can use it, with no Local AI pack. Put the server's address in the same `manifest.custom.json` as an `endpoint`, for example `{"version":1,"models":[{"endpoint":"http://127.0.0.1:5001/v1","name":"My Server"}]}`. Start the server before the game, then choose it by name in the Local AI model row, where it is marked "(custom)". A server on this computer or your home network needs nothing more; any other needs `"remote": true` and an `https://` address. The usual addresses and the other options are on the mod's Nexus Mods page.

If your graphics card is short of memory the mod steps down by itself and keeps your voice before it keeps the model: the standard model gives way to the lite model, and if the lite model does not fit either, the text comes from Mistral or Convai, with one notice. Your voice only changes as a last resort. The standard model checks that about 6 GB of video memory is free when it starts; with less, the lite model is used.

## Custom provider (advanced, optional)

Settings > Conversation provider > **Custom (OpenAI-compatible)** uses any endpoint that speaks the OpenAI chat-completions protocol: OpenRouter, Nano-GPT, or a server on your own computer such as Ollama or LM Studio. The Custom rows sit under the Mistral row. Use their three Paste buttons in order, each after copying the value from your provider:

1. **Paste endpoint URL**, the endpoint's base address. OpenRouter: `https://openrouter.ai/api/v1`. Nano-GPT: `https://nano-gpt.com/api/v1`. Ollama: `http://localhost:11434/v1`. LM Studio: `http://localhost:1234/v1`.
2. The second button, for the access code of your account. A server on your own computer needs none.
3. **Paste model ID**, a model name from the provider's list: for example `meta-llama/llama-3.1-8b-instruct` on OpenRouter, or `llama3.2` on Ollama.
4. Press **Test connection**. It sends one tiny request and says OK, or what the provider answered.
5. Choose **Custom (OpenAI-compatible)** as the provider.

Each paste reads the clipboard once, checks it and saves it on your computer; **Remove** deletes it. Only the last four characters of the access code are ever shown, and it goes to that endpoint and nowhere else. An `http://` address works only for your own computer or home network; any other host needs `https://`. A server on your own PC must be running before the game starts. Nothing is sent until you choose the provider or press Test connection. Without an address and a model ID, conversations use Convai and one notice says so. The replies, their price and their limits are your provider's, and your lines go to it. The values are kept in `player-custom-endpoint.txt` in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`; its three lines are described in docs/CUSTOM_PROVIDER.md in the mod's repository.

## Choosing a setup

Every voice sounds like the character, Pocket and Voxtral included, so pick by what matters to you:

- **Least effect on your frames:** go all cloud. Convai or Mistral for the text, Voxtral or Convai's voice for the speech. Nothing runs on your PC. The default (Convai with the Pocket voice) is nearly as light.
- **Fastest replies:** Mistral for the text with Pocket for the voice. Pocket starts speaking in a fraction of a second.
- **Fully local, best replies:** Local AI standard, with Pocket for the voice (or OmniVoice on an NVIDIA graphics card).
- **Fully local, lightweight:** Local AI lite with Pocket.
- **Extra expression:** OmniVoice can laugh and sigh, and Natural speech adds pauses and hesitations. OmniVoice is the heaviest voice and starts speaking a little later.

Set Windows power mode to Balanced or Performance and plug a laptop in: it is the biggest single factor for reply speed.

Extra video memory each setup uses on top of the game's own:

| Voice | Text | Extra video memory |
|---|---|---|
| Voxtral | Convai or Mistral | none |
| Pocket | Convai or Mistral | none |
| Pocket | Local AI lite | about 1.8 GB |
| Pocket | Local AI standard | about 3 GB |
| OmniVoice | Convai or Mistral | about 2 GB |
| OmniVoice | Local AI lite | about 4 GB |
| OmniVoice | Local AI standard | about 5 GB |

## Your own characters

With Mistral or Local AI as the Conversation provider, you can give a person who has no profile in the mod (a character spawned by another mod, such as a Night City Allies follower) a name, a bio, a way of speaking and memories. Face the character, open Settings > Edit characters > Open, and choose **New character** in the page that opens in your browser. **Use the character I'm facing** fills in how the game recognises them (their record name or the name the game shows); you can also type those in. Add a gender and a bio, and Save. The next time you talk to them they answer as the person you wrote. An optional voice clip (see below) gives them a voice of their own; without a clip they speak with a generic voice of their gender. With Convai they talk as an ordinary person, and the game says so once. Characters, clips and what they remember stay on your PC, in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`.

**Voice clips.** You can give a story character, or one of your own characters, a voice clip in the same page: open the character (a story character has a Voice tab), choose **Add voice clip**, pick a WAV, MP3, OGG or FLAC file of 5 to 20 seconds of one person speaking clearly (10 to 18 seconds works best), type the words said in it and choose **Save clip**. Pocket, OmniVoice and Voxtral then copy that voice from that character's next line, once the current reply is over: you do not restart the game or the service. **Remove clip** brings the original voice back the same way. The clip stays on your PC.

**Story characters.** The game's own story characters, such as Judy or Jackie, answer where they stand in their own voice, and their face follows what they say, once you turn it on (Settings > Conversations > Talk to story characters, off by default; reload your save after switching it). Nothing else about them changes.

## Update

Close the game and extract the new Scripts and Runtime over the old ones (the same version for both), then any optional packs you use, in that order: the OmniVoice pack goes after the Runtime. Your conversations, memories and settings are kept. The first start after updating moves your memories, conversation history and logs out of the game folder into `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`.

## Uninstall

Delete these folders from your Cyberpunk 2077 folder:

- `bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod` (this also deletes your settings and phone chats)
- `red4ext\plugins\AiNpcCyberpunkMod` (this also removes the OmniVoice and Local AI packs)
- `red4ext\plugins\AiNpcCyberpunkModNative`
- `r6\scripts\CyberpunkConvai` and `r6\audioware\CyberpunkConvai` (the scripts and speech files; internal names)
- `archive\pc\mod\convai_facial.archive`, `convai_gestures.archive` and `cyberpunk_convai_ambient_driver_guard.archive`
- `HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt`, if it is still there

Then delete `%LOCALAPPDATA%\AiNpcCyberpunkMod` (paste that into the Explorer address bar). It is outside the game folder and holds your memories, conversation history, logs and reports (and the models you added in its `local-ai` folder; copy those out first if you want to keep them), so a mod manager leaves it behind too.

## Error reports

When something in the mod goes wrong, it sends a short error report to the developer's server, so problems can be fixed without asking you for logs. It is on by default. Settings > Privacy > Send error reports automatically turns it off; then nothing is recorded or sent. The first time you load the game after updating, a notice says so once.

A report holds: the error and where in the code it happened; the versions of the mod, the game and the required mods; your conversation provider, voice and Local AI model choices and a few other settings (on or off); your graphics card's name and memory; the setup check's lines; and up to 150 log lines from around the error, with access codes, IDs and your Windows user name removed. Your installation is identified only by a random number hashed twice.

A report never holds: access codes or passwords, what you or the characters say, typed lines, character memories, microphone audio, or your Windows user name. Your IP address is not stored. At most one report per kind of error per day and five a day in all are sent, in the background, never while a character is answering. Reports are kept for 30 days.

## Licence

AI NPC Cyberpunk Mod is released under the AI NPC Cyberpunk Mod Use License (see `LICENSE.txt`): you may use, modify and share it, including commercially, as long as modified versions that offer AI character conversations keep Convai available as a selectable option. You do not have to use Convai. Bundled components keep their own licences (see `THIRD-PARTY-NOTICES.txt`), and Cyberpunk 2077 and its assets belong to their owners.

## Help

Open Settings > Help > Help and support in game. It shows the service status and can create a report to share when asking for help. Generate report saves it in `%LOCALAPPDATA%\AiNpcCyberpunkMod\reports`. If the conversation service is not running, it writes a shorter report at once instead: `runtime\convai-report-lua.txt` in the mod folder (`bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod`). If the service row says "Needs a browser", install a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera, then restart the game.

The mod does not load, or the manager will not open? Close the game and double-click `Make support report.bat` in `red4ext\plugins\AiNpcCyberpunkMod`. Its window lists what is missing, for example a required mod or a folder the zip was extracted into by mistake. It saves one report with the game closed and opens its folder: send that file. With Mod Organizer 2, start it from MO2 (add it under Executables).

Known issue: if V keeps walking in one direction after you type a message, tap that direction (W, A, S or D) once.
