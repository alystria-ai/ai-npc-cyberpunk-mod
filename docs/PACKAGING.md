# Two-archive distribution plan

Status: **planned, not yet a portable release**. The machine-readable plan was
created on September 30, 2026; this document was refreshed against the current
manifest on October 2. No release ZIP has been built or published.

The requested player experience is to extract both archives into the Cyberpunk
2077 game directory. Later Lua updates replace only the Scripts archive. Keep
that requirement explicit while resolving the current runtime setup gaps.

## Archive contract

| Archive | Contents | Installation root |
|---|---|---|
| `CyberpunkConvai-Scripts.zip` | Only `.lua` files; currently 63 own-mod development files, plus approved Lua files from any bundled dependencies | Game-relative CET mod paths, including `bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/` |
| `CyberpunkConvai-Runtime.zip` | Every other mod component: catalogs, nine redscript files, facial archive, audio manifest, portable bridge/browser/Python, OmniVoice code and weights, local lip-sync tool, bootstrap and notices | Paths relative to the game directory |

The current shared development manifest contributes 14 known non-Lua files to
Runtime. **Those listed files are not a complete runtime package.** The proposed
additional components and unresolved requirements are listed in
[`packaging/release-plan.json`](../packaging/release-plan.json). It deliberately
has `status: proposal-not-buildable`; it is not an installer or a copy command.

ZIPs must have `bin/`, `r6/` and `archive/` directly at their roots, as applicable,
without a wrapper directory. Do not include CET's global bindings or settings.
Scripts must carry a compatible runtime version in Lua; Runtime must carry its
own version/hash manifest so a mismatched update can explain what is missing.

Any approved bundled dependency follows the same partition: its `.lua` entries
belong to Scripts; its non-Lua assets belong to Runtime. Preserve each approved
archive entry's game-relative path. The pinned development MCM 0.10.3 ZIP has
**57 Lua files and 34 non-Lua files**: 19 locale JSON files, 14 redscript files
and one `ModConfigurationMenuAPI/data/storage.version` marker. The plan records
its source ZIP/hash and separate `plannedDependencyComponents` declarations for
both archives. These declarations do not authorize redistribution or provide a
built dependency package; notices and compatibility still need review. Never
place the complete MCM ZIP in Runtime or copy a player's MCM state or CET bindings.

## Voice behavior to preserve

- The default selector is **OmniVoice**. The current development registry has
  prepared local references for 75 of 79 profiles; the four unprepared profiles
  use their configured Convai voices. **Convai** selects online voices for all
  characters. The user's saved selection takes priority.
- OmniVoice defaults to **32 generation steps**, with **16 steps** as the other
  option. Both use **FP16 on CUDA through PyTorch**. These step counts are not
  floating-point precision, training epochs or separate voice models.
- The existing bounded CUDA graph optimization can remain. Production currently
  uses no TensorRT or FP8 model.
- One shared local model stays warm while OmniVoice is selected. Johnny, Judy
  and Panam are the three initial conditioning profiles; other references are
  prepared lazily, with at most eight conditioning profiles cached. Selecting
  **Convai** unloads the model through the existing owned-worker lifecycle.
  Packaging must not start an extra model worker or VoiceStudio UI.
- Settings draft selection starts OmniVoice preparation immediately; Apply
  commits the choice, and Revert or leaving an unsaved page cancels the preview.
- Convai delivers continuous original PCM. OmniVoice plays completed phrases
  while later phrases generate. Preserve these distinct producer paths.
- Do not include benchmark recordings, generated listening samples, training
  data, the rejected fine-tune or other engines.

## Concrete runtime inventory

