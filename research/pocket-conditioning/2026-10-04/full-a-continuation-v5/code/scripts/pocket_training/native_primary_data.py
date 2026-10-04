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
QUOTE_POLICY = "authenticated_native_rendered_primary_quote_v3"
QUOTE_RENDERER_SHA = "5ac9940401d6e7072959b682b042ef3cc0f6d1874c53af45c67a9a751c2dbe28"
QUOTE_GUARDED_WORKER_SHA = "7505765bc16a612f3754787e5ad3a0b3cf6165629718e5454c08aee805c252ac"
QUOTE_SOURCE_GATE_SHA = "705e43b7ec14ed5e5a18245a8e7493f6fe1be558009da17968d33f6e69d0310a"
QUOTE_DERIVATION = {
    "path": "runtime/voice-data-expansion-20261004/qualification/native-quote-v3-derivation.json",
    "sha256": "3fad4b023c74a31444bcbc0bcfc6bab3b3de43a14a47a40b8efedaaa3f39ac60",
}
REFERENCE_SHA = "4da896fa3becef9a67106a2d3645753428c17adfd5efa24b8b92a2284972ba76"
LEGACY_BUNDLE_SHA = "297fda549036dec15b6b137b910e1872aec30f123d901213894843d6e6ff577c"
_VERIFIED_OVERLAP = set()
SHORT_KIND = "native_rendered_primary_short_fallback_cache"
SHORT_CONDITIONING = "official_aligned_short_fallback_v1"
SHORT_LOADER_POLICY = "upstream-aligned-no-cut-fallback-v1"
EDGE_KIND = "native_rendered_primary_edge_cache"
LOCAL_STT_KIND = "local_stt_source_preserved_edge_cache"
LOCAL_STT_POLICY = "authentic_audio_local_stt_source_preserved_v1"
LOCAL_STT_WORKER_SHA = "265df4c97930c58c55be3027b52b0015c1747820c3318e4a8aa0d40e0463ef25"
LOCAL_STT_CONTRACT = {
    "path": "runtime/voice-data-expansion-20261004/qualification/local_stt_contract_v1.py",
    "sha256": "71d50e9f6f924a97c2f55c1551af1ee32d012742f71029d0d8963f3910f43659",
}
LOCAL_STT_TARGET_PROOFS = {
    "8ae6ee8be50172d6b4c93421f89fefa4ac257943b3400a7d4f5eb8d933afcc80": {
        "source_gate_sha256": "05289b5e79d432cbbc7cb557b06753a38353e621f20986af998777bf9d62c253",
        "ids": {"songbird/3495705299552411648/female/vo/ff3427366f16e3e3"},
    },
    "e9eefa62f3f405f43a9b32a78d7fefbaadb3f342c731bc13733b9c191616189d": {
        "source_gate_sha256": "be81332e2de98e97ee69c76884ec4523b08a919c3e465682511ccccc665e3377",
        "ids": {"songbird/3540288133960933376/female/vo/42294ecfd17ce3c5",
                "songbird/2953435567175458816/female/vo/9b4951a21b0556a2",
                "songbird/3001425086610124800/female/vo/c1a089705f179548"},
    },
}
BANK_SOURCE_SUPERSESSION_SHA = "1559b2b105f2154e3684914bd38fbf9a0737f08eeacb8bcb477b259a7d56c194"
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
    LOCAL_STT_KIND: (
        LOCAL_STT_POLICY, "voice_local_stt_source_preserved_edge_stitched_scope_v1",
        "voice_local_stt_source_preserved_edge_stitched_codec_cache_loader_proof_v1", LOCAL_STT_WORKER_SHA),
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
NUMERIC_WORKERS = {
    "526f49ad458a9cd493f8bcbd5a06b27e8d91637ee058c6fd9fb8e377baf06958": "kerry_single",
    "310921ef32ec36d626e5a893f91608fbc81be1825c68a9ab55fb2cbd10df1b7b": "reviewed_three",
    "c3a1d3100ad070ec7145558529bd7eefaf26e331eb7dd0f617ecbdd26f168c79": "reviewed_two_punctuation",
}
KERRY_NUMERIC_MAP_SHA = "04f6b04f2ed44aa57415f719a5c712508a3c23f81caa2d489cb9d596f1da63a5"
THREE_NUMERIC_MAP_SHA = "7b1836553c446b6fc5801487dcdafd61c981aa273a0ae59bc86343387df778f2"
THREE_NUMERIC_SOURCE_MAP = {
    "path": "runtime/voice-data-expansion-20261004/qualification/batch-602-source/pronunciation-map.json",
    "sha256": "3c977c03ceb073245edcb4e1fe92477ef635e27156081d10787e259c8ceb2f73",
}
TWO_NUMERIC_SOURCE_MAP = {
    "path": "runtime/voice-data-expansion-20261004/qualification/batch-603-source/pronunciation-map.json",
    "sha256": "a9fce250c3f7ae1f17fbde3b2ea1e24640463c0f81ac7d9243637f514779270e",
}
TWO_NUMERIC_SOURCE_INPUTS = {
    "path": "runtime/voice-data-expansion-20261004/qualification/batch-603-source/inputs.jsonl",
    "sha256": "657e9a0b96f3194c3c874864b79f2ac6795bfdc697649cd2359ab28e4d8d7523",
}
TWO_NUMERIC_DERIVATION = {
    "path": "runtime/voice-data-expansion-20261004/qualification/numeric-recovery-v2-derivation.json",
    "sha256": "6b0bc3d4152c48335709732469a0e6a50a0dea38d6414d5bec5ad35c562f3860",
}
# Expected LF bytes are derived from the pinned worker's exact emit semantics.
# Actual completed run/readback must confirm them before corpus admission.
TWO_NUMERIC_MAP_SHA = "a286af70e152465c1996e292f1a132818506e83ad2daff14bef020def9a8169b"


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
    if kind == EDGE_KIND and scope.get("qualification_policy") == QUOTE_POLICY:
        return (QUOTE_POLICY, KINDS[EDGE_KIND][1], KINDS[EDGE_KIND][2], QUOTE_GUARDED_WORKER_SHA)
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
    if not isinstance(raw, str) or not raw.strip() or renderer_sha not in (RENDERER_SHA, RENDERER_V2_SHA, QUOTE_RENDERER_SHA):
        fail("nonempty native text and an explicitly reviewed renderer are required")
    quote = renderer_sha == QUOTE_RENDERER_SHA
    version2 = renderer_sha in (RENDERER_V2_SHA, QUOTE_RENDERER_SHA)
    language = translation = None
    base = {"policy": "cyberpunk-native-spoken-text-v2" if version2 else "cyberpunk-native-spoken-text-v1", "original_native_text": raw,
            "original_native_text_sha256": td.text_sha(raw), "native_caption_primary": True,
            "asr_text_substituted": False, "training_admission_decided": False}
    if quote:
        base["policy"] = "cyberpunk-native-spoken-text-quote-v3"
    if "<" not in raw and ">" not in raw:
        spoken, rule, proof = raw, "plain_native_passthrough", None
    else:
        tag = re.fullmatch(r"<(?P<kind>mothertongue|kiroshi)\s+(?P<attributes>[^<>]*)/\s*>", raw.strip(), re.DOTALL)
        if tag is None:
            fail("unsupported native markup requires separate engine evidence")
        fields, cursor, content = {}, 0, tag["attributes"]
        pattern = (r'([A-Za-z_][A-Za-z_0-9-]*)\s*=\s*"((?:\\"|[^"<>\\])*)"' if quote
                   else r'([A-Za-z_][A-Za-z_0-9-]*)\s*=\s*"([^"<>]*)"')
        for match in re.finditer(pattern, content):
            if content[cursor:match.start()].strip() or match[1] in fields:
                fail("native markup attributes are ambiguous")
            fields[match[1]], cursor = match[2].replace(r'\"', '"') if quote else match[2], match.end()
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
    if quote:
        result["quote_grammar_extension"] = {"rule": "backslash_quote_is_one_literal_quote_in_attribute_v1",
            "applied": r'\"' in raw, "exact_escaped_specimen_observed_in_game": False,
            "authority": "bounded attribute grammar inference; existing native b+o/m+a semantics retained",
            "other_backslash_escapes_supported": False}
    return result


