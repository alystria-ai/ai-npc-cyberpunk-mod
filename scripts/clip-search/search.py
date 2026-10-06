"""Per-character reference clip search: which whole clips (1, 2 or 3) make the best voice reference, by ECAPA similarity.

Research tool; reads the picker's pool index and the live configs, writes only under E:/CyberpunkConvai-offload/work/clip-search.
Run with vendor/reference-voicestudio/.venv/Scripts/python.exe (OmniVoice in-process on the GPU; Pocket through
worker subprocesses in vendor/pocket-tts-env).

  python scripts/clip-search/search.py --engine omni   --voices carol-emeka,judy-alvarez
  python scripts/clip-search/search.py --engine pocket --voices carol-emeka --export <pocket export dir> --prune-from omni16

Design (per voice and engine; every random choice is seeded by the voice name, every score is cached, so a run resumes):
  0. Split: a few real clips are held out (common.split_voice): their leave-one-out centroid is the ECAPA target, two are the
     dev lines the search renders, four are fresh lines kept for the final comparison.  No holdout clip is ever a candidate.
  1. Screen + singles: candidates are screened for free (loudness near the voice's median, ECAPA closeness of the clip to the
     held-out centroid, short clips kept for pairs, a few random wildcards), then every screened clip is rendered alone on the
     two dev lines.  Clips clearly worse than the best (more than ~2 paired standard errors, or outside the top 12) are dropped;
     a few mid-ranked clips far from the survivors in ECAPA space stay as exploration slots, so a clip that is weak alone but
     different can still meet a partner.
  2. Pairs: all feasible pairs (<= 10 s) of the surviving pool are ranked by the mean of their singles; the top ones plus pairs
     with explorers plus a few random pairs are raced (one dev line, then the second for the best).
  3. Triples: the best pairs are extended by every pool clip (<= 18 s), predicted from pair and single scores, and raced.
  4. Final: the best three sets of each size, today's reference and the research proposals are rendered on the four fresh lines
     with three seeds; sets are compared pairwise (cluster-robust over lines); the smallest set within one standard error of the
     best wins.  PLS (fd_mfcc, mcd, ltas_hi) is computed for these only and is secondary.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ROOT = common.ROOT
SEARCH_SEED = 1042
FINAL_SEEDS = (1042, 7, 99)

SIZES = {  # stage sizes; "pocket" is smaller because a CPU render costs ~3 s
    "omni": dict(screen_top=22, screen_wild=6, shorts=8, keep=10, explore=4, short_pool=6,
                 pairs_top=30, pairs_explore=6, pairs_wild=4, pairs_keep=12, parents=6,
                 triples_top=28, triples_wild=4, triples_keep=12, per_k=3, n_final=4),
    "pocket": dict(screen_top=15, screen_wild=5, shorts=6, keep=7, explore=3, short_pool=5,
                   pairs_top=26, pairs_explore=6, pairs_wild=4, pairs_keep=10, parents=5,
                   triples_top=26, triples_wild=4, triples_keep=10, per_k=3, n_final=6),
}


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else float("nan")


class Search:
    def __init__(self, engine: str, renderer, scorer, voice: str, index: dict, out_root: Path, sizes: dict, log=print):
        self.engine, self.renderer, self.scorer, self.voice, self.sizes, self.log = engine, renderer, scorer, voice, sizes, log
        self.pool = common.VoicePool(index, voice)
        self.dir = out_root / renderer.tag / voice
        self.dir.mkdir(parents=True, exist_ok=True)
        self.rng = random.Random(common.stable(voice, "clip-search"))
        self.store_file = self.dir / "scores.json"
        self.store = json.loads(self.store_file.read_text(encoding="utf-8")) if self.store_file.is_file() else {}
        self.stats = {"renders": 0, "render_ms": 0, "cached": 0, "failed": 0, "stage": {}}
        self.split = common.split_voice(self.pool, n_final=sizes.get("n_final", 4))
        self.started = time.time()

    # ---- clips and references ----
    def clip(self, clip_id: str) -> dict:
        if clip_id.startswith("live:"):
            live = self.pool.live[clip_id.split(":", 1)[1]]
            return {"id": clip_id, "d": live["d"], "t": live["transcript"], "path": str(ROOT / live["reference"])}
        return self.pool.clip(clip_id)

    def seconds(self, ids) -> float:
        return round(common.joined_seconds(self.clip(i)["d"] for i in ids), 3)

    def reference(self, ids: tuple):
        """(absolute wav, transcript) for an ordered set; whole clips joined as the picker builds them."""
        transcript = " ".join(self.clip(i)["t"].strip() for i in ids)
        if len(ids) == 1 and ids[0].startswith("live:"):
            return self.clip(ids[0])["path"], transcript
        path = common.WORK / "refs" / f"{sha1('|'.join(ids))}.wav"
        if not path.is_file():
            common.build_reference([self.clip(i)["path"] for i in ids], path)
        return str(path), transcript

    # ---- rendering and scoring with a cache ----
    def key(self, ids, line, seed) -> str:
        return f"{'|'.join(ids)}#{line}#{seed}"

    def evaluate(self, sets, lines, seeds=(SEARCH_SEED,), keep=False, stage="?"):
        """Render and score every missing (set, line, seed); returns nothing, read results with value()."""
        jobs = []
        for ids in sets:
            for line in lines:
                for seed in seeds:
                    key = self.key(ids, line, seed)
                    if key in self.store and (not keep or Path(self.render_path(key)).is_file() or self.store[key].get("ec") is None):
                        self.stats["cached"] += 1
                        continue
                    ref, transcript = self.reference(ids)
                    jobs.append({"key": key, "ref": ref, "transcript": transcript, "text": self.clip(line)["t"], "seed": seed,
                                 "out": self.render_path(key), "line": line})
        if not jobs:
            return
        began = time.time()
        step = 48 if self.engine == "omni" else 96
        for start in range(0, len(jobs), step):
            chunk = jobs[start:start + step]
            results = self.renderer.render(chunk)
            for job, result in zip(chunk, results):
                if not result["ok"]:
                    self.stats["failed"] += 1
                    self.store[job["key"]] = {"ec": None, "et": None, "error": result["error"]}
                    continue
                score = self.scorer.score_line(job["out"], self.targets["lines"][job["line"]])
                score["sec"] = round(result["seconds"], 2)
                self.store[job["key"]] = score
                self.stats["renders"] += 1
                self.stats["render_ms"] += result["tookMs"]
                if not keep:
                    Path(job["out"]).unlink(missing_ok=True)
            self.save()
        stage_stats = self.stats["stage"].setdefault(stage, {"renders": 0, "seconds": 0.0})
        stage_stats["renders"] += len(jobs)
        stage_stats["seconds"] = round(stage_stats["seconds"] + time.time() - began, 1)
        self.log(f"  [{self.voice}] {stage}: {len(jobs)} renders in {time.time() - began:.0f}s")

    def render_path(self, key: str) -> str:
        return str(self.dir / "r" / f"{sha1(key)}.wav")

    def save(self):
        temporary = self.store_file.with_name(self.store_file.name + ".part")
        temporary.write_text(json.dumps(self.store), encoding="utf-8")
        temporary.replace(self.store_file)

    def per_line(self, ids, lines, seeds=(SEARCH_SEED,), field="ec") -> list[float]:
        """Mean over seeds for each line (a failed render counts as 0)."""
        out = []
        for line in lines:
            values = [(self.store.get(self.key(ids, line, seed)) or {}).get(field) for seed in seeds]
            values = [0.0 if v is None else v for v in values]
            out.append(mean(values))
        return out

    def value(self, ids, lines, seeds=(SEARCH_SEED,), field="ec") -> float:
        return mean(self.per_line(ids, lines, seeds, field))

    # ---- stage 0: screen candidates for free ----
    def screen(self):
        sizes, split, pool = self.sizes, self.split, self.pool
        emb_file = common.WORK / "emb" / f"{self.voice}.json"
        self.scorer.load_embeddings(emb_file)
        self.targets = self.scorer.targets(pool, split)
        candidates = [pool.clip(i) for i in split["candidates"]]
        median = pool.loud_median
        near = [c for c in candidates if median is None or c.get("lv") is None or abs(c["lv"] - median) <= 3.5]
        if len(near) < 60:
            near = [c for c in candidates if median is None or c.get("lv") is None or abs(c["lv"] - median) <= 6.0]
        if len(near) < 20:
            near = candidates
        # embed at most ~600: the typical (index percentile) ones plus a seeded random sample of the rest
        near.sort(key=lambda c: (-(c.get("ty") if c.get("ty") is not None else 50), common.stable(c.id, "screen")))
        embedded = near[:350] + self.rng.sample(near[350:], min(250, max(0, len(near) - 350)))
        for c in embedded:
            self.scorer.embed_cached(c["path"])
        self.scorer.save_embeddings(emb_file, {str(c["path"]) for c in pool.clips})
        centroid = self.targets["centroid"]
        prior = {c.id: float(self.scorer._cache[str(c["path"])] @ centroid) for c in embedded}
        ranked = sorted(embedded, key=lambda c: -prior[c.id])
        chosen = ranked[:sizes["screen_top"]]
        rest = [c for c in ranked if c not in chosen]
        chosen += self.rng.sample(rest, min(sizes["screen_wild"], len(rest)))
        shorts = [c for c in chosen if c.d <= 5.0]
        for c in [c for c in ranked if c.d <= 5.0 and c not in chosen]:
            if len(shorts) >= sizes["shorts"]:
                break
            chosen.append(c); shorts.append(c)
        self.prior = prior
        self.screened = [c.id for c in chosen]
        return {"candidates": len(candidates), "near_loudness": len(near), "embedded": len(embedded), "screened": len(chosen)}

    def screen_from_other(self, other_dir: Path):
        """Pocket: reuse another engine's singles ranking (top few plus wildcards plus that engine's finalists)."""
        result = json.loads((other_dir / self.voice / "result.json").read_text(encoding="utf-8"))
        ranking = [row["id"] for row in result["singles"]]
        sizes = self.sizes
        keep = ranking[:sizes["screen_top"]]
        rest = ranking[sizes["screen_top"]:]
        keep += self.rng.sample(rest, min(sizes["screen_wild"], len(rest)))
        for finalist in result["finalists"]:
            for cid in finalist["ids"]:
                if cid in self.pool.by_id and cid not in keep and not cid.startswith("live:") and cid in set(self.split["candidates"]):
                    keep.append(cid)
        keep = [c for c in keep if c in set(self.split["candidates"])]
        return keep

    # ---- the search ----
    def run(self, prune_from: Path | None = None) -> dict:
        if not self.split["ok"]:
            return {"voice": self.voice, "engine": self.engine, "skipped": self.split["reason"]}
        sizes, dev, final = self.sizes, self.split["dev"], self.split["final"]
        screen_info = self.screen()
        if prune_from is not None and (prune_from / self.voice / "result.json").is_file():
            self.screened = self.screen_from_other(prune_from)
            screen_info["pruned_from"] = str(prune_from)
            screen_info["screened"] = len(self.screened)
        self.log(f"[{self.voice}] {screen_info}")
        # ---- stage 1: singles, raced: everything on dev line 1, the better ~55% (at least 12) on dev line 2
        self.evaluate([(c,) for c in self.screened], dev[:1], stage="1 singles")
        first = sorted(self.screened, key=lambda c: -self.value((c,), dev[:1]))
        racers = first[:max(min(len(first), 12), math.ceil(len(first) * 0.55))]
        self.evaluate([(c,) for c in racers], dev[1:], stage="1 singles")
        s1 = {c: self.value((c,), dev) for c in racers}
        matrix = [self.per_line((c,), dev) for c in racers]
        noise = residual_sd(matrix)
        se_diff = noise * math.sqrt(2 / len(dev))
        order = sorted(racers, key=lambda c: -s1[c])
        best1 = s1[order[0]]
        margin = max(2 * se_diff, 0.02)
        kept = [c for c in order if best1 - s1[c] <= margin][:sizes["keep"]]
        for c in order:
            if len(kept) >= min(6, len(order)):
                break
            if c not in kept:
                kept.append(c)
        rest = [c for c in order if c not in kept]
        median = statistics.median(s1.values())
        floor = sorted(s1.values())[len(s1) // 4]            # decent: not in the bottom quarter
        explorers = self.explorers([c for c in rest if s1[c] >= floor], kept, sizes["explore"])
        # pairs need short clips: add the best-scoring short ones from the first-round list (second line for them only)
        have_short = sum(1 for c in kept + explorers if self.clip(c)["d"] <= 5.0)
        short_add = [c for c in first if self.clip(c)["d"] <= 5.0 and c not in kept and c not in explorers][:max(0, sizes["short_pool"] - have_short)]
        extra = [c for c in short_add if c not in s1]
        self.evaluate([(c,) for c in extra], dev[1:], stage="1 singles")
        for c in short_add:
            s1[c] = self.value((c,), dev)
        for c in first:                                      # first-round-only clips keep their one-line score for the record
            s1.setdefault(c, self.value((c,), dev[:1]))
        pool_q = kept + explorers + short_add
        self.log(f"  [{self.voice}] singles: best {best1:.3f} median {median:.3f} noise sd {noise:.3f} (se of a difference {se_diff:.3f}); "
                 f"{len(first)} on one line, {len(racers)} on two; kept {len(kept)}, explorers {len(explorers)}, short extras {len(short_add)}")
        # ---- stage 2: pairs
        explorer_set = set(explorers)
        feasible = [(a, b) for i, a in enumerate(pool_q) for b in pool_q[i + 1:] if common.joined_seconds([self.clip(a)["d"], self.clip(b)["d"]]) <= common.CAPS[2]]
        pairs = self.ordered_sets(feasible, s1)
        pred = {p: mean(s1[c] for c in p) for p in pairs}
        pick = sorted(pairs, key=lambda p: -pred[p])[:sizes["pairs_top"]]
        extra = [p for p in sorted(pairs, key=lambda p: -pred[p]) if p not in pick and explorer_set & set(p)][:sizes["pairs_explore"]]
        others = [p for p in pairs if p not in pick and p not in extra]
        wild = self.rng.sample(others, min(sizes["pairs_wild"], len(others)))
        race_pairs = pick + extra + wild
        ranked2 = self.race(race_pairs, dev, sizes["pairs_keep"], "2 pairs")
        # ---- stage 3: triples
        parents = [p for p, _ in ranked2[:sizes["parents"]]]
        children = {}
        for parent in parents:
            for c in pool_q:
                if c in parent:
                    continue
                if common.joined_seconds([self.clip(i)["d"] for i in (*parent, c)]) > common.CAPS[3]:
                    continue
                trio = self.order_set((*parent, c), s1)
                children.setdefault(trio, (2 * dict(ranked2)[parent] + s1[c]) / 3)
        pick3 = sorted(children, key=lambda t: -children[t])[:sizes["triples_top"]]
        others3 = [t for t in children if t not in pick3]
        wild3 = self.rng.sample(others3, min(sizes["triples_wild"], len(others3)))
        ranked3 = self.race(pick3 + wild3, dev, sizes["triples_keep"], "3 triples") if children else []
        # ---- stage 4: final
        result = self.finalize(order, s1, ranked2, ranked3, final)
        result.update({"voice": self.voice, "engine": self.engine, "tag": self.renderer.tag, "split": self.split, "screen": screen_info,
                       "noise": {"single_sd": round(noise, 4), "se_diff_two_lines": round(se_diff, 4)},
                       "pool_after_pruning": {"kept": kept, "explorers": explorers, "short_extras": short_add,
                                              "dropped": len(self.screened) - len(pool_q), "screened": len(self.screened)},
                       "singles": [{"id": c, "ec": round(s1[c], 4), "seconds": self.clip(c)["d"], "lines": 2 if c in racers or c in short_add else 1}
                                   for c in sorted(s1, key=lambda c: -s1[c])],
                       "pairs": [{"ids": list(p), "ec": round(v, 4)} for p, v in ranked2],
                       "triples": [{"ids": list(t), "ec": round(v, 4)} for t, v in ranked3]})
        result["budget"] = {"renders": self.stats["renders"], "cached_hits": self.stats["cached"], "failed": self.stats["failed"],
                            "early_dropped_finalists": self.stats.get("early_dropped_finalists", 0), "render_seconds": round(self.stats["render_ms"] / 1000, 1), "wall_seconds": round(time.time() - self.started, 1),
                            "stages": self.stats["stage"]}
        (self.dir / "result.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
        return result

    def order_set(self, ids, s1):
        return tuple(sorted(ids, key=lambda c: -s1.get(c, 0)))

    def ordered_sets(self, combos, s1):
        return [self.order_set(c, s1) for c in combos]

    def explorers(self, candidates, kept, count):
        """Farthest-point picks (in ECAPA space of the clips themselves) among decent but not top clips."""
        torch = self.scorer.torch
        if not candidates or count <= 0:
            return []
        emb = {c: self.scorer.embed_cached(self.clip(c)["path"]) for c in candidates + kept}
        chosen, anchor = [], list(kept)
        for _ in range(min(count, len(candidates))):
            best, best_distance = None, -1
            for c in candidates:
                if c in chosen:
                    continue
                distance = min(1 - float(emb[c] @ emb[a]) for a in anchor)
                if distance > best_distance:
                    best, best_distance = c, distance
            chosen.append(best); anchor.append(best)
        return chosen

    def race(self, sets, dev, keep, stage):
        """Round 1: first dev line for everything; round 2: second line for the best; ranked by the mean of both."""
        self.evaluate(sets, dev[:1], stage=stage)
        first = sorted(sets, key=lambda s: -self.value(s, dev[:1]))
        top = first[:keep]
        self.evaluate(top, dev[1:], stage=stage)
        scored = [(s, self.value(s, dev)) for s in top]
        return sorted(scored, key=lambda row: -row[1])

    # ---- stage 4 ----
    def finalize(self, order, s1, ranked2, ranked3, final):
        sizes = self.sizes
        groups = {1: [((c,), s1[c]) for c in order[:sizes["per_k"]]], 2: ranked2[:sizes["per_k"]], 3: ranked3[:sizes["per_k"]]}
        sets = [s for rows in groups.values() for s, _ in rows]
        baselines = {}
        engine_key = "omni" if self.engine == "omni" else "pocket"
        if self.pool.live.get(engine_key, {}).get("exists"):
            baselines["today"] = (f"live:{engine_key}",)
        for name in ({"omni": ("omni", "omni-short"), "pocket": ("pocket",)}[engine_key]):
            clips = self.pool.proposed.get(name, {}).get("clips")
            if clips and all(c in self.pool.by_id for c in clips):
                baselines[f"proposed-{name}"] = tuple(clips)
        every = list(dict.fromkeys(sets + list(baselines.values())))
        # early stop: everything on the first two fresh lines with one seed; a searched set more than 2 pooled standard errors
        # behind the best (and not the best of its size) is dropped before the expensive full comparison
        self.evaluate(every, final[:2], FINAL_SEEDS[:1], keep=True, stage="4a final screen")
        screen = {s: self.value(s, final[:2], FINAL_SEEDS[:1]) for s in every}
        sigma = residual_sd([self.per_line(s, final[:2], FINAL_SEEDS[:1]) for s in every]) * math.sqrt(2 / 2)
        top_all = max(screen.values())
        keep_sets = set(baselines.values())
        for k in (1, 2, 3):
            members = [s for s in every if len(s) == k and s not in keep_sets]
            if members:
                keep_sets.add(max(members, key=lambda s: screen[s]))
        survivors = [s for s in every if s in keep_sets or screen[s] >= top_all - 2 * sigma]
        self.stats["early_dropped_finalists"] = len(every) - len(survivors)
        every = survivors
        sets = [s for s in sets if s in survivors]
        self.evaluate(every, final, FINAL_SEEDS, keep=True, stage="4 final")
        summary = {s: self.summarize(s, final) for s in every}
        pairs = self.compare(summary, final)
        # order check: the best set of each size reversed
        checks = {}
        for k in (2, 3):
            members = [s for s in sets if len(s) == k]
            if not members:
                continue
            best = max(members, key=lambda s: summary[s]["ecapa"])
            reverse = tuple(reversed(best))
            self.evaluate([reverse], final, FINAL_SEEDS, keep=True, stage="4 final")
            summary[reverse] = self.summarize(reverse, final)
            checks[k] = {"best": list(best), "reversed": list(reverse), "delta": round(summary[reverse]["ecapa"] - summary[best]["ecapa"], 4)}
            if summary[reverse]["ecapa"] > summary[best]["ecapa"]:
                sets.append(reverse)
        pairs = self.compare(summary, final)
        picks = {"best": self.choose(summary, pairs, sets, max_k=3, cap=common.CAPS[3]),
                 "short": self.choose(summary, pairs, sets, max_k=2, cap=common.CAPS[2]),
                 "single": self.choose(summary, pairs, sets, max_k=1, cap=common.CAPS[1])}
        out = {"finalists": [self.describe(s, summary, baselines) for s in every + [s for s in summary if s not in every]],
               "picks": {name: (self.describe(s, summary, baselines) if s else None) for name, s in picks.items()},
               "order_check": checks}
        for name in ("today", "proposed-omni", "proposed-omni-short", "proposed-pocket"):
            if name in baselines:
                out.setdefault("baselines", {})[name] = self.describe(baselines[name], summary, baselines)
        out["paired"] = [{"a": list(a), "b": list(b), "diff": round(d, 4), "se": round(se, 4)} for (a, b), (d, se) in pairs.items()
                         if a in picks.values() or b in picks.values()]
        return out

    def summarize(self, ids, lines):
        per_line = self.per_line(ids, lines, FINAL_SEEDS)
        tgt = self.value(ids, lines, FINAL_SEEDS, "et")
        seed_sd = mean(statistics.pstdev([self.per_line(ids, [line], (seed,))[0] for seed in FINAL_SEEDS]) for line in lines)
        return {"ecapa": mean(per_line), "per_line": per_line, "ecapa_tgt": tgt, "seed_sd": seed_sd,
                "ecapa_se": (statistics.stdev(per_line) / math.sqrt(len(per_line))) if len(per_line) > 1 else float("nan")}

    def compare(self, summary, lines):
        """Paired differences over the fresh lines (each line's mean over seeds); se = sd of the differences / sqrt(lines)."""
        out = {}
        keys = list(summary)
        for a in keys:
            for b in keys:
                if a == b:
                    continue
                diffs = [x - y for x, y in zip(summary[a]["per_line"], summary[b]["per_line"])]
                se = statistics.stdev(diffs) / math.sqrt(len(diffs)) if len(diffs) > 1 else float("nan")
                out[(a, b)] = (mean(diffs), se)
        return out

    def choose(self, summary, pairs, sets, max_k, cap):
        """Best by ECAPA among the searched sets of at most max_k clips within the cap; then the smallest set that is
        within one paired standard error of it (shorter prompts are cheaper)."""
        allowed = [s for s in dict.fromkeys(sets) if len(s) <= max_k and not s[0].startswith("live:") and self.seconds(s) <= cap + 1e-6]
        if not allowed:
            return None
        top = max(allowed, key=lambda s: summary[s]["ecapa"])
        within = [s for s in allowed if s == top or (len(s) < len(top) and (summary[top]["ecapa"] - summary[s]["ecapa"]) <= max(pairs[(top, s)][1], 1e-9) * 1.0)]
        return min(within, key=lambda s: (len(s), -summary[s]["ecapa"]))

    def describe(self, ids, summary, baselines):
        info = summary[ids]
        row = {"ids": list(ids), "k": len(ids), "seconds": self.seconds(ids), "ecapa": round(info["ecapa"], 4),
               "ecapa_se": round(info["ecapa_se"], 4), "ecapa_tgt": round(info["ecapa_tgt"], 4), "seed_sd": round(info["seed_sd"], 4),
               "per_line": [round(v, 4) for v in info["per_line"]]}
        for name, b in baselines.items():
            if b == ids:
                row["baseline"] = name
        self._pls = getattr(self, "_pls", {})
        if ids not in self._pls:
            self._pls[ids] = self.pls_for(ids)
        row.update(self._pls[ids])
        return row

    def pls_for(self, ids) -> dict:
        from score import pls_from_components
        if not hasattr(self, "_stats"):
            self._stats = self.scorer.voice_stats(self.pool, self.split)
        pairs = []
        for line in self.split["final"]:
            for seed in FINAL_SEEDS:
                wav = self.render_path(self.key(ids, line, seed))
                if Path(wav).is_file():
                    pairs.append((wav, self.clip(line)["path"]))
        if not pairs:
            return {}
        try:
            components = self.scorer.pls_components(self.voice, pairs, self._stats)
        except Exception as error:  # PLS is secondary; never lose a voice over it
            return {"pls_error": str(error)[:200]}
        return {"pls": round(pls_from_components(components), 2), "pls_parts": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in components.items()}}