| Component | Current development source | Packaging requirement |
|---|---|---|
| Bridge | `bridge/convai-bridge.mjs` and its production import closure | Copy reviewed runtime modules, not tests or every historical prototype. |
| Browser client | Fresh `build:voice` output plus `bridge/continuous-pcm-player.mjs`, `bridge/continuous-pcm-core.mjs` and `bridge/continuous-pcm-worklet.mjs` | The host serves these three modules for continuous Convai PCM playback. Stage them with the fresh bundle and verify their hashes; the old capture worklet is not part of this path. Never copy the entire developer `runtime/` directory. |
| JavaScript runtime | Currently global Node, observed version `20.20.2` | Pin and test a portable Windows x64 distribution; current version is an inventory observation, not a future support promise. |
| Browser transport | Playwright `1.58.2`; currently `channel: msedge` | Bundle a matching browser or explicitly qualify an installed-browser dependency. The requested self-contained Runtime needs an executable-path bootstrap and browser notices. |
| Convai SDK | `@convai/web-sdk` `1.7.0`, compiled into browser client | Retain SDK/transitive notices; no API key embedded in its bundle. |
| Python | VoiceStudio `.venv`, CPython 3.11 | Build a fresh relocatable runtime; the existing venv is not portable. |
| GPU dependencies | Torch `2.8.0+cu128`, torchaudio `2.8.0+cu128`, torchvision `0.23.0+cu128` | Review actual import closure, pin wheels, retain their bundled CUDA/dependency notices, and test driver compatibility. A GPU driver is a system prerequisite, not something to overwrite from the mod ZIP. |
| Other observed Python libraries | transformers `5.15.1`, accelerate `1.14.0`, NumPy `2.2.6`, soundfile `0.14.0`, safetensors `0.8.0`, einops `0.8.2` | This is a partial observed inventory, not a complete dependency lock. Do not copy all optional VoiceStudio engines/ASR/web UI dependencies by default. |
| Voice adapter | VoiceStudio commit `08a1592e3cb9b4c36beef5fa3185ec2313bb1fea` | Package a reviewed import closure with corresponding source/notice inventory. Keep the same synthesis settings and voice quality. |
| Model and audio tokenizer | `k2-fsa/OmniVoice`, revision `c5fdb5ccb189668d56333f77ba2629f4cd7535f4` | Preserve exact files/hashes and distinct license terms; do not substitute a smaller model or quantize silently. |
| Local lip sync | Rhubarb `1.14.0`, phonetic mode | Include executable, required resources and the complete combined license file. |
| Positional speech bank | Generated by `initializeAudioDepot()` | Generate eight new silent WAV placeholders and `speech.yml`; never package live reply-slot recordings. |
| Facial graph archive | Fresh validated `convai_facial.archive` from the existing builder | Include only this explicitly generated mod asset, not extracted game archives or build work directories. |
| Ambient-car Johnny guard | `Build-AmbientJohnnyDriverGuard.py --stage-development` | Stages only `cyberpunk_convai_ambient_driver_guard.archive`. The reviewed 2.31 phase fingerprint and native round-trip check are required; runtime carries this one generated file. No extracted source assets or evidence folders are included. Live fresh-entry acceptance is still pending. |
| Character/quest data | Approved roster/catalog exports and explicit intrinsic-history files | Ship a reviewed release profile mapping and the file-loaded intrinsic data listed in the plan. Never copy the developer's private account mapping or experimental research tree wholesale. |
| Required quest catalog | `research/cyberpunk/generated/quest-catalog.json` | Explicitly stage this file at `bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/app/research/cyberpunk/generated/quest-catalog.json`. The production bridge reads it at startup; omitting it prevents startup. The plan's `quest-catalog` component is an individual file allowlist, not permission to include the generated research tree. |

Observed pinned model snapshot size is **3,267,470,260 bytes (about 3.04 GiB)**:
2,450,344,112 bytes main weights, 805,665,628 bytes audio-tokenizer weights, plus
tokenizer/configuration/model-card files. This is **disk size**, not GPU memory
or a measured ZIP size. No weights were read for inference or copied for this
inventory.

### Native game dependencies

Current development versions are CET 1.37.1, RED4ext 1.30.0, redscript 0.5.31,
Codeware 1.20.5, TweakXL 1.11.4, Audioware 1.9.9 and MCM 0.10.3. They are required
by the current Lua/native code. Their compatibility, notice files and chosen
distribution method must be part of the release build; listing them here does
not mean the proposed Runtime ZIP already supplies them. Avoid overwriting a
player's newer shared frameworks or user configuration without a version check.
If MCM is bundled after those checks, the Scripts and Runtime staging declarations
above apply to its Lua and non-Lua entries respectively. If it remains a separate
prerequisite, the installation instructions must say so; the current declarations
are not a claim that extracting two ZIPs already supplies it.

## Why the existing development folder cannot simply be zipped

1. `vendor/reference-voicestudio/.venv/pyvenv.cfg` points to a Python installation
   under this developer's `C:\Users\...` workspace. Its
   `_editable_impl_omnivoice.pth` also has an absolute workspace path. Both break
   after relocation. Build and test a proper portable Python layout instead.
2. Development defaults still use the existing venv. The worker now accepts
   explicit app model/adapter paths and separate persistent reference/cache
   paths, validates its source before CUDA, and confirms the layout in its
   readiness frame. The actual portable dependency closure remains to be built.
3. The source bootstrap discovers the game root from its installed app location
   and passes explicit Python/browser/client/voice/tool paths. Its relocated
   fixture tests do not qualify a complete portable runtime distribution.
4. `Start-ConversationBridge.ps1` relies on global Node and a source rebuild. That
   is now safer for development but is not the finished player launcher. The
   release needs a prebuilt, verified client and packaged executable lookup.
5. Development autostart exists: `native/autostart` is a runtime-independent
   RED4ext plugin that starts `scripts/Supervise-ConversationBridge.mjs` when
   the game starts and hands it a stdin lifeline that closes when the game ends.
   The supervisor owns single-instance startup, crash restarts, explicit stops
   and game-exit shutdown, and publishes `runtime/bridge-service.json` for the
   in-game messages. A release should ship the same DLL with a `launcher.ini`
   whose `%GAME%`-relative paths name the packaged Node and supervisor, and a
   prebuilt verified client instead of `--build-voice-client`. Wiring that to
   the packaged layout (and its environment overrides) and the first-run UI
   remain pending.