def _same_recording(target, original):
    fields = ("id", "speaker_id", "source_panel", "audio_sha256", "pcm_sha256", "source_wem_sha256",
              "source_row_sha256", "duration", "sample_rate", "channels", "native_frames", "path",
              "string_id", "gender_variant", "scenes", "source_delivery", "raw_receipt")
    if any(target.get(key) != original.get(key) for key in fields):
        fail("derived/native scope changed the authenticated recording or delivery")


def _targets(evidence, descriptor, policy="authenticated_native_rendered_primary_v1"):
    if policy == LOCAL_STT_POLICY:
        return _local_stt_targets(evidence, descriptor)
    receipt = evidence.document(descriptor)
    if receipt.get("qualification_policy") != policy:
        fail("unsupported native target receipt")
    if policy == QUOTE_POLICY and receipt["original_source_gate"]["sha256"] != QUOTE_SOURCE_GATE_SHA:
        fail("quote grammar extension is restricted to its three reviewed original recordings")
    originals, unused = _source_gate(evidence, receipt["original_source_gate"])
    if (evidence.document(receipt["original_source_gate"]).get("native_caption_matches_actual_bank_audio") is False
            or any(row.get("native_caption_matches_actual_bank_audio") is False for row in originals.values())):
        fail("audited bank-caption mismatch requires its separate actual STT-authority route")
    renderer = receipt["native_renderer"]
    expected_renderer = QUOTE_RENDERER_SHA if policy == QUOTE_POLICY else RENDERER_V2_SHA if policy == SHORT_V2_CONTRACT[0] else RENDERER_SHA
    if renderer["sha256"] != expected_renderer:
        fail("native renderer is not the reviewed engine-proven source")
    evidence.descriptor(renderer)
    evidence.descriptor(PARSER_PROOF)
    if renderer["sha256"] in (RENDERER_V2_SHA, QUOTE_RENDERER_SHA):
        evidence.descriptor(KIROSHI_PROOF)
    if policy == QUOTE_POLICY:
        evidence.descriptor(QUOTE_DERIVATION)
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


