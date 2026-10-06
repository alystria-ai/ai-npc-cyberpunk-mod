"""Build the combat / shouted-delivery flags for every pool and dataset clip -> scripts/phone_detect/combat-flags.json.

    vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/combat_flags/build_flags.py [--out scripts/phone_detect/combat-flags.json]

Signals, strongest first (see source_signal.py for the game-metadata part):
  1. GAME METADATA (primary).  Every line is played by a scene.  A voiceset bark with a combat trigger, a line in the Combat voice
     context, or a quest line played by a fight trigger (bossfight / low health / reinforcements) is combat at the source.  Alert barks, scenes
     that are fights by name or by their triggers, and shouting VO events are moderate evidence.  Social barks (greeting, bump, phone)
     and plain dialogue carry none.
  2. ACOUSTICS, relative to each voice's conversational baseline (robust median / MAD over the voice's clips that the game does not mark
     as combat; shrunk toward the pooled spread for small voices): loudness (RMS and short-term p90), push (p90-p50), pitch level and
     range, brightness (alpha ratio, spectral tilt, 4-12 kHz share), strain (HNR down), speech rate.  A logistic model learns the weights
     FROM THE GAME'S OWN LABELS (strong-source barks and fight lines versus ordinary quest dialogue), cross-validated by voice, then scores
     every clip, so lines the metadata cannot classify (no scene, or ordinary scene) still get a delivery score.
  3. ECAPA distance from the voice's conversational centroid (robust z), one weak feature of the model.
  4. TRANSCRIPT cues (exclamations, ALL CAPS, combat words, imperatives): a small bonus.
  5. DURATION: only a tie-breaker inside the undecided band (very short exclamations lean combat, long lines lean conversation).
Decision: strong source evidence -> combat.  Otherwise a logit = model + source prior (moderate +, ambient 0, conversation -) + text + duration
tie-break; combat when it passes the threshold, chosen so that the model flags about FP_TARGET of ordinary quest dialogue.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_signal as ss  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORK = Path("E:/CyberpunkConvai-offload/work/combat-flags")
OUT = ROOT / "scripts/phone_detect/combat-flags.json"
SHOWN = ROOT / "scripts/reference-picker/shown-voices.json"
ADAM_PICKS = ["1653087655475433472", "1776711517152501760", "1876330591075450880", "1876331655187152896", "1995324830177058816",
              "1995048870861103104", "1995076448980328448", "1792270501449261056", "1792271201864474624", "1792275223900020748", "1792275223900020764"]

SPLIT_COSINE, SPLIT_MIN = 0.6, 25   # a voice splits into per-performer baselines when 2-means centroids are this dissimilar
FP_TARGET = 0.02          # share of ordinary quest dialogue the acoustic model may flag on its own (out-of-fold)
MIN_BASELINE = 40         # clips a voice needs for its own baseline; below that the pooled spread is blended in
SHRINK = 20               # pseudo-count of the pooled MAD in the blended spread
N_AC = 12                 # acoustic features (the 13th, the ECAPA distance, is added with a small fixed weight)
EMB_WEIGHT = 0.15         # logit per robust sd of ECAPA distance above the conversational centroid (0 to 4 sd)
FEATURES = ["z_rms", "z_stl90", "z_push", "z_f0", "z_f0hi", "z_f0rng", "z_alpha", "z_tilt", "z_hb4", "z_centroid", "z_hnr", "z_wps", "z_emb"]
COMBAT_WORDS = re.compile(r"\b(kill|killed|die|dies|dead|death|fire|shoot|shot|shots|gun|guns|bullet|bullets|blood|attack|enemy|enemies|grenade|cover|reload|reloading|"
                          r"run|move|behind|ambush|hostile|flank|hit|hits|down|drop|freeze|stop|back off|get out|get down|watch out|incoming|charge|"
                          r"fuck you|bastard|scum|bitch|asshole|motherfucker|pathetic|insect|worm|meat|crush|destroy|rip|burn)\b", re.I)
EXCLAIM = re.compile(r"!")
ALLCAPS = re.compile(r"\b[A-Z]{3,}\b")
PROCESSED = re.compile(r"holocall|rewind|helmet")


def load_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def robust(values: np.ndarray) -> tuple[float, float]:
    values = values[np.isfinite(values)]
    if len(values) < 3:
        return float("nan"), float("nan")
    median = float(np.median(values))
    return median, float(np.median(np.abs(values - median)) * 1.4826)


def text_score(text: str) -> float:
    """Transcript cue in [0, 1]: exclamations, shouted capitals, combat vocabulary."""
    if not text:
        return 0.0
    exclaim = min(len(EXCLAIM.findall(text)), 3) / 3
    caps = min(len(ALLCAPS.findall(text)), 2) / 2
    words = min(len(COMBAT_WORDS.findall(text)), 2) / 2
    return min(1.0, 0.5 * exclaim + 0.5 * caps + 0.4 * words)


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def split_groups(voice_index: dict, keys: list[str]) -> dict:
    """Voices recorded by two different performers (Mr. Hands: ECAPA centroids of the two halves have cosine 0.02) get one baseline per
    performer: 2-means over the voice's plain-recording ECAPA vectors, split when the centroids differ strongly (cosine < SPLIT_COSINE) and
    the smaller half has at least SPLIT_MIN clips.  Everything else keeps a single baseline per voice."""
    from sklearn.cluster import KMeans
    groups = {}
    for voice, idx in voice_index.items():
        groups[voice] = idx
        stored = WORK / "ecapa" / f"{voice}.npz"
        if not stored.is_file() or len(idx) < 4 * SPLIT_MIN:
            continue
        data = np.load(stored, allow_pickle=False)
        position = {str(k): i for i, k in enumerate(data["keys"])}
        have = np.array([i for i in idx if keys[i] in position])
        if len(have) < 4 * SPLIT_MIN:
            continue
        emb = data["emb"][[position[keys[i]] for i in have]]
        plain = np.array([not PROCESSED.search(keys[i].split("/", 1)[1]) for i in have])
        km = KMeans(2, n_init=5, random_state=0).fit(emb[plain])
        centers = km.cluster_centers_ / np.linalg.norm(km.cluster_centers_, axis=1, keepdims=True)
        label = (emb @ centers.T).argmax(1)
        sizes = [int(((label == c) & plain).sum()) for c in (0, 1)]
        if float(centers[0] @ centers[1]) < SPLIT_COSINE and min(sizes) >= SPLIT_MIN:
            rest = np.array([i for i in idx if i not in set(have)], dtype=int)
            groups.pop(voice)
            for c in (0, 1):
                members = np.concatenate([have[label == c], rest]) if c == 0 else have[label == c]
                groups[f"{voice}#{c}"] = np.sort(members.astype(int))
    return groups


def prepare() -> dict:
    """Load every input, compute the per-voice baselines and the robust z feature matrix."""
    # ---- inputs ----------------------------------------------------------------------------------------------------------------
    paths = {r["key"]: r for r in load_jsonl(WORK / "paths.jsonl")}
    acoustic = {r["key"]: r for r in load_jsonl(WORK / "acoustic-features.jsonl")}
    by_sid, fight_scenes = ss.load_by_sid()
    keys = sorted(paths)
    voices = sorted({paths[k]["voice"] for k in keys})
    source = {k: ss.classify_lines(by_sid.get(paths[k]["string_id"], []), fight_scenes) for k in keys}
    # label sets for the model
    quest_only = {}
    for key in keys:
        rows = by_sid.get(paths[key]["string_id"], [])
        quest_only[key] = bool(rows) and all(r["cat"] in ss.QUEST_CATS and (r.get("vo_expression") or "").endswith("Spoken") for r in rows)

    # ---- per-voice baseline -------------------------------------------------------------------------------------------------------
    def col(name):
        return np.array([acoustic[k].get(name) if acoustic[k].get(name) is not None else np.nan for k in keys], dtype=float)
    raw = {name: col(name) for name in ["rms_active_db", "stl_p90", "stl_push", "f0_median", "f0_p90", "f0_p10_p90_st", "alpha_ratio_db", "tilt_db_oct",
                                        "hb4_ratio", "centroid_hz", "hnr_mean_db", "wps_speech", "voiced_frac_active", "n_f0_frames", "dur_s"]}
    raw["f0_median_st"] = 12 * np.log2(raw["f0_median"] / 100)
    raw["f0_p90_st"] = 12 * np.log2(raw["f0_p90"] / 100)
    raw["hb4_logit"] = np.log(raw["hb4_ratio"] / (1 - raw["hb4_ratio"]))
    raw["centroid_log"] = np.log(raw["centroid_hz"])
    raw["wps_log"] = np.log(np.clip(raw["wps_speech"], 0.2, None))
    pitch_ok = (raw["voiced_frac_active"] >= 0.3) & (raw["n_f0_frames"] >= 15)
    for name in ("f0_median_st", "f0_p90_st", "f0_p10_p90_st"):
        raw[name] = np.where(pitch_ok, raw[name], np.nan)
    spec = {"z_rms": ("rms_active_db", 1), "z_stl90": ("stl_p90", 1), "z_push": ("stl_push", 1), "z_f0": ("f0_median_st", 1), "z_f0hi": ("f0_p90_st", 1),
            "z_f0rng": ("f0_p10_p90_st", 1), "z_alpha": ("alpha_ratio_db", 1), "z_tilt": ("tilt_db_oct", 1), "z_hb4": ("hb4_logit", 1),
            "z_centroid": ("centroid_log", 1), "z_hnr": ("hnr_mean_db", -1), "z_wps": ("wps_log", 1)}
    voice_index = {v: np.array([i for i, k in enumerate(keys) if paths[k]["voice"] == v]) for v in voices}
    tiers = np.array([source[k]["tier"] for k in keys])
    group_index = split_groups(voice_index, keys)
    # Phone/holocall variants are processed audio (band-limited, filtered): their acoustics say nothing about delivery, so they never
    # enter a baseline or the model and inherit the verdict of the plain recording of the same line.
    processed = np.array([bool(PROCESSED.search(k.split("/", 1)[1])) for k in keys])
    baseline_mask = np.isin(tiers, ["conversation"]) & ~processed
    wide_mask = np.isin(tiers, ["conversation", "none", "ambient", "moderate"]) & ~processed

    stats: dict[str, dict] = {}
    pooled_mad = {}
    for feature, (name, _) in spec.items():
        mads = []
        for v, idx in group_index.items():
            sel = idx[baseline_mask[idx] & np.isfinite(raw[name][idx])]
            if len(sel) >= MIN_BASELINE:
                mads.append(robust(raw[name][sel])[1])
        pooled_mad[feature] = float(np.nanmedian(mads)) if mads else 1.0
    baseline_n = {}
    for v, idx in group_index.items():
        sel = idx[baseline_mask[idx]]
        if len(sel) < 12:
            sel = idx[wide_mask[idx]]
        if len(sel) < 12:
            sel = idx
        baseline_n[v] = int(len(sel))
        stats[v] = {}
        for feature, (name, _) in spec.items():
            data = raw[name][sel]
            data = data[np.isfinite(data)]
            median, mad = robust(data)
            n = len(data)
            if not math.isfinite(median):
                median, mad = 0.0, pooled_mad[feature]
            # blend the voice's own spread with the pooled one when the baseline is small
            eff = (n * mad + SHRINK * pooled_mad[feature]) / (n + SHRINK) if n < MIN_BASELINE else max(mad, 0.6 * pooled_mad[feature])
            stats[v][feature] = (median, max(eff, 1e-6))

    Z = np.zeros((len(keys), len(FEATURES)))
    for j, feature in enumerate(FEATURES[:-1]):
        name, sign = spec[feature]
        for v, idx in group_index.items():
            median, scale = stats[v][feature]
            z = sign * (raw[name][idx] - median) / scale
            Z[idx, j] = np.where(np.isfinite(z), np.clip(z, -3, 6), 0.0)

    # ECAPA distance to the voice's conversational centroid, robust z within the baseline distances
    embedding_ok = np.zeros(len(keys), bool)
    for v, idx in group_index.items():
        stored = WORK / "ecapa" / f"{v.split(chr(35))[0]}.npz"
        if not stored.is_file():
            continue
        data = np.load(stored, allow_pickle=False)
        position = {str(k): i for i, k in enumerate(data["keys"])}
        emb = data["emb"]
        rows = [(i, position[keys[i]]) for i in idx if keys[i] in position]
        if len(rows) < 10:
            continue
        sel = [p for i, p in rows if baseline_mask[i]] or [p for i, p in rows if wide_mask[i]] or [p for _, p in rows]
        centroid = emb[sel].mean(0)
        centroid /= np.linalg.norm(centroid) + 1e-9
        distance = {i: 1 - float(emb[p] @ centroid) for i, p in rows}
        base = np.array([distance[i] for i, p in rows if baseline_mask[i] or not baseline_mask[idx].any()])
        median, mad = robust(base) if len(base) >= 5 else (float(np.median(list(distance.values()))), 0.02)
        mad = max(mad, 0.005)
        for i, d in distance.items():
            Z[i, len(FEATURES) - 1] = float(np.clip((d - median) / mad, -3, 6)); embedding_ok[i] = True

    return dict(paths=paths, acoustic=acoustic, by_sid=by_sid, keys=keys, voices=voices, source=source, quest_only=quest_only, raw=raw, Z=Z,
                voice_index=voice_index, group_index=group_index, tiers=tiers, baseline_n=baseline_n, embedding_ok=embedding_ok, processed=processed)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--fp", type=float, default=FP_TARGET)
    args = parser.parse_args()
    P = prepare()
    paths, keys, voices, source, quest_only, raw, Z = P["paths"], P["keys"], P["voices"], P["source"], P["quest_only"], P["raw"], P["Z"]
    voice_index, tiers, baseline_n, embedding_ok, processed = P["voice_index"], P["tiers"], P["baseline_n"], P["embedding_ok"], P["processed"]
    # ---- the acoustic model, trained on the game's own labels --------------------------------------------------------------------------
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    positive = (tiers == "strong") & ~processed
    negative = (tiers == "conversation") & np.array([quest_only[k] for k in keys]) & ~processed
    labelled = np.flatnonzero(positive | negative)
    y = positive[labelled].astype(int)
    voice_of = np.array([paths[k]["voice"] for k in keys])
    counts = collections.Counter(voice_of[labelled])
    weight = np.where(y == 1, 0.5 * len(y) / max(1, y.sum()), 0.5 * len(y) / max(1, (1 - y).sum()))     # balance the classes
    folds = {v: n % 5 for n, v in enumerate(sorted(counts, key=lambda v: (-counts[v], v)))}
    fold_of = np.array([folds[voice_of[i]] for i in labelled])
    oof = np.zeros(len(labelled))
    for fold in range(5):
        train, test = fold_of != fold, fold_of == fold
        if test.sum() == 0:
            continue
        model = LogisticRegression(C=0.5, max_iter=2000).fit(Z[labelled][train][:, :N_AC], y[train], sample_weight=weight[train])
        oof[test] = model.decision_function(Z[labelled][test][:, :N_AC])
    auc = float(roc_auc_score(y, oof, sample_weight=weight))
    full = LogisticRegression(C=0.5, max_iter=2000).fit(Z[labelled][:, :N_AC], y, sample_weight=weight)
    logit = full.decision_function(Z[:, :N_AC])
    logit[labelled] = oof                      # honest out-of-fold scores where the model saw the label
    neg_oof = oof[y == 0]
    threshold = float(np.quantile(neg_oof, 1 - args.fp))
    # the ECAPA distance is a weak extra: an ablation (in sample) shows what it adds to the acoustic model, and it enters the decision with a small fixed weight
    with_emb = LogisticRegression(C=0.5, max_iter=2000).fit(Z[labelled], y, sample_weight=weight)
    auc_no_emb = float(roc_auc_score(y, full.decision_function(Z[labelled][:, :N_AC]), sample_weight=weight))
    auc_in = float(roc_auc_score(y, with_emb.decision_function(Z[labelled]), sample_weight=weight))

    # ---- decision ----------------------------------------------------------------------------------------------------------------
    prior = {"strong": 0.0, "moderate": 0.8, "weak": 0.4, "ambient": 0.0, "conversation": 0.0, "none": 0.0}
    clips: dict[str, dict] = {}
    method_counts = collections.Counter()
    order = [i for i in range(len(keys)) if not processed[i]] + [i for i in range(len(keys)) if processed[i]]
    for i in order:
        key = keys[i]
        src, entry = source[key], paths[key]
        if processed[i]:
            base = re.sub(r"\.?(holocall|rewinded|helmet)", "", key, count=1)
            if base in clips:
                inherited = clips[base]
                clips[key] = {"combat": inherited["combat"], "score": inherited["score"], "tier": src["tier"],
                              "reasons": (["phone-processed variant: verdict of the plain recording of this line"] + inherited["reasons"])[:5]}
                if inherited["combat"]:
                    clips[key]["how"] = inherited.get("how")
                method_counts[("inherited-flagged" if inherited["combat"] else "inherited-unflagged", src["tier"])] += 1
                continue
            if src["tier"] != "strong":     # no plain recording: only the game's own metadata can speak for a processed clip
                clips[key] = {"combat": False, "score": 0.0, "tier": src["tier"], "reasons": []}
                method_counts[("unflagged", src["tier"])] += 1
                continue
        text = (entry.get("text") or "")
        duration = raw["dur_s"][i]
        reasons = list(src["reasons"])
        tcue = text_score(text)
        adjust = prior[src["tier"]] + 1.2 * tcue
        if tcue >= 0.5 and src["tier"] != "strong":
            reasons.append("transcript reads as shouted or combat (exclamations / capitals / combat words)")
        z = dict(zip(FEATURES, Z[i]))
        adjust += EMB_WEIGHT * min(max(z["z_emb"], 0.0), 4.0) if embedding_ok[i] else 0.0
        margin = logit[i] + adjust - threshold
        # duration only breaks ties inside the undecided band
        if abs(margin) < 0.6 and src["tier"] != "strong":
            if duration < 1.6 and (EXCLAIM.search(text) or len(text.split()) <= 2):
                margin += 0.4; reasons.append("very short exclamation (tie-break)")
            elif duration > 6.0:
                margin -= 0.4
        acoustic_reasons = []
        if z["z_rms"] > 1.5 or z["z_stl90"] > 1.5:
            acoustic_reasons.append(f"loud for this voice (+{max(z['z_rms'], z['z_stl90']):.1f} robust sd)")
        if z["z_f0"] > 1.5 or z["z_f0hi"] > 1.5:
            acoustic_reasons.append(f"raised pitch (+{max(z['z_f0'], z['z_f0hi']):.1f} sd)")
        if z["z_f0rng"] > 1.5:
            acoustic_reasons.append(f"wide pitch range (+{z['z_f0rng']:.1f} sd)")
        if z["z_alpha"] > 1.5 or z["z_tilt"] > 1.5:
            acoustic_reasons.append(f"bright, shouted spectrum (+{max(z['z_alpha'], z['z_tilt']):.1f} sd)")
        if z["z_hnr"] > 1.5:
            acoustic_reasons.append(f"strained voice quality (+{z['z_hnr']:.1f} sd)")
        if z["z_emb"] > 2.5 and embedding_ok[i]:
            acoustic_reasons.append(f"timbre far from this voice's conversational centroid (+{z['z_emb']:.1f} sd)")
        # independent acoustic families past 1.5 robust sd: loudness, pitch, brightness (a single odd measurement, e.g. a pitch-tracker slip, is not enough)
        families = sum([max(z["z_rms"], z["z_stl90"]) > 1.5, max(z["z_f0"], z["z_f0hi"], z["z_f0rng"]) > 1.5, max(z["z_alpha"], z["z_tilt"], z["z_centroid"]) > 1.5])
        needed = 1 if src["tier"] in ("moderate", "weak") or tcue >= 0.5 else 2
        if src["tier"] == "strong":
            combat, how, score = True, "source", max(0.9, float(sigmoid(margin)))
        else:
            combat = margin > 0 and families >= needed
            score = float(sigmoid(margin * 1.5))
            how = "source+acoustic" if src["tier"] in ("moderate", "weak") and combat else "acoustic" if combat else "none"
            if combat:
                reasons += acoustic_reasons or ["acoustic model score above the threshold"]
        method_counts[(how if combat else "unflagged", src["tier"])] += 1
        clips[key] = {"combat": bool(combat), "score": round(score, 3), "reasons": reasons[:5], "tier": src["tier"], "how": how if combat else None}
        if combat is False:
            del clips[key]["how"]

    # ---- statistics ------------------------------------------------------------------------------------------------------------------
    shown = json.loads(SHOWN.read_text(encoding="utf-8"))
    per_voice = {}
    for v in voices:
        ks = [k for k in keys if paths[k]["voice"] == v]
        flagged = [k for k in ks if clips[k]["combat"]]
        by_how = collections.Counter(clips[k]["how"] for k in flagged)
        per_voice[v] = {"clips": len(ks), "flagged": len(flagged), "share": round(len(flagged) / len(ks), 4), "by": dict(by_how),
                        "baseline_clips": sum(n for g, n in baseline_n.items() if g.split(chr(35))[0] == v), "baseline_groups": sorted(g for g in baseline_n if g.split(chr(35))[0] == v), "seconds": round(sum(raw["dur_s"][i] for i in voice_index[v]), 1),
                        "seconds_flagged": round(sum(raw["dur_s"][keys.index(k)] for k in flagged), 1)}
    summary = {
        "keys": len(keys), "flagged": sum(c["combat"] for c in clips.values()), "voices": len(voices),
        "by_source_tier": {t: int((tiers == t).sum()) for t in ["strong", "moderate", "weak", "ambient", "conversation", "none"]},
        "by_how": {f"{a}|{b}": n for (a, b), n in sorted(method_counts.items())},
        "model": {"auc_cv_by_voice": round(auc, 4), "auc_without_ecapa_in_sample": round(auc_no_emb, 4), "auc_with_ecapa_in_sample": round(auc_in, 4),
                  "threshold_logit": round(threshold, 3), "fp_target": args.fp, "labelled": int(len(labelled)), "positives": int(y.sum()),
                  "coefficients": {f: round(float(c), 3) for f, c in zip(FEATURES[:N_AC], full.coef_[0])}, "ecapa_weight": EMB_WEIGHT, "intercept": round(float(full.intercept_[0]), 3)},
        "validation": {"adam_picks_flagged": sum(clips[k]["combat"] for k in keys if paths[k]["voice"] == "adam-smasher" and k.split("/")[1] in ADAM_PICKS),
                       "adam_picks": sum(1 for k in keys if paths[k]["voice"] == "adam-smasher" and k.split("/")[1] in ADAM_PICKS),
                       "adam_others_flagged": sum(clips[k]["combat"] for k in keys if paths[k]["voice"] == "adam-smasher" and k.split("/")[1] not in ADAM_PICKS),
                       "adam_others": sum(1 for k in keys if paths[k]["voice"] == "adam-smasher" and k.split("/")[1] not in ADAM_PICKS)},
        "per_voice": per_voice,
    }
    document = {"schema": "combat-flags/v1",
                "meaning": "combat: true = combat or shouted delivery (do not use as a reference, scoring target or training clip); keys are voice/stringId with the "
                           "dataset's /female|/male suffix removed and other suffixes (.holocall, .m) kept",
                "method": __doc__.strip().splitlines()[0] + " See scripts/combat_flags/build_flags.py.",
                "summary": summary, "clips": clips}
    args.out.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (WORK / "combat-flags-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "per_voice"}, indent=1))
    print("adam:", {k.split('/')[1]: clips[k]["combat"] for k in keys if paths[k]["voice"] == "adam-smasher" and k.split("/")[1] in ADAM_PICKS})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
