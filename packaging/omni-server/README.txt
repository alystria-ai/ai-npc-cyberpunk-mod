OmniVoice server for the AI NPC Cyberpunk Mod
=============================================

This folder runs the mod's OmniVoice voices on its own: on another PC, or on a second graphics
card of the same PC. The game then loads no OmniVoice and keeps its frames.

What you need on THIS PC: Windows and an NVIDIA graphics card (about 4 GB of free graphics
memory). No game and no mod are needed here.

Start it
--------
1. Open "Start OmniVoice server.cmd" in Notepad and read the four options (they are explained in
   plain words). If the game is on ANOTHER PC, change LISTEN=127.0.0.1 to LISTEN=0.0.0.0. If this PC
   has two graphics cards, choose one with GPU= ("Show graphics cards.cmd" lists them).
2. Save, then double-click "Start OmniVoice server.cmd".
3. A window opens and loads the voice (a minute or more the first time). When it says what to
   type into the game, it is ready. Leave the window open.

In the game
-----------
Settings > Voices > Custom voices:
  - turn Remote OmniVoice on and press Apply,
  - copy the address from the server window (for example 192.168.1.20:8765), press Paste address,
  - press Test: it shows whether the server answers and how fast,
  - under Settings > Voices choose an OmniVoice entry for the companions.

If the server cannot be reached, replies show as text until it answers again. No other voice takes
its place.

Good to know
------------
- The server has no password. With LISTEN=0.0.0.0 anyone on your network can use it to make voices,
  so use it on your own home network only. With LISTEN=127.0.0.1 only this PC can reach it.
- If Windows asks whether to allow the server through its firewall, allow it on private networks.
- The voice clips of the player's own characters and of V are sent by the game the first time
  they are needed. The "voices" folder here only saves the game from sending the shipped ones.
- "server-data" (next to the start file) holds the server's cache, the clips the game sent and
  server.log (what the server did, never what was said).
- To stop the server, close its window.

Full steps and troubleshooting: docs/REMOTE_OMNIVOICE.md in the mod's repository
(github.com/alystria-ai/ai-npc-cyberpunk-mod).
