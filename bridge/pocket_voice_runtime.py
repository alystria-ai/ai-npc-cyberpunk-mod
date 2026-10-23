"""Verified, local-only Pocket student assets and a bounded reference cache.

This module deliberately imports neither Torch nor Pocket. Source/protocol tests
can exercise identity and cancellation without loading a neural model.
"""
from __future__ import annotations

from collections import OrderedDict
import copy
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import struct
import time

PROTOCOL_VERSION = 1
SOURCE_REVISION = "41cbc84af539ea78a804ffca5f9c6edc1a22ce44"
SOURCE_SHA256 = "b86f98955b6c4776bb24a748b321408aba89d3b66f6b911f415ef4f4191a7666"
# __folder_managed_by_vortex: Vortex drops this marker file into folders it creates in the game folder (two 0.2.2 reports: the Pocket source
# "differs from the pinned official revision" on a Vortex install, with that file in the Runtime's folders), so it is not part of the source.
# desktop.ini and Thumbs.db are what Windows Explorer leaves in a folder it has shown; .DS_Store is the same from a zip made on a Mac.
SOURCE_IGNORES = {".git", "__pycache__", ".pytest_cache", ".ruff_cache", "__folder_managed_by_vortex", "desktop.ini", "Thumbs.db", ".DS_Store"}
# The files the pinned revision ships (path -> SHA-256 of the file as upstream has it), all 140 of them (the Runtime installs the pocket_tts/
# package and the licence of them: SOURCE_SHIPPED_PREFIX below). The source check reads this list, so a
# file that is NOT here (a Vortex marker or backup, a leftover from an older Runtime, a __pycache__, an antivirus note) is ignored by design:
# only a listed file that is missing or changed counts. SOURCE_SHA256 above is the digest of exactly this list (digest_manifest()), and
# packaging/build-release.mjs refuses to build when the files it ships differ from it. Do not edit by hand.
# BEGIN POCKET SOURCE MANIFEST
SOURCE_FILES = {
    ".dockerignore": "295d5bcbc843bedc0ab07cdaa8cb95696475c7fb39f7bc6607c138ccf2fa021c",
    ".github/workflows/gh-pages.yml": "a25d1ee419e0d12fc3c3977779fa07d142d227e543f19b0ecaf850671f18dd2d",
    ".github/workflows/publish-package.yml": "a951d7ffe42f72c406d6ff0fb9781e73f7316e328f90eedd15a580efdef60792",
    ".github/workflows/run-tests.yml": "c708d7cf29baf1c2b297a9c88766175c9db812120bd9c8212bf2da6d5ed64c16",
    ".gitignore": "c440f5a07618c83767dafcf5faf3387efa33c81247d8273be0937f1d7741dcdc",
    ".pre-commit-config.yaml": "aa9b3f3fa5c292c81395cea65ef9da0d84400c698297bca2e25abcfcfd2c6058",
    ".python-version": "bbec651b5e268b14772e0d2dced069b27ba3794401a095d16502b2f5e11bcf32",
    "AGENTS.md": "1fc5157ecb1fc7d89d3d5c37dad9994f6af4224111aa2c69055beadc0ebda403",
    "CONTRIBUTING.md": "0f7b0da60c20df9ad6750aa96695239d5a90d10040d719b01fd5c41ab3a744f4",
    "Dockerfile": "8923d5432abbfc8d7ce7186043a942a406c470bc87a5b24322d620cf1c993c40",
    "LICENSE": "23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3",
    "README.md": "b10cbaf9b650da187bd0d3bb4fc87d5d6a13ffd62dc8258ac7e71bb6c0b97ca2",
    "deploy.sh": "32ee31aab0a6a9c2f1da7ab94f86506dd29d64d62f3840d2cd2a4444a94e7897",
    "docker-bake.hcl": "c4cb63e3b676ef7b3271bdaefdd0c4609fbd3bd3bbf2b2430f48abbf428027cc",
    "docker-compose.yaml": "ada315f0af41ec00dfd8c84e6fec071b7f4659bb371f8ede555048d8c3610f07",
    "docs/API Reference/Reference/tts_model.md": "46889170684f3acf9ef42b07d1908ed913fa5e33703c727d15e3c0b89a27e46f",
    "docs/API Reference/python-api.md": "d2ec6e9b3ff5d0bf93cf75adf2359fb5d95ba259cb0063a7ff3106196307fff0",
    "docs/CLI Commands/export_voice.md": "311bdcfbb0dce566eebf351e570b7e8acdef6d9b27cb53078e32fa9cae30925c",
    "docs/CLI Commands/generate.md": "762ba62a20bcf604d63ecd1b057e007ac6a874c503dd22e9e6e01e92618df05e",
    "docs/CLI Commands/serve.md": "ef59c50733ce1b5e34b49e76dfbf0c585ab2ea3942d3fb3bd335ca45eadfd69f",
    "docs/index.md": "dbcc210d7f4962499db6d4cfa18658e26d05ee700c962a811cac911f095e22fd",
    "docs/logo.png": "f674a22e3728493d14e045999963b9326bf513424cce1d8f7ac45c8aff6225ca",
    "docs/mascot.png": "1b146966bf38362428880c73843c5ae01f2f6da9ba631539f29c73e67f2aab72",
    "docs/model_arch.png": "70cf69d4a65834a253e796a60be69246f03dc6ba91b678da5c1901bbbee97de0",
    "docs/pocket-tts-example.ipynb": "c62ea5f2ddfaf61bbc1495772cc957b30530fb02b05769f8a99fbd21ef401dd7",
    "docs/quantization.md": "a2c92c9997f9d1cbbe6216082e245a4801d0953b05d5a919fc3b8c8e407de976",
    "mkdocs.yml": "70de9854aa761fde189166b94f3c06306431a684f8f05dcd7cec50ffde90ba18",
    "pocket_tts/__init__.py": "d6a4eab97e2f4acb8b6bd5268d55a52e1fdce991e45b0dd536395ad02e2e5777",
    "pocket_tts/__main__.py": "76435e641e9363aa6022582a5eacf4c2c0f0f674cbf99c6a850d11448c36bb95",
    "pocket_tts/config/dutch.yaml": "93689d1d848c24b77651e4ca60708cacca93bb272905918ad8194631f7bcf1d6",
    "pocket_tts/config/dutch_24l.yaml": "82aaca7d40ce41958e06f85b80e047ff04ffbcc7cfa51f60bfd7d62689524d7b",
    "pocket_tts/config/english.yaml": "1b06236b6a4405a4010c731da097745c23d3d5c543e712e31086b6293fd1124a",
    "pocket_tts/config/english_2026-01.yaml": "3a4ebb5d01aa544353765876ea1b0122c3a9904c127fd9c3eeaa55942c6b8f79",
    "pocket_tts/config/english_2026-04.yaml": "9bb565cc15a79e9f2991c7f74da1cd9b8bcc07828d1b3b96f7f675a456625416",
    "pocket_tts/config/english_2026-04_24l.yaml": "14c7913e797a5b92e7b9591749fa089ad697cf92b9fc315f0b90d84634086b29",
    "pocket_tts/config/english_2026-09.yaml": "c3f0f611f4c9db070b9fcb7e5f757756d659fb8b2c8c074669f7a0bedb5d348a",
    "pocket_tts/config/english_2026-09_24l.yaml": "5058e2d76440fbd04fbac2eb71089ba1a547e91c62f42ebeee204cf83f656c9a",
    "pocket_tts/config/english_drifting_26-09.yaml": "dcca37f1c6700227286672d1230355d3811b6d8e7b878e842d6b35da0e965e70",
    "pocket_tts/config/french.yaml": "d55e3070953b837d3c4d03885d22b7a8b6373fcdef03ce76750977d9715e1ac2",
    "pocket_tts/config/french_24l.yaml": "44c75ad5bcc01d69a837281d8a7b3aa5c81641b6db1ea0c4683da4c6fe4a1189",
    "pocket_tts/config/german.yaml": "ff9be552a8cc4de0e07bcf63f96ab48e4033004810aa25d9bc77b8df0390c1ba",
    "pocket_tts/config/german_24l.yaml": "201691c48ee11b3eb7368c9d14b458ce0e60b449fb36f86c50f128f359be0a9c",
    "pocket_tts/config/italian.yaml": "2f411f76c9284de81cfa86ce6c3137a3aec0949e9af5c9da8cbdd97c775f5246",
    "pocket_tts/config/italian_24l.yaml": "65907467f00715a98d26ebca6f942b0b900d130955647aa9beddd39c29f41ded",
    "pocket_tts/config/portuguese.yaml": "db6696f8aadffa9a89b884a27af89c96248a0b616cb9672c598f1b5e0c946fcc",
    "pocket_tts/config/portuguese_24l.yaml": "938249c37a69320ce647a108c642902b968de498d652180c513f214b6525b904",
    "pocket_tts/config/spanish.yaml": "c103c57c5ec262eb5d420150e41c17b3dd860c3e123ae77ceaac81e54334fff2",
    "pocket_tts/config/spanish_24l.yaml": "9a91d64ba9df99ab3ec0aec429742800318ddeb89dae283367494062c9111d53",
    "pocket_tts/data/__init__.py": "b33c565d305c647e7b793b5fadde562d367d4d6391fae060a4e3a48c58241e22",
    "pocket_tts/data/audio.py": "3e5048f0210f46486661055768f9078f388e465914752cbf7f9971fe968668f5",
    "pocket_tts/data/audio_utils.py": "674612bc7d87f06ed4ce03b31e579c60c4f9e0d68d213d91c74f1c6e60f6fde2",
    "pocket_tts/default_parameters.py": "374f50d10d9c257a70a464e385a903f9ac7a1b588a4631f22bed5622f376ee38",
    "pocket_tts/main.py": "ca9c7feb61156255fac64853436857824abb0fb37a410489daee7991ee45ffa8",
    "pocket_tts/models/__init__.py": "df3b7c0022c1c321fa8bec3c9e41d774a06e89c6b65b696ae57b0da74bcfc45d",
    "pocket_tts/models/flow_lm.py": "c4595225b0f81dc30df0b3ef77c1bcee954357452f4ec1c38abf57ccb3f71119",
    "pocket_tts/models/mimi.py": "93996a84525e41fb204a53f1edd72abdf5925f6bb8f92304e87d29c7a431054b",
    "pocket_tts/models/model_state.py": "b55655e887e83ff529cfbccf748d94a23cfa8f6e4917fc96c4cfe403abde8848",
    "pocket_tts/models/text_chunking.py": "215a78549b527495206b93e0941449a8ffb30be1bcf6aa311f5de8ea0d8716d3",
    "pocket_tts/models/tts_model.py": "6ae39e7d7510f59062e9d3e88d20620c0bf399fe3cd690ba9f767ecee2dc2514",
    "pocket_tts/modules/__init__.py": "d0fbd8a39faf4b638af992577f89a26f1d29feb865ac98ceec97ff7ef756bfeb",
    "pocket_tts/modules/attention.py": "4b1763c527e6bb87c4152c7f17f5aa30a88164f1ed11136110539a53d0dbd296",
    "pocket_tts/modules/conv.py": "9fdeb902936ac3e7d0e0abaf2bffdceb7b1e1632804c36b4120e6bad0840faa1",
    "pocket_tts/modules/dummy_quantizer.py": "68a5a957e69df72a56aa82727a112ec7c913456fa961733e35adceb1f290133f",
    "pocket_tts/modules/layer_scale.py": "72178214ab7fe7a112cfa4797b5bd6c10a377f65e928ee043d422495c17e1ff2",
    "pocket_tts/modules/mlp.py": "75e1ad41092095256c37417c96c76ac8e1d886d00bfee1be32732107867723db",
    "pocket_tts/modules/resample.py": "463ee64b0fadc88d8755316aed9f9037864c5d3d294c0223c150ac6cc8173771",
    "pocket_tts/modules/rope.py": "0cf8cac4b5ef0bbb6e025f04d77af627528a8adad69a0792a17a193693ddcbce",
    "pocket_tts/modules/seanet.py": "17cfd00617f8aae225b699c3d66d3bfd463fa717090edb97498936bbdf5080d8",
    "pocket_tts/modules/stateful_module.py": "2b111910ea55bc39b5810ad95167404d3face9e586d94e7917b8f6cedb3b0836",
    "pocket_tts/modules/text_conditioner.py": "d3f3de0f7eb9f400ed7bd484981f6682a3690c09ea9e8c25ebb6d88564ce18ac",
    "pocket_tts/modules/transformer.py": "c9543c9abb4a6f76173942696d6add83cfc4539000140bb9d6e1238fa0cc96ea",
    "pocket_tts/quantization.py": "26de1880c00930f912b3a5708d03e2cb0a5154c588da7c9ed9d2e79b6b75c102",
    "pocket_tts/static/index.html": "c322568e1ec8c97eba33a216a7afd14b7a6b11e5e506364430198a81a52a6996",
    "pocket_tts/utils/__init__.py": "08035263cbc6abfeaff2b5a159121d9e4f96a392c0d91f568e0d67a9b5aa2cec",
    "pocket_tts/utils/config.py": "b4c2f71b2cfc7971a791ba6b0df3f9c97829471efa9ef3b6204d31025aa637c3",
    "pocket_tts/utils/debugging.py": "75d02ec5775cb8b55f422a67123d787f990ff0a9cc37e78934392fc47f05507f",
    "pocket_tts/utils/logging_utils.py": "d547b25a07335f230dbdc55c00e1870635cd5bbee4915edb810f50ee29f623c4",
    "pocket_tts/utils/utils.py": "c528edd447685d25a7089f4603bb10e1c5b54dbd3d01d8eec6fc5c52db625b63",
    "pocket_tts/utils/weights_loading.py": "e1b38ba05f23a0b4581c6711dfa4715725398451eaaf26ff15a0c541639f54bf",
    "pyproject.toml": "93fb22a52332da4d6d6edfccb00c3d42a7fdea5c91b18786cbfe1fd6a099ef00",
    "scripts/evaluate_quantization.py": "01e1f71802af71dafabcd476eebf8b2ab20d142bfae57da71e185dc3c06430cd",
    "scripts/generate_default_voices.py": "336bc0d4397b36334455762d1bdab7e1e5b689b2d4760dff32075e300d30d9c5",
    "swarm-config.yaml": "a22a7723976e2d5fad1e1eddbf73160b3affaa537bb90b192f1afc217a676d0e",
    "tests/conftest.py": "6e93c694c5af515df2630ae2376e63380f83c65c8a085003fe085b036567168b",
    "tests/test_audio.py": "8dae99780ecef3dd1438c9ae9717edb52157ba2d31f5d3afb4bd3c7223201bd6",
    "tests/test_cli_generate.py": "c4414c7425153387abad0440e7dbcd0ce684d0b7bb03d33305a6dfd39b634b65",
    "tests/test_documentation_examples.py": "8df8697fc1d58eddbf79453118247b0acefca87dd4c5b9462aae283b53ff0c03",
    "tests/test_end_on_pause.py": "91226cc688dc77d2d65fd119f2aba0494e7afd55be8cc6c0e05699d4efcac13f",
    "tests/test_generation_regressions.py": "64e15b5d593f8d2897648c80a3a666d180e780ff7c53d19fbb859bcdd126ca16",
    "tests/test_python_api.py": "a65a1fae087e079f14ca0a885c20342051b741cc508082b1edd6171824fb20d9",
    "tests/test_quantization.py": "4948e731eb0016fbd4f4603fc8ef96da4d53932d0a24ad118dab6a50b920583a",
    "tests/test_serve_default_voice.py": "1445e68abd4b56d7e4343f87606ab87dc7bff2931658cb3319e90ce5b054219c",
    "tests/test_split_sentences.py": "8d83bdbd2490dd9a46bc9ce7f3d75d50812e19ca9ac153c30cf36f092441f3a6",
    "tests/test_streaming_cancellation.py": "ef784e4a53bf5fa48ac037a8c51766f68f73b16f38dfe1a7e390f06b13e096bb",
    "tests/test_tokenizer_backends.py": "1b00fce7ee295b567ffa1bab40c26642addac9de11f401a844ecad5134830340",
    "tests/test_utils.py": "949c8a882aeb34a94214411d81b6e8192eb49eee71a55166117aafcc9f7d8a43",
    "training/README.md": "55c557b1212cf69d99e019b6ea91509b10c1391cf55116728127f30d29b37653",
    "training/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "training/args.py": "230c76f6d26bdaf0e5543b1b3a9f336e4387bd46b533d1e79c0250f1b28017d4",
    "training/checkpointing.py": "baf82836ec9c6870c024e7663da9113cb1122b05989a4708fe0e8a793a12f078",
    "training/configs/depth_distill.yaml": "a3beb070d7e8cdf80332e5c9f5e8ae08cb3fa7bca9d4261f15867b4e004e8a03",
    "training/configs/drifting.yaml": "1195e43b25677fa512a04845e74c7a92a6577b172b8e91f4a924afe58178e95f",
    "training/configs/finetune.yaml": "486303b990b87444dde468664391b153465ce8db71abc79522394c9ea3e04dd2",
    "training/configs/finetune_language.yaml": "5b970d64784fa42ed65444fa1875d123a12c0ecb2ada667a9523bc3b2ffae882",
    "training/configs/scratch.yaml": "3af44798bf6cca42f7f88a382c7453c63c44a860ea812915fc63daab827c4b09",
    "training/dataloader/__init__.py": "c1f259c89a6aeeb5d32fafc8d02747ebe7c89aa555636d7d4f7ac82b3a2cc73f",
    "training/dataloader/audio.py": "2cea067e55f67ad69d7c45da06f4c93baeb7eebd68ff1ea792ac4b9a8d143dbf",
    "training/dataloader/encode.py": "f52aae938ef9833eec2c05ff72d0ac101e853fdbc8a9baf15de46d84eb423d42",
    "training/dataloader/loader.py": "44ca0bc2c25b79cde4637ab081bd8389cfee6f2f414da764948fc24286352b15",
    "training/dataloader/manifest.py": "71b34ef9aaec58fa8ccb1c9b0eefbdd4293a3b04dcb0b0c6f8c3e6ed45f647d8",
    "training/dataloader/subproc.py": "28e3903e675b13f409189228ca91ab0f7afd7b0a615bd38c3e2df06efa3dadbc",
    "training/dataloader/types.py": "d20fd9b6c923b8230ad90c2f68ec3a95f0ea985cdb8b0c991d1f87e53dce65a6",
    "training/distributed.py": "9409d89a9d888a023c1c5370d25bb7773e3d8b2aa71aa4b18e6cc4dc14940fb2",
    "training/eval/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "training/eval/librispeech.py": "fb34ba81a4c74d149a3122092d76c5766f6fcc6e20c9bb7a1b97cc135b04f1b9",
    "training/modules/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "training/modules/builders.py": "b05ddba05ad361b25056d075a3bee13cbfdcf0d60b7adabc2996bd9f562c4a81",
    "training/modules/conditioner.py": "e471dee5b85cbc2a4c409093303eaf17ff081e95c0e04e159d0e1ca6062ace64",
    "training/modules/model.py": "57c93cc9c1906d7bca2ff8901f59832520c2ca2f937b08fccab81660dc86d009",
    "training/modules/muon.py": "7937b8028daf2e9f7d257b80b274d6780b595aecd7dfdcd8e8ee7dd6b57d84f0",
    "training/modules/samplers.py": "ac0de80a260eaa8888fc845bcd1285f6ad592ad179e9ca291e1ea5cc4cf593d5",
    "training/modules/utils.py": "24aa2138983d00f005feff762a583cc34bf4207f039c3033c94e17e48666990c",
    "training/scripts/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "training/scripts/align_data.py": "09be2f4408ab6e543e45cc5cace3b5c3842f0a03910db52758f05c842fe8c912",
    "training/scripts/convert_tokenizer.py": "a2c0b4411aebdc34f686d7cff31687e4ce3b0a7e9343a7f6560c8ad17b9f84d0",
    "training/scripts/precompute_latents.py": "33c45dcdec7c8536b7055d1ccc2d95fe323f260d7172f18140ba9432b64644dd",
    "training/scripts/prepare_data.py": "60edb85d128142b7e7d4bc968d524da15993dc35e23d44661f2907313e9f3241",
    "training/scripts/shrink_checkpoint.py": "3526505dd4920851c7ffa9091b6ced69f913eb99e43cb73a68977dabd6241831",
    "training/scripts/train_tokenizer.py": "9550374326e699ce8eb9ae80f1c8da38d173abd32d343dda971c05fd175a47e2",
    "training/tests/test_config_invariants.py": "37f152ec68208d49a52a469f46e2955f17c730727f7020a8f007296c57855902",
    "training/tests/test_dataloader.py": "198d9f52c69902fe6659aafd7ad987afa2d917a3fad92feb4fb2e516467d69d0",
    "training/tests/test_eval_naming.py": "09f6baf42d967fa493ba7550e3e59953d0a471eb6c2899bc7b3426b5c9548daa",
    "training/tests/test_loader_signals.py": "ea2751ad3d69781eba1abace8d944ef31a752471a79c7da31e6edea6847f2ba6",
    "training/tests/test_muon.py": "2103fb42527593e8c2d4d4b8bbfb182b78d34835f94f8bafb46a52ddc9ddcbdb",
    "training/tests/test_prepare_data.py": "37e2b576df8697f1ed29cea1df5f7afa8247e400d6278522b544442f2f8eb1a6",
    "training/tests/test_smoke.py": "0ae3b8b19e96e1d5b62179407f66ffa4b66e79d6caab61f355cc8a7dbb813106",
    "training/tests/test_units.py": "cdf65268930792c3da79b27282754d1a74d29a04cb1a1da0b1d66f4d06075a0d",
    "training/train.py": "726f4c9ea7f1bb984e32c892ab01191cdd9370515d8a533d473e34677d3ee475",
    "training/train_utils.py": "01d38117352ed217d35d8b11b0a7d230d9b98e38435da87cde9a8cbe55168806",
    "uv.lock": "da94e6b333f2e7234780ab773caa51bde559e17e187a8daafbc0c05a1370a587",
}
# END POCKET SOURCE MANIFEST
# A pinned file only matters to what runs when it is Python or lives in the pocket_tts package (code, model configs, the page it serves); a
# changed README, test, notebook or picture in the pinned tree is reported in the log but never stops the voice.
SOURCE_RUNS_PREFIX = "pocket_tts/"
SOURCE_RUNS_SUFFIXES = (".py", ".pyd", ".pyc")
# The Runtime ships the pocket_tts/ package and the licence only (the upstream tests, training code, docs, Docker and CI files stay out:
# packaging/lib/runtime-prune.mjs, which must name the same files). The check below looks at those; the other pinned files still count in the
# digest above, so the pin is still the whole revision. A copy that has the extra files (a development checkout, an older Runtime) is not
# looked at beyond them.
SOURCE_SHIPPED_PREFIX = "pocket_tts/"
SOURCE_SHIPPED_FILES = ("LICENSE",)
# Text files whose line endings a tool may have converted (a zip made with CRLF conversion); the same bytes with LF endings count as unchanged.
SOURCE_TEXT_SUFFIXES = (".py", ".yaml", ".yml", ".json", ".toml", ".md", ".txt", ".html", ".sh", ".hcl", ".ipynb", ".lock")
SOURCE_NAMED_LIMIT = 3
ASSETS = {"model.safetensors": "sha256", "inference.yaml": "configSha256",
          "tokenizer.json": "tokenizerSha256", "receipt.json": "receiptSha256"}