def _local_stt_targets(evidence, descriptor):
    """One explicit approved source-preserving STT route, never native equality."""
    approved = LOCAL_STT_TARGET_PROOFS.get(descriptor["sha256"])
    if approved is None:
        fail("local STT target proof is not one of the root-reviewed exact bank corrections")
    proof = evidence.document(descriptor)
    if (proof.get("schema") != "voice_local_stt_source_preserved_targets_v1"
            or proof.get("qualification_policy") != LOCAL_STT_POLICY
            or proof["original_source_gate"]["sha256"] != approved["source_gate_sha256"]
            or proof.get("source_audio_or_native_caption_changed") is not False
            or proof.get("training_admitted") is not False):
        fail("separate STT target proof lost its exact original source/boundary")
    evidence.descriptor(proof["source_code"])
    evidence.descriptor(LOCAL_STT_CONTRACT)
    originals, unused = _source_gate(evidence, proof["original_source_gate"])
    if evidence.document(proof["original_source_gate"]).get("native_caption_matches_actual_bank_audio") is True:
        fail("local STT correction cannot relabel an explicitly matching native bank")
    targets = _indexed(rows(evidence.resolve(_sibling(descriptor["path"], "inputs.jsonl"), proof["inputs_sha256"])), "local STT targets")
    authorities = _indexed(proof["rows"], "exact local STT authorities")
    if set(targets) != approved["ids"] or set(targets) != set(authorities) or not set(targets) <= set(originals):
        fail("local STT correction changed its bounded approved recording inventory")
    for key, target in targets.items():
        original, authority = originals[key], authorities[key]
        _same_recording(target, original)
        bank = authority["source_bank_binding"]
        expected_id = "/".join((original["speaker_id"], str(original["string_id"]), original["gender_variant"],
                                "vo", original["source_wem_sha256"][:16]))
        expected_bank = {"delivery_bank": "vo", "derived_id": expected_id, "original_id": original["original_id"],
            "source_wem_sha256": original["source_wem_sha256"], "wem_depot": original.get("wem_depot")}
        if (key != expected_id or bank != expected_bank or target.get("original_id") != original["original_id"]
                or original.get("delivery_bank") != "vo" or target.get("delivery_bank") != "vo"
                or original.get("native_caption_matches_actual_bank_audio") is not False):
            fail("local STT target lost its explicit bank-distinct original media identity")
        if (authority["original_native_source_identity"] != td.identity(original)
                or authority["original_native_text"] != original["native_text"]
                or authority["original_native_text_sha256"] != original["native_text_sha256"]):
            fail("local STT target replaced the immutable original lookup caption/source")
        run = evidence.document(authority["stt_run_proof"])
        old_inputs = _indexed(rows(evidence.descriptor(authority["stt_input_proof"])), "actual STT source inputs")
        old_identity = authority["original_stt_input_identity"]
        old = old_inputs[old_identity["id"]]
        if (run.get("input_manifest_sha256") != authority["stt_input_proof"]["sha256"]
                or run.get("hypotheses_sha256") != authority["stt_hypotheses_proof"]["sha256"]
                or run.get("model_id") != "openai/whisper-large-v3-turbo"):
            fail("STT authority's exact input/model/raw hypothesis receipts differ")
        evidence.descriptor(authority["stt_hypotheses_proof"])
        actual = _alignment(evidence, authority["stt_run_proof"], "whisper", authority["stt_input_proof"]["sha256"])[old_identity["id"]]
        if (actual.get("status") != "audited" or actual["source_identity"] != old_identity
                or td.identity(old) != old_identity or old_identity["id"] != original["original_id"]):
            fail("STT hypothesis lost its original cross-ID source identity")
        for name in ("speaker_id", "audio_sha256", "pcm_sha256", "source_wem_sha256"):
            if original[name] != old[name] or original[name] != old_identity[name]:
                fail("STT target crossed the immutable speaker/WEM/WAV/PCM tuple")
        raw, text = actual["raw_hypothesis"], actual["raw_hypothesis"].strip()
        if (not text or authority.get("authority") != "local_stt" or authority.get("raw_stt_text") != raw
                or authority.get("transform") != "strip_leading_trailing_whitespace_only_v1"
                or authority.get("training_transcript") != text
                or authority.get("training_transcript_sha256") != td.text_sha(text)
                or any(target.get(name) != authority.get(name) for name in authority if name != "id")
                or target.get("native_text") != text or target.get("transcript") != text
                or target.get("native_text_sha256") != td.text_sha(text)
                or target.get("transcript_authority") != "local_stt" or target.get("native_caption_primary") is not False
                or target.get("asr_text_substituted") is not True
                or target.get("source_audio_or_native_caption_changed") is not False):
            fail("STT speech target is not exact actual recognition plus declared whitespace stripping")
        td.identity(target)
    return targets, proof["inputs_sha256"]


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


