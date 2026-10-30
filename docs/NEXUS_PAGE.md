# Nexus Mods page: AI NPC LLM Companions (launch 18 Oct 2026, page text for 0.3.5, file descriptions for 0.3.5)

## 1. Page description (Nexus BBCode)

The page text is kept short: each fact is said once, in the section where a player looks for it, and features get one tight line. Sections in order: one download with the game versions, videos, key features (the old FAQ is folded in here and into the packs section), the settings block (local first, then cloud, then video memory), install (requirements, then three routes: by hand, Vortex, Mod Organizer 2, each with its update line), optional packs and your own models (including the second PC setup), languages, privacy and error reports, troubleshooting. Release history stays in the changelog, not on the page.

```text
[size=4][b]One download: the main file, AI NPC LLM Companions, holds everything. Extract it into your Cyberpunk 2077 folder and you are done.[/b][/size]
The main file is for game [b]2.5[/b]. Still on [b]2.31[/b]? Take the optional file [b]AI NPC LLM Companions - for game 2.31 (older game version)[/b] instead, same mod and version. To play 2.31 on Steam: right-click the game, Properties, Game Versions & Betas, 2_31_old.

[youtube]iR0lOYfrFx8[/youtube]

[youtube]7hoYG5tmZ98[/youtube]

Questions, bugs or ideas? Join the [url=https://discord.gg/p4pxQhAvJ]Discord server[/url]:

[url=https://discord.gg/p4pxQhAvJ][img]https://img.icons8.com/color/64/discord-logo.png[/img][/url]

[size=4][b]Key features[/b][/size]
[b]Talk to anyone[/b][list]
[*][b]Voice or text.[/b] Face someone and press your talk key: hold it while you speak and let go to send, or type. They answer out loud with subtitles, and now and then ask you something back. The microphone opens the instant you press, so your first words are not lost. Voice activation (Settings > Voice and microphone, off by default) is hands-free, and Speak dialogue choices (same page, off by default) lets you pick a dialogue option by saying its words or its number.
[*][b]Key bindings and controller.[/b] Companion Manager > Key bindings gives each action a keyboard key, a combination such as Shift+F5, or a controller button, with no restart. Defaults: F7 talk by voice, F6 talk by text, F10 group voice chat, F8 group text chat, F4 the Companion Manager.
[*][b]The game's cast and the whole city.[/b] 700+ game characters with their own personality and story, from Judy and Panam to side characters like Mateo, the Mox bartender at Lizzie's, each researched from the game's lore. Everyone else you can aim at (gangers, NCPD, guards, ripperdocs, vendors, bartenders, quest extras, passers-by) answers as their kind of person: 40 kinds with 80 personalities. Shopkeepers remember you, and each passer-by gets a fitting Night City name, shown on the scanner and in subtitles. With Talk to story characters (Settings > Conversations, off by default, reload your save) the game's own Judy, Jackie, Panam or Rogue answer in place, with voice and face only.
[*][b]Talk has consequences.[/b] Threaten or insult an ordinary person and they react from who they are: civilians run or call the police, gangers and guards fight back. Settings > Night City > NPCs react to threats and commands (off by default) adds commands such as "get down" and fistfights.
[*][b]Group chat, phone and holocalls.[/b] Two or three people at once, companions or anyone near you, taking turns (nobody in front of you? your party answers). Text any character with a profile here, your own included, from the Chat tab on V's phone (on a contact: T text, H call, J invite, L dismiss, F favorite), or call them and watch them pick up on screen.
[/list][b]Companions[/b][list]
[*][b]Invite almost anyone[/b] from Main characters to invite or Side characters to invite, plus hundreds more character models from the Model browser. No party size limit. Favorites go first in the list and on the phone, and Companion Manager > Parties saves your party for one-press Spawn party. Characters spawned by other mods, Night City Allies followers among them, talk too, as themselves when they have a profile here, and Lucy and Rita Wheeler have their own voices and memory.
[*][b]They live alongside you.[/b] They follow through doors, lifts and fast travel, sit on couches and bar stools, ride in your car and fight with the game's own combat AI. Ask one to drive ("can you drive us to the waypoint?") and they take the wheel. At a calm moment they speak up, and two or more near chat among themselves (Settings > Conversations > Companions speak up). Tag an enemy with your scanner (or look at them) and tell them to attack, or to leave (or use Dismiss in Current party). They comment on fights and loot (Settings > Companions > Companions react, on by default).
[*][b]Optional extras, all off by default.[/b] Immersive invitations (Settings > Companions): inviting becomes an appointment, they come on foot or by car and text when they arrive. Housemates (Settings > Companions > Housemates): tell a character they can stay and they move into one of your apartments and live there, with the apartment, chat pause and Evict all housemates on the same page. Eddies (Settings > Companions): borrow, lend, give or pay back eddies by talking, characters decide from who they are and how they feel about you, and nothing leaves your wallet until you say yes. Revenge ambushes (Settings > Night City): a gang you keep killing may rarely send a small squad, never mid-fight, indoors or while wanted. Outfit changes (Settings > Companions): companions change looks only while you are not looking.
[/list][b]Faces and voices[/b][list]
[*][b]Faces and bodies that act.[/b] Lips follow the words, the face shifts at the word the feeling changes, eyes and head follow you, and characters gesture, nod and hold poses with props.
[*][b]Voices that sound like them.[/b] Pocket TTS (default) runs on your processor with no setup, Voxtral 3 makes each voice in the cloud with a Mistral key, and OmniVoice (NVIDIA) can laugh and sigh. Natural speech adds pauses and hesitations. The companion and V volume sliders both run 50 to 300 percent. If a voice fails mid-reply, you still get the whole reply as text. V speaks too: lines you type are voiced in a V voice that matches yours (Settings > Voice and microphone > V's voice), and V's voice for microphone lines (off by default) does the same for spoken ones.
[*][b]OmniVoice on AMD Radeon (experimental) or another PC.[/b] With the OmniVoice pack and a Radeon RX 6000, 7000 or 9000 card, Settings > Voice and microphone > OmniVoice for AMD downloads AMD's ROCm PyTorch (about 1.5 GB) and turns it on, but the one-button setup is not yet tried on AMD hardware. To render voices on another PC instead, paste the address of an OmniVoice server (see Optional packs) into Custom voices > Remote OmniVoice and press Test. Nothing of OmniVoice loads on your game PC.
[*][b]Inworld voice (your own key).[/b] At the bottom of Settings > Voice and microphone > Custom voices, add an Inworld API key from [url=https://inworld.ai]inworld.ai[/url], press Test connection and pick Inworld as the last entry of Companion voices. Companions speak in cloned voices, English only. The free plan is a one-time trial of about 70 minutes. Not used with Mature content.
[/list][b]Story and memory[/b][list]
[*][b]They know the moment.[/b] They pick up from the game's own dialogue and know your quest, clothes and what you carry. With Companion vision on they also get a fresh glimpse of the game window (never saved), with any provider. Quest givers explain the job: ask "what do I do next?" and they walk you through the step you are on, never beyond it. Covers 171 jobs, Phantom Liberty included.
[*][b]They remember you.[/b] Conversations stay with a character across saves, and Judy, Panam, River, Kerry and Meredith know where things stand with V. Make one character, or everyone, forget at any time.
[*][b]Johnny in your head (off by default).[/b] Give a key to Talk to Johnny by voice or text and he answers in V's head. With Speaks up rarely or often he also comments on people you meet, jobs you finish and romances.
[/list][b]Make it yours[/b][list]
[*][b]Character editor.[/b] Companion Manager > Home > Character editor opens in your browser: edit any character's bio, speaking style and memories, or make your own with Google Gemini, Local AI or a Custom endpoint (with Convai they talk as an ordinary person). To make one, face a character with no profile here and open Open > New character: a name, a bio, a way of speaking and optionally a voice clip. Yours show in Characters to invite and in the phone's Chat tab. The Look and moves tab sets outfit, gestures, idle moves and reply length. The Voice tab gives a story character or one of yours a new voice: choose Add voice clip, a WAV, MP3, OGG or FLAC file of 5 to 20 seconds of one person speaking clearly, with the words typed out. Pocket, OmniVoice and Voxtral copy that voice from the next line with no restart, Remove clip brings the original back, and the clip stays on your PC.
[*][b]World rules and prompting.[/b] Write rules for all of Night City, for example "nobody knows V's name unless V says it", and every character follows them from the next reply. The editor's Prompting tab tunes the prompt per AI option: output rules, example replies, sampling, length limits and an Advanced parameters box, with a live preview and a reset for any part. Game facts, safety rules and Mature hard limits stay locked. Convai's prompting lives on Convai's side.
[*][b]Content packs.[/b] Small no-code add-ons that change how characters talk (world rules, prompt wording, backstories, names, a separate memory). Extract into your Cyberpunk 2077 folder and switch on in Settings > Content packs. Your editor edits win over a pack. [url=https://www.nexusmods.com/cyberpunk2077/mods/35950][b]Medieval Night City - AI NPCs[/b][/url], a separate add-on page, is the first and turns Night City medieval.
[*][b]Choose what they know.[/b] Settings > Conversations > Dynamic info has twelve switches for what characters are told (Location, Time and weather, Health, V's money, V's gear and clothes, Quest and journal, Music and TV and more). Off means left out, on every provider.
[*][b]Bring your own AI and any language.[/b] Custom works with OpenRouter, Nano-GPT, Ollama, LM Studio, Mistral (a preset) or any OpenAI-compatible service, and Local AI runs your own model files (see Optional packs and your own models). Menus come in sixteen languages and characters can answer in yours (see Languages).
[/list][b]Light and fast[/b][list]
[*][b]Heavy work stays out of the game.[/b] It runs in a separate background service and the default setup uses no video memory, so it does not slow your game. Unused models unload, and Local AI steps down to a lighter model when the game needs the memory. Companions are temporary copies the mod owns, and the game's story characters are left alone unless you turn on Talk to story characters.
[*][b]Fast replies.[/b] Everything between your words and the first sound runs at High Windows priority once you are in the world. If the game stutters, see Troubleshooting.
[/list]

[size=4][b]Recommended settings[/b][/size]
Pick a provider in Companion Manager > Settings > AI provider. Local is free and private, cloud is the quick start.
[b]1. Local: free, no internet, no account, no limit[/b][list]
[*][b]You need[/b] a graphics card with room to spare next to the game: 12 GB of video memory or more (see below), at least 16 GB of system memory and Vulkan (NVIDIA or AMD). It shares the card with the game, so it is slower than cloud on most PCs.
[*][b]Install[/b] a Local AI pack: [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/LocalAI-Standard-Gemma-4-E4B.zip][b]Local AI standard[/b][/url], or [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/LocalAI-Lite-Bonsai-2-4B.zip][b]Local AI lite[/b][/url] for smaller cards. A Mature pack works too. Extract it into your game folder like the mod, then choose [b]Local AI[/b] as the provider (with only a Mature pack, also turn on [b]Mature content[/b]). The mod starts and stops the AI by itself, with no server, Ollama, LM Studio or command line.
[*][b]Voice:[/b] [b]Pocket[/b] (included, English, on your processor), or [b]OmniVoice[/b] with its pack (see Optional packs) on an NVIDIA card with 12 GB or more free next to the game, for game-like voices and other languages.
[*][b]Local stays local:[/b] if your local voice or Local AI fails, you get a message or text only. The mod never switches to a cloud voice or cloud text on its own.
[/list][b]2. Cloud: fastest replies, light on your PC, no extra downloads[/b][list]
[*][b]Convai (higher tier):[/b] already set up, nothing to do. The most complete option: characters act on what you ask and see where you are. The free tier gives 500 turns a day and Settings shows how many are left.
[*][b]Google Gemini (free key):[/b] about a second to the first words. Make a free key at [url=https://aistudio.google.com/apikey]Google AI Studio[/url] (a Google account is enough, no card), choose [b]Google Gemini (free plan)[/b] in Settings > AI provider and press [b]Add[/b]. About 500 replies a day, up to 15 a minute. Not offered in every country, and Google may use free-plan chats to improve its products.
[*][b]Mistral:[/b] add a key with the [b]Mistral[/b] preset on the Custom page ([url=https://console.mistral.ai]console.mistral.ai[/url]). New accounts don't seem to get a free key any more.
[*][b]Voice:[/b] Pocket TTS runs on your processor with no limit. With a Mistral key, choose [b]Voxtral[/b] in Settings > Voice and microphone > Companion voices.
[/list][b]How much video memory?[/b] The game uses roughly 6 to 7 GB at 1080p, 9 to 10 GB at 1440p or with ray tracing, 12 GB or more at 4K or path tracing. Local AI and OmniVoice need room on top:[list]
[*][b]8 GB:[/b] cloud text with Pocket or Voxtral is fastest. Local AI still starts, with the part that does not fit on your processor (slower). OmniVoice is not started: the mod uses Pocket and tells you once.
[*][b]10 to 12 GB:[/b] Local AI lite with Pocket at 1080p without ray tracing, or OmniVoice with cloud text.
[*][b]12 to 16 GB:[/b] Local AI standard with Pocket at 1080p, or lite with ray tracing or 1440p.
[*][b]16 GB or more:[/b] Local AI standard with ray tracing or 1440p and up, or Local AI with OmniVoice.
[/list]Added on top of the game (measured on a 12 GB RTX 4080 Laptop): cloud text with Pocket or Voxtral [b]0 GB[/b] (the default). Pocket with Local AI lite about 1.8 GB, with standard about 3.1 GB (needs about 6 GB free to start). OmniVoice with cloud text about 2 GB (up to 4 GB), with Local AI lite about 3.9 GB (up to 5.9 GB), with standard about 5.2 GB (up to 7.3 GB). If your card runs short, the mod steps down by itself (standard to lite, then part of the model on your processor, never to the cloud). Lowering texture quality frees the most room. Companion vision adds its vision file (see Optional packs): about 0.8 GB for standard, 0.4 GB for lite.

[size=4][b]Install[/b][/size]
[b]Requirements[/b][list]
[*][b]Game and PC:[/b] Cyberpunk 2077 version 2.5 (or the older 2.31) on Windows 10 or 11 (64-bit), and the file you install must be the build for your game version. About 3 GB free, plus the optional packs (the Local AI and Mature packs need the Runtime of version 0.2.7 or newer). Internet for Convai, Google Gemini or Voxtral (needs a Mistral key), none for Local AI with a local voice. A graphics card only for OmniVoice and Local AI.
[*][b]Browser:[/b] a Chromium browser such as Microsoft Edge (included in Windows), Google Chrome, Brave or Opera. Firefox does not work.
[*][b]Mods to install first, game 2.5:[/b] [url=https://www.nexusmods.com/cyberpunk2077/mods/107]Cyber Engine Tweaks[/url] 1.38.0 (it can hang a NEW game, see Troubleshooting), [url=https://www.nexusmods.com/cyberpunk2077/mods/1511]redscript[/url] 0.5.32, [url=https://www.nexusmods.com/cyberpunk2077/mods/2380]RED4ext[/url] 1.31.0 or newer, [url=https://www.nexusmods.com/cyberpunk2077/mods/7780]Codeware[/url] 1.21.0, and either [url=https://www.nexusmods.com/cyberpunk2077/mods/31640]Mod Configuration Menu[/url] 0.10.5 or newer or [url=https://www.nexusmods.com/cyberpunk2077/mods/3518]Native Settings UI[/url] 1.97 (one is enough, with both the manager uses Mod Configuration Menu). Audioware and TweakXL are not needed, but having them does no harm.
[*][b]Game 2.31 needs other versions:[/b] Cyber Engine Tweaks 1.37.1, redscript 0.5.31, RED4ext 1.30.0, the official [url=https://www.nexusmods.com/cyberpunk2077/mods/7780]Codeware[/url] 1.20.5, Mod Configuration Menu 0.10.5 or Native Settings UI 1.96. RED4ext 1.31.0 and Codeware 1.21.0 are for 2.5 only.
[/list]

[b]Pick how you install[/b]
First install the mods in Requirements. Vortex and Mod Organizer 2 always use the [b]main file[/b], for a new install and for every update. The [b]Update[/b] file is only for installs you extracted by hand.

[b]By hand[/b][list=1]
[*]Download [b]AI NPC LLM Companions[/b] from this page (the main file for game 2.5, or the optional file for 2.31). It holds everything.
[*]Close the game. Extract the zip into your [b]Cyberpunk 2077 folder[/b] (the one with bin, archive and r6) and let the folders merge. If Windows asks about files with the same names, choose Replace: it is always safe. Don't extract into a new folder named after the zip, as "Extract All" and 7-Zip's "Extract to" suggest.
[*]Want Local AI, Mature or OmniVoice? Extract its pack into the same folder the same way, after the main file.
[*]Start the game (the first start takes a little longer), then check your keys under [b]Companion Manager > Key bindings[/b] or in Cyber Engine Tweaks' [b]Bindings[/b].
[/list][b]Updating by hand:[/b] download the [b]Update[/b] file for your game (in Updates for game 2.5, in Optional files for 2.31). Its name says the oldest version it works on: "Update 0.3.3 and up to 0.3.5" works on 0.3.3 and anything newer. Close the game, extract it into the Cyberpunk 2077 folder and choose Replace if asked. Settings, memories and packs are kept, so never delete the mod's folders. If Settings > Privacy and help > Help and support says the Runtime is too old, or you moved from 2.31 to 2.5, extract the main file instead.

[b]Vortex[/b][list=1]
[*]Add the main file with Vortex's download button on this page, or drop its zip onto Vortex's Mods page.
[*]Click Deploy. It is the only mod you need. Vortex moving the HOW TO INSTALL file to its mod-extra-files folder, and the warning sign in its Version column, are harmless.
[/list][b]Updating with Vortex:[/b] add the newer [b]main file[/b] the same way (never the Update file), choose "Replace the existing mod" (it may first ask to replace the file, say yes), then Deploy. If Vortex shows "Mod files were changed outside Vortex", click Save all changes (or Use newer file for all changes), never Revert, then Confirm.
[b]Packs with Vortex:[/b] for Local AI and Mature, Vortex shows "You Have Reached The Fallback Installer": choose "Yes, Install To Staging Anyway". Two packs report "unresolved file conflicts" because they share identical files, so load either one after the other. Extract the OmniVoice pack by hand, Vortex can't install it.

[b]Mod Organizer 2[/b][list=1]
[*]Install the main file as one mod. It holds everything.
[*]Enable it in the left pane and start the game through Mod Organizer 2.
[/list][b]Updating with Mod Organizer 2:[/b] install the newer [b]main file[/b] the same way (never the Update file) and choose Merge if asked, so the packs in its folder stay.
[b]Packs with Mod Organizer 2:[/b] put the multilingual packs and the PocketTTS models INTO that mod's folder (replace files). The other packs can be mods of their own.

[b]Coming from 0.3.3 or older, with a Scripts mod and a Runtime mod in Vortex or Mod Organizer 2?[/b] Remove both of the old mods, then install the main file as one mod and deploy. From 0.3.4 the main file holds both, and the managers show three mods until you do. Your memories, keys and characters live in %LOCALAPPDATA%\AiNpcCyberpunkMod, outside any mod, so none is lost. Packs you put inside the old Runtime mod's folder go with it, so put them into the new mod again.

[size=4][b]Optional packs and your own models[/b][/size]
All packs are on the same [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main]Hugging Face page[/url]. Each is one zip that works on its own. Install none, some or all, the same way as the main file.[list]
[*][url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/voice/OmniPack-OmniVoice-0.6B.zip][b]OmniVoice[/b][/url] (about 7.4 GB installed): a richer voice that can laugh and sigh, for NVIDIA cards with at least 12 GB of video memory (experimental and untested on AMD Radeon). Choose it in Settings > Voice and microphone.
[*][url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/server][b]OmniVoice server[/b][/url] (a 4.8 GB download, with its own Python and the voice model): for Remote OmniVoice, to render the voices on another PC. Needs Windows and an NVIDIA card, no game.
[*][url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/LocalAI-Standard-Gemma-4-E4B.zip][b]Local AI standard[/b][/url] (about 5.3 GB) is the local language model with the best replies, [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/LocalAI-Lite-Bonsai-2-4B.zip][b]Local AI lite[/b][/url] (about 1.3 GB) the same for smaller graphics cards.
[*][url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/mature/Mature-Lite-Qwen3.5-4B.zip][b]Mature lite[/b][/url] (about 2.8 GB) and [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/mature/Mature-Standard-Gemma-4-E4B.zip][b]Mature standard[/b][/url] (about 5.5 GB): uncensored local models. Characters act like real adults: explicit when you take things there or when the relationship and moment fit. Each works on its own, so no Local AI pack is needed. The Mature content setting is off by default.
[*][b]Vision files[/b] (0.37 to 0.68 GB each): with Companion vision on, a Local AI model sees only with its vision file, a small zip you extract after the pack: [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/vision/Vision-Gemma-4-E4B-projector.zip]Gemma 4 E4B[/url] (Local AI standard and Mature standard, 0.56 GB), [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/local-ai/vision/Vision-Bonsai-2-4B-projector.zip]Bonsai 2 4B[/url] (Local AI lite, 0.37 GB) or [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/mature/vision/Vision-Qwen3.5-4B-projector.zip]Qwen3.5 4B[/url] (Mature lite, 0.68 GB). Folders: [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/local-ai/vision]local-ai vision[/url] and [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature/vision]mature vision[/url] (the Gemma one is in both). Without it the model answers from your words alone.
[*][url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/mic/MicPack-European-Parakeet-TDT-0.6B-v3.zip][b]Microphone, European languages[/b][/url] (about 0.67 GB): speak Russian, Ukrainian, Polish, Czech, Hungarian, German, French, Spanish, Italian or Portuguese with Local AI or a Custom endpoint. [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/mic/MicPack-Asian-SenseVoice-Small-234M.zip][b]Microphone, Asian languages[/b][/url] (about 0.24 GB) covers Mandarin Chinese, Japanese and Korean.
[*][url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual][b]Multilingual packs[/b][/url] (about 150 to 170 MB each) and [b]PocketTTS models[/b] (about 219 MB each): the game's own dubbed voices in ten languages and the Pocket voice in five. Get only the languages you play in, from the [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual]multilingual folder on Hugging Face[/url] (not on Nexus Mods). See Languages.
[/list][b]Your own AI model or model server.[/b] Local AI can use models you already run. Create a text file named [b]manifest.custom.json[/b] (check it does not end in .txt) in %LOCALAPPDATA%\AiNpcCyberpunkMod\local-ai\ (paste that into the Explorer address bar, and make the folder if needed). It survives reinstalls and mod managers. A setup in the older place, Cyberpunk 2077\red4ext\plugins\AiNpcCyberpunkMod\app\local-ai\, is still read but a clean reinstall deletes it, so copy it over.

[b]Your own model server[/b] (KoboldCpp, LM Studio, Ollama, llama.cpp, or anything OpenAI-compatible). Start the server first, then:
[code]{"version":1,"models":[{"endpoint":"http://127.0.0.1:5001/v1","name":"My Server"}]}[/code]
Usual addresses: KoboldCpp http://127.0.0.1:5001/v1, LM Studio http://127.0.0.1:1234/v1, Ollama http://127.0.0.1:11434/v1 (also add "model":"qwen3:8b", or the model you pulled). If your server wants a key, add "apiKey":"your-key". No Local AI pack is needed.

[b]Your own model file[/b] (any GGUF). Put it in a folder named custom next to the manifest, then:
[code]{"version":1,"models":[{"file":"custom/MyModel-Q4_K_M.gguf","name":"My Model"}]}[/code]
This runs on the mod's own engine, so no Local AI pack is needed.

Then in game: Settings > AI provider, choose Local AI and pick your model in the Local AI model row. List several models in the same file, separated by commas. Your model shares the graphics card with the game, so leave it enough video memory.

[b]Run the AI on a second PC.[/b] On the second PC (a GTX 1060 6 GB is enough) run llama.cpp's Vulkan server with the Local AI lite model and start it with [b]--host 0.0.0.0[/b]. Allow it through the Windows firewall on Private and Public networks. Then in the mod choose Custom, open the Custom endpoint page and paste [b]http://169.254.x.x:8080/v1 (its own address)[/b] and the model name you gave the server. A direct network cable works with no router (run ipconfig to read the 169.254 addresses). The exact command is in the README on GitHub: [url=https://github.com/alystria-ai/ai-npc-cyberpunk-mod#run-the-ai-on-another-pc]Run the AI on another PC[/url].

[size=4][b]Languages[/b][/size]
Menus come in sixteen languages. Characters answer in English by default, and Settings > Voice and microphone > Voice language can be Automatic (the language you write in) or a fixed language. With Convai, Google Gemini, Local AI or a Custom endpoint the other languages need no pack.[list]
[*][b]Voices:[/b] other spoken languages need the OmniVoice, Voxtral or Convai voice. OmniVoice and the Convai voice (with Convai as the provider) speak every language, Voxtral the 22 Mistral lists for it. Pocket speaks English, and French, Italian, German, Spanish and Portuguese with the optional PocketTTS model and that language's multilingual pack. A reply in a language your voice does not speak is shown as text.
[*][b]Dubbed voices:[/b] for Chinese (Mandarin), Japanese, Korean, French, German, Italian, Spanish (Spain), Polish, Portuguese (Brazil) and Russian, the optional [url=https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual]multilingual packs[/url] make OmniVoice and Mistral voices sound like the game's dub instead of the English actors, and with the PocketTTS model of the same language Pocket speaks in the dubbed voice too.
[*][b]Microphone:[/b] the Convai microphone expects English, so type in other languages. With Mistral it understands others too. With Google Gemini, Local AI or a Custom endpoint, the optional Microphone packs add ten European languages, Mandarin Chinese, Japanese and Korean.
[/list]

[size=4][b]Privacy and error reports[/b][/size]
[b]What leaves my computer?[/b][list]
[*][b]Convai, Google Gemini, Mistral:[/b] your lines go to that provider. The Runtime carries no Convai key of its own. With Local AI nothing leaves your computer for replies.
[*][b]Companion vision (off by default):[/b] a recent capture of only the game window goes with your line to whichever provider you use. It is taken only while someone you can talk to is near, kept in memory for a few seconds and never saved. With Local AI it never leaves your computer (it needs the vision file, see Optional packs).
[*][b]Fully offline:[/b] decline if Windows asks whether Node.js may use the network, and turn off [b]Settings > Privacy and help > Send error reports automatically[/b]. The hidden browser runs in a sandbox.
[*][b]Error reports:[/b] when something fails, or replies stay slow, a short report goes to the developer so it can be fixed without asking you for logs. It is on by default, and you can turn it off in the setting above.
[*][b]Sent:[/b] the error, mod and requirement versions, your provider, voice and Local AI choices, Mature content on or off, your graphics card, processor, Windows version, security products, the game's drive, screen size, the names of your installed mods, the setup check, and up to 150 log lines around the error (these can include Cyber Engine Tweaks lines that mention other mods), with keys, IDs and your Windows user name removed. For a silent voice also the cause, your free video memory and the voice worker's last lines. For slow replies, how long each stage took and token counts.
[*][b]Never sent:[/b] keys, what you or the characters say, memories, audio, your Windows user name or your IP address. Reports are kept for 30 days.
[/list]

[size=4][b]Troubleshooting[/b][/size]
[b]A new game hangs on game 2.5.[/b]
That is Cyber Engine Tweaks 1.38.0, not this mod. Start the new game without it installed, save once, then install it again.

[b]The game stutters since the High priority.[/b]
Make a text file named [b]priority.txt[/b] in %LOCALAPPDATA%\AiNpcCyberpunkMod\data (paste that into the Explorer address bar) with one line, [b]priority = normal[/b], and restart the game. Delete the file to return to High.

[b]V never speaks my lines.[/b]
Typed lines are voiced by default (Settings > Voice and microphone > V's voice). Microphone lines only with [b]V's voice for microphone lines[/b] on. If you type a line, the row is not Off and V stays silent, open Settings > Privacy and help > Help and support, press Generate report and send it to me.

[b]The Companion Manager doesn't show up.[/b]
Press your manager key (stand up first if V is sitting), or Esc, then Mods, and choose Companion Manager (in Native Settings UI, the AI NPC Cyberpunk Mod tab). No Mods entry? Install or update Mod Configuration Menu or Native Settings UI.

[b]Settings says it needs a browser, or the service does not start.[/b]
Install or repair Microsoft Edge (free from [url=https://www.microsoft.com/edge]microsoft.com/edge[/url]) or install Google Chrome, then restart the game. Browser installed somewhere unusual? Make a file named [b]browser.txt[/b] next to launcher.ini (red4ext\plugins\AiNpcCyberpunkMod) with the path to its exe on one line.

[b]Settings says "No model installed" for Local AI.[/b]
The pack was probably extracted into an extra folder named after the zip. Extract it again into the Cyberpunk 2077 folder itself. With only a Mature pack, turn on Mature content in Settings > AI provider.

[b]I only get subtitles, a voice error, or Help and support says Windows blocks the files of a voice or of Local AI.[/b]
Open Settings > Privacy and help > Help and support: it names the cause. With OmniVoice it is usually too little free video memory next to the game, so choose Pocket or Voxtral in Settings > Voice and microphone. If the notice mentions the paging file (error 1455), enlarge it or close other programs, then restart the game. If it says Windows' Smart App Control (or a company's Application Control policy) refuses to load the files, they cannot run on that PC: choose a cloud voice such as Voxtral and a cloud provider.

[b]The mod does not load, the manager will not open, or something else is wrong?[/b]
In game, open Companion Manager > Settings > Privacy and help > Help and support, choose [b]Generate report[/b], and send that file with what you were doing. You can also post what you see (a screenshot helps) on this page's Posts tab or in the [url=https://discord.gg/p4pxQhAvJ]Discord server[/url].
```