MAX_TEXT = 12_000
MAX_AUDIO_SECONDS = 120
MAX_CACHED_PROFILES = 8
MAX_PROFILES = 1024
MAX_COMMAND_BYTES = 65_536
MAX_REFERENCE_BYTES = 24_000_000
# A player's own clip for a character (docs/CHARACTER_EDITOR.md) lives in the player's data folder, never beside the shipped references:
# its descriptor names this second, fixed namespace, and it resolves only inside runtime.playerVoiceDirectory (never a general path).
REFERENCE_PREFIX = "runtime/voice-references/"
PLAYER_PREFIX = "runtime/player-voices/"
PLAYER_REFERENCE = re.compile(r"runtime/player-voices/[a-z0-9][a-z0-9-]{0,79}\.wav")


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def digest_source(root):
    root = Path(root)
    paths = sorted((path for path in root.rglob("*") if path.is_file()
                    and not set(path.relative_to(root).parts) & SOURCE_IGNORES),
                   key=lambda path: path.relative_to(root).as_posix())
    digest = hashlib.sha256()
    for path in paths:
        if path.is_symlink():
            raise ValueError("Pocket source must contain ordinary local files")
        digest.update(path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        digest.update(bytes.fromhex(digest_file(path)) + b"\n")
    return digest.hexdigest()



def digest_manifest(files=None):
    """The digest of a path -> file-hash list, in the order and form digest_source() uses (path, NUL, raw hash, newline)."""
    digest = hashlib.sha256()
    for rel, file_hash in sorted((SOURCE_FILES if files is None else files).items()):
        digest.update(rel.encode("utf-8") + b"\0" + bytes.fromhex(file_hash) + b"\n")
    return digest.hexdigest()


def source_file_matches(path, expected):
    """True when the file is the pinned bytes, or the pinned text with only its line endings converted to CRLF."""
    digest = digest_file(path)
    if digest == expected:
        return True
    if path.suffix.lower() in SOURCE_TEXT_SUFFIXES and path.stat().st_size <= 4_000_000:
        return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest() == expected
    return False


def source_runs(rel):
    return rel.startswith(SOURCE_RUNS_PREFIX) or rel.lower().endswith(SOURCE_RUNS_SUFFIXES)


def source_shipped(rel):
    """True for a file of the pinned revision that the Runtime ships (the package and the licence)."""
    return rel.startswith(SOURCE_SHIPPED_PREFIX) or rel in SOURCE_SHIPPED_FILES


def source_differences(root, files=None):
    """(critical, other): the pinned files that are missing, changed or linked under `root`, as [(relative path, "missing"|"changed"|"linked")].
    Files that are not in the pinned list are never looked at, so a marker, a backup or a leftover beside the source cannot fail it. With no
    `files` the list is the pinned revision's files that the Runtime ships (source_shipped()); a list that is passed in is checked whole."""
    root = Path(root)
    critical, other = [], []
    wanted = {rel: expected for rel, expected in SOURCE_FILES.items() if source_shipped(rel)} if files is None else files
    for rel, expected in sorted(wanted.items()):
        path = root.joinpath(*rel.split("/"))
        try:
            if path.is_symlink():
                state = "linked"
            elif not path.is_file():
                state = "missing"
            else:
                state = None if source_file_matches(path, expected) else "changed"
        except OSError:
            state = "missing"
        if state:
            (critical if source_runs(rel) else other).append((rel, state))
    return critical, other


def describe_differences(differences, limit=SOURCE_NAMED_LIMIT):
    """First few relative paths with what is wrong with each, on one line: "a.py changed, b.py missing, +2 more"."""
    named = [f"{rel} {state}" for rel, state in differences[:limit]]
    if len(differences) > limit:
        named.append(f"+{len(differences) - limit} more")
    return ", ".join(named)


def verify_source(root, files=None):
    """Checks that the pinned code is what is under `root`. Raises ValueError naming the first differing files when a pinned Python file or a
    pocket_tts file is missing, changed or linked; returns a note (or None) about pinned files that differ but are not code that runs."""
    if files is None and digest_manifest() != SOURCE_SHA256:
        raise ValueError("Pocket source list does not match its pinned digest")
    critical, other = source_differences(root, files)
    if critical:
        raise ValueError(f"Pocket source differs from the pinned official revision ({describe_differences(critical)})")
    return f"Pocket source: {describe_differences(other, 8)} (not code that runs, so the voice starts)" if other else None


def read_json(path, maximum=1_000_000):
    path = Path(path)
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError("Pocket configuration/receipt is missing or oversized")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


# Mod Organizer 2 runs the game, and every process it starts, inside USVFS (a virtual file system). The service sets this variable to "1" in every
# process it starts there (packaging/runtime/usvfs-compat.mjs). A folder of the app is then the merge of several mod folders, and Path.resolve() of a file
# in it answers with the real place of that one file: the mod that holds it, which is rarely the mod that resolve() of the folder named. Comparing
# resolved paths therefore refuses a file that is plainly inside its folder. Under USVFS the paths are compared as they are spelled instead
# (absolute, normalised, never resolved), and every component of the path is still refused when it is a symlink or junction, so a link planted in the
# app folder still cannot redirect the worker. The bytes read are the real files either way, and their hashes are checked against the pinned list.
USVFS_VARIABLE = "CYBERPUNK_CONVAI_USVFS"


def usvfs_active(environ=None):
    return (os.environ if environ is None else environ).get(USVFS_VARIABLE) == "1"


def is_linked(path):
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def spelled_inside(path, root):
    """True when `path` is `root` or below it as spelled (absolute, `..` collapsed, case folded on Windows), without resolving either."""
    path, root = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(root))
    return path == root or path.startswith(root.rstrip("\\/") + os.sep)