def residual_sd(matrix) -> float:
    """Residual sd of a (clips x lines) score matrix after removing clip and line effects (paired-design noise)."""
    n, m = len(matrix), len(matrix[0]) if matrix else 0
    if n < 2 or m < 2:
        return 0.03
    grand = mean(v for row in matrix for v in row)
    row_means = [mean(row) for row in matrix]
    col_means = [mean(matrix[i][j] for i in range(n)) for j in range(m)]
    total = sum((matrix[i][j] - row_means[i] - col_means[j] + grand) ** 2 for i in range(n) for j in range(m))
    return math.sqrt(total / ((n - 1) * (m - 1)))


def wait_for_gpu(max_used_mb=1500, max_util=35, poll=15, quiet_polls=6, log=print):
    """Block until nobody else is using the GPU: `quiet_polls` consecutive quiet readings (gaps between another job's
    model unload and load are shorter than that)."""
    quiet = 0
    while quiet < quiet_polls:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True).stdout.strip().split(",")
        used, util = float(out[0]), float(out[1])
        if used <= max_used_mb and util <= max_util:
            quiet += 1
        else:
            quiet = 0
            log(f"waiting for the GPU (used {used:.0f} MiB, util {util:.0f}%)")
        time.sleep(poll)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", choices=["omni", "pocket"], required=True)
    parser.add_argument("--voices", help="comma list; default: the 29 shown voices")
    parser.add_argument("--steps", type=int, default=16)
    parser.add_argument("--export", type=Path, default=common.OLD_POCKET_EXPORT)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--index", type=Path, default=common.POOL_INDEX)
    parser.add_argument("--out", type=Path, default=common.WORK / "runs")
    parser.add_argument("--prune-from", help="tag of another engine's run (e.g. omni16) whose singles ranking prunes this one")
    parser.add_argument("--prune-wait-min", type=int, default=60, help="how long to wait for the other engine's result of a voice")
    parser.add_argument("--wait-gpu", action="store_true")
    parser.add_argument("--scorer-device", default="cuda")
    args = parser.parse_args(argv)

    index = common.load_index(args.index)
    shown = json.loads((ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
    voices = args.voices.split(",") if args.voices else shown
    from score import Scorer
    if args.engine == "omni":
        if args.wait_gpu:
            wait_for_gpu()
        from render import OmniRenderer
        renderer = OmniRenderer(args.steps)
    else:
        from render import PocketRenderer
        renderer = PocketRenderer(args.export, args.workers, args.threads)
    scorer = Scorer(args.scorer_device)
    out_root = args.out
    prune = out_root / args.prune_from if args.prune_from else None
    started = time.time()
    try:
        for voice in voices:
            if voice not in index["voices"]:
                print(f"{voice}: not in the pool index")
                continue
            done = out_root / renderer.tag / voice / "result.json"
            if done.is_file():
                print(f"{voice}: already done")
                continue
            if prune is not None:                 # run alongside the other engine: wait for its singles for this voice
                waited = 0
                while not (prune / voice / "result.json").is_file() and waited < args.prune_wait_min * 60:
                    time.sleep(20); waited += 20
            search = Search(args.engine, renderer, scorer, voice, index, out_root, SIZES[args.engine])
            try:
                result = search.run(prune)
            except Exception as error:               # a night's run must survive one voice's failure
                import traceback
                traceback.print_exc()
                print(f"{voice}: FAILED ({type(error).__name__}: {error})", flush=True)
                continue
            if "skipped" in result:
                print(f"{voice}: skipped ({result['skipped']})")
                continue
            best = result["picks"]["best"]
            print(f"{voice}: best {best['k']} clip(s) {best['seconds']} s ecapa {best['ecapa']} (+-{best['ecapa_se']}) "
                  f"pls {best.get('pls')}; renders {result['budget']['renders']} in {result['budget']['wall_seconds']:.0f}s", flush=True)
    finally:
        renderer.close()
    print(f"finished {len(voices)} voices in {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
