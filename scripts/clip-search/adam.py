"""Reference sets for one voice from a hand-picked pool of clips, scored on that voice's own page lines (overfitting allowed).

Written for Adam Smasher (the user picked 11 clips by ear; the pool has too few other clips for the held-out search).  Same
engines and settings as search.py; the score is ECAPA between each render and the ORIGINAL recording of the same line
(primary, mean over the voice's two held-out page lines and several seeds), with PLS components secondary.  No WER.

  python scripts/clip-search/adam.py --engine omni --steps 16
  python scripts/clip-search/adam.py --engine pocket --export <pocket export dir>
  python scripts/clip-search/adam.py --engine omni --steps 32 --verify omni16        # re-score the 16-step finalists at 32

Search: every single, pair and triple of the pool (they all fit the caps) on both lines with one seed; the best of each size
are grown by one clip (4, 5, 6 clips) while they still fit 18 s; the best of each size plus the best short (<= 10 s) sets get
five seeds; the best sets of each size are then re-rendered in other clip orders; the winner per variant is the best mean, but
the smallest set within one paired standard error of it (over line x seed cells) wins.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ROOT = common.ROOT
VOICE = "adam-smasher"
POOL_IDS = ("1653087655475433472 1776711517152501760 1876330591075450880 1876331655187152896 1995324830177058816 "
            "1995048870861103104 1995076448980328448 1792270501449261056 1792271201864474624 1792275223900020748 "
            "1792275223900020764").split()
SEEDS = (1042, 7, 99, 2024, 31337)
OUT = common.WORK / "adam"


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else float("nan")


class AdamSearch:
    def __init__(self, engine, renderer, scorer, voice=VOICE, ids=POOL_IDS, out=OUT, log=print):
        self.engine, self.renderer, self.scorer, self.voice, self.log = engine, renderer, scorer, voice, log
        index = common.load_index()
        self.pool = common.VoicePool(index, voice)
        self.ids = [f"{voice}/{i}" for i in ids]
        for cid in self.ids:
            if cid not in self.pool.by_id or self.pool.clip(cid).get("fx"):
                raise SystemExit(f"{cid} is not a usable pool clip")
        self.lines = [l for l in index["voices"][voice]["lines"] if l["exists"]]
        self.dir = out / renderer.tag
        self.dir.mkdir(parents=True, exist_ok=True)
        self.store_file = self.dir / "scores.json"
        self.store = json.loads(self.store_file.read_text(encoding="utf-8")) if self.store_file.is_file() else {}
        self.target = [scorer.embed_cached(l["path"]) for l in self.lines]
        self.renders = 0
        self.render_ms = 0
        self.started = time.time()

    # ---- clips, sets, references ----
    def clip(self, cid):
        return self.pool.clip(cid)

    def seconds(self, ids):
        return round(common.joined_seconds(self.clip(i)["d"] for i in ids), 3)

    def fits(self, ids):
        return common.joined_seconds(self.clip(i)["d"] for i in ids) <= common.CAPS[3] + 1e-9

    def reference(self, ids):
        import hashlib
        name = hashlib.sha1("|".join(ids).encode()).hexdigest()[:16]
        path = common.WORK / "refs" / f"{name}.wav"
        if not path.is_file():
            common.build_reference([self.clip(i)["path"] for i in ids], path)
        return str(path), " ".join(self.clip(i)["t"].strip() for i in ids)

    # ---- render + score with a cache ----
    @staticmethod
    def key(ids, line, seed):
        return f"{'|'.join(ids)}#{line}#{seed}"

    def render_path(self, key):
        import hashlib
        return str(self.dir / "r" / f"{hashlib.sha1(key.encode()).hexdigest()[:16]}.wav")

    def evaluate(self, sets, seeds=(SEEDS[0],), keep=False, stage="?"):
        jobs = []
        for ids in sets:
            for li, line in enumerate(self.lines):
                for seed in seeds:
                    key = self.key(ids, li, seed)
                    if key in self.store and (not keep or Path(self.render_path(key)).is_file() or self.store[key].get("ec") is None):
                        continue
                    ref, transcript = self.reference(ids)
                    jobs.append({"key": key, "ref": ref, "transcript": transcript, "text": line["t"], "seed": seed,
                                 "out": self.render_path(key), "line": li})
        if not jobs:
            return
        began = time.time()
        step = 64
        for start in range(0, len(jobs), step):
            chunk = jobs[start:start + step]
            for job, result in zip(chunk, self.renderer.render(chunk)):
                if not result["ok"]:
                    self.store[job["key"]] = {"ec": None, "error": result["error"]}
                    continue
                emb = self.scorer.embed(job["out"])
                self.store[job["key"]] = {"ec": float(emb @ self.target[job["line"]]), "sec": round(result["seconds"], 2)}
                self.renders += 1
                self.render_ms += result["tookMs"]
                if not keep:
                    Path(job["out"]).unlink(missing_ok=True)
            self.save()
        self.log(f"  [{self.renderer.tag}] {stage}: {len(jobs)} renders in {time.time() - began:.0f}s")

    def save(self):
        temporary = self.store_file.with_name(self.store_file.name + ".part")
        temporary.write_text(json.dumps(self.store), encoding="utf-8")
        temporary.replace(self.store_file)

    def cells(self, ids, seeds):
        return [(self.store.get(self.key(ids, li, s)) or {}).get("ec") or 0.0 for li in range(len(self.lines)) for s in seeds]

    def value(self, ids, seeds=(SEEDS[0],)):
        return mean(self.cells(ids, seeds))

    # ---- the search ----
    def run(self, verify=None):
        log = self.log
        canon = lambda ids: tuple(sorted(ids))
        singles = [(c,) for c in self.ids]
        pairs = [canon(p) for p in itertools.combinations(self.ids, 2) if self.fits(p)]
        triples = [canon(t) for t in itertools.combinations(self.ids, 3) if self.fits(t)]
        self.evaluate(singles + pairs, stage="singles and pairs, seed 1")
        self.evaluate(triples, stage="triples, seed 1")
        level = {1: singles, 2: pairs, 3: triples}
        score1 = {s: self.value(s) for s in singles + pairs + triples}
        grown = {}
        previous = sorted(triples, key=lambda s: -score1[s])[:12]
        for k in (4, 5, 6):
            children = {canon((*s, c)) for s in previous for c in self.ids if c not in s and self.fits((*s, c))}
            if not children:
                break
            self.evaluate(sorted(children), stage=f"{k} clips, seed 1")
            for s in children:
                score1[s] = self.value(s)
            level[k] = sorted(children)
            previous = sorted(children, key=lambda s: -score1[s])[:8]
        # five seeds for the contenders
        contenders = []
        for k, sets in level.items():
            contenders += sorted(sets, key=lambda s: -score1[s])[:5 if k > 1 else 6]
        contenders += sorted(pairs, key=lambda s: -score1[s])[:8]                        # the 10 s family
        contenders += sorted(singles + pairs, key=lambda s: -score1[s])[:6]
        contenders = list(dict.fromkeys(contenders))
        self.evaluate(contenders, SEEDS, stage="contenders, 5 seeds")
        score5 = {s: self.value(s, SEEDS) for s in contenders}
        # order tests: the best sets of each size in other orders
        orders = []
        for k in (2, 3, 4, 5):
            tops = [s for s in sorted(score5, key=lambda s: -score5[s]) if len(s) == k][:3]
            for s in tops:
                perms = [p for p in itertools.permutations(s) if p != s]
                perms = perms if len(perms) <= 8 else [perms[i] for i in range(0, len(perms), max(1, len(perms) // 8))][:8]
                orders += perms
        orders = list(dict.fromkeys(orders))
        self.evaluate(orders, SEEDS, stage="order tests, 5 seeds")
        everything = list(dict.fromkeys(contenders + orders))
        score5 = {s: self.value(s, SEEDS) for s in everything}
        baseline = [("live:omni" if self.engine == "omni" else "live:pocket",)]
        # today's reference as a baseline
        return {"level": level, "score1": score1, "score5": score5, "baseline": baseline}


def paired_se(a, b):
    diffs = [x - y for x, y in zip(a, b)]
    return statistics.stdev(diffs) / math.sqrt(len(diffs)) if len(diffs) > 1 else float("nan")


def choose(search, score5, max_k, cap):
    """Best mean among sets within the cap and at most max_k clips; then the smallest set within one paired SE."""
    allowed = [s for s in score5 if len(s) <= max_k and search.seconds(s) <= cap + 1e-6]
    if not allowed:
        return None
    top = max(allowed, key=lambda s: score5[s])
    cells_top = search.cells(top, SEEDS)
    within = [s for s in allowed if s == top or (len(s) < len(top) and score5[top] - score5[s] <= paired_se(cells_top, search.cells(s, SEEDS)))]
    return min(within, key=lambda s: (len(s), -score5[s]))


def describe(search, ids, score5):
    cells = search.cells(ids, SEEDS)
    return {"ids": list(ids), "k": len(ids), "seconds": search.seconds(ids), "ecapa": round(score5[ids], 4),
            "ecapa_se": round(statistics.stdev(cells) / math.sqrt(len(cells)), 4),
            "per_line": [round(mean(search.cells(ids, SEEDS)[li * len(SEEDS):(li + 1) * len(SEEDS)]), 4) for li in range(len(search.lines))],
            "text": [search.clip(i)["t"] for i in ids]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", choices=["omni", "pocket"], required=True)
    parser.add_argument("--steps", type=int, default=16)
    parser.add_argument("--export", type=Path, default=Path(r"E:\CyberpunkConvai-offload\work\pocket-v2\exports\student-v2-s2000-ema-decv2"))
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--verify", help="result.json of a 16-step run: re-score its finalists with this renderer instead of searching")
    parser.add_argument("--scorer-device", default="cuda")
    args = parser.parse_args(argv)
    from score import Scorer
    if args.engine == "omni":
        from render import OmniRenderer
        renderer = OmniRenderer(args.steps)
    else:
        from render import PocketRenderer
        renderer = PocketRenderer(args.export, args.workers, 4)
    scorer = Scorer(args.scorer_device)
    search = AdamSearch(args.engine, renderer, scorer)
    try:
        if args.verify:
            previous = json.loads(Path(args.verify).read_text(encoding="utf-8"))
            sets = [tuple(row["ids"]) for row in previous["finalists"][:14]] + [tuple(row["ids"]) for row in previous["picks"].values() if row]
            sets = list(dict.fromkeys(sets))
            search.evaluate(sets, SEEDS, keep=True, stage="verify")
            score5 = {s: search.value(s, SEEDS) for s in sets}
            result = {"verify": [describe(search, s, score5) for s in sorted(sets, key=lambda s: -score5[s])]}
            (search.dir / "verify.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
            for row in result["verify"][:8]:
                print(row["k"], row["seconds"], row["ecapa"], row["per_line"], [i.split("/")[-1][-6:] for i in row["ids"]])
            return 0
        outcome = search.run()
        score5 = outcome["score5"]
        picks = {"best": choose(search, score5, 6, 18), "short": choose(search, score5, 2, 10), "single": choose(search, score5, 1, 9),
                 "best3": choose(search, score5, 3, 18)}
        # today's reference as the baseline, and the earlier auto-best of this voice
        today = ("live:" + args.engine if args.engine == "omni" else "live:pocket",)
        index = common.load_index()
        live = index["voices"][search.voice]["live"]
        extra = [today]
        previous = None
        try:
            old = json.loads((ROOT / "runtime/autobest-sets.json").read_text(encoding="utf-8"))["voices"][search.voice][args.engine]["best"]
            previous = tuple(old["ids"])
            extra.append(previous)
        except Exception:
            pass
        # the baselines need the live reference: register it as a pseudo clip
        search.pool.by_id[today[0]] = common.Clip({"id": today[0], "d": live[args.engine]["d"], "t": live[args.engine]["transcript"],
                                                  "path": str(ROOT / live[args.engine]["reference"])})
        chosen = [s for s in dict.fromkeys(tuple(v) for v in picks.values() if v)]
        baselines = [s for s in extra if s == today or all(c in search.pool.by_id for c in s)]
        final_sets = list(dict.fromkeys(chosen + baselines))
        # the live reference is a single wav, not a pool clip: render it through the same path
        search.evaluate([s for s in final_sets if s != today], SEEDS, keep=True, stage="final renders")
        live_ref = (str(ROOT / live[args.engine]["reference"]), live[args.engine]["transcript"])
        search.reference = (lambda orig: (lambda ids: live_ref if ids == today else orig(ids)))(search.reference)
        search.evaluate([today], SEEDS, keep=True, stage="today's reference")
        for s in final_sets:
            score5.setdefault(s, search.value(s, SEEDS))
        result = {"engine": args.engine, "tag": renderer.tag, "lines": [l["t"] for l in search.lines],
                  "picks": {name: (describe(search, s, score5) if s else None) for name, s in picks.items()},
                  "today": describe(search, today, score5), "previous_autobest": describe(search, previous, score5) if previous in score5 else None,
                  "finalists": [describe(search, s, score5) for s in sorted(score5, key=lambda s: -score5[s])[:40]],
                  "by_size": {str(k): describe(search, max((s for s in score5 if len(s) == k), key=lambda s: score5[s]), score5)
                              for k in range(1, 7) if any(len(s) == k for s in score5)},
                  "budget": {"renders": search.renders, "render_seconds": round(search.render_ms / 1000, 1),
                             "wall_seconds": round(time.time() - search.started, 1)}}
        (search.dir / "result.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
        for name, row in result["picks"].items():
            if row:
                print(name, row["k"], row["seconds"], row["ecapa"], "+-", row["ecapa_se"], [i.split("/")[-1][-8:] for i in row["ids"]])
        print("today", result["today"]["ecapa"], "previous", (result["previous_autobest"] or {}).get("ecapa"))
    finally:
        renderer.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