def plain_absolute(value, label):
    if (not isinstance(value, str) or not value or value != value.strip()
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError(f"Pocket {label} must be an absolute local path")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"Pocket {label} must be an absolute local path")
    # Check ancestors too: a symlink/junction must not mix one export with
    # another owner's references or move writes into an immutable asset tree.
    for candidate in (path, *path.parents):
        if is_linked(candidate):
            raise ValueError(f"Pocket {label} must not use linked directories")
    # Inside USVFS the path stays as spelled: its resolved form is only where one mod happens to hold it (see above).
    return Path(os.path.abspath(path)) if usvfs_active() else path.resolve()


def local_asset(root, name):
    usvfs = usvfs_active()
    root = Path(os.path.abspath(root)) if usvfs else Path(root).resolve()
    path = root / name
    # Inside USVFS the file is looked at where the virtual folder shows it; it is refused when it is linked (or left the folder by spelling).
    inside = spelled_inside(path, root) if usvfs else path.resolve().is_relative_to(root)
    if is_linked(path) or not path.is_file() or not inside:
        raise ValueError("Pocket export asset is missing or linked")
    return path


def text_valid(value):
    return (isinstance(value, str) and 0 < len(value.strip()) <= MAX_TEXT
            and not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value))


def profile_key_valid(value):
    return (isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", value)
            and value not in {"constructor", "prototype", "__proto__"})