def _numeric_words(row, actual, mapping, *, punctuation_null=False):
    """Verify ordered native-token partition and real expanded/merged spans."""
    native, labels = row["native_text"].split(), mapping["alignment_words"]
    positions = mapping["native_to_alignment_token_indices"]
    declarations = mapping["mapped_numeric_tokens"]
    if (mapping.get("source_identity") != td.identity(row) or mapping.get("native_words") != native
            or mapping.get("training_caption_changed") is not False or mapping.get("timings_will_be_actual_ctc") is not True
            or len(positions) != len(native) or not declarations
            or any(not isinstance(group, list) or not group or any(type(i) is not int for i in group) for group in positions)
            or [i for group in positions for i in group] != list(range(len(labels)))):
        fail("numeric pronunciation map lost the exact source or ordered native-token partition")
    mapped = {item["original_token_index"]: item for item in declarations}
    if len(mapped) != len(declarations) or any(type(i) is not int or not 0 <= i < len(native) for i in mapped):
        fail("numeric pronunciation declarations are duplicated or out of bounds")
    for index, (word, indices) in enumerate(zip(native, positions, strict=True)):
        selected = [labels[i] for i in indices]
        if index in mapped:
            item = mapped[index]
            pattern = r"\d[\d,.…-]*" if punctuation_null else r"\d[\d,.-]*"
            if (re.fullmatch(pattern, word) is None or item["original_token"] != word
                    or item["alignment_token_indices"] != indices or item["alignment_tokens"] != selected):
                fail("numeric declaration differs from its actual native token and pronunciation labels")
        elif selected != [word]:
            fail("numeric recovery rewrote an ordinary native token")
    expanded = actual.get("expanded_alignment_words")
    if not isinstance(expanded, list) or [word.get("word") for word in expanded] != labels:
        fail("numeric alignment does not carry every actual expanded CTC word")
    previous = 0.
    for word in expanded:
        start, end = word.get("start"), word.get("end")
        if punctuation_null and not td.compact(word["word"]):
            if start is not None or end is not None:
                fail("punctuation-only numeric recovery token invented an acoustic span")
            continue
        if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end))
                or not previous <= start < end <= row["duration"]):
            fail("numeric expanded CTC spans are missing, nonfinite or unordered")
        previous = end
    merged = [{"word": word, "start": expanded[indices[0]]["start"], "end": expanded[indices[-1]]["end"]}
              for word, indices in zip(native, positions, strict=True)]
    if actual.get("words") != merged:
        fail("numeric native-token spans are not the exact merge of actual expanded CTC spans")