## 2. File descriptions (the four uploads)

Game 2.5 is the default: the full install is the main file and its update sits under Updates. Game 2.31 is two optional files ("Optional files", not "Old versions"), the same version number. `<from>` is runtimeBase.required, or `<required>-and-up` when the update covers several releases: for 0.3.5 the name is Update-0.3.3-and-up-to-0.3.5 and it needs the Runtime 0.3.3 or newer. Each description at most 255 characters.

AI NPC LLM Companions (the main file, game 2.5, zip AI-NPC-LLM-Companions-<version>.zip):

```text
Full install for game 2.5, everything in one zip. Extract it into your Cyberpunk 2077 folder, or add it as one mod in Vortex or Mod Organizer 2. New: content packs, key bindings, car invitations, housemates, outfits, Music and TV info.
```

Update <from> to <version> (an update file, game 2.5, zip AI-NPC-LLM-Companions-Update-<from>-to-<version>.zip, for example Update 0.3.3 to 0.3.4, and Update any to 0.3.5 for this release):

```text
Update for game 2.5, for manual installs only: extract it into the game folder. Not for Vortex or Mod Organizer 2, they use the main file. Needs the Runtime <from> or newer. New: content packs, key bindings, car invitations, housemates.
```

AI NPC LLM Companions - for game 2.31 (older game version) (optional file, zip AI-NPC-LLM-Companions-<version>-for-2.31.zip):