def player_reference(reference):
    return isinstance(reference, str) and reference.startswith(PLAYER_PREFIX)


def descriptor_valid(descriptor):
    reference = descriptor.get("reference") if isinstance(descriptor, dict) else None
    return (isinstance(reference, str) and len(reference) <= 512
            and (reference.startswith(REFERENCE_PREFIX) or PLAYER_REFERENCE.fullmatch(reference) is not None)
            and reference.endswith(".wav")
            and not re.search(r"[\\\x00-\x1f\x7f:]", reference)
            and not any(part in ("", ".", "..") for part in reference.split("/"))
            and sha(descriptor.get("sha256")) and text_valid(descriptor.get("transcript")))


def inspect_reference(path):
    """Read WAV structure without resampling/normalizing the source recording."""
    path = Path(path)
    if path.stat().st_size > MAX_REFERENCE_BYTES:
        raise ValueError("Pocket reference is oversized")
    with path.open("rb") as stream:
        header = stream.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            raise ValueError("Pocket reference must be a RIFF WAV")
        remaining = struct.unpack_from("<I", header, 4)[0] - 4
        if remaining < 0 or remaining + 12 != path.stat().st_size:
            raise ValueError("Pocket reference has an invalid RIFF size")
        fmt = None
        data_size = None
        while remaining:
            chunk = stream.read(8)
            if len(chunk) != 8:
                raise ValueError("Pocket reference has a truncated chunk")
            name, size = chunk[:4], struct.unpack_from("<I", chunk, 4)[0]
            length = size + (size % 2)
            if length + 8 > remaining:
                raise ValueError("Pocket reference chunk exceeds its file")
            if name == b"fmt ":
                if fmt is not None or size < 16 or size > 4096:
                    raise ValueError("Pocket reference has an invalid format")
                raw = stream.read(length)
                fmt = struct.unpack_from("<HHIIHH", raw)
            else:
                if name == b"data":
                    if data_size is not None:
                        raise ValueError("Pocket reference has duplicate audio")
                    data_size = size
                stream.seek(length, 1)
            remaining -= 8 + length
    if fmt is None or data_size is None:
        raise ValueError("Pocket reference lacks PCM audio")
    codec, channels, rate, byte_rate, align, bits = fmt
    if (codec not in (1, 3) or channels not in (1, 2) or not 8000 <= rate <= 96000
            or bits not in (16, 24, 32) or (codec == 3 and bits != 32)
            or align != channels * bits // 8 or byte_rate != rate * align
            or data_size <= 0 or data_size % align):
        raise ValueError("Pocket reference has an unsupported PCM format")
    duration = data_size / (rate * align)
    if not .1 <= duration <= 30:
        raise ValueError("Pocket reference must contain 0.1 to 30 seconds")
    return {"sampleRate": rate, "channels": channels, "duration": duration}