def _native_alignment(evidence, descriptor, originals, input_sha, scoped):
    """Admit only the explicit, authenticated numeric subset derivations."""
    run = evidence.document(descriptor)
    single, multiple = run.get("alignment_pronunciation_mapping"), run.get("alignment_pronunciation_mappings")
    if single is None and multiple is None:
        return _alignment(evidence, descriptor, "ctc", input_sha)
    route = NUMERIC_WORKERS.get(run["source_code"]["sha256"])
    if route is None or run.get("word_timings_are_actual_ctc_not_interpolated") is not True:
        fail("numeric alignment is not an explicitly reviewed actual CTC mapper")
    subset = _indexed(rows(evidence.resolve(_sibling(descriptor["path"], "inputs.jsonl"), run["input_manifest_sha256"])), "numeric alignment subset")
    if (not 1 <= len(subset) <= 128 or len(subset) != run["input_rows"]
            or not set(subset) <= set(originals) or not set(scoped) <= set(subset)):
        fail("numeric alignment subset differs from its full authenticated native target cohort")
    for key, row in subset.items():
        _same_recording(row, originals[key])
        if td.identity(row) != td.identity(originals[key]) or row["native_text"] != originals[key]["native_text"]:
            fail("numeric subset changed an original native target identity")
    map_path = _sibling(descriptor["path"], "pronunciation-map.json")
    if route == "kerry_single":
        if single is None or multiple is not None or set(subset) != {"kerry-eurodyne/1828593430513278976/female"}:
            fail("Kerry pronunciation route is not its exact one-recording subset")
        pinned = evidence.json(map_path, KERRY_NUMERIC_MAP_SHA)
        if single != pinned:
            fail("Kerry run rewrote its reviewed pronunciation map")
        key, row = next(iter(subset.items()))
        native = row["native_text"].split(); position = single["original_token_index"]
        if type(position) is not int or not 0 <= position < len(native) or native[position] != single["original_token"]:
            fail("Kerry original numeric token changed")
        labels, groups = [], []
        for index, token in enumerate(native):
            replacement = single["alignment_tokens"] if index == position else [token]
            groups.append(list(range(len(labels), len(labels)+len(replacement)))); labels.extend(replacement)
        mapping = {"source_identity": td.identity(row), "native_words": native, "alignment_words": labels,
            "native_to_alignment_token_indices": groups,
            "mapped_numeric_tokens": [{name: single[name] for name in ("original_token_index", "original_token", "alignment_token_indices", "alignment_tokens")}],
            "training_caption_changed": single["training_caption_changed"], "timings_will_be_actual_ctc": True,
            "diagnostic_run": {"path": single["independent_run_path"], "sha256": single["independent_run_sha256"]},
            "diagnostic_hypotheses_sha256": single["independent_hypothesis_sha256"]}
        maps = {key: mapping}; expected_actual_maps = {key: single}
    else:
        expected_map = TWO_NUMERIC_MAP_SHA if route == "reviewed_two_punctuation" else THREE_NUMERIC_MAP_SHA
        source_map = TWO_NUMERIC_SOURCE_MAP if route == "reviewed_two_punctuation" else THREE_NUMERIC_SOURCE_MAP
        if single is not None or not isinstance(multiple, dict) or run.get("pronunciation_map_sha256") != expected_map:
            fail("Bounded numeric recovery lost its exact reviewed map identity")
        packet = evidence.json(map_path, expected_map)
        # The pinned worker emitted LF JSON from the original CRLF packet.
        # Keep both exact byte identities and require unchanged map semantics.
        if packet != evidence.document(source_map):
            fail("Actual numeric map changed the reviewed original source-map semantics")
        if (packet.get("schema") != "caption_preserving_numeric_pronunciation_mapping_v1"
                or packet.get("original_audio_or_caption_edited") is not False or packet.get("training_admitted") is not False):
            fail("Three-row numeric map changed its caption-preserving boundary")
        maps = _indexed(packet["rows"], "reviewed numeric pronunciation maps")
        if maps != multiple or set(maps) != set(subset):
            fail("Three-row numeric run differs from the reviewed map/subset inventory")
        expected_actual_maps = maps
        if route == "reviewed_two_punctuation":
            evidence.descriptor(TWO_NUMERIC_DERIVATION)
            proof = run.get("input_subset_proof")
            if (run.get("input_pronunciation_map_proof") != TWO_NUMERIC_SOURCE_MAP
                    or not isinstance(proof, dict) or proof.get("sha256") != input_sha
                    or run.get("punctuation_only_null_span_policy") != "preserve_actual_upstream_null_spans_v1"):
                fail("Punctuation-aware recovery lost its exact source subset/map or actual-null policy")
            original_subset = _indexed(rows(evidence.descriptor(proof)), "punctuation mapper original subset")
            raw_subset = _indexed(rows(evidence.descriptor(TWO_NUMERIC_SOURCE_INPUTS)), "reviewed two raw originals")
            if original_subset != subset or set(raw_subset) != set(subset) or len(subset) != 2:
                fail("Punctuation-aware recovery changed the original or re-emitted two-row subset")
            for key, row in raw_subset.items():
                _same_recording(row, subset[key])
                if td.identity(row) != td.identity(subset[key]) or row["native_text"] != subset[key]["native_text"]:
                    fail("Punctuation-aware subset lost either reviewed original caption/source")
    alignment = _alignment(evidence, descriptor, "ctc", run["input_manifest_sha256"])
    if set(alignment) != set(subset):
        fail("Numeric actual CTC outputs do not cover the exact input subset")
    for key, mapping in maps.items():
        row, actual = subset[key], alignment[key]
        if actual.get("source_identity") != td.identity(row) or actual.get("alignment_pronunciation_mapping") != expected_actual_maps[key]:
            fail("Numeric actual hypothesis lost its original source or pronunciation map")
        diagnostic_run = evidence.document(mapping["diagnostic_run"])
        if diagnostic_run.get("hypotheses_sha256") != mapping["diagnostic_hypotheses_sha256"]:
            fail("Numeric acoustic diagnostic hypotheses changed")
        diagnostic = _alignment(evidence, mapping["diagnostic_run"], "ctc")[key]
        if diagnostic["source_identity"] != td.identity(row):
            fail("Numeric pronunciation diagnostic belongs to a different original recording")
        if route == "kerry_single":
            if "TWENTY TWENTY" not in diagnostic["raw_hypothesis"]:
                fail("Kerry numeric expansion lost its actual acoustic pronunciation evidence")
        elif diagnostic["raw_hypothesis"] != mapping["diagnostic_raw_hypothesis"]:
            fail("Numeric map rewrote its diagnostic acoustic evidence")
        _numeric_words(row, actual, mapping, punctuation_null=route == "reviewed_two_punctuation")
    return alignment


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
    edge = item["kind"] in (EDGE_KIND, LOCAL_STT_KIND)
    allowed_helpers = {helper_sha, EDGE_GUARDED_WORKER_SHA} if item["kind"] == EDGE_KIND and policy != QUOTE_POLICY else {helper_sha}
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
        if result["helper_source_sha256"] in (EDGE_GUARDED_WORKER_SHA, QUOTE_GUARDED_WORKER_SHA, LOCAL_STT_WORKER_SHA):
            _verify_edge_gpu_guard(evidence, result)
        elif "gpu_headroom_probe_receipt" in result or "native_gpu_headroom_guard" in result["source_sha256"]:
            fail("original edge worker cannot claim the later resource guard")
    short = item["kind"] in (SHORT_KIND, EDGE_KIND, LOCAL_STT_KIND)
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
        alignment = _native_alignment(evidence, scope["alignment_source_proof"], originals, input_sha, indexed)
        for key, row in indexed.items():
            original = originals[key]
            _same_recording(row, original)
            if td.identity(row) != td.identity(original) or row["native_text"] != original["native_text"]:
                fail("scope does not bind the exact original/native-rendered caption")
            if kind == "native_primary_cache" and ("<" in row["native_text"] or ">" in row["native_text"]):
                fail("markup requires the separate rendered policy")
            if kind in ("native_rendered_primary_cache", SHORT_KIND, EDGE_KIND, LOCAL_STT_KIND):
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