```text
Full install for older game 2.31, all in one zip. Extract it into your Cyberpunk 2077 folder, or add it as one mod in Vortex or Mod Organizer 2. New: content packs, key bindings, car invitations, housemates, outfits, Music and TV info.
```

Update <from> to <version> - for game 2.31 (older game version) (optional file, zip AI-NPC-LLM-Companions-Update-<from>-to-<version>-for-2.31.zip):

```text
Update for older game 2.31, for manual installs only: extract it into the game folder. Not for Vortex or Mod Organizer 2. Needs the Runtime <from> or newer. New: content packs, key bindings, car invitations, housemates.
```

## 3. Short summary (brief overview field)

```text
Talk to Cyberpunk 2077 characters by voice or text, and hear companions answer in their own voices. Run it fully on your own PC with Local AI, free, with no account and no internet. Or use the Convai free tier, or a free Google Gemini key. Pocket TTS voices need no setup.
```

Character count of the summary (including spaces and punctuation): 265

## 4. Screenshot captions (suggested)

1. Text conversation with a character, opened with the talk-by-text key.
2. Voice chat showing the "Listening" prompt.
3. Companion Manager with the "Main characters to invite" list.
4. Settings > AI provider, showing Local AI, Google Gemini and the Convai free tier.
5. Group conversation with companions taking turns.
6. Phone Chat with a holocall live on screen.