def validate_profile(root, descriptor, player_root=None):
    """The file a descriptor names, checked. A player reference resolves ONLY inside `player_root` (a profile without one is unavailable)."""
    if not descriptor_valid(descriptor):
        raise ValueError("Invalid Pocket reference descriptor")
    reference = descriptor["reference"]
    if player_reference(reference):
        if player_root is None:
            raise ValueError("Pocket reference is unavailable")
        root, prefix = Path(player_root), PLAYER_PREFIX
    else:
        prefix = REFERENCE_PREFIX
    # The configured root replaces only the established reference (or player) directory;
    # the descriptor never chooses a general filesystem path.
    tail = PurePosixPath(reference).relative_to(prefix.rstrip("/"))
    path = Path(root).joinpath(*tail.parts)
    resolved = plain_absolute(str(path), "reference")
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError("Pocket reference is unavailable")
    if digest_file(resolved) != descriptor["sha256"]:
        raise ValueError("Pocket reference identity changed")
    inspect_reference(resolved)
    return resolved


def resolve_reference(paths, descriptor):
    """Every lookup of a reference file (configuration and the later preparation) goes through here, so both use the same roots."""
    return validate_profile(paths["referenceDirectory"], descriptor, paths.get("playerVoiceDirectory"))


def inspect_student_export(directory, expected, *, yaml_load=None):
    """Verify the selected six-layer export before importing any neural code."""
    if not isinstance(expected, dict) or any(not sha(expected.get(field)) for field in ASSETS.values()):
        raise ValueError("Pocket needs hashes for every export asset")
    if not sha(expected.get("inputIdentity")) or type(expected.get("selectedStep")) is not int or expected["selectedStep"] <= 0:
        raise ValueError("Pocket needs the selected training identity")
    assets = {name: local_asset(directory, name) for name in ASSETS}
    for name, field in ASSETS.items():
        if digest_file(assets[name]) != expected[field]:
            raise ValueError("Pocket export asset differs from its selected identity")
    receipt = read_json(assets["receipt.json"])
    if (not isinstance(receipt, dict) or receipt.get("source_revision") != SOURCE_REVISION
            or receipt.get("weights") not in ("ema", "raw") or receipt.get("sample_cfg") != 1.0
            or receipt.get("selected_step") != expected["selectedStep"]
            or receipt.get("input_identity") != expected["inputIdentity"]
            or receipt.get("model_sha256") != expected["sha256"]):
        raise ValueError("Pocket receipt does not identify the selected student export")
    return checked_config(assets, yaml_load)


