# Nexus Mods page: AI NPC Cyberpunk Mod (launch 18 Oct 2026)

## 1. Page description (Nexus BBCode)

```text
[size=5][b]AI NPC Cyberpunk Mod[/b][/size]

Talk to Cyberpunk 2077 characters by voice or text, and hear them answer in their own voices. Invite a character along and they walk at your shoulder through Night City, sit beside you and ride in your car. Every way to run it is free.

[size=4][b]Key features[/b][/size]

[list]
[*][b]Talk by voice or text.[/b] Face someone, press your key, then speak or type. They answer out loud, with subtitles and moving lips.
[*][b]Bring companions along.[/b] They walk beside you, follow you through doors and fast travel, sit on couches and bar stools, and ride in your car. Ask one to drive.
[*][b]Group conversations.[/b] Talk to several people at once, and they take turns.
[*][b]Phone Chat and holocalls.[/b] Text supported contacts from V's phone, or call them and they answer live on screen.
[*][b]The street talks back.[/b] Gangers, police officers, ripperdocs and bartenders answer as their kind of person.
[*][b]V speaks too.[/b] Lines you type are voiced in V's own voice before the reply.
[*][b]They remember.[/b] Conversations stay with a character across saves. Make one character forget, or all of them.
[*][b]Voices that sound like them.[/b] Pocket TTS, the default, runs on your processor with no setup. Voxtral and OmniVoice are optional.
[*][b]Characters spawned by other mods can talk too.[/b] They use their own profile, voice and memory.
[/list]

[size=4][b]How it runs[/b][/size]

Three ways, all free. Pick one in Companion Manager > Settings > Conversation provider.

[list]
[*][b]Local AI: fully on your own PC.[/b] Download a Local AI pack and your characters think and speak on your own computer. No account, no key, no internet and no limit. It needs a graphics card with Vulkan (NVIDIA or AMD), at least 16 GB of system memory, and about 5 GB more than usual while it runs. A lite pack runs on smaller cards.
[*][b]Mistral: free account, fastest cloud replies.[/b] Make a free Mistral account (it asks for phone verification), paste its key once, and get about 5,000 turns a day. Replies are plainer than Convai's. The same key unlocks Voxtral, a voice made in the cloud for each character.
[*][b]Convai free tier (the default): nothing to set up.[/b] Install, start the game and talk. It gives 100 turns a day, and Settings shows how many are left. Convai's paid plans give more turns, and their plan page is in the Convai settings.
[/list]

[b]Voices.[/b] Pocket TTS runs on your processor and never counts against a daily limit. Voxtral needs a Mistral key. OmniVoice needs an NVIDIA card and its optional pack.

[size=4][b]Requirements[/b][/size]

[list]
[*]Cyberpunk 2077 version 2.31 on Windows 10 or 11 (64-bit). Tested on 2.31 only.
[*]These mods, all from Nexus Mods, installed first: [url=https://www.nexusmods.com/cyberpunk2077/mods/107]Cyber Engine Tweaks[/url], [url=https://www.nexusmods.com/cyberpunk2077/mods/2380]RED4ext[/url], [url=https://www.nexusmods.com/cyberpunk2077/mods/1511]redscript[/url], [url=https://www.nexusmods.com/cyberpunk2077/mods/7780]Codeware[/url], [url=https://www.nexusmods.com/cyberpunk2077/mods/4197]TweakXL[/url], [url=https://www.nexusmods.com/cyberpunk2077/mods/12001]Audioware[/url] and [url=https://www.nexusmods.com/cyberpunk2077/mods/31640]Mod Configuration Menu[/url]. RED4ext starts the voice service with the game.
[*]Tested with Cyber Engine Tweaks 1.37.1, RED4ext 1.30.0, redscript 0.5.31, Codeware 1.20.5, TweakXL 1.11.4, Audioware 1.9.9 and Mod Configuration Menu 0.10.3. Newer versions may work.
[*]About 3 GB of free disk space, plus more for the optional packs.
[*]Internet while you use Convai, Mistral or the Voxtral voice. Local AI with a local voice needs none.
[*]No graphics card needed for the default setup. Only OmniVoice and Local AI use one.
[/list]

[size=4][b]Install[/b][/size]

[list=1]
[*]Install the mods in Requirements first.
[*]Download Scripts for version 0.2 from Nexus Mods, with Vortex or by hand.
[*]Download the Runtime for version 0.2 from the [url=https://github.com/alystria-ai/ai-npc-cyberpunk-mod/releases]GitHub releases page[/url]. Use the same version number as the Scripts.
[*]Close the game. Extract both zips into your Cyberpunk 2077 folder (the one with bin, archive and r6) and let the folders merge. Extract the Runtime before the OmniVoice pack. If Windows' extractor reports an error, use [url=https://www.7-zip.org]7-Zip[/url].
[*]Start the game. The first start after installing takes a little longer while the voice service prepares itself.
[/list]

[size=4][b]Optional packs[/b][/size]

Each pack is one zip file and works on its own. Install none, some or all. Get them from the [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs]Hugging Face page[/url], in the 0.2 folder, and use the same version number as the Scripts.

[list]
[*][b]OmniVoice pack[/b] (about 9 GB installed). A richer voice that can laugh and sigh. For NVIDIA cards with at least 8 GB of video memory and a current driver. Choose an OmniVoice voice in Settings > Voices.
[*][b]Local AI standard[/b] (about 5.3 GB). The language model for fully local conversations, with the best replies.
[*][b]Local AI lite[/b] (about 1.4 GB). The same kind of model, for smaller graphics cards.
[*][b]Mature lite[/b] (about 2.7 GB) and [b]Mature standard[/b] (about 5.3 GB). For adults only (18+). Each adds a model without the usual refusals. They need a Local AI pack, and the Mature content setting is off by default.
[/list]

[size=4][b]FAQ[/b][/size]

[b]Will it slow my game down?[/b]
The heavy work runs in a separate background service, not inside the game. The default setup uses no video memory. On a laptop, set Windows power mode to Balanced or Performance and plug it in. In testing, Silent mode cut Local AI's speed by about 40 percent.

[b]Do I have to set keys?[/b]
Yes. Open Cyber Engine Tweaks' Bindings and give a key to each AI NPC Cyberpunk Mod action, such as talk by text, talk by voice and the companion manager. The mod never assigns or overwrites keys for you.

[b]Does it change the story?[/b]
No. Companions are temporary copies that the mod owns. Story characters you meet in the world are left alone by default, so the story plays out as written. Talking to them is off until you turn on Settings > Conversations > Talk to story characters (then reload your save); they then answer with voice and face only.

[b]What leaves my computer?[/b]
With Convai, your lines go to Convai, along with a recent picture of the game window. That picture is taken only while someone you can talk to is near, kept in memory for a few seconds and never saved. With Mistral, your lines go to Mistral. With Local AI, nothing leaves your computer for replies.

[b]What languages can I use?[/b]
The menus come in sixteen languages. Turn on Multilingual conversations to talk in any language. Pocket and Voxtral speak English only, so those replies use OmniVoice, or Convai's cloud voice without the pack. The Convai microphone expects English, so type in other languages.

[size=4][b]Links and credits[/b][/size]

[list]
[*]Source code and releases: [url=https://github.com/alystria-ai/ai-npc-cyberpunk-mod]github.com/alystria-ai/ai-npc-cyberpunk-mod[/url]
[*]Optional packs: [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs]Hugging Face[/url]
[*]Something off? In game, open Companion Manager > Settings > Help > Help and support, choose Generate report, and send that file with what you were doing.
[/list]

Licence: AI NPC Cyberpunk Mod Use License 1.1. Thanks to the authors of Cyber Engine Tweaks, RED4ext, redscript, Codeware, TweakXL, Audioware, Mod Configuration Menu and the other bundled components. Thanks also to Convai and Mistral for their services.

Cyberpunk 2077 and its characters, voices and assets belong to CD PROJEKT RED.
```

## 2. File description (Scripts upload)

```text
AI NPC Cyberpunk Mod, the Scripts file for version 0.2 (Cyberpunk 2077 2.31). Small and text only. Install it with Vortex or by hand, after the mods listed on this page.
The Runtime for version 0.2 is also needed. Get it from the GitHub releases page linked on this page. It holds the voice service and the Pocket TTS voices.
```

## 3. Short summary (brief overview field)

```text
Talk to Cyberpunk 2077 characters by voice or text, and hear companions answer in their own voices. Run it fully on your own PC with Local AI, free, with no account and no internet. Or use free cloud Mistral or the Convai free tier. Pocket TTS voices need no setup.
```

Character count of the summary (including spaces and punctuation): 265

## 4. Screenshot captions (suggested)

1. Text conversation with a character, opened with the talk-by-text key.
2. Voice chat showing the "Listening" prompt.
3. Companion Manager with the "Characters to invite" list.
4. Settings > Conversation provider, showing Local AI, Mistral and the Convai free tier.
5. Group conversation with companions taking turns.
6. Phone Chat with a holocall live on screen.
