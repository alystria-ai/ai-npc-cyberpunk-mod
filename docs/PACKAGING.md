# Two-archive distribution plan

Status: **planned, not yet a portable release**. Inventory and a machine-readable
plan were created on September 30, 2026. No large runtime was copied, no ZIP was
built, and nothing was uploaded or published.

The requested player experience is to extract both archives into the Cyberpunk
2077 game directory. Later Lua updates replace only the Scripts archive. Keep
that requirement explicit while resolving the current runtime setup gaps.

## Archive contract

| Archive | Contents | Installation root |
|---|---|---|
| `CyberpunkConvai-Scripts.zip` | Only `.lua` files; currently 39 active development files, including `continuous-speech.lua` | `bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/` |
| `CyberpunkConvai-Runtime.zip` | Every other mod component: catalogs, nine redscript files, facial archive, audio manifest, portable bridge/browser/Python, OmniVoice code and weights, local lip-sync tool, bootstrap and notices | Paths relative to the game directory |

The current shared development manifest contributes 14 known non-Lua files to
Runtime. **Those 14 files are not a complete runtime package.** The proposed
additional components and unresolved requirements are listed in
[`packaging/release-plan.json`](../packaging/release-plan.json). It deliberately
has `status: proposal-not-buildable`; it is not an installer or a copy command.

ZIPs must have `bin/`, `r6/` and `archive/` directly at their roots, as applicable,
without a wrapper directory. Do not include CET's global bindings or settings.
Scripts must carry a compatible runtime version in Lua; Runtime must carry its
own version/hash manifest so a mismatched update can explain what is missing.

## Voice behavior to preserve

- The default route is OmniVoice for Johnny, Judy and Panam, with configured
  Convai voices for other characters. The user's saved selection takes priority.
- OmniVoice defaults to **32 generation steps**, with **16 steps** as the other
  option. Both use **FP16 on CUDA through PyTorch**. These step counts are not
  floating-point precision, training epochs or separate voice models.
- The existing bounded CUDA graph optimization can remain. Production currently
  uses no TensorRT or FP8 model.
- One local model stays warm while the hybrid provider is selected. Selecting
  **Convai for all characters** unloads it through the existing owned-worker
  lifecycle. Packaging must not start an extra model worker or VoiceStudio UI.
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
| Character/quest data | Approved roster/catalog exports | Ship a reviewed release profile mapping. Never copy the developer's private account mapping or experimental research tree wholesale. |

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

## Why the existing development folder cannot simply be zipped

1. `vendor/reference-voicestudio/.venv/pyvenv.cfg` points to a Python installation
   under this developer's `C:\Users\...` workspace. Its
   `_editable_impl_omnivoice.pth` also has an absolute workspace path. Both break
   after relocation. Build and test a proper portable Python layout instead.
2. `ResidentVoice.start()` currently launches the developer venv path, and the
   worker validates model/reference paths under the project tree. A release
   layout needs a central, package-relative path resolver.
3. The bridge defaults to this machine's `E:` game location. Production bootstrap
   must discover the root from its installed location and pass explicit paths.
4. `Start-ConversationBridge.ps1` relies on global Node and a source rebuild. That
   is now safer for development but is not the finished player launcher. The
   release needs a prebuilt, verified client and packaged executable lookup.
5. The bridge is currently started manually. Pasting two ZIPs does not yet own
   service startup/shutdown, handle launch races or present first-run setup.
   Add a supported hidden bootstrap; do not smuggle an autorun task or unrelated
   persistent service into the package.
6. Three conditioning references and transcripts are required. Current setup
   reads ignored benchmark metadata and existing extracted game audio. The
   release must produce the selected references from the user's installed game
   through a narrow, version-checked local extraction path; do not ship personal
   audio/sample folders or silently claim cloning works without references.
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