def checked_config(assets, yaml_load=None):
    """The YAML of a six-layer CPU export, checked and relocated to the export's own files (a private copy: the downloaded file is never changed)."""
    config_path = assets["inference.yaml"]
    if config_path.stat().st_size > 65_536:
        raise ValueError("Pocket inference config is oversized")
    if yaml_load is None:
        from yaml import safe_load
        yaml_load = safe_load
    config = yaml_load(config_path.read_text(encoding="utf-8-sig"))
    try:
        flow, mimi = config["flow_lm"], config["mimi"]
        if (flow["transformer"]["num_layers"] != 6 or flow["dtype"] != "float32"
                or mimi["dtype"] != "float32" or mimi["sample_rate"] != 24000 or mimi["channels"] != 1):
            raise ValueError("Pocket runtime accepts only the CPU six-layer student")
    except (KeyError, TypeError) as error:
        raise ValueError("Pocket inference config is incomplete") from error
    # The upstream loader resolves YAML paths from CWD. Make a private copy;
    # never mutate downloaded configs/receipts or load another remote asset.
    config = copy.deepcopy(config)
    config["weights_path"] = str(assets["model.safetensors"])
    config["weights_path_without_voice_cloning"] = None
    config["flow_lm"]["weights_path"] = None
    config["mimi"]["weights_path"] = None
    config["flow_lm"]["lookup_table"]["tokenizer_path"] = str(assets["tokenizer.json"])
    return config


# ---- language models (docs/POCKET_LANGUAGE_MODELS.md) ----------------------------------------------------------------------------
# A PocketTTS model is a folder <referenceDirectory>/multilingual-pocket/<language>/ (model.safetensors, tokenizer.json, inference.yaml) the bridge has
# checked; the worker checks the files against the hashes the bridge sends before it loads them, and a language's voices are clips of the multilingual pack of
# the same language (<referenceDirectory>/multilingual/<language>/), named like every other reference.
LANGUAGE_FOLDER = "multilingual-pocket"
LANGUAGES = ("fr", "it", "de", "es-es", "pt-br")
LANGUAGE_ASSETS = {"model.safetensors": "sha256", "inference.yaml": "configSha256", "tokenizer.json": "tokenizerSha256"}


def language_valid(value):
    return isinstance(value, str) and value in LANGUAGES


def language_prefix(language):
    return f"{REFERENCE_PREFIX}multilingual/{language}/"


VERIFIED_ASSETS = {}


def digest_known_file(path):
    """digest_file, remembered for a file that has not changed (same path, size and modification time): swapping back to a language model that was read a
    moment ago does not read its 219 MB again. The remembered answers are few (three files per language) and only ever a hash this process computed itself."""
    try:
        status = Path(path).stat()
        stamp = (str(path), status.st_size, status.st_mtime_ns)
    except OSError:
        return digest_file(path)
    if stamp not in VERIFIED_ASSETS:
        if len(VERIFIED_ASSETS) >= 64:
            VERIFIED_ASSETS.clear()
        VERIFIED_ASSETS[stamp] = digest_file(path)
    return VERIFIED_ASSETS[stamp]


def inspect_language_export(paths, language, expected, *, yaml_load=None):
    """Verify one language model before any of it is loaded. Returns the relocated config. `expected` has the three SHA-256 values."""
    if not language_valid(language):
        raise ValueError("Pocket has no model for this language")
    if not isinstance(expected, dict) or any(not sha(expected.get(field)) for field in LANGUAGE_ASSETS.values()):
        raise ValueError("Pocket needs hashes for every language model asset")
    root = plain_absolute(str(Path(paths["referenceDirectory"]) / LANGUAGE_FOLDER / language), "language model directory")
    if not root.is_dir() or not root.is_relative_to(paths["referenceDirectory"]):
        raise ValueError("PocketTTS model is missing")
    assets = {name: local_asset(root, name) for name in LANGUAGE_ASSETS}
    for name, field in LANGUAGE_ASSETS.items():
        if digest_known_file(assets[name]) != expected[field]:
            raise ValueError("PocketTTS model asset differs from its identity")
    return checked_config(assets, yaml_load)


def new_language_registry(registry, language, model_sha256):
    """The registry of a language: the same folders and limits as the English one, and only the voices that were asked for."""
    return {"raw": {"model": {"sha256": model_sha256}, "language": language}, "paths": registry["paths"], "refs": {}, "descriptors": {},
            "unavailable": {}, "threads": registry["threads"], "temperature": registry["temperature"], "startup": [],
            "cacheLimit": registry["cacheLimit"], "language": language}


def add_language_voices(registry, voices, cache=None):
    """Adds voices (descriptors) to a language registry. A descriptor names a clip of this language's voice pack, or the player's own clip. All checked before any is added.
    A voice whose clip changed leaves the prepared-state cache (and the saved setup of its old clip), so the next reply prepares it from the new clip. Returns the changed keys."""
    if not isinstance(voices, dict) or len(voices) > MAX_VOICE_CHANGES or len(registry["descriptors"]) + len(voices) > MAX_PROFILES:
        raise ValueError("Invalid Pocket language voices")
    prefix = language_prefix(registry["language"])
    checked = {}
    for key, descriptor in voices.items():
        if not profile_key_valid(key) or not descriptor_valid(descriptor):
            raise ValueError("Invalid Pocket reference descriptor")
        if not (descriptor["reference"].startswith(prefix) or player_reference(descriptor["reference"])):
            raise ValueError("Pocket language voices come from the voice pack of their language")
        try:
            checked[key] = (dict(descriptor), resolve_reference(registry["paths"], descriptor))
        except ValueError:
            checked[key] = (dict(descriptor), None)
    changed = []
    for key, (descriptor, path) in checked.items():
        old = registry["descriptors"].get(key)
        registry["descriptors"][key] = descriptor
        registry["refs"].pop(key, None)
        registry["unavailable"].pop(key, None)
        if path is not None:
            registry["refs"][key] = path
        else:
            registry["unavailable"][key] = "unavailable"
        if old is None or old["sha256"] != descriptor["sha256"]:
            changed.append(key)
            if cache is not None:
                cache.forget(key, old["sha256"] if old else None)
    return changed