def conditional_scene_exposure(row, historical_scenes, current_final_train_scenes):
    """Describe final conditional exposure without rewriting source history."""
    scenes = _scenes(row)
    historical = sorted(scenes & historical_scenes)
    current = sorted(scenes & current_final_train_scenes)
    if not historical and not current:
        fail("conditional evaluation has no historical or current-final TRAIN scene exposure")
    classification = "both" if historical and current else "historical_train" if historical else "current_final_train"
    return {"classification": classification, "historical_intersecting_scenes": historical,
            "current_final_train_intersecting_scenes": current}


def _historical_caption_aliases(row):
    # Unscoped legacy text is not a global veto. Use only known speaker/text
    # pairs from actual history, including its rich canonical-text records.
    speaker = _speaker(row)
    if not speaker:
        # The immutable prior-core ledger records speaker only in its exact
        # cast-slug/localization-ID tuple, not in a separate speaker field.
        parts = str(row.get("id", "")).split("/")
        if len(parts) == 2 and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", parts[0]) and re.fullmatch(r"[0-9]+", parts[1]):
            speaker = parts[0]
    if not speaker:
        return set()
    texts = (row.get("text"), row.get("transcript"), row.get("native_text"),
             row.get("original_native_text"), row.get("canonical_text"), *row.get("transcript_aliases", []))
    return {(speaker, td.compact(text)) for text in texts if isinstance(text, str) and text.strip()}