6. The current registry has 75 prepared conditioning references and transcripts,
   including the three startup voices. Current setup reads an ignored registry
   and extracted game dialogue; one model serves the whole catalog. The release
   must produce supported references from the user's installed game through a
   narrow, version-checked extraction path and explicit manifest. Do not ship
   personal audio/sample folders or claim cloning works without references.
7. A user-owned Convai credential and an approved character-ID catalog need a
   defined first-run setup flow. Missing credentials must yield a clear status,
   never borrow the developer key or provision dozens of characters implicitly.

## License and source inventory

These are observed license labels and release-review requirements, not a blanket
claim that all artifacts can be redistributed together:

- VoiceStudio's pinned `pyproject.toml` says **AGPL-3.0-only** and its `LICENSE`
  contains AGPLv3. Preserve its applicable source and notices; decide the mod's
  release license and distribution obligations before publication.
- OmniVoice's model card distinguishes **Apache-2.0 code** from **CC-BY-NC
  pretrained weights**. The local model card does not specify a CC-BY-NC version.
  Do not label the weights Apache-2.0. The upstream card confirms this distinction:
  [OmniVoice model card](https://huggingface.co/k2-fsa/OmniVoice).
- `audio_tokenizer/LICENSE` contains the **Boson Higgs Audio 2 Community License**.
  Treat it separately from both VoiceStudio and the main model's terms.
- Convai Web SDK and Playwright identify Apache-2.0; Rhubarb's combined license
  file covers its MIT code and bundled dependencies. Python, Node, browser,
  PyTorch/CUDA and all transitive packages still need their own notice inventory.
- No project-level release license is currently declared. Audioware's staged
  package also needs a verified license/source inventory; absence of a LICENSE
  at the inspected repository root is not permission to invent a license.

## Privacy and update contract

Exclude API keys, authentication tokens, player IDs, memory registries, sessions,
phone history/drafts, requests/replies, microphone captures, logs, diagnostic
receipts, backups, research downloads, raw game dialogue extracts, training data
and unrelated user files. Use an explicit allowlist; a broad `runtime/**` or
`vendor/**` include is unacceptable.

Pocket TTS is a separate CPU research environment, not a production dependency
or proposed Runtime component. Its downloaded weights, exported Johnny state,
benchmark samples, Python environment and Hugging Face credential are excluded.

Generated player state lives separately from application binaries and is never
included in an upgrade archive. Updates preserve one existing player ID, all
settings/history and chosen bindings. Generate fresh default config only when
absent. An uninstall/update must not reset Convai memory.

## GitHub size constraint

GitHub currently requires each release asset to be **under 2 GiB**.
[GitHub release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
The raw model snapshot already exceeds that size before Python, CUDA or browser
files. Compression has not been measured, so do not promise that the complete
Runtime ZIP fits. Measure the actual archive; if it exceeds the cap, the hosting
or physical-download arrangement needs a decision. Keep the two logical package
roles. Do not silently omit weights, make OmniVoice download at first launch,
split the requested ZIP, or upload anything as part of this planning work.

## Build and acceptance method

1. Resolve the above runtime layout, bootstrap, reference preparation, dependency
   and license decisions. Convert the proposal into an explicit build manifest.
2. Stage both packages in fresh directories; build binaries/bundles from pinned
   sources. Include content hashes and compatible Scripts/Runtime versions.
3. Assert every Scripts entry ends in `.lua` and no Runtime entry does. Reject
   absolute/traversing/duplicate archive paths and all private-state filenames.
   Apply these checks to bundled dependency entries too, verify the pinned source
   archive hash/counts, and confirm required bridge data such as `quest-catalog.json`
   exists at the package-relative paths loaded by the production code.
4. Scan staged text and executable configuration for developer absolute paths,
   credentials and model-hub caches outside the intended package. Retain notices.
5. Extract onto a clean, relocated game installation with spaces/non-ASCII path
   characters and no developer Node/Python/Edge assumption. Test startup,
   disconnect/restart, world reload and safe updates independently of source tests.
6. Qualify Convai-only speech, OmniVoice 32/16, model unload/reload, group ordering,
   native audio/lip sync, UI and no visible helper windows. Audio/visual acceptance
   still requires the installed game.
7. Measure ZIP sizes/checksums and inspect their complete entry lists. Publication
   remains a separate explicitly authorized action.

`bridge/packaging-plan.test.mjs` checks the proposal's partition, relative paths,
privacy exclusions, voice settings and explicit unresolved gates. Passing it
means the **plan** is internally consistent; it does not certify a built package.