def checked_player_directory(value, paths):
    """The player's own clips (optional): a folder of the player's data. It may be missing (those profiles are then unavailable), but it
    must not overlap the work folder (which the worker writes) nor any shipped asset, so a clip never resolves through either."""
    player = plain_absolute(value, "playerVoiceDirectory")
    if any(player.is_relative_to(other) or other.is_relative_to(player)
           for other in (paths["workDirectory"], paths["sourceDirectory"], paths["exportDirectory"], paths["referenceDirectory"])):
        raise ValueError("Pocket player voices must be separate from the work folder and the shipped assets")
    return player


def validate_config(raw, *, yaml_load=None, source_hasher=None):
    if (not isinstance(raw, dict) or type(raw.get("version")) is not int or raw.get("version") != 1
            or raw.get("engine") != "pocket-tts" or raw.get("provider") != "pocket"):
        raise ValueError("Expected a Pocket student runtime configuration")
    runtime = raw.get("runtime", {})
    paths = {key: plain_absolute(runtime.get(key), key) for key in
             ("sourceDirectory", "exportDirectory", "referenceDirectory", "workDirectory")}
    if (not paths["sourceDirectory"].is_dir() or not paths["exportDirectory"].is_dir()
            or not paths["referenceDirectory"].is_dir()):
        raise ValueError("Pocket runtime assets are missing")
    work = paths["workDirectory"]
    if any(work.is_relative_to(paths[key]) or paths[key].is_relative_to(work)
           for key in ("sourceDirectory", "exportDirectory", "referenceDirectory")):
        raise ValueError("Pocket work and immutable assets must remain separate")
    # The player's own clips (optional): a folder of the player's data. It may be missing (those profiles are then unavailable), but it
    # must not overlap the work folder (which the worker writes) nor any shipped asset, so a clip never resolves through either.
    if runtime.get("playerVoiceDirectory") is not None:
        paths["playerVoiceDirectory"] = checked_player_directory(runtime.get("playerVoiceDirectory"), paths)
    # source_hasher is a test seam (a replacement tree digest); the shipped check is verify_source().
    source_note = None
    if source_hasher is not None:
        if source_hasher(paths["sourceDirectory"]) != SOURCE_SHA256:
            raise ValueError("Pocket source differs from the pinned official revision")
    else:
        source_note = verify_source(paths["sourceDirectory"])
    cpu = raw.get("cpu", {})
    threads = cpu.get("threads", 2)
    if type(threads) is not int or not 1 <= threads <= 4:
        raise ValueError("Pocket CPU threads must be between one and four")
    sampling = raw.get("sampling", {})
    temperature = sampling.get("temperature", .3)
    if (type(temperature) not in (int, float) or not math.isfinite(temperature)
            or not .1 <= temperature <= 1 or type(sampling.get("decodeSteps", 1)) is not int
            or sampling.get("decodeSteps", 1) != 1):
        raise ValueError("Pocket student requires one sampler step and a valid temperature")
    inference = inspect_student_export(paths["exportDirectory"], raw.get("model"), yaml_load=yaml_load)
    voices = raw.get("voices", {})
    if not isinstance(voices, dict) or len(voices) > MAX_PROFILES:
        raise ValueError("Invalid Pocket voice registry")
    refs, unavailable, descriptors = {}, {}, {}
    for key, descriptor in voices.items():
        if not profile_key_valid(key) or not isinstance(descriptor, dict):
            raise ValueError("Invalid Pocket voice profile")
        status = descriptor.get("status", "ready")
        if status not in ("ready", "unprepared", "unavailable"):
            raise ValueError("Invalid Pocket voice profile status")
        if status != "ready":
            unavailable[key] = status
            continue
        # Malformed descriptors fail configuration. A disappeared or changed
        # actual recording instead withdraws that exact profile from routing.
        if not descriptor_valid(descriptor):
            raise ValueError("Invalid Pocket reference descriptor")
        descriptors[key] = dict(descriptor)
        try:
            refs[key] = resolve_reference(paths, descriptor)
        except ValueError:
            unavailable[key] = "unavailable"
    preparation = raw.get("preparation", {})
    startup = preparation.get("startupProfiles", [])
    limit = preparation.get("maxCachedProfiles", MAX_CACHED_PROFILES)
    if (not isinstance(startup, list) or len(startup) > 3 or len(set(startup)) != len(startup)
            or any(key not in descriptors for key in startup) or type(limit) is not int
            or not 1 <= limit <= MAX_CACHED_PROFILES or len(startup) > limit):
        raise ValueError("Invalid Pocket reference cache policy")
    return {"raw": raw, "paths": paths, "inference": inference, "refs": refs,
            "descriptors": descriptors, "unavailable": unavailable, "threads": threads,
            "temperature": temperature, "startup": [key for key in startup if key in refs],
            "cacheLimit": limit, "sourceNote": source_note}


MAX_VOICE_CHANGES = 24


def apply_voices(registry, change, cache=None):
    """Changes some voices of a running worker without reloading anything (a player gave a character a clip, or took it away).

    `change` is {"set": {key: descriptor}, "remove": [key, ...], "playerVoiceDirectory": absolute folder or None}. Everything is checked
    before anything changes, so a refused change leaves the registry exactly as it was. A descriptor is checked like the configuration's
    (shape, then the file and its hash through the one resolver); a file that is gone or changed withdraws only that voice. Each changed
    voice leaves the prepared-state cache (and the saved setup of a clip that is replaced or removed); no other voice is touched.
    Returns the changed keys."""
    if not isinstance(change, dict):
        raise ValueError("Invalid Pocket voice change")
    voices, removed = change.get("set", {}), change.get("remove", [])
    if (not isinstance(voices, dict) or not isinstance(removed, list) or len(voices) + len(removed) > MAX_VOICE_CHANGES
            or len(set(registry["descriptors"]) | set(registry["unavailable"]) | set(voices)) > MAX_PROFILES
            or any(not profile_key_valid(key) for key in (*voices, *removed)) or set(voices) & set(removed)):
        raise ValueError("Invalid Pocket voice change")
    paths = registry["paths"]
    folder = change.get("playerVoiceDirectory")
    if folder is not None:
        wanted = checked_player_directory(folder, paths)
        if paths.get("playerVoiceDirectory") not in (None, wanted):
            raise ValueError("Pocket player voice folder cannot change while running")
    else:
        wanted = paths.get("playerVoiceDirectory")
    checked = {}
    for key, descriptor in voices.items():
        if not isinstance(descriptor, dict):
            raise ValueError("Invalid Pocket voice profile")
        status = descriptor.get("status", "ready")
        if status not in ("ready", "unprepared", "unavailable"):
            raise ValueError("Invalid Pocket voice profile status")
        if status != "ready":
            checked[key] = (None, None, status)
            continue
        if not descriptor_valid(descriptor):
            raise ValueError("Invalid Pocket reference descriptor")
        try:
            path = resolve_reference({**paths, **({"playerVoiceDirectory": wanted} if wanted is not None else {})}, descriptor)
        except ValueError:
            path = None
        checked[key] = (dict(descriptor), path, "ready" if path is not None else "unavailable")
    if wanted is not None:
        paths["playerVoiceDirectory"] = wanted
    changed = []
    for key in removed:
        old = registry["descriptors"].pop(key, None)
        known = key in registry["refs"] or key in registry["unavailable"] or old is not None
        registry["refs"].pop(key, None)
        registry["unavailable"].pop(key, None)
        if cache is not None:
            cache.forget(key, old["sha256"] if old and player_reference(old.get("reference")) else None)
        if known:
            changed.append(key)
    for key, (descriptor, path, status) in checked.items():
        old = registry["descriptors"].get(key)
        registry["refs"].pop(key, None)
        registry["unavailable"].pop(key, None)
        registry["descriptors"].pop(key, None)
        if descriptor is not None:
            registry["descriptors"][key] = descriptor
            if path is not None:
                registry["refs"][key] = path
        if status != "ready":
            registry["unavailable"][key] = status
        if cache is not None:
            cache.forget(key, old["sha256"] if old and player_reference(old.get("reference"))
                         and (descriptor is None or old["sha256"] != descriptor["sha256"]) else None)
        changed.append(key)
    registry["startup"] = [key for key in registry["startup"] if key in registry["refs"]]
    return changed


