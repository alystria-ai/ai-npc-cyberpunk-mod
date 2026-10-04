"""Admission of immutable native-caption/actual-alignment/cache evidence.

This is a corpus-entry check, not a new codec implementation. It reads retained
observations; it never loads a model, reruns ASR, writes evidence, or qualifies
the cache prepared for a new training run. teacher_data.verify_actual_cache
continues to own that latter check. Native ASR disagreement is diagnostic.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
import json
import math
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
from types import FunctionType, SimpleNamespace

from . import teacher_data as td

SCHEMA = "teacher_native_primary_admission_v1"
INDEX_SCHEMA = "teacher_native_primary_evidence_index_v1"
CODEC_SHA = "29335a056899c615a95664894c691222d4eb3b2c060009bacbaf0f676cb8ce2b"
MODEL_SHA = "95d91ae4b970e51bc6270326dccf1294d576f9cb9df4f9667ebb2838c7cb0d27"
LOADER_SHA = "44ca0bc2c25b79cde4637ab081bd8389cfee6f2f414da764948fc24286352b15"
RENDERER_SHA = "40a5bfa623825a868d642a5a5899e7a4521677580fb399b6c9b256baee6cf068"
RENDERER_V2_SHA = "a8cee8837926e8a38da22b1b27e8f0470cd1c753d76cbda678207d6374e17af2"
REFERENCE_SHA = "4da896fa3becef9a67106a2d3645753428c17adfd5efa24b8b92a2284972ba76"
LEGACY_BUNDLE_SHA = "297fda549036dec15b6b137b910e1872aec30f123d901213894843d6e6ff577c"
_VERIFIED_OVERLAP = set()
SHORT_KIND = "native_rendered_primary_short_fallback_cache"
SHORT_CONDITIONING = "official_aligned_short_fallback_v1"
SHORT_LOADER_POLICY = "upstream-aligned-no-cut-fallback-v1"
EDGE_KIND = "native_rendered_primary_edge_cache"
EDGE_COVERAGE = "actual_originals_all_cut_arithmetic_edge_stitches_v1"
EDGE_GUARDED_WORKER_SHA = "a8950774db9a70323053732b876d7b976a0d394777b1031619a2a4a1d3b6a60b"
EDGE_GPU_GUARD = {
    "path": "runtime/voice-data-expansion-20261004/qualification/cached_native_gpu_guard.py",
    "sha256": "b4fe88b7ce86e7ee6a201f3fb8397c1d22ac0e78882fb281def5f853e662465f",
}
SHORT_CUT_HELPER = {
    "path": "runtime/voice-data-expansion-20261004/qualification/short-fallback-v1/loader_cuts.py",
    "sha256": "6f84a1f3a09c3b7252cbf6293daa88e528b0a05f392c83bb1c89e82321103616",
}
SHORT_CACHE_VERIFIER = {
    "path": "runtime/voice-data-expansion-20261004/qualification/short_cache_verifier.py",
    "sha256": "09a5fb9fbbd7b2b6eee00508ec3dc3af3328ccd84cd9e62c139f47489b92e112",
}
PARSER_PROOF = {
    "path": "runtime/verification/native-mothertongue-20261004.json",
    "sha256": "2fd4995945d0e22bda7312867f5e7dd6b150999e7d0a6eaf808997702ede623e",
    "api": "scnDialogLineData.GetDisplayText",
    "verified_shape": 'one self-closing mothertongue tag with l="mex", m, b and a attributes',
}
KIROSHI_PROOF = {
    "path": "runtime/verification/native-kiroshi-20261004.json",
    "sha256": "308144c82cc6ab0e38608e59fad2e5d67dd50ff55d5e423a688249756c015f10",
    "api": "scnDialogLineData.GetDisplayText",
    "verified_shapes": ['kiroshi l="mex" with b,o,t,a', 'mothertongue l="fre" or l="jpn" with b,m,a'],
}
KINDS = {
    "native_primary_cache": (
        "authenticated_native_primary_v1", "voice_native_primary_cache_scope_v1",
        "voice_native_primary_actual_codec_cache_loader_proof_v1",
        "1b034d2bc2ad4bf27500a388347434a40939ea7b408199311d604f482d9e7754"),
    "native_rendered_primary_cache": (
        "authenticated_native_rendered_primary_v1", "voice_native_rendered_primary_cache_scope_v1",
        "voice_native_rendered_primary_actual_codec_cache_loader_proof_v1",
        "daaa77047ef2c34a3bc633f915ffbaef4405e4ab42674169ee137ad7ed6ca5b7"),
    "legacy_exact_native_v1": (
        None, "voice_full_cast_cache_scope_v1", "voice_actual_codec_cache_loader_proof_v1",
        "2d1bbc0a6960306e47bffcf20ac5a8a7b926293f7f350eae666e67dc765e8880"),
    SHORT_KIND: (
        "authenticated_native_rendered_primary_v1", "voice_native_rendered_primary_aligned_short_fallback_scope_v1",
        "voice_native_rendered_primary_aligned_short_fallback_actual_codec_cache_loader_proof_v1",
        "267af860f924a20ae5bee08b59a1c4ddb93397798a693e8648936da4b12db20a"),
    EDGE_KIND: (
        "authenticated_native_rendered_primary_v2", "voice_native_rendered_primary_edge_stitched_scope_v1",
        "voice_native_rendered_primary_edge_stitched_codec_cache_loader_proof_v1",
        "1c8410f005da77a387e04726a298e1370770607cd2985f0595f134614457f363"),
}
SHORT_V2_CONTRACT = (
    "authenticated_native_rendered_primary_v2", "voice_native_rendered_primary_aligned_short_fallback_scope_v2",
    "voice_native_rendered_primary_aligned_short_fallback_actual_codec_cache_loader_proof_v2",
    "7c3b948a7f37d6091374280d5d18b4daefe3c926f9b8a030caea0fd3d430de4e",
)
# The previous 177-row qualification and first 21 October 4 rows retain their
# actual policies. This is deliberately not an extensible legacy escape hatch.
LEGACY_SCOPES = {
    "13aa442aa21d58dea1bdeb32e8eed0d79cb204d308025f3a2893826382d892e2":
        "cc3c6ebea25bf0bcd51090e09b71f71c0314de5a8fecafbf898630d18c440e21",
    "1d53d57e37576ba2cbce68e6a4ea2fdbbdefe558b3959ed5e68cde58ef866723":
        "5d65169b5b4ad4c3eb0124920d2f8f80a4fd0611160a52a31768879d11b4f2df",
    "750601d170cc0558ffd08f915c59bac5d40d9acbf7e1e6940d12a1aa52db4040":
        "2554f359f7628a1baed00d9c70536f6c24f6f03874503a0643eef9451eab8152",
    "551c0e92ccd3bb1a7acc3dd5e956c7d03277279f272f256f673af22f5ef63f4e":
        "2ef66a7422331af57669bdd6852f99fb95cbff289f4a8315e9784ce6d915a8aa",
}
EXECUTED_SOURCES = {
    "runner": "scripts/pocket_training/runner.py",
    "cache_verifier": "scripts/pocket_training/teacher_data.py",
    "actual_loader": "vendor/pocket-tts-training/source/training/dataloader/loader.py",
    "actual_precompute": "vendor/pocket-tts-training/source/training/scripts/precompute_latents.py",
    "state_name_lifecycle": "vendor/pocket-tts-training/source/training/modules/utils.py",
}
ASR_MODELS = {
    "ctc": td.CTC_SHA,
    "whisper": "542566a422ae4f3fd23f1ba11add198fca01bbf82e66e6a2857b3f608b1eb9d1",
}


def fail(message):
    raise ValueError("Native-primary admission: " + message)


def declared(bundle):
    """Absent means legacy dispatch; malformed declarations never fall back."""
    if "native_primary_admission" not in bundle:
        return False
    if (not isinstance(bundle["native_primary_admission"], dict)
            or bundle["native_primary_admission"].get("schema") != SCHEMA):
        fail("unsupported native_primary_admission schema")
    return True


def allow_overlap(row):
    """Only a fully verified no-cut tuple can relax the legacy cut check.

    No flag in a manifest can grant this. New workers populate the registry by
    calling verify_input; relocation preserves the source/words/target tuple.
    """
    try:
        return td.digest(td.cache_source(row)) in _VERIFIED_OVERLAP
    except (KeyError, TypeError, ValueError):
        return False


def _contract(kind, scope):
    # A second engine-proven rendering contract is explicit, not a permissive
    # version-prefix match. Old policy/schema/helper tuples remain unchanged.
    if kind == SHORT_KIND and scope.get("schema") == SHORT_V2_CONTRACT[1]:
        return SHORT_V2_CONTRACT
    return KINDS[kind]


def _sha(value):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        fail("an evidence descriptor lacks a full SHA256")
    return value


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            fail("duplicate JSON key: " + key)
        value[key] = item
    return value


def _json(text):
    return json.loads(text, object_pairs_hook=_pairs,
        parse_constant=lambda value: fail("nonfinite JSON value: " + value))


def read(path):
    if not 0 < Path(path).stat().st_size <= 128 * 1024 * 1024:
        fail("JSON evidence is empty or exceeds its bounded size")
    return _json(Path(path).read_text(encoding="utf-8-sig"))


def rows(path):
    if Path(path).stat().st_size > 128 * 1024 * 1024:
        fail("JSONL evidence exceeds its bounded size")
    return [_json(line) for line in Path(path).read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def _portable(base, value):
    if (not isinstance(value, str) or not value or any(c in value for c in ("\\", ":", "\0"))
            or PurePosixPath(value).is_absolute() or any(p in ("", ".", "..") for p in value.split("/"))):
        fail("staged member is not a portable relative path")
    path = (Path(base) / value).resolve()
    if not path.is_relative_to(Path(base).resolve()) or not path.is_file():
        fail("staged member is absent or escapes the bundle: " + value)
    return path


def _bound(base, item):
    path = _portable(base, item["path"])
    if td.file_sha(path) != _sha(item["sha256"]):
        fail("staged evidence changed: " + item["path"])
    return path


def _join(original_base, value):
    """Join a declared original context; never guess a drive/root/basename."""
    if PureWindowsPath(value).is_absolute() or PurePosixPath(value).is_absolute():
        return value
    path_type = PureWindowsPath if "\\" in original_base else PurePosixPath
    return str(path_type(original_base) / value)


def _sibling(original, value):
    path_type = PureWindowsPath if "\\" in original else PurePosixPath
    return str(path_type(original).parent / value)


class Evidence:
    """Closed (original path, SHA256) -> staged bytes, with explicit aliases."""
    def __init__(self, base, descriptor):
        self.base, self.verified, self.documents = Path(base).resolve(), {}, {}
        index = read(_bound(self.base, descriptor))
        if index.get("schema") != INDEX_SCHEMA or not isinstance(index.get("files"), dict) or not index["files"]:
            fail("unsupported or empty evidence index")
        self.files = {}
        for original, versions in index["files"].items():
            if not isinstance(original, str) or not original or "\0" in original or "://" in original:
                fail("invalid original evidence path")
            versions = versions if isinstance(versions, list) else [versions]
            if not versions:
                fail("empty evidence version list")
            table = {}
            for item in versions:
                sha = _sha(item["sha256"])
                _portable(self.base, item["path"])
                if sha in table:
                    fail("duplicate original path/SHA entry")
                table[sha] = {"path": item["path"], "sha256": sha}
            self.files[original] = table

    def resolve(self, original, sha=None):
        if original not in self.files:
            fail("unmapped original provenance path: " + str(original))
        versions = self.files[original]
        if sha is None:
            if len(versions) != 1:
                fail("SHA required for a versioned original path: " + original)
            sha = next(iter(versions))
        if _sha(sha) not in versions:
            fail("original path/SHA is absent from the closed index: " + original)
        item = versions[sha]
        path = _portable(self.base, item["path"])
        stamp = (path.stat().st_size, path.stat().st_mtime_ns)
        if self.verified.get((str(path), sha)) != stamp:
            if td.file_sha(path) != sha:
                fail("original evidence bytes changed: " + original)
            if stamp != (path.stat().st_size, path.stat().st_mtime_ns):
                fail("evidence changed during verification")
            self.verified[(str(path), sha)] = stamp
        return path

    def descriptor(self, item):
        return self.resolve(item["path"], item["sha256"])

    def json(self, original, sha=None):
        path = self.resolve(original, sha)
        key = (str(path), self.verified.get((str(path), sha)))
        if key not in self.documents:
            self.documents[key] = read(path)
        return self.documents[key]

    def document(self, item):
        return self.json(item["path"], item["sha256"])

    def context(self, original_base, item):
        return self.resolve(_join(original_base, item["path"]), item["sha256"])


def _indexed(values, label, source=False):
    result = {}
    for row in values:
        key = row["source_identity"]["id"] if source else row["id"]
        if not isinstance(key, str) or not key or key in result:
            fail("duplicate or absent ID in " + label)
        result[key] = row
    return result


def _legacy_namespace(evidence, original_base):
    # Clone the existing helper functions' globals rather than monkey-patching
    # the imported module or loading an arbitrary executable verifier plug-in.
    namespace = dict(vars(td))
    for name, function in vars(td).items():
        if isinstance(function, FunctionType) and function.__module__ == td.__name__:
            clone = FunctionType(function.__code__, namespace, name, function.__defaults__, function.__closure__)
            clone.__kwdefaults__ = function.__kwdefaults__
            namespace[name] = clone
    namespace["bound"] = lambda unused, item: evidence.context(original_base, item)
    return SimpleNamespace(**namespace)


def _source_gate(evidence, descriptor):
    gate = evidence.document(descriptor)
    if gate.get("schema") != "voice_actual_original_source_gate_v1":
        fail("unsupported original source gate")
    originals = rows(evidence.resolve(_sibling(descriptor["path"], "inputs.jsonl"), gate["canonical_input_sha256"]))
    source = _indexed(originals, "original native inputs")
    accepted = _indexed(gate["rows"], "original source gate")
    if set(source) != set(accepted):
        fail("source gate does not cover the exact immutable input")
    for pin in gate["pinned_source_files"]:
        evidence.descriptor(pin)
    for key, row in source.items():
        actual = accepted[key]
        if (actual["source_identity"] != td.identity(row) or actual.get("native_source_verified") is not True
                or actual.get("original_wem_wav_pcm_verified") is not True
                or actual.get("typed_identity_verified") is not True or actual.get("protected_component") is not False):
            fail("source gate does not authenticate exact original audio/identity")
        evidence.resolve(row["path"], row["audio_sha256"])
        evidence.descriptor(row["raw_receipt"])
    return source, gate["canonical_input_sha256"]


def _render(raw, renderer_sha=RENDERER_SHA):
    """Exactly the reviewed engine-proven transformation, without ASR text."""
    if not isinstance(raw, str) or not raw.strip() or renderer_sha not in (RENDERER_SHA, RENDERER_V2_SHA):
        fail("nonempty native text and an explicitly reviewed renderer are required")
    version2 = renderer_sha == RENDERER_V2_SHA
    language = translation = None
    base = {"policy": "cyberpunk-native-spoken-text-v2" if version2 else "cyberpunk-native-spoken-text-v1", "original_native_text": raw,
            "original_native_text_sha256": td.text_sha(raw), "native_caption_primary": True,
            "asr_text_substituted": False, "training_admission_decided": False}
    if "<" not in raw and ">" not in raw:
        spoken, rule, proof = raw, "plain_native_passthrough", None
    else:
        tag = re.fullmatch(r"<(?P<kind>mothertongue|kiroshi)\s+(?P<attributes>[^<>]*)/\s*>", raw.strip(), re.DOTALL)
        if tag is None:
            fail("unsupported native markup requires separate engine evidence")
        fields, cursor, content = {}, 0, tag["attributes"]
        for match in re.finditer(r'([A-Za-z_][A-Za-z_0-9-]*)\s*=\s*"([^"<>]*)"', content):
            if content[cursor:match.start()].strip() or match[1] in fields:
                fail("native markup attributes are ambiguous")
            fields[match[1]], cursor = match[2], match.end()
        kind = tag["kind"]
        required = {"l", "m", "b", "a"} if kind == "mothertongue" else {"l", "o", "t", "b", "a"}
        languages = {"mex", "fre", "jpn"} if version2 and kind == "mothertongue" else {"mex"}
        if (content[cursor:].strip() or set(fields) != required or not version2 and kind != "mothertongue"
                or fields["l"] not in languages or any("&" in value for value in fields.values())):
            fail("native markup is outside the proven parser shape")
        language, translation = fields["l"], fields.get("t")
        spoken = fields["b"] + fields["m" if kind == "mothertongue" else "o"] + fields["a"]
        rule = "native_" + kind + "_pre_plus_native_plus_post"
        proof = PARSER_PROOF if kind == "mothertongue" and language == "mex" else KIROSHI_PROOF
    result = {**base, "status": "rendered", "spoken_text": spoken, "spoken_text_sha256": td.text_sha(spoken),
            "transform_rule": rule, "transformed": spoken != raw, "native_parser_evidence": proof}
    if version2:
        result.update(native_language_code=language, translation_text=translation,
            translation_text_sha256=None if translation is None else td.text_sha(translation), translation_used_as_spoken_text=False)
    return result


def _same_recording(target, original):
    fields = ("id", "speaker_id", "source_panel", "audio_sha256", "pcm_sha256", "source_wem_sha256",
              "source_row_sha256", "duration", "sample_rate", "channels", "native_frames", "path",
              "string_id", "gender_variant", "scenes", "source_delivery", "raw_receipt")
    if any(target.get(key) != original.get(key) for key in fields):
        fail("derived/native scope changed the authenticated recording or delivery")


def _targets(evidence, descriptor, policy="authenticated_native_rendered_primary_v1"):
    receipt = evidence.document(descriptor)
    if receipt.get("qualification_policy") != policy:
        fail("unsupported native target receipt")
    originals, unused = _source_gate(evidence, receipt["original_source_gate"])
    renderer = receipt["native_renderer"]
    expected_renderer = RENDERER_V2_SHA if policy == SHORT_V2_CONTRACT[0] else RENDERER_SHA
    if renderer["sha256"] != expected_renderer:
        fail("native renderer is not the reviewed engine-proven source")
    evidence.descriptor(renderer)
    evidence.descriptor(PARSER_PROOF)
    if renderer["sha256"] == RENDERER_V2_SHA:
        evidence.descriptor(KIROSHI_PROOF)
    targets = _indexed(rows(evidence.resolve(_sibling(descriptor["path"], "inputs.jsonl"), receipt["inputs_sha256"])), "rendered native inputs")
    if len(targets) != receipt["rows"] or not set(targets) <= set(originals):
        fail("rendered target inventory is not a subset of authenticated originals")
    for key, row in targets.items():
        original = originals[key]
        _same_recording(row, original)
        rendered = _render(original["native_text"], renderer["sha256"])
        if (row.get("original_native_source_identity") != td.identity(original)
                or row.get("original_native_text") != original["native_text"]
                or row.get("original_native_text_sha256") != original["native_text_sha256"]
                or row.get("native_rendering") != rendered
                or row.get("training_transcript") != rendered["spoken_text"]
                or row.get("training_transcript_sha256") != rendered["spoken_text_sha256"]
                or row.get("native_text") != rendered["spoken_text"]
                or row.get("native_text_sha256") != rendered["spoken_text_sha256"]
                or row.get("transcript_authority") != "native-game-caption-rendered-by-verified-engine-semantics"):
            fail("original native markup and derived spoken target are not separately bound")
        td.identity(row)
    return targets, receipt["inputs_sha256"]


def _alignment(evidence, descriptor, engine, input_sha=None):
    run = evidence.document(descriptor)
    if (run.get("schema") != "voice_caption_free_wording_v1" or run.get("engine") != engine
            or run.get("model_sha256") != ASR_MODELS[engine] or run.get("status") != "completed"
            or run.get("model_released") is not True
            or input_sha is not None and run.get("input_manifest_sha256") != input_sha):
        fail("actual alignment/wording run provenance differs")
    evidence.descriptor(run["source_code"])
    auxiliary_paths = {
        "qualification.py": _sibling(run["source_code"]["path"], "qualification.py"),
        "original_audio_reader": "runtime/research/pocket-wording-audit.py",
        "pinned_ctc_viterbi": "vendor/pocket-tts-training/source/training/scripts/align_data.py",
    }
    for name, sha in run.get("auxiliary_source_sha256", {}).items():
        if name not in auxiliary_paths:
            fail("unsupported actual alignment helper")
        evidence.resolve(auxiliary_paths[name], sha)
    if engine == "ctc" and run.get("forced_alignment_is_separate_caption_conditioned_post_inference") is not True:
        fail("word alignment is not the recorded separate CTC alignment")
    if any(run.get(key) is not False for key in ("caption_prompt", "caption_derived_hints", "previous_clip_context", "original_audio_or_caption_edited")):
        fail("actual run lost its no-edit/caption-free inference provenance")
    observed = rows(evidence.resolve(_sibling(descriptor["path"], "hypotheses.jsonl"), run["hypotheses_sha256"]))
    result = _indexed(observed, engine + " actual hypotheses", source=True)
    if len(result) != run["completed_rows"]:
        fail("actual run completion inventory differs from its raw outputs")
    return result


def _legacy_sources(evidence, scope, item):
    if LEGACY_SCOPES.get(item["scope"]["sha256"]) != item["cache_result"]["sha256"]:
        fail("unsupported legacy scope; only the four retained actual cohorts are admitted")
    input_sha = None
    if item["scope"]["sha256"] == "551c0e92ccd3bb1a7acc3dd5e956c7d03277279f272f256f673af22f5ef63f4e":
        proposal = evidence.json(_sibling(item["scope"]["path"], "proposal.json"))
        if proposal.get("schema") != "voice_bounded_full_cast_gpu_proposal_v1":
            fail("first legacy October 4 run lacks its actual launch proposal")
        original, input_sha = _source_gate(evidence, {
            "path": "runtime/voice-data-expansion-20261004/qualification/batch-001-source/source-gate.json",
            "sha256": proposal["source_gate_sha256"]})
        if input_sha != proposal["input_sha256"]:
            fail("first legacy October 4 source/input binding differs")
        for row in scope["rows"]:
            _same_recording(row, original[row["id"]])
            if td.identity(row) != td.identity(original[row["id"]]):
                fail("first legacy October 4 scope lost its actual original source")
    # The pinned old scopes already contain the original native proof metadata.
    # They are not retroactively described as a native-primary run.
    for row in scope["rows"]:
        original = evidence.document(row["raw_receipt"])
        if (original.get("key") != row["speaker_id"] or str(original.get("stringId")) != row["string_id"]
                or original.get("transcript") != row["native_text"] or original.get("sha256") != row["audio_sha256"]
                or original.get("transcriptSha256") != row["native_text_sha256"]):
            fail("retained legacy raw-source receipt differs from its fixed scope")
        evidence.resolve(row["path"], row["audio_sha256"])
        if row.get("native_source_metadata") is not None and any(
                original["provenance"].get(key) != value for key, value in row["native_source_metadata"].items()):
            fail("legacy source metadata changed from the actual original receipt")
    proofs = scope["wording_source_proofs"]
    ctc, whisper = (_alignment(evidence, proofs[name], name, input_sha) for name in ("ctc", "whisper"))
    for row in scope["rows"]:
        actual = [records[row["id"]] for records in (ctc, whisper)]
        if any(value["source_identity"] != td.identity(row) or value.get("status") != "audited" for value in actual):
            fail("legacy actual recognizer source tuple differs")
        if (actual[0].get("alignment_status") != "aligned" or actual[0].get("words") != row["words"]
                or not any(td.compact(value["raw_hypothesis"]) == td.compact(row["native_text"]) for value in actual)):
            fail("legacy exact-native caption/alignment no longer matches its actual old policy")


def _word_cuts(row, stored, *, allow_short=False):
    # Equations of the SHA-pinned upstream loader used in these retained runs:
    # prompt <=5s, max target 30s, 1s interior reserve, 0.2s trailing reserve.
    td.require_word_caption(row)
    previous = -1.0
    for word in row["words"]:
        start, end = word.get("start"), word.get("end")
        if not td.compact(word["word"]) and start is None and end is None:
            continue
        if (type(start) not in (int, float) or type(end) not in (int, float)
                or not math.isfinite(start + end) or not 0 <= start < end <= row["duration"] + 1/row["sample_rate"]
                or start < previous):
            fail("native alignment is missing/overlapping/nonfinite/outside original audio")
        previous = end
    available = []
    for index, word in enumerate(row["words"][1:], 1):
        before = row["words"][index - 1].get("end")
        if before is not None and word.get("start") is not None:
            cut = (before + word["start"]) / 2
            if cut >= 1 and row["duration"] - cut >= 1:
                available.append((cut, index))
    eligible = [(cut, i) for cut, i in available if row["words"][i - 1]["end"] < 5]
    available = eligible or available[:1]
    fallback = not available
    if stored < 2 or fallback and not allow_short:
        fail("no actual interior cut; this scope does not declare official aligned fallback")
    if fallback:
        available = [(0.0, 0)]
    last = max(word["end"] for word in row["words"] if word.get("end") is not None)
    result = []
    for cut, index in available:
        frames = 0 if fallback else min(max(round(cut * 12.5), 1), stored - 1)
        begin = frames / 12.5
        end = min(row["duration"], last + .2) if last > begin else row["duration"]
        target = max(1, min(int(min(end - begin, 30) * 12.5), stored - frames))
        reasons = []
        first = (next(word["start"] for word in row["words"][index:] if td.compact(word["word"]))
                 if allow_short else row["words"][index]["start"])
        if begin > first + 1e-9:
            reasons.append("rounded_crop_starts_after_aligned_suffix_word")
        if (frames + target) / 12.5 + 1e-9 < last:
            reasons.append("floor_frames_omit_aligned_last_word")
        value = {"word_index": index, "cut_seconds": cut, "cut_frames": frames, "target_frames": target,
            "consumed_start": begin, "consumed_end": (frames + target) / 12.5,
            "suffix_text": row["transcript"] if fallback else " ".join(word["word"] for word in row["words"][index:]),
            "rejection_reasons": reasons}
        if allow_short:
            value.update(loader_sampling_policy=SHORT_LOADER_POLICY,
                sampling_mode="aligned_full_utterance_fallback" if fallback else "aligned_disjoint_prefix",
                interior_boundary=None if fallback else [cut, index], prompt_target_overlap=fallback)
        result.append(value)
    return result


def _verify_edge_gpu_guard(evidence, result):
    """Bind the reviewed resource-only successor; audio coverage is unchanged."""
    if result["source_sha256"].get("native_gpu_headroom_guard") != EDGE_GPU_GUARD["sha256"]:
        fail("guarded edge worker lost its executed resource helper")
    evidence.descriptor(EDGE_GPU_GUARD)
    receipt = result.get("gpu_headroom_probe_receipt")
    if result.get("device") == "cpu" and receipt is None:
        return
    if (not isinstance(receipt, dict) or receipt.get("policy") != "native_windows_headroom_max_one_second_v1"
            or receipt.get("max_cache_age_seconds") != 1.0 or receipt.get("clock") != "time.monotonic"
            or receipt.get("allocator_cap_changed") is not False or receipt.get("headroom_thresholds_changed") is not False
            or type(receipt.get("cache_hits")) is not int or receipt["cache_hits"] < 0):
        fail("guarded edge worker lacks its bounded native headroom receipt")
    queries = receipt.get("queries")
    if not isinstance(queries, list) or receipt.get("query_count") != len(queries):
        fail("native headroom probe inventory differs")
    forced = defaultdict(int)
    previous = -math.inf
    for query in queries:
        start, end, elapsed = (query.get(name) for name in ("start_monotonic", "end_monotonic", "elapsed_seconds"))
        if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end, elapsed))
                or start < previous or end < start or not math.isclose(end - start, elapsed, abs_tol=1e-6)
                or type(query.get("forced")) is not bool):
            fail("native headroom probe timing is inconsistent")
        timestamp = datetime.fromisoformat(query["utc"])
        if timestamp.tzinfo is None:
            fail("native headroom probe lost its absolute timestamp")
        total, free, used = (query.get(name) for name in ("total", "free", "used"))
        # Preserve the provider's independent counters. The executed guard
        # bounds free memory; it does not assert free+used equals total.
        if (any(type(value) is not int or value < 0 for value in (total, free, used))
                or not total or free > total or used > total):
            fail("native headroom probe memory observation is inconsistent")
        if query["forced"]:
            reason = query["reason"]
            if reason not in ("before_model_load", "before_original_or_calibration_encode",
                              "before_recording_stitched_proof", "after_model_release"):
                fail("unsupported forced resource probe point")
            if reason != "after_model_release" and free < (5 if reason == "before_model_load" else 4) * 1024**3:
                fail("actual edge GPU work crossed its recorded headroom threshold")
            forced[reason] += 1
        elif query.get("reason") != "bounded_poll":
            fail("unrecognized cached resource probe")
        previous = end
    if (forced["before_model_load"] != 1 or forced["after_model_release"] != 1
            or forced["before_recording_stitched_proof"] != result["scope_rows"]
            or forced["before_original_or_calibration_encode"] != len(result["actual_precompute_encoder_calls"])):
        fail("guarded edge worker lacks a fresh sample at each required GPU boundary")


def _verify_cache(evidence, scope, item):
    policy, unused, result_schema, helper_sha = _contract(item["kind"], scope)
    result = evidence.document(item["cache_result"])
    edge = item["kind"] == EDGE_KIND
    allowed_helpers = {helper_sha, EDGE_GUARDED_WORKER_SHA} if edge else {helper_sha}
    if (result.get("schema") != result_schema or result.get("qualification_policy") != policy
            or result.get("scope_sha256") != item["scope"]["sha256"] or result.get("status") != "completed"
            or result.get("model_released") is not True or result.get("dtype") != "float32"
            or result.get("actual_mimi_encode_hash") != CODEC_SHA or result.get("actual_mimi_encode_hash_after") != CODEC_SHA
            or result.get("approved_model_sha256") != MODEL_SHA or result.get("helper_source_sha256") not in allowed_helpers
            or item["helper_source"]["sha256"] != result.get("helper_source_sha256")
            or result.get("cache_rows_all_finite_and_source_bound") is not True
            or not edge and result.get("loader_masks_and_suffix_tokens_verified") is not True
            or result.get("native_captions_or_audio_edited") is not False):
        fail("actual codec/loader proof is incomplete or belongs to another source/helper")
    evidence.descriptor(item["helper_source"])
    if edge:
        if (scope.get("codec_coverage_policy") != EDGE_COVERAGE or result.get("codec_coverage_policy") != EDGE_COVERAGE
                or result.get("all_cut_token_and_frame_arithmetic_verified") is not True
                or result.get("edge_cut_masks_verified") is not True or result.get("every_interior_cut_reencoded") is not False
                or "loader_masks_and_suffix_tokens_verified" in result
                or type(result.get("actual_stitched_cut_encodes")) is not int):
            fail("edge result does not truthfully declare its reduced stitched-encode coverage")
        if result["helper_source_sha256"] == EDGE_GUARDED_WORKER_SHA:
            _verify_edge_gpu_guard(evidence, result)
        elif "gpu_headroom_probe_receipt" in result or "native_gpu_headroom_guard" in result["source_sha256"]:
            fail("original edge worker cannot claim the later resource guard")
    short = item["kind"] in (SHORT_KIND, EDGE_KIND)
    if short:
        if (scope.get("conditioning_policy") != SHORT_CONDITIONING or result.get("conditioning_policy") != SHORT_CONDITIONING
                or scope.get("loader_cut_helper") != SHORT_CUT_HELPER or result.get("loader_cut_helper") != SHORT_CUT_HELPER
                or result["source_sha256"].get("official_short_cache_verifier") != SHORT_CACHE_VERIFIER["sha256"]):
            fail("actual short fallback is not bound to its explicit policy/helpers")
        evidence.descriptor(SHORT_CUT_HELPER)
        evidence.descriptor(SHORT_CACHE_VERIFIER)
    for name, original in EXECUTED_SOURCES.items():
        evidence.resolve(original, result["source_sha256"][name])
        if original in scope["pinned_source_sha256"] and result["source_sha256"][name] != scope["pinned_source_sha256"][original]:
            fail("actual codec source differs from the scoped source")
    if result["source_sha256"]["actual_loader"] != LOADER_SHA:
        fail("cache proof used a different loader cut contract")
    for key in ("scope_rows", "qualified_scope_rows", "actual_cache_rows"):
        if result.get(key) != len(scope["rows"]):
            fail("actual cache completion does not cover its exact scope")
    if result.get("diagnostic_scope_rows") != 0:
        fail("diagnostic-only cache rows cannot be silently admitted")
    original_result = item["cache_result"]["path"]
    raw = rows(evidence.resolve(_sibling(original_result, "data/train.jsonl")))
    annotated = rows(evidence.resolve(_sibling(original_result, "data/train_latents.jsonl")))
    observations = rows(evidence.resolve(_sibling(original_result, "actual-cache-rows.jsonl")))
    cuts = rows(evidence.resolve(_sibling(original_result, "actual-loader-cuts.jsonl")))
    meta = evidence.json(_sibling(original_result, "data/train_latents.meta.json"))
    if meta != result["actual_stitch_calibration"] or meta.get("mimi_hash") != CODEC_SHA or meta.get("frame_rate") != 12.5:
        fail("actual stitch calibration changed")
    if not (len(raw) == len(annotated) == len(observations) == len(scope["rows"])):
        fail("original cache row ledgers have different inventories")
    grouped = defaultdict(list)
    for cut in cuts:
        grouped[cut["id"]].append(cut)
    if len(cuts) != result["actual_reachable_cuts"] or set(grouped) != {row["id"] for row in scope["rows"]}:
        fail("actual loader-cut ledger omits or invents recordings")
    stitched_encodes = 0
    for source, original, cached, observed in zip(scope["rows"], raw, annotated, observations, strict=True):
        if {key: value for key, value in source.items() if key != "path"} != {key: value for key, value in original.items() if key != "path"}:
            fail("actual cache train.jsonl changed scoped metadata or words")
        if {key: value for key, value in cached.items() if key != "latents_file"} != original:
            fail("actual annotated cache manifest changed its raw row")
        evidence.resolve(original["path"], source["audio_sha256"])
        if (observed.get("id") != source["id"] or observed.get("source") != td.cache_source(source)
                or observed.get("mimi_encode_hash") != CODEC_SHA or observed.get("sample_rate") != 24000
                or observed.get("frame_rate") != 12.5 or observed.get("latents_file") != cached["latents_file"]):
            fail("actual cache source/word/frame identity differs")
        _sha(observed["decoded_float32_sha256"])
        samples, available = observed["actual_resampled_samples"], observed["encoded_frames_available"]
        if type(samples) is not int or type(available) is not int or min(samples, available) <= 0:
            fail("actual decoded/encoded sample observation is invalid")
        expected = min(max(1, int(samples * 12.5 / 24000)), available)
        latent = evidence.resolve(_sibling(original_result, "data/" + cached["latents_file"]), observed["latents_sha256"])
        if td.latent_shape(latent) != [expected, 32] or observed["shape"] != [expected, 32]:
            fail("actual retained latent tensor shape/bytes are inconsistent")
        expected_cuts = _word_cuts(source, expected, allow_short=short)
        if short and any(source.get(name) != expected_cuts[0][name] for name in
                ("sampling_mode", "prompt_target_overlap", "loader_sampling_policy")):
            fail("short scope row mislabels its actual no-cut/prefix conditioning")
        actual_cuts = grouped[source["id"]]
        if len(expected_cuts) != len(actual_cuts):
            fail("actual loader proof omits a reachable suffix")
        for cut_number, (expected_cut, actual) in enumerate(zip(expected_cuts, actual_cuts, strict=True)):
            if any(actual.get(key) != value for key, value in expected_cut.items()):
                fail("actual loader suffix/frame arithmetic changed")
            prompt_limit = expected if expected_cut.get("prompt_target_overlap") else expected_cut["cut_frames"]
            prompt_field = "loader_declared_prompt_frames" if edge else "actual_prompt_frames"
            target_field = "loader_declared_target_frames" if edge else "actual_target_mask_frames"
            if (actual.get("scope_role") != source["cache_scope_role"]
                    or actual.get(target_field) != expected_cut["target_frames"]
                    or actual.get("actual_cached_target_start_seconds") != expected_cut["consumed_start"]
                    or actual.get("actual_raw_target_start_seconds") != expected_cut["cut_seconds"]
                    or actual.get("native_text_suffix_loss_confirmed") is not False
                    or not actual.get("actual_target_token_ids")
                    or any(type(token) is not int or token < 0 for token in actual["actual_target_token_ids"])
                    or type(actual.get(prompt_field)) is not int
                    or not 0 < actual[prompt_field] <= min(prompt_limit, int(5 * 12.5))):
                fail("actual cached/raw suffix, target mask or prompt observation differs")
            if "floor_frames_omit_aligned_last_word" in expected_cut["rejection_reasons"]:
                fail("actual target frames omit the aligned final word")
            observed_encode = not edge or cut_number in {0, len(expected_cuts) - 1}
            if edge and (actual.get("stitched_encode_observed") is not observed_encode
                    or actual.get("stitched_encode_coverage") != "earliest_latest_per_recording_v1"):
                fail("stitched observation is not exactly the first/last reachable cut")
            if observed_encode:
                if (actual.get("actual_target_mask_frames") != expected_cut["target_frames"]
                        or actual.get("actual_prompt_frames") != actual[prompt_field]):
                    fail("observed stitched edge mask/prompt differs from actual loader arithmetic")
                _sha(actual["actual_stitched_target_latent_sha256"])
                stitched_encodes += 1
            elif any(key in actual for key in ("actual_prompt_frames", "actual_target_mask_frames",
                    "actual_stitched_target_latent_sha256", "actual_raw_target_mask_frames", "cached-target", "raw-target")):
                fail("an unencoded interior cut claims an observed encoded tensor or mask")
    summary = {"rows": len(raw), "cuts": len(cuts), "policy": item["kind"]}
    if edge:
        if stitched_encodes != result["actual_stitched_cut_encodes"]:
            fail("edge result's actual stitched-encode count differs from its cut ledger")
        summary.update(codec_coverage_policy=EDGE_COVERAGE, actual_stitched_cut_encodes=stitched_encodes,
            every_interior_cut_reencoded=False)
    return summary


def _scope(evidence, item):
    kind = item.get("kind")
    if kind not in KINDS:
        fail("unsupported scope kind: " + str(kind))
    scope = evidence.document(item["scope"])
    policy, schema, unused, unused2 = _contract(kind, scope)
    if scope.get("schema") != schema or scope.get("qualification_policy") != policy:
        fail("declared scope kind differs from the immutable actual policy")
    indexed = _indexed(scope["rows"], "bounded native scope")
    if not 1 <= len(indexed) <= 128:
        fail("scope is not a distinct bounded actual cohort")
    for path, sha in scope["pinned_source_sha256"].items():
        evidence.resolve(path, sha)
    if kind == "legacy_exact_native_v1":
        _legacy_sources(evidence, scope, item)
    else:
        if scope.get("independent_wording_agreement_required") is not False:
            fail("native-primary scope must retain ASR's diagnostic-only role")
        if kind == "native_primary_cache":
            originals, input_sha = _source_gate(evidence, scope["native_source_proof"])
        else:
            originals, input_sha = _targets(evidence, scope["target_proof"], policy)
        alignment = _alignment(evidence, scope["alignment_source_proof"], "ctc", input_sha)
        for key, row in indexed.items():
            original = originals[key]
            _same_recording(row, original)
            if td.identity(row) != td.identity(original) or row["native_text"] != original["native_text"]:
                fail("scope does not bind the exact original/native-rendered caption")
            if kind == "native_primary_cache" and ("<" in row["native_text"] or ">" in row["native_text"]):
                fail("markup requires the separate rendered policy")
            if kind in ("native_rendered_primary_cache", SHORT_KIND, EDGE_KIND):
                for field in ("original_native_source_identity", "original_native_text", "original_native_text_sha256",
                              "training_transcript", "training_transcript_sha256", "native_rendering", "transcript_authority"):
                    if row.get(field) != original.get(field):
                        fail("scope lost separate original and rendered provenance")
            actual = alignment[key]
            if (actual["source_identity"] != td.identity(row) or actual.get("status") != "audited"
                    or actual.get("alignment_status") != "aligned" or actual.get("words") != row["words"]
                    or row.get("transcript") != row["native_text"]):
                fail("actual native-target word alignment differs")
            # raw_hypothesis and normalized_caption_agreement are intentionally
            # not acceptance predicates for either native-primary policy.
    return indexed, _verify_cache(evidence, scope, item)


def _speaker(row):
    return row.get("speaker_id", row.get("character"))


def _recordings(row):
    result = {key for key in td.alias_keys(row) if key[0] != "text"}
    parts = row["id"].split("/")
    if len(parts) >= 2 and _speaker(row):
        result.add(("id", _speaker(row) + "/" + parts[1]))
    if row.get("raw_pcm_sha256"):
        result.add(("pcm", row["raw_pcm_sha256"]))
    return result


def _captions(row):
    return {(_speaker(row), td.compact(value)) for value in
        (row.get("transcript"), row.get("native_text"), row.get("original_native_text"), *row.get("transcript_aliases", [])) if value}


def _scenes(row):
    return {str(scene).replace("/", "\\").casefold() for scene in row.get("scenes", [])}


def _history(evidence, descriptor):
    old = evidence.document(descriptor)
    base = descriptor["original_base"]
    source, prior = {}, []
    for item in old["source_ledgers"]:
        path = evidence.context(base, item)
        purpose = item["purpose"]
        if purpose in ("immutable_original_train", "accepted_original_train_spans", "reference_exclusions"):
            if purpose in source:
                fail("duplicate historical source ledger")
            source[purpose] = (item["sha256"], path)
        elif purpose == "conservative_prior_train_content":
            prior.extend(row for row in read(path) if row["panel"] == "train")
        elif purpose == "conservative_prior_train":
            prior.extend(rows(path))
    expected = {"immutable_original_train": "33c6a9b1d60f3aea73d6bab2e8c3b7ccfc802ebdfdb6e8551b6b132a56a3e8af",
        "accepted_original_train_spans": "ed3bb60a9540390d68834943d748679ef2172fa85a236ebb6c31a1140c65e15c",
        "reference_exclusions": "1cbfd1005e48da7dd39717be5c0bca606e320f31a99000dc90b1500df594f30f"}
    if any(key not in source or source[key][0] != sha for key, sha in expected.items()):
        fail("history lacks the immutable actual train/alignment/reference sources")
    accepted = read(source["accepted_original_train_spans"][1])["rows"]
    original = [row for row in rows(source["immutable_original_train"][1]) if row["id"] in accepted]
    if len(original) != 2743:
        fail("immutable historical training inventory changed")
    return original + prior


def _fences(spec, evidence, admission, panels, inherited):
    reservations = evidence.document(admission["role_reservations"])
    if reservations.get("schema") != "cast_expansion_role_reservations_v1":
        fail("unsupported corrected role-reservation contract")
    reference = evidence.document(admission["reference_sources"])
    if (admission["reference_sources"]["sha256"] != REFERENCE_SHA
            or reference.get("schema") != "actual_expanded_reference24_release_v1"
            or len(reference.get("references", {})) != 24):
        fail("current immutable 24-reference inventory changed")
    reserved_refs = {row["speaker_id"]: row for row in reservations["current_blind_reference_components"]}
    if set(reserved_refs) != set(reference["references"]):
        fail("corrected reservations do not cover every current reference")
    reserved = {("id", value) for value in reservations["exact_reserved_ids"]}
    for kind, hashes in reservations["exact_reserved_hashes"].items():
        reserved.update((kind, _sha(sha)) for sha in hashes)
    for speaker, row in reference["references"].items():
        current = reserved_refs[speaker]
        if current["reference_sha256"] != row["sha256"] or not current["segments"]:
            fail("reference reservation differs from its immutable source")
        evidence.descriptor(row["source_reference"]["audio"])
        for source in row["source_reference"]["sourceBindings"]:
            evidence.descriptor(source)
        for segment in current["segments"]:
            reserved.add(("id", speaker + "/" + str(segment["localization_id"])))
            for field, kind in (("wav_sha256", "wav"), ("wem_sha256", "wem"), ("pcm_sha256", "pcm")):
                if segment.get(field):
                    reserved.add((kind, _sha(segment[field])))
    history = _history(evidence, admission["history"])
    history.extend(reservations["historical_train_rows"] + reservations["current_pilot_train_rows"])
    historical, historical_scenes = set(), set()
    for row in history:
        if row.get("id"):
            historical |= _recordings(row)
        historical_scenes |= _scenes(row)
    # Corrected reservations supersede old global caption and conditioning-
    # scene vetoes. Exact recording aliases still win; caption duplication is
    # checked within speaker, and unseen dev claims require unseen train scenes.
    components = reservations["components"]
    protected_nodes = {node for group in components if group["protectedForTraining"] for node in group["nodes"]}
    by_identity = defaultdict(list)
    for row in reservations["roleByIdentity"].values():
        identity = row["identity"]
        by_identity[(identity["key"], str(identity["localizationId"]))].append(row)
    heldout_captions = {(_speaker(row), td.compact(row["canonical_text"])) for row in reservations["heldout_rows"] if row.get("canonical_text")}
    seen_recordings, seen_captions = {}, {}
    train_scenes = set().union(*(_scenes(row) for row in panels["train"])) if panels["train"] else set()
    inherited_reasons = {"original_mandatory_eval_scene_or_reused_recording_component",
        "genuine_new_heldout_scene_or_reused_recording_component", "archive_only_matches_original_accepted1744_no_added_exposure"}
    for role, values in panels.items():
        for row in values:
            keys, captions = _recordings(row), _captions(row)
            for key in keys:
                if key in seen_recordings and seen_recordings[key] != role:
                    fail("one recording/source alias crosses corpus panels")
                seen_recordings[key] = role
            for key in captions:
                if key in seen_captions and seen_captions[key] != role:
                    fail("same-character spoken/native caption crosses corpus panels")
                seen_captions[key] = role
            if role not in td.ADMISSION:
                continue
            known_role = (role, row["id"]) in inherited
            if keys & reserved and not known_role:
                fail("new admission overlaps an exact reference or reserved evaluation recording")
            if role == "train":
                if keys & reserved or captions & heldout_captions:
                    fail("training overlaps an exact reservation or same-speaker evaluation caption")
                retained = bool(keys & historical)
                nodes = {kind + ":" + value for kind, value in keys}
                nodes |= {"scene:" + value for value in _scenes(row)}
                if row.get("wem_depot"):
                    nodes.add("wem-depot:" + row["wem_depot"].replace("/", "\\").casefold())
                if nodes & protected_nodes and not retained:
                    fail("new training overlaps a genuinely protected delivery component")
                parts = row["id"].split("/")
                for reservation in by_identity.get((_speaker(row), parts[1]), []):
                    if row.get("gender_variant") and reservation["identity"].get("localizationVariant") != row["gender_variant"]:
                        continue
                    if reservation["protectedForNextTrain"] and not (retained and set(reservation["reasons"]) <= inherited_reasons):
                        fail("final corrected source role is protected from training")
            elif not known_role:
                if keys & historical:
                    fail("new heldout panel reuses an already trained recording")
                scenes = _scenes(row)
                if not scenes:
                    fail("new heldout row has no authenticated delivery-scene exposure")
                if role == "dev" and scenes & (historical_scenes | train_scenes):
                    fail("new unseen-dev row is from an exposed training scene; label it honestly")
                if role == "teacher_conditional" and not scenes & historical_scenes:
                    fail("conditional evaluation lacks its claimed historical scene exposure")


def verify_input(spec, bundle):
    """Verify one declared native-primary teacher_staged_bundle_v1 corpus."""
    _VERIFIED_OVERLAP.clear()
    if not declared(bundle) or bundle.get("schema") != "teacher_staged_bundle_v1":
        fail("explicit teacher_staged_bundle_v1 native admission is required")
    admission = bundle["native_primary_admission"]
    evidence = Evidence(spec.base, admission["evidence_index"])
    panels = {role: rows(_bound(spec.base, item)) for role, item in bundle["manifests"].items()}
    if set(panels) != td.ROLES:
        fail("teacher manifest roles differ")
    selected = {(role, row["id"]): row for role in td.ADMISSION for row in panels[role]}
    for role, values in panels.items():
        _indexed(values, role)
        for row in values:
            td.identity(row)
            td.require_word_caption(row)
            _bound(spec.base, {"path": row["path"], "sha256": row["audio_sha256"]})
    protected = admission["protected_snapshot"]
    _legacy_namespace(evidence, protected["original_base"]).verify_protected(
        spec.base, panels, evidence.document(protected))
    admitted, inherited, pending_overlap, summaries = set(), set(), set(), []

    def include(items, originals, kind):
        for item in items:
            key = (item["role"], item["id"])
            if key in admitted or key not in selected or item["id"] not in originals:
                fail("admission membership is duplicate, invented or in a protected role")
            row, original = selected[key], originals[item["id"]]
            if td.identity(row) != td.identity(original) or td.model_payload(row) != td.model_payload(original):
                fail("staged row changed the actual source/caption/words/model payload")
            if _scenes(row) != _scenes(original):
                fail("staged row changed actual delivery scenes")
            for name in ("original_native_source_identity", "original_native_text", "original_native_text_sha256",
                         "training_transcript", "training_transcript_sha256", "native_rendering", "transcript_authority",
                         "sampling_mode", "prompt_target_overlap", "loader_sampling_policy"):
                if row.get(name) != original.get(name):
                    fail("staged row lost original-versus-spoken target provenance")
            admitted.add(key)
            if kind in (SHORT_KIND, EDGE_KIND) and original["sampling_mode"] == "aligned_full_utterance_fallback":
                pending_overlap.add(td.digest(td.cache_source(row)))

    for item in admission.get("legacy_bundles", []):
        legacy = evidence.document(item["bundle"])
        if (item["bundle"]["sha256"] != LEGACY_BUNDLE_SHA
                or legacy.get("schema") != "teacher_staged_bundle_v1"
                or "native_primary_admission" in legacy or "expanded_data_contract" in legacy):
            fail("legacy_bundles supports only the original standard bundle, not expanded overlays")
        namespace = _legacy_namespace(evidence, item["original_base"])
        result = namespace.verify_input(SimpleNamespace(base=spec.base), legacy)
        original_panels = {role: rows(evidence.context(item["original_base"], descriptor)) for role, descriptor in legacy["manifests"].items()}
        for member in item["admitted"]:
            role = member["role"]
            include([member], _indexed(original_panels[role], "legacy " + role), "legacy_bundle")
            inherited.add((role, member["id"]))
        summaries.append({"kind": "standard_legacy_bundle", "verification": result, "admitted": len(item["admitted"])})
    for item in admission.get("scopes", []):
        original_rows, summary = _scope(evidence, item)
        include(item["admitted"], original_rows, item["kind"])
        summaries.append({**summary, "admitted": len(item["admitted"]), "scope_sha256": item["scope"]["sha256"]})
    if admitted != set(selected):
        fail("actual evidence does not cover every train/dev/conditional row")
    _fences(spec, evidence, admission, panels, inherited)
    _VERIFIED_OVERLAP.update(pending_overlap)
    return {"schema": SCHEMA, "admission_rows": len(admitted), "roles": {role: len(values) for role, values in panels.items()},
            "scopes": summaries, "native_asr_role": "diagnostic_only", "protected_rows": 170,
            "verified_aligned_overlap_rows": len(pending_overlap),
            "actual_runtime_cache_must_still_be_verified": True, "models_loaded": False}
