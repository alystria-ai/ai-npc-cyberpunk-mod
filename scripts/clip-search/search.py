"""Per-character reference search by total DURATION: which whole clips make the best voice reference, by ECAPA similarity.

There is no clip count anywhere: a reference is an ordered list of whole clips joined with 0.4 s gaps, and the only budget is
its total seconds.  Research tool; reads the picker's pool index and the live configs, writes only under
E:/CyberpunkConvai-offload/work/clip-search.  Run with vendor/reference-voicestudio/.venv/Scripts/python.exe (OmniVoice in-process
on the GPU; Pocket through worker subprocesses in vendor/pocket-tts-env).

  python scripts/clip-search/search.py --engine omni   --voices carol-emeka
  python scripts/clip-search/search.py --engine pocket --voices carol-emeka --prune-from omni16
  python scripts/clip-search/search.py --engine omni --steps 32 --verify-from omni16        # 32-step check of the 16-step winners

Design (per voice and engine; every random choice is seeded by the voice name, every score is cached, so a run resumes):
  0. Split: real clips are held out (common.split_voice); their leave-one-out centroid is the ECAPA target, two are the dev
     lines the search renders, the others are fresh lines kept for the final comparison.  Holdout clips are never candidates.
     Adam Smasher is special: only his 11 hand-picked clips are candidates and his two page lines are both dev and final
     (the user allows overfitting there); the target is the original recording of each line.
  1. Screen + singles: free prescreen (loudness, effect exclusions, ECAPA of the clip vs the held-out centroid, wildcards), then
     singles raced (everything on dev line 1, the better half on line 2).  Poor clips are dropped, a few diverse mid-ranked
     clips stay as explorers.
  2. Greedy forward selection under a duration cap (a beam of 2): from each state the clip that adds the most ECAPA, and the most
     ECAPA per second, are tried (candidates raced on one line, the best on the second line); the best states continue.  OmniVoice
     is run with caps of 10 s and 18 s; Pocket grows to 40 s (its student was trained on references up to 18 s; the bridge
     accepts 30 s) so the curve shows whether longer keeps helping.
  3. Final: prefixes of the best path (the ECAPA-vs-duration curve), the beam states and a few clip orders are rendered on fresh
     lines with several seeds; per budget the best mean wins, but the SHORTEST set within one paired standard error of it is
     chosen (duration costs OmniVoice latency).  PLS is computed for the winners only and is secondary.  No WER.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ROOT = common.ROOT
SEARCH_SEED = 1042
LATENCY_MS_PER_SECOND = {"16": 42, "32": 95}      # measured added first-audio latency per second of OmniVoice reference
POCKET_BRIDGE_LIMIT = 30.0                        # bridge/pocket_voice_runtime.py refuses references over 30 s

# Adam Smasher: the user chose these 11 pool clips by ear; only they are candidates, and his two page lines are the targets.
RESTRICT = {
    "adam-smasher": ("1653087655475433472 1776711517152501760 1876330591075450880 1876331655187152896 1995324830177058816 "
                     "1995048870861103104 1995076448980328448 1792270501449261056 1792271201864474624 1792275223900020748 "
                     "1792275223900020764").split(),
}

SIZES = {
    "omni": dict(screen_top=22, screen_wild=6, keep=12, explore=4, beam=2, beam_full_steps=99, cand=12, second=4,
                 caps=(10.0, 18.0), final_lines=4, final_seeds=(1042, 7), orders=3),
    "pocket": dict(screen_top=26, screen_wild=4, keep=14, explore=3, beam=2, beam_full_steps=4, cand=10, second=3,
                   caps=(27.0,), final_lines=6, final_seeds=(1042, 7), orders=2, stop_after_fall=2),
}
# Probe voices keep growing to 40 s (no early stop) so the aggregate curve shows what happens far beyond the 18 s the student was
# trained on; every other Pocket voice stops at 27 s, or earlier once its score has fallen two steps past its best.
PROBES = {"johnny-silverhand", "songbird", "judy-alvarez", "carol-emeka", "alex", "claire-russell", "adam-smasher", "dexter-deshawn"}
PROBE_CAP = 40.0


def split_for(index, voice):
    """The held-out split of a voice, identical for every engine (6 fresh lines; an engine may use fewer).  For a voice with a
    hand-picked pool (RESTRICT) the picked clips are removed first, so the holdout never contains one of them."""
    pool = common.VoicePool(index, voice)
    if voice in RESTRICT:
        picked = {f"{voice}/{i}" for i in RESTRICT[voice]}
        pool.clips = [c for c in pool.clips if c.id not in picked]
    return common.split_voice(pool, n_final=6)


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else float("nan")


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


class Search:
    def __init__(self, engine, renderer, scorer, voice, index, out_root: Path, sizes: dict, log=print, plan=None):
        self.engine, self.renderer, self.scorer, self.voice, self.sizes, self.log = engine, renderer, scorer, voice, sizes, log
        self.plan = plan                  # {"split", "screened"}: a precomputed split and prescreen (portable runs)
        self.pool = common.VoicePool(index, voice)
        self.index_voice = index["voices"][voice]
        self.dir = out_root / renderer.tag / voice
        self.dir.mkdir(parents=True, exist_ok=True)
        self.rng = random.Random(common.stable(voice, "clip-search"))
        self.store_file = None            # set once the split (and so the ECAPA targets) is known: scores are keyed by it
        self.store = {}
        self.stats = {"renders": 0, "render_ms": 0, "failed": 0, "stage": {}}
        self.final_seeds = tuple(sizes["final_seeds"])
        self.restrict = [f"{voice}/{i}" for i in RESTRICT.get(voice, [])]
        self.page_lines = [{**l, "path": common.data_path(l["path"])} for l in self.index_voice["lines"] if l.get("exists")]
        self.split = plan["split"] if plan else split_for(index, voice)
        if self.split["ok"] and not self.restrict:
            self.split["final"] = self.split["final"][:sizes["final_lines"]]      # same holdout for every engine; Omni uses 4 fresh lines
        if self.split["ok"] and self.restrict:
            self.split["candidates"] = list(self.restrict)
            self.split["dev"] = self.split["final"] = [f"line:{i}" for i in range(len(self.page_lines))]
        self.started = time.time()
        # A cached score is only valid for the targets it was measured against: the key covers the holdout, dev and final clips
        # (the targets are built from them), so a changed split (e.g. a new exclusion flag) never reuses old scores.
        self.split_key = sha1(json.dumps([self.split.get("holdout"), self.split.get("dev"), self.split.get("final")], sort_keys=True))[:10] if self.split["ok"] else "none"
        self.store_file = self.dir / f"scores-{self.split_key}.json"
        self.store = json.loads(self.store_file.read_text(encoding="utf-8")) if self.store_file.is_file() else {}

    # ---- clips and references ----
    def clip(self, clip_id: str) -> dict:
        if clip_id.startswith("line:"):
            line = self.page_lines[int(clip_id.split(":")[1])]
            return {"id": clip_id, "d": line["d"], "t": line["t"], "path": line["path"]}
        if clip_id.startswith("live:"):
            live = self.pool.live[clip_id.split(":", 1)[1]]
            return {"id": clip_id, "d": live["d"], "t": live["transcript"], "path": str(ROOT / live["reference"])}
        return self.pool.clip(clip_id)

    def dur(self, clip_id: str) -> float:
        return self.clip(clip_id)["d"]

    def seconds(self, ids) -> float:
        return round(common.joined_seconds(self.dur(i) for i in ids), 3)

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

    def render_path(self, key: str) -> str:
        return str(self.dir / "r" / f"{sha1(key)}.wav")

    def save(self):
        temporary = self.store_file.with_name(self.store_file.name + ".part")
        temporary.write_text(json.dumps(self.store), encoding="utf-8")
        temporary.replace(self.store_file)

    def evaluate(self, sets, lines, seeds=(SEARCH_SEED,), keep=False, stage="?"):
        jobs = []
        for ids in sets:
            for line in lines:
                for seed in seeds:
                    key = self.key(ids, line, seed)
                    if key in self.store and (not keep or Path(self.render_path(key)).is_file() or self.store[key].get("ec") is None):
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
            for job, result in zip(chunk, self.renderer.render(chunk)):
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

    def cells(self, ids, lines, seeds, field="ec") -> list[float]:
        out = []
        for line in lines:
            for seed in seeds:
                value = (self.store.get(self.key(ids, line, seed)) or {}).get(field)
                out.append(0.0 if value is None else value)
        return out

    def per_line(self, ids, lines, seeds=(SEARCH_SEED,), field="ec") -> list[float]:
        n = len(seeds)
        cells = self.cells(ids, lines, seeds, field)
        return [mean(cells[i * n:(i + 1) * n]) for i in range(len(lines))]

    def value(self, ids, lines, seeds=(SEARCH_SEED,), field="ec") -> float:
        return mean(self.cells(ids, lines, seeds, field))

    # ---- stage 0: screen candidates for free ----
    def screen(self):
        sizes, split, pool = self.sizes, self.split, self.pool
        emb_file = common.WORK / "emb" / f"{self.voice}.json"
        self.scorer.load_embeddings(emb_file)
        self.targets = self.scorer.targets(pool, split)
        if self.plan:
            self.screened = list(self.plan["screened"])
            for i, line in enumerate(self.page_lines):
                if self.restrict:
                    emb = self.scorer.embed_cached(line["path"])
                    self.targets["lines"][f"line:{i}"] = {"own": emb, "centroid": emb}
            return {"plan": True, "screened": len(self.screened)}
        if self.restrict:                              # the target of a page line is the original recording itself
            for i, line in enumerate(self.page_lines):
                emb = self.scorer.embed_cached(line["path"])
                self.targets["lines"][f"line:{i}"] = {"own": emb, "centroid": emb}
            self.screened = list(self.restrict)
            return {"restricted_to": len(self.restrict), "screened": len(self.screened)}
        candidates = [pool.clip(i) for i in split["candidates"]]
        median = pool.loud_median
        near = [c for c in candidates if median is None or c.get("lv") is None or abs(c["lv"] - median) <= 3.5]
        if len(near) < 60:
            near = [c for c in candidates if median is None or c.get("lv") is None or abs(c["lv"] - median) <= 6.0]
        if len(near) < 20:
            near = candidates
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
        self.prior = prior
        self.screened = [c.id for c in chosen]
        return {"candidates": len(candidates), "near_loudness": len(near), "embedded": len(embedded), "screened": len(chosen)}

    def screen_from_other(self, other_dir: Path):
        """Pocket: reuse another engine's singles ranking (its racers plus wildcards plus its picks)."""
        result = json.loads((other_dir / self.voice / "result.json").read_text(encoding="utf-8"))
        allowed = set(self.split["candidates"])
        ranking = [row["id"] for row in result["singles"] if row["id"] in allowed]
        sizes = self.sizes
        keep = ranking[:sizes["screen_top"]]
        rest = ranking[sizes["screen_top"]:]
        keep += self.rng.sample(rest, min(sizes["screen_wild"], len(rest)))
        for name, pick in result.get("picks", {}).items():
            for cid in (pick or {}).get("ids", []):
                if cid in allowed and cid not in keep:
                    keep.append(cid)
        return keep

    # ---- the search ----
    def run(self, prune_from: Path | None = None, rechoose: bool = False) -> dict:
        """rechoose: recompute the picks from the cached scores only (no renders; PLS is carried over from the old result when
        the picked set is unchanged)."""
        self.rechoose = rechoose
        if not self.split["ok"]:
            return {"voice": self.voice, "engine": self.engine, "skipped": self.split["reason"]}
        sizes, dev, final = self.sizes, self.split["dev"], self.split["final"]
        screen_info = self.screen()
        if prune_from is not None and not self.restrict and (prune_from / self.voice / "result.json").is_file():
            self.screened = self.screen_from_other(prune_from)
            screen_info.update({"pruned_from": str(prune_from), "screened": len(self.screened)})
        self.log(f"[{self.voice}] {screen_info}")
        # ---- singles, raced
        if self.restrict:
            self.evaluate([(c,) for c in self.screened], dev, stage="1 singles")
            racers = list(self.screened)
        else:
            self.evaluate([(c,) for c in self.screened], dev[:1], stage="1 singles")
            first = sorted(self.screened, key=lambda c: -self.value((c,), dev[:1]))
            racers = first[:max(min(len(first), 12), math.ceil(len(first) * 0.55))]
            self.evaluate([(c,) for c in racers], dev[1:], stage="1 singles")
        s1 = {c: self.value((c,), dev) for c in racers}
        noise = residual_sd([self.per_line((c,), dev) for c in racers])
        se_diff = noise * math.sqrt(2 / len(dev))
        order = sorted(racers, key=lambda c: -s1[c])
        best1 = s1[order[0]]
        kept = [c for c in order if best1 - s1[c] <= max(2 * se_diff, 0.02)][:sizes["keep"]]
        for c in order:
            if len(kept) >= min(8, len(order)):
                break
            if c not in kept:
                kept.append(c)
        rest = [c for c in order if c not in kept]
        floor = sorted(s1.values())[len(s1) // 4]
        explorers = self.explorers([c for c in rest if s1[c] >= floor], kept, sizes["explore"])
        # time-efficient clips matter under a duration budget: keep the best score-per-second clips too
        efficient = [c for c in sorted(rest, key=lambda c: -s1[c] / (self.dur(c) + 0.4)) if c not in explorers][:3]
        pool_q = list(dict.fromkeys(kept + explorers + efficient)) if not self.restrict else list(order)
        self.log(f"  [{self.voice}] singles: best {best1:.3f} median {statistics.median(s1.values()):.3f} noise sd {noise:.3f}; "
                 f"pool for growth {len(pool_q)} of {len(self.screened)}")
        # ---- greedy forward selection under each duration cap
        caps = (PROBE_CAP,) if (self.engine == "pocket" and self.voice in PROBES) else sizes["caps"]
        self.stop_after_fall = None if self.voice in PROBES else sizes.get("stop_after_fall")
        histories = {cap: self.grow(cap, s1, pool_q, dev) for cap in caps}
        result = self.finalize(histories, final, s1)
        result.update({"voice": self.voice, "engine": self.engine, "tag": self.renderer.tag, "split": self.split, "split_key": self.split_key, "screen": screen_info,
                       "noise": {"single_sd": round(noise, 4), "se_diff_two_lines": round(se_diff, 4)},
                       "pool_for_growth": pool_q,
                       "singles": [{"id": c, "ec": round(s1[c], 4), "seconds": self.dur(c)} for c in order],
                       "budget": {"renders": self.stats["renders"], "failed": self.stats["failed"],
                                  "render_seconds": round(self.stats["render_ms"] / 1000, 1), "wall_seconds": round(time.time() - self.started, 1),
                                  "stages": self.stats["stage"]}})
        (self.dir / "result.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
        for path in (self.dir / "r").glob("*.wav"):        # the wavs were only needed for PLS
            path.unlink(missing_ok=True)
        return result

    def explorers(self, candidates, kept, count):
        """Farthest-point picks (in ECAPA space of the clips themselves) among decent but not top clips."""
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

    def grow(self, cap, s1, pool_q, dev):
        """Beam of greedy forward selections under a duration cap.  Returns [[(state, score), ...] per step]."""
        sizes = self.sizes
        stage = f"2 grow to {cap:g} s"
        starts = [c for c in sorted(pool_q, key=lambda c: -s1[c]) if self.seconds((c,)) <= cap][:sizes["beam"]]
        self.evaluate([(c,) for c in starts], dev, stage=stage)
        states = [(c,) for c in starts]
        history = [[(s, self.value(s, dev)) for s in states]]
        step = 1
        while states:
            children: dict = {}
            seen = {frozenset(s) for s in states}
            for state in states:
                rest = [c for c in pool_q if c not in state and self.seconds((*state, c)) <= cap]
                if not rest:
                    continue
                by_score = sorted(rest, key=lambda c: -s1[c])[:sizes["cand"]]
                by_rate = sorted(rest, key=lambda c: -s1[c] / (self.dur(c) + 0.4))[:4]
                options = list(dict.fromkeys(by_score + by_rate))
                trials = [(*state, c) for c in options if frozenset((*state, c)) not in seen]
                self.evaluate(trials, dev[:1], stage=stage)
                base = self.value(state, dev[:1])
                gain = {t: (self.value(t, dev[:1]) - base) / (self.dur(t[-1]) + common.GAP_SECONDS) for t in trials}
                top = sorted(trials, key=lambda t: -self.value(t, dev[:1]))[:sizes["second"]]
                top += [t for t in sorted(trials, key=lambda t: -gain[t])[:2] if t not in top]
                self.evaluate(top, dev[1:], stage=stage)
                for t in top:
                    if frozenset(t) not in seen:
                        seen.add(frozenset(t))
                        children[t] = self.value(t, dev)
            if not children:
                break
            step += 1
            width = sizes["beam"] if step <= sizes["beam_full_steps"] else 1
            states = sorted(children, key=lambda t: -children[t])[:width]
            history.append([(s, children[s]) for s in states])
            if self.stop_after_fall:                       # stop once the best score has fallen N steps past its best
                tops = [max(v for _, v in level) for level in history]
                peak = max(range(len(tops)), key=lambda i: tops[i])
                if len(tops) - 1 - peak >= self.stop_after_fall:
                    self.log(f"  [{self.voice}] stopping growth at {self.seconds(history[-1][0][0])} s: {len(tops) - 1 - peak} steps past the best")
                    break
        return history

    # ---- stage 4: fresh lines ----
    def finalize(self, histories, final, s1):
        sizes, seeds = self.sizes, self.final_seeds
        paths = {}                                       # cap -> lineage of the best final state (the curve)
        finalists = []
        for cap, history in histories.items():
            top = history[-1][0][0]
            paths[cap] = [top[:k] for k in range(1, len(top) + 1)]
            finalists += paths[cap]
            for states in history:
                finalists += [s for s, _ in states]
        today = None
        engine_key = "omni" if self.engine == "omni" else "pocket"
        if not self.restrict and self.pool.live.get(engine_key, {}).get("exists"):
            today = (f"live:{engine_key}",)
        elif self.restrict and self.pool.live.get(engine_key, {}).get("exists"):
            today = (f"live:{engine_key}",)
        finalists = list(dict.fromkeys(finalists))
        everything = finalists + ([today] if today else [])
        keep_wavs = not getattr(self, "rechoose", False)
        self.evaluate(everything, final, seeds, keep=keep_wavs, stage="4 final")

        def allowed(cap):
            return [s for s in finalists if self.seconds(s) <= cap + 1e-6]

        # clip-order checks for the best sets of each budget
        budgets = [10.0, 18.0] if self.engine == "omni" else [POCKET_BRIDGE_LIMIT]
        extra = []
        for cap in budgets:
            tops = sorted(allowed(cap), key=lambda s: -self.value(s, final, seeds))[:2]
            for s in tops:
                if len(s) < 2:
                    continue
                variants = [tuple(reversed(s))]
                if len(s) >= 3:
                    variants.append(s[1:] + s[:1])
                shuffled = list(s)
                random.Random(common.stable("|".join(s), "order")).shuffle(shuffled)
                variants.append(tuple(shuffled))
                extra += [v for v in variants if v != s][:sizes["orders"]]
        extra = [s for s in dict.fromkeys(extra) if s not in finalists]
        self.evaluate(extra, final, seeds, keep=keep_wavs, stage="4 final")
        candidates = finalists + extra

        def choose(cap):
            # A reference has at least two whole clips (user rule), except for a voice with no feasible multi-clip set.
            pool = [s for s in candidates if self.seconds(s) <= cap + 1e-6]
            multi = [s for s in pool if len(s) >= 2]
            pool = multi or pool
            if not pool:
                return None
            top = max(pool, key=lambda s: self.value(s, final, seeds))
            cells_top = self.cells(top, final, seeds)
            within = [s for s in pool if s == top or (self.seconds(s) < self.seconds(top) and
                      self.value(top, final, seeds) - self.value(s, final, seeds) <= self.paired_se(cells_top, self.cells(s, final, seeds)))]
            return min(within, key=lambda s: (self.seconds(s), -self.value(s, final, seeds)))

        picks = {}
        if self.engine == "omni":
            picks["short"], picks["long"] = choose(10.0), choose(18.0)
            short, long_ = picks["short"], picks["long"]
            picks["best"] = long_ if (short is None or (long_ and self.seconds(long_) > self.seconds(short) and
                                                         self.value(long_, final, seeds) - self.value(short, final, seeds) >
                                                         self.paired_se(self.cells(long_, final, seeds), self.cells(short, final, seeds)))) else short
        else:
            picks["best"] = choose(POCKET_BRIDGE_LIMIT)
            beyond = max(candidates, key=lambda s: self.value(s, final, seeds))
            picks["unconstrained"] = beyond if self.seconds(beyond) > POCKET_BRIDGE_LIMIT else None
        longest = max(histories)
        curve = [self.describe(s, final, seeds, with_pls=False) for s in paths[longest]]
        result = {"picks": {k: (self.describe(v, final, seeds) if v else None) for k, v in picks.items()},
                  "today": self.describe(today, final, seeds) if today else None,
                  "curve": curve,
                  "paths": {f"{cap:g}": [self.describe(s, final, seeds, with_pls=False) for s in path] for cap, path in paths.items()},
                  "candidates": [self.describe(s, final, seeds, with_pls=False)
                                 for s in sorted(candidates, key=lambda s: -self.value(s, final, seeds))[:40]],
                  "final_lines": len(final), "final_seeds": list(seeds)}
        if self.engine == "omni":
            for row in result["picks"].values():
                if row:
                    row["latency_ms"] = {steps: round(per * row["seconds"]) for steps, per in LATENCY_MS_PER_SECOND.items()}
        return result

    @staticmethod
    def paired_se(a, b):
        diffs = [x - y for x, y in zip(a, b)]
        return statistics.stdev(diffs) / math.sqrt(len(diffs)) if len(diffs) > 1 else float("inf")

    def describe(self, ids, final, seeds, with_pls=True) -> dict:
        per_line = self.per_line(ids, final, seeds)
        row = {"ids": list(ids), "seconds": self.seconds(ids), "ecapa": round(mean(per_line), 4),
               "ecapa_se": round(statistics.stdev(per_line) / math.sqrt(len(per_line)), 4) if len(per_line) > 1 else None,
               "ecapa_tgt": round(self.value(ids, final, seeds, "et"), 4), "per_line": [round(v, 4) for v in per_line]}
        if with_pls and getattr(self, "rechoose", False):
            old = getattr(self, "old_result", None) or {}
            for earlier in list((old.get("picks") or {}).values()) + [old.get("today")] + list(old.get("candidates", [])):
                if earlier and earlier.get("ids") == list(ids) and "pls" in earlier:
                    row.update({k: earlier[k] for k in ("pls", "pls_parts") if k in earlier})
                    break
        elif with_pls:
            self._pls = getattr(self, "_pls", {})
            if ids not in self._pls:
                self._pls[ids] = self.pls_for(ids, final, seeds)
            row.update(self._pls[ids])
        return row

    def pls_for(self, ids, final, seeds) -> dict:
        from score import pls_from_components
        if not hasattr(self, "_stats"):
            self._stats = self.scorer.voice_stats(self.pool, self.split)
        pairs = []
        for line in final:
            for seed in seeds:
                wav = self.render_path(self.key(ids, line, seed))
                if Path(wav).is_file():
                    pairs.append((wav, self.clip(line)["path"]))
        if not pairs:
            return {}
        try:
            components = self.scorer.pls_components(self.voice, pairs, self._stats)
        except Exception as error:                     # PLS is secondary; never lose a voice over it
            return {"pls_error": str(error)[:200]}
        return {"pls": round(pls_from_components(components), 2), "pls_parts": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in components.items()}}


def make_plans(index, voices, scorer, out_dir: Path, engine: str = "pocket"):
    """Write <out_dir>/<voice>.json = {split, screened, split_key, files}: the held-out split and prescreen of a voice, so another
    machine (a Kaggle notebook) can run the same search on a trimmed copy of the pool without the full pool."""
    out_dir.mkdir(parents=True, exist_ok=True)

    class _Tag:
        tag = "plan"

    for voice in voices:
        search = Search(engine, _Tag, scorer, voice, index, common.WORK / "plans-work", SIZES[engine])
        if not search.split["ok"]:
            print(f"{voice}: no split ({search.split['reason']})")
            continue
        info = search.screen()
        ids = list(dict.fromkeys(search.screened + search.split["holdout"] + (search.restrict or [])))
        files = {i: search.pool.clip(i)["path"] for i in ids if not i.startswith("line:")}
        plan = {"voice": voice, "split": search.split, "screened": search.screened, "split_key": search.split_key, "screen": info,
                "files": files, "lines": [l["path"] for l in search.page_lines],
                "live": {k: v["reference"] for k, v in search.pool.live.items() if v.get("exists")}}
        (out_dir / f"{voice}.json").write_text(json.dumps(plan, indent=1), encoding="utf-8")
        print(f"{voice}: plan with {len(files)} clips, split {search.split_key}", flush=True)


def verify(engine_tag_from: Path, renderer, scorer, index, out_root, voices, sizes, plan_dir=None):
    """Re-score another run's winners with this renderer (OmniVoice 32 steps) on the same fresh lines."""
    for voice in voices:
        source = engine_tag_from / voice / "result.json"
        target = out_root / renderer.tag / voice / "verify.json"
        if not source.is_file() or target.is_file():
            continue
        result = json.loads(source.read_text(encoding="utf-8"))
        plan = json.loads((plan_dir / f"{voice}.json").read_text(encoding="utf-8")) if plan_dir and (plan_dir / f"{voice}.json").is_file() else None
        search = Search("omni", renderer, scorer, voice, index, out_root, sizes, plan=plan)
        search.screen()
        final, seeds = search.split["final"], search.final_seeds
        sets = {name: tuple(row["ids"]) for name, row in result["picks"].items() if row}
        unique = list(dict.fromkeys(sets.values()))
        search.evaluate(unique, final, seeds, keep=True, stage="verify")
        out = {name: search.describe(ids, final, seeds) for name, ids in sets.items()}
        out["today"] = None
        today = (f"live:omni",)
        if search.pool.live.get("omni", {}).get("exists"):
            search.evaluate([today], final, seeds, keep=True, stage="verify")
            out["today"] = search.describe(today, final, seeds)
        target.write_text(json.dumps(out, indent=1), encoding="utf-8")
        for path in (search.dir / "r").glob("*.wav"):
            path.unlink(missing_ok=True)
        print(f"{voice}: verified at {renderer.tag}: " + ", ".join(f"{k} {v['ecapa']}" for k, v in out.items() if v), flush=True)


def wait_for_gpu(max_used_mb=1500, max_util=35, poll=15, quiet_polls=6, log=print):
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
    parser.add_argument("--export", type=Path, default=Path(r"E:\CyberpunkConvai-offload\work\pocket-v2\exports\student-v2-s2000-ema-decv2"))
    parser.add_argument("--tag", help="result folder name for Pocket (default pocket-<export folder name>); remote runs pass the local tag")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--index", type=Path, default=common.POOL_INDEX)
    parser.add_argument("--out", type=Path, default=common.WORK / "runs3")
    parser.add_argument("--prune-from", help="tag of another engine's run (e.g. omni16) whose singles ranking prunes this one")
    parser.add_argument("--prune-wait-min", type=int, default=90)
    parser.add_argument("--verify-from", help="tag of a 16-step run whose winners are re-scored by this (32-step) renderer")
    parser.add_argument("--plan-dir", type=Path, help="use precomputed <voice>.json plans (split + prescreen) from this folder")
    parser.add_argument("--make-plans", type=Path, help="write the plans for --voices into this folder and exit")
    parser.add_argument("--rechoose", action="store_true", help="recompute the picks of finished voices from the cached scores (no renders)")
    parser.add_argument("--omni-direct", action="store_true", help="call the omnivoice package directly (portable GPU runs) instead of the VoiceStudio backend")
    parser.add_argument("--wait-gpu", action="store_true")
    parser.add_argument("--scorer-device", default="cuda")
    args = parser.parse_args(argv)

    index = common.load_index(args.index)
    shown = json.loads((ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
    voices = args.voices.split(",") if args.voices else shown
    from score import Scorer
    if args.rechoose:                                  # cached scores only; a renderer starts lazily if a score is missing
        class _Cached:
            tag = args.tag or (f"omni{args.steps}" if args.engine == "omni" else f"pocket-{args.export.name}")
            inner = None

            def render(self, jobs):
                if self.inner is None:
                    print(f"rechoose: {len(jobs)} score(s) missing in the cache, starting a renderer", flush=True)
                    if args.engine == "omni":
                        from render import OmniDirectRenderer
                        self.inner = OmniDirectRenderer(args.steps)
                    else:
                        from render import PocketRenderer
                        self.inner = PocketRenderer(args.export, 1, args.threads, tag=_Cached.tag)
                return self.inner.render(jobs)

            def close(self):
                if self.inner is not None:
                    self.inner.close()
        renderer = _Cached()
    elif args.engine == "omni":
        if args.wait_gpu:
            wait_for_gpu()
        from render import OmniDirectRenderer, OmniRenderer
        direct = args.omni_direct or os.environ.get("CLIP_SEARCH_OMNI") == "direct" or not (ROOT / "vendor/reference-voicestudio/backend").is_dir()
        renderer = (OmniDirectRenderer if direct else OmniRenderer)(args.steps)
    else:
        from render import PocketRenderer
        renderer = PocketRenderer(args.export, args.workers, args.threads, tag=args.tag)
    scorer = Scorer(args.scorer_device)
    out_root = args.out
    if args.make_plans:
        make_plans(index, voices, scorer, args.make_plans, args.engine)
        return 0
    started = time.time()
    try:
        if args.verify_from:
            verify(out_root / args.verify_from, renderer, scorer, index, out_root, voices, SIZES["omni"], args.plan_dir)
            return 0
        prune = out_root / args.prune_from if args.prune_from else None
        for voice in voices:
            if voice not in index["voices"]:
                print(f"{voice}: not in the pool index")
                continue
            result_file = out_root / renderer.tag / voice / "result.json"
            if result_file.is_file() and not args.rechoose:
                print(f"{voice}: already done")
                continue
            if args.rechoose and not result_file.is_file():
                continue
            if prune is not None:
                waited = 0
                while not (prune / voice / "result.json").is_file() and waited < args.prune_wait_min * 60:
                    time.sleep(20)
                    waited += 20
            plan = None
            if args.plan_dir and (args.plan_dir / f"{voice}.json").is_file():
                plan = json.loads((args.plan_dir / f"{voice}.json").read_text(encoding="utf-8"))
            search = Search(args.engine, renderer, scorer, voice, index, out_root, SIZES[args.engine], plan=plan)
            try:
                if args.rechoose:
                    search.old_result = json.loads(result_file.read_text(encoding="utf-8"))
                    backup = result_file.with_name("result.before-rechoose.json")
                    if not backup.is_file():
                        shutil.copy2(result_file, backup)
                result = search.run(prune, rechoose=args.rechoose)
            except Exception as error:                 # a night's run must survive one voice's failure
                import traceback
                traceback.print_exc()
                print(f"{voice}: FAILED ({type(error).__name__}: {error})", flush=True)
                continue
            if "skipped" in result:
                print(f"{voice}: skipped ({result['skipped']})")
                continue
            best = result["picks"]["best"]
            extra = "" if args.engine == "pocket" else f" short {result['picks']['short']['seconds']} s {result['picks']['short']['ecapa']}, long {result['picks']['long']['seconds']} s {result['picks']['long']['ecapa']};"
            print(f"{voice}: best {best['seconds']} s ecapa {best['ecapa']} (+-{best['ecapa_se']});{extra} renders {result['budget']['renders']} in {result['budget']['wall_seconds']:.0f}s", flush=True)
    finally:
        renderer.close()
    print(f"finished {len(voices)} voices in {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