PREPARED_FORMAT = "pocket-prepared-voice-v1"
MAX_PREPARED_FILES = 160


class PreparedVoiceStore:
    """Saved voice setups: one file per voice, keyed by voice + reference + model.

    The prepared state of a voice is a pure function of its reference audio, the student export and the pinned
    Pocket source, so a saved copy is exactly what encoding the reference again would produce, minus 0.5 to 1.4 s
    of Mimi encoding and prompting. Saving and loading are injected (the worker uses safetensors); this module
    stays free of Torch. A file that is missing, damaged or written for another identity is simply a miss.
    """
    def __init__(self, directory, model_sha256, source_sha256, save_state, load_state,
                 max_files=MAX_PREPARED_FILES):
        self.directory = Path(directory)
        self.model_sha256, self.source_sha256 = model_sha256, source_sha256
        self.save_state, self.load_state, self.max_files = save_state, load_state, max_files

    def identity(self, key, reference_sha256):
        text = json.dumps({"format": PREPARED_FORMAT, "voice": key, "reference": reference_sha256,
                           "model": self.model_sha256, "source": self.source_sha256}, sort_keys=True)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def path(self, key, reference_sha256):
        return self.directory / f"{key}-{self.identity(key, reference_sha256)[:24]}.safetensors"

    def load(self, key, reference_sha256):
        path = self.path(key, reference_sha256)
        if not path.is_file() or path.is_symlink():
            return None
        try:
            state = self.load_state(path, self.identity(key, reference_sha256))
        except Exception:
            state = None
        if state is None:
            try:
                path.unlink()
            except OSError:
                pass
            return None
        try:
            os.utime(path, None)
        except OSError:
            pass
        return state

    def save(self, key, reference_sha256, state):
        """Atomic write; never raises (a full disk must not break a reply)."""
        path = self.path(key, reference_sha256)
        temporary = path.with_name(path.name + ".tmp")
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.save_state(temporary, state, self.identity(key, reference_sha256))
            os.replace(temporary, path)
        except Exception:
            try:
                temporary.unlink()
            except OSError:
                pass
            return False
        self.prune(keep=path)
        return True

    def prune(self, keep):
        """Drop this voice's files for older references/models, then the oldest beyond the file limit."""
        try:
            files = [file for file in self.directory.glob("*.safetensors") if file.is_file()]
            prefix = keep.name.rsplit("-", 1)[0] + "-"
            for file in files:
                if file != keep and file.name.startswith(prefix) and file.name[len(prefix):-12].isalnum():
                    file.unlink()
            files = sorted((file for file in self.directory.glob("*.safetensors") if file.is_file()),
                           key=lambda file: file.stat().st_mtime)
            for file in files[:max(0, len(files) - self.max_files)]:
                file.unlink()
        except OSError:
            pass

    def forget(self, key, reference_sha256):
        """Removes the saved setup of one voice for one reference (a player's clip that was replaced or removed)."""
        for path in (self.path(key, reference_sha256), self.path(key, reference_sha256).with_suffix(".safetensors.tmp")):
            try:
                path.unlink()
            except OSError:
                pass

    def clear(self):
        removed = 0
        for file in self.directory.glob("*.safetensors*") if self.directory.is_dir() else ():
            try:
                file.unlink()
                removed += 1
            except OSError:
                pass
        return removed


class ReferenceCache:
    """One shared model with a bounded LRU of exact acoustic prompt states.

    With a PreparedVoiceStore and keep=True, a voice that is not in memory is loaded from its saved setup before
    the reference is encoded again, and a freshly encoded one is saved. `last_source` says which happened.
    """
    def __init__(self, registry, encode, now=time.perf_counter, store=None):
        self.registry, self.encode, self.now, self.store = registry, encode, now, store
        self.states = OrderedDict()
        self.last_source = "memory"

    def prepared(self):
        return list(self.states)

    def forget(self, key, reference_sha256=None):
        """This voice's prepared state leaves memory (and, for a clip the player replaced, its saved setup leaves the disk): the next
        reply prepares it again from whatever the registry now names. Other voices are not touched."""
        self.states.pop(key, None)
        if reference_sha256 and self.store is not None:
            self.store.forget(key, reference_sha256)

    def prepare(self, key, keep=False):
        if key not in self.registry["refs"]:
            raise ValueError("This character has no available Pocket voice")
        try:
            path = resolve_reference(self.registry["paths"], self.registry["descriptors"][key])
        except ValueError:
            self.states.pop(key, None)
            self.registry["refs"].pop(key, None)
            self.registry["unavailable"][key] = "unavailable"
            raise
        if key in self.states:
            self.states.move_to_end(key)
            self.last_source = "memory"
            return self.states[key], 0.0
        started = self.now()
        saving = keep and self.store is not None
        reference_sha256 = self.registry["descriptors"][key]["sha256"]
        state = self.store.load(key, reference_sha256) if saving else None
        self.last_source = "disk"
        if state is None:
            self.last_source = "computed"
            state = self.encode(path)
            if saving:
                self.store.save(key, reference_sha256, state)
        self.states[key] = state
        while len(self.states) > self.registry["cacheLimit"]:
            self.states.popitem(last=False)
        return state, (self.now() - started) * 1000


def cpu_environment(threads):
    environment = dict(os.environ)
    environment.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                       HF_HUB_DISABLE_TELEMETRY="1", PYTHONDONTWRITEBYTECODE="1",
                       TOKENIZERS_PARALLELISM="false", OMP_NUM_THREADS=str(threads),
                       MKL_NUM_THREADS=str(threads), OPENBLAS_NUM_THREADS=str(threads))
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_API_TOKEN"):
        environment.pop(key, None)
    return environment