def _verify_conditional_scene_exposure(row, historical_scenes, train_scenes, historical_captions):
    if _captions(row) & historical_captions:
        fail("new conditional evaluation repeats a historically trained same-character utterance")
    exposure = conditional_scene_exposure(row, historical_scenes, train_scenes)
    if row.get("conditional_scene_exposure") != exposure:
        fail("new conditional scene classification/intersections differ from exact history and final TRAIN")
    return exposure


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
    historical, historical_scenes, historical_captions = set(), set(), set()
    for row in history:
        if row.get("id"):
            historical |= _recordings(row)
        historical_scenes |= _scenes(row)
        historical_captions |= _historical_caption_aliases(row)
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
                if role == "teacher_conditional":
                    _verify_conditional_scene_exposure(row, historical_scenes, train_scenes, historical_captions)


def _target_supersessions(evidence, admission, panels):
    """Bind the exact three replacement targets and the one explicit MAIN hold."""
    descriptor = admission.get("target_supersessions")
    if descriptor is None:
        corrected_ids = LOCAL_STT_TARGET_PROOFS["e9eefa62f3f405f43a9b32a78d7fefbaadb3f342c731bc13733b9c191616189d"]["ids"]
        if any(row["id"] in corrected_ids for values in panels.values() for row in values):
            fail("corrected MAIN admission lacks its exact old/new target supersession ledger")
        return None
    ledger = evidence.document(descriptor)
    if ledger.get("schema") != "qualified_corpus_target_supersession_ledger_v1":
        fail("unsupported target supersession ledger")
    source_descriptor = ledger["source_supersession_ledger"]
    if source_descriptor["sha256"] != BANK_SOURCE_SUPERSESSION_SHA:
        fail("target supersession is not the exact root-reviewed bank source correction")
    source = evidence.document(source_descriptor)
    if source.get("schema") != "exact_songbird_bank_pair_supersession_source_ledger_v1" or source.get("old_originals_and_qualification_unchanged") is not True:
        fail("bank source supersession lost its immutable old-source boundary")
    evidence.descriptor(source["source_adapter"])
    evidence.descriptor(source["actual_main_stt_run"])
    evidence.descriptor(source["actual_holo_ctc_run"])
    if ledger["current_corpus_hold_ledger"] != source["existing_corpus_hold_ledger"]:
        fail("target supersession changed its exact source-corpus hold ledger")
    evidence.descriptor(ledger["current_corpus_hold_ledger"])
    originals = _indexed([{**row, "id":row["original_id"]} for row in source["rows"]], "source bank supersessions")
    replacements = {key:row for key,row in originals.items() if row["main_stt_target_selected"]}
    actual = _indexed([{**row, "id":row["old_recording_id"]} for row in ledger["rows"]], "qualified target supersessions")
    if len(actual) != 3 or set(actual) != set(replacements):
        fail("qualified supersession does not contain exactly the three approved MAIN replacements")
    selected = {row["id"]:row for values in panels.values() for row in values}
    for key, item in originals.items():
        membership = item["original_qualification_membership"]
        old_rows = rows(evidence.descriptor(membership["manifest"]))
        pointer = membership["row_pointer"]
        if re.fullmatch(r"/[0-9]+", pointer) is None or int(pointer[1:]) >= len(old_rows):
            fail("old bank supersession row pointer is invalid")
        old = old_rows[int(pointer[1:])]
        if old["id"] != key or td.identity(old) != item["original_source_identity"]:
            fail("old bank supersession changed its immutable source membership")
        evidence.descriptor(item["original_raw_receipt"])
        evidence.descriptor(membership["scope"])
        old_result = evidence.document(membership["cache_result"])
        if old_result.get("status") != "completed" or old_result.get("model_released") is not True:
            fail("old source membership lacks its completed actual cache receipt")
        if key in selected:
            fail("superseded or held old MAIN/native target remains in the final corpus")
        same_media = [row for row in selected.values() if any(row.get(name) == old[name]
            for name in ("source_wem_sha256", "audio_sha256", "pcm_sha256"))]
        if not item["main_stt_target_selected"]:
            if same_media:
                fail("ambiguous held MAIN waveform was admitted through another target/ID")
            continue
        replacement = actual[key]
        expected_new = next(row["id"] for row in item["new_bank_sources"] if row["bank"] == "vo")
        if (replacement["old_membership"] != membership or replacement["old_source_identity"] != td.identity(old)
                or replacement["new_recording_id"] != expected_new or expected_new not in selected
                or not replacement.get("reason")):
            fail("qualified MAIN replacement does not bind its exact old and selected new membership")
        new = selected[expected_new]
        if (replacement["new_source_identity"] != td.identity(new) or len(same_media) != 1
                or same_media[0]["id"] != expected_new or new.get("transcript_authority") != "local_stt"
                or _speaker(old) != _speaker(new)
                or any(old[name] != new[name] for name in ("source_wem_sha256", "audio_sha256", "pcm_sha256"))):
            fail("MAIN target supersession changed media/speaker or retained duplicate old targets")
        new_membership = replacement["new_membership"]
        new_rows = rows(evidence.descriptor(new_membership["manifest"]))
        new_pointer = new_membership["row_pointer"]
        if re.fullmatch(r"/[0-9]+", new_pointer) is None or int(new_pointer[1:]) >= len(new_rows):
            fail("new bank supersession row pointer is invalid")
        observed = new_rows[int(new_pointer[1:])]
        if td.identity(observed) != td.identity(new) or td.model_payload(observed) != td.model_payload(new):
            fail("new supersession membership differs from actual aligned/cache-qualified target")
        target = replacement["target_proof"]
        if target["sha256"] not in LOCAL_STT_TARGET_PROOFS:
            fail("new supersession target is not one of the exact approved STT proofs")
        scope = evidence.document(new_membership["scope"])
        if scope["target_proof"] != target or scope["alignment_source_proof"] != replacement["alignment_source_proof"]:
            fail("target supersession changed its actual scope/alignment links")
        evidence.descriptor(target)
        evidence.descriptor(replacement["alignment_source_proof"])
        if replacement["cache_result"] != new_membership["cache_result"]:
            fail("target supersession changed its actual new cache result")
        result = evidence.document(replacement["cache_result"])
        if (result.get("status") != "completed" or result.get("model_released") is not True
                or result.get("qualification_policy") != LOCAL_STT_POLICY):
            fail("new supersession target lacks its completed actual STT codec receipt")
    return {"approved_main_replacements":3, "held_main_waveforms":1, "original_artifacts_modified":False}


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
            # A final heldout assignment does not rewrite the source run's
            # original qualification role or its historical metadata.
            for name in ("cache_scope_role", "previous_training_seen", "previous_training_scene_seen",
                         "historical_evaluation_protected", "role_reservation"):
                if name in original and row.get(name) != original[name]:
                    fail("final role assignment changed an existing source/history flag or qualification role")
                if name.startswith("previous_training_") and name not in original and row.get(name) is True:
                    fail("final role assignment invented a historical source flag")
            if kind == "legacy_bundle" and row.get("conditional_scene_exposure") != original.get("conditional_scene_exposure"):
                fail("inherited legacy conditional metadata was rewritten")
            admitted.add(key)
            for name in ("original_id", "delivery_bank", "native_caption_matches_actual_bank_audio"):
                if row.get(name) != original.get(name):
                    fail("staged row lost its actual bank/canonical-source binding")
            if kind == LOCAL_STT_KIND:
                for name in ("authority", "native_caption_primary", "asr_text_substituted", "raw_stt_text", "transform",
                             "source_bank_binding", "stt_input_proof", "stt_run_proof", "stt_hypotheses_proof", "original_stt_input_identity"):
                    if row.get(name) != original.get(name):
                        fail("staged STT target lost its exact authority or original-media provenance")
            if kind in (SHORT_KIND, EDGE_KIND, LOCAL_STT_KIND) and original["sampling_mode"] == "aligned_full_utterance_fallback":
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
    supersessions = _target_supersessions(evidence, admission, panels)
    _VERIFIED_OVERLAP.update(pending_overlap)
    return {"schema": SCHEMA, "admission_rows": len(admitted), "roles": {role: len(values) for role, values in panels.items()},
            "scopes": summaries, "native_asr_role": "diagnostic_only", "protected_rows": 170,
            "verified_aligned_overlap_rows": len(pending_overlap),
            "explicit_local_stt_target_rows": sum(row.get("transcript_authority") == "local_stt" for values in panels.values() for row in values),
            "target_supersessions": supersessions,
            "actual_runtime_cache_must_still_be_verified": True, "models_loaded": False}
