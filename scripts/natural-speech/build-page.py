"""Build the labeled natural-speech listening page next to the WAVs.

Reads scripts/natural-speech/lines.json and <root>/measurements.json, copies the WAVs to <root>/page/audio and
writes <root>/page/index.html (a static page; the picker can also serve the page folder read-only).
Rows: character x line.  Columns: variant x engine (Pocket, Omni 16, Omni 32).  Each variant's text sits above its row
of players, with the measured pauses under each player.
"""
from __future__ import annotations

import html
import json
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
ENGINES = [("pocket", "Pocket"), ("omni16", "Omni 16"), ("omni32", "Omni 32")]
CHUNKED = [("omni16c", "Omni 16, bridge phrases"), ("omni32c", "Omni 32, bridge phrases")]
TAGS_NOTE = {
    "[laughter]": "laugh", "[sigh]": "sigh", "[confirmation-en]": "confirmation (mm-hm)", "[question-en]": "question",
    "[surprise-oh]": "surprise oh", "[surprise-ah]": "surprise ah", "[dissatisfaction-hnn]": "dissatisfaction hnn"}


def e(text: str) -> str:
    return html.escape(text, quote=True)


def stats_text(item: dict | None) -> str:
    if not item:
        return "not rendered"
    pauses = ", ".join(f"{e(p.get('after', 'at ' + str(p['at'])))} {p['seconds']:.2f}" for p in item["pauses"]) or "none"
    return (f"<b>{item['seconds']:.1f} s</b> &middot; {item['pauseCount']} pauses &ge;150 ms, total {item['pauseTotal']:.2f} s, "
            f"longest {item['pauseLongest']:.2f} s &middot; speech {item['speech']:.1f} s"
            f"<div class=p>after word (s): {pauses}</div>")


def player(root: Path, page: Path, engine: str, name: str, measure: dict) -> str:
    source = root / engine / f"{name}.wav"
    if not source.is_file():
        return "<td class=na>missing</td>"
    target = page / "audio" / engine / f"{name}.wav"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return (f"<td><audio controls preload=none src=\"audio/{engine}/{e(name)}.wav\"></audio>"
            f"<div class=m>{stats_text(measure.get(engine, {}).get(name))}</div></td>")


def summary(measure: dict, lines: dict) -> str:
    rows = []
    for variant in lines["variants"]:
        cells = [f"<th class=v>{e(variant['id'])}: {e(variant['label'])}</th>"]
        for engine, _ in ENGINES + CHUNKED:
            items = [item for name, item in measure.get(engine, {}).items()
                     if not name.startswith("probe/") and name.endswith("__" + variant["id"]) ]
            if not items:
                cells.append("<td>-</td>")
                continue
            n = len(items)
            cells.append("<td>{:.1f} s<div class=m>{:.1f} pauses, {:.2f} s paused, longest {:.2f} s, speech {:.1f} s</div></td>".format(
                sum(i["seconds"] for i in items) / n, sum(i["pauseCount"] for i in items) / n,
                sum(i["pauseTotal"] for i in items) / n, sum(i["pauseLongest"] for i in items) / n,
                sum(i["speech"] for i in items) / n))
        rows.append("<tr>" + "".join(cells) + "</tr>")
    head = "<tr><th class=v>Variant (mean over 8 lines)</th>" + "".join(f"<th>{label}</th>" for _, label in ENGINES + CHUNKED) + "</tr>"
    return f"<table class=sum>{head}{''.join(rows)}</table>"


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\CyberpunkConvai-offload\work\natural-speech")
    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))
    measure = json.loads((root / "measurements.json").read_text(encoding="utf-8"))
    page = root / "page"
    page.mkdir(exist_ok=True)

    def table(engines):
        head = ["<tr><th class=v rowspan=2>Character / line</th>"]
        for variant in lines["variants"]:
            head.append(f"<th colspan={len(engines)}>{e(variant['id'])}<div class=t>{e(variant['label'])}</div></th>")
        head.append("</tr><tr>" + "".join(f"<th>{label}</th>" for _ in lines["variants"] for _, label in engines) + "</tr>")
        body = []
        for key, character in lines["characters"].items():
            for line_id, line in character["lines"].items():
                texts, players = [], []
                for variant in lines["variants"]:
                    vid = variant["id"]
                    text = line["v"][vid]
                    if vid == "v5":
                        fallback = line["v"]["v5_pocket"]
                        shown = f"<div><span class=eng>Omni:</span> {e(text)}</div>"
                        if any(name == "pocket" for name, _ in engines):
                            shown += f"<div><span class=eng>Pocket (no tags, spelled fallback):</span> {e(fallback)}</div>"
                    else:
                        shown = e(text)
                    texts.append(f"<td colspan={len(engines)} class=txt>{shown}</td>")
                    for engine, _ in engines:
                        players.append(player(root, page, engine, f"{key}__{line_id}__{vid}", measure))
                label = f"<th class=v rowspan=2>{e(character['name'])}, line {line_id}<div class=t>{e(line['context'])}</div></th>"
                body.append(f"<tr>{label}{''.join(texts)}</tr><tr>{''.join(players)}</tr>")
        return f"<div class=\"wrap\"><table>{''.join(head)}{''.join(body)}</table></div>"

    probe_rows = []
    probe = lines["tag_probe"]
    for key in probe["characters"]:
        for tag in probe["tags"]:
            name = f"probe/{key}__{tag.strip('[]')}"
            cells = [f"<th class=v>{e(lines['characters'][key]['name'])}: <code>{e(tag)}</code>"
                     f"<div class=t>{e(probe['carrier'].format(tag=tag))}</div></th>"]
            for engine in ("omni16", "omni32"):
                source = root / engine / f"{name}.wav"
                if source.is_file():
                    target = page / "audio" / engine / f"{name}.wav"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
                    item = measure.get(engine, {}).get(name)
                    cells.append(f"<td><audio controls preload=none src=\"audio/{engine}/{e(name)}.wav\"></audio>"
                                 f"<div class=m>{stats_text(item)}</div></td>")
                else:
                    cells.append("<td class=na>missing</td>")
            probe_rows.append("<tr>" + "".join(cells) + "</tr>")

    fprobe = json.loads((root / "fprobe.json").read_text(encoding="utf-8")) if (root / "fprobe.json").is_file() else {}
    filler_rows = []
    spec = lines["filler_probe"]
    for key in spec["characters"]:
        for slug, text in spec["texts"].items():
            cells = [f"<th class=v>{e(lines['characters'][key]['name'])}: <code>{e(text)}</code>"
                     f"{'<div class=t>control: a real word</div>' if slug.startswith('ctl-') else ''}</th>"]
            for engine in ("pocket", "omni16", "omni32"):
                source = root / engine / "fprobe" / f"{key}__{slug}.wav"
                if not source.is_file():
                    cells.append("<td class=na>missing</td>")
                    continue
                target = page / "audio" / engine / "fprobe" / source.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                cue = fprobe.get(engine, {}).get(source.stem)
                cue_text = (f"voiced span {cue['span']:.2f} s &middot; centroid {cue['centroidHz']} Hz &middot; "
                            f"{int(cue['below1k'] * 100)}% below 1 kHz &middot; {int(cue['voicedFraction'] * 100)}% voiced") if cue and cue.get("span") else ""
                cells.append(f"<td><audio controls preload=none src=\"audio/{engine}/fprobe/{e(source.name)}\"></audio><div class=m>{cue_text}</div></td>")
            filler_rows.append("<tr>" + "".join(cells) + "</tr>")

    css = """body{font-family:system-ui,sans-serif;margin:16px;background:#111;color:#eee}
table{border-collapse:collapse} .wrap{overflow-x:auto} td,th{border:1px solid #333;padding:6px;vertical-align:top}
th{background:#1b1b1b;font-weight:600;font-size:13px} th.v{text-align:left;min-width:150px;max-width:230px}
.t{font-weight:400;color:#aaa;font-size:12px;margin-top:4px} .m{font-weight:400;color:#8fd;font-size:12px;margin-top:4px}
.p{color:#999;font-size:11px;margin-top:3px} audio{width:200px} p{max-width:960px;color:#bbb} td.txt{font-size:13px;max-width:600px;background:#161616}
td.na{color:#777} .eng{color:#fc8} code{color:#fc8} table.sum td{min-width:210px} h2,h3{margin-top:26px}"""
    page_html = f"""<!doctype html><html><head><meta charset="utf-8"><title>Natural speech test</title>
<style>{css}</style></head><body>
<h2>Natural speech: pauses, fillers and trailing off, per engine</h2>
<p>Labeled, not blind. Four characters, two original in-character lines each (written for this test, not game dialogue), five
variants of the same content. Every engine uses the character's proposed 18 s three-clip reference. Pocket = student 5,000
raw with the fine-tuned (decoder A) Mimi decoder, CPU, the bridge's own generation call; Omni = the bridge's OmniVoice call at
16 and 32 steps, seed 1042. Under each player: duration, pauses of at least 150 ms found by silence detection (internal
only), the word each pause follows (alignment is proportional, so approximate), and speech time without pauses. The rows
above the players give each variant's text. Variant 5 is an OmniVoice tag
(<code>[laughter]</code> or <code>[sigh]</code>); Pocket has no tag support, so it gets a spelled-out fallback (&ldquo;Heh.&rdquo; or &ldquo;Haah.&rdquo;).</p>
<h3>Measured means per variant</h3>{summary(measure, lines)}
<h3>Lines (whole line in one call)</h3>{table(ENGINES)}
<h3>Lines as the bridge actually sends them to OmniVoice</h3>
<p>The bridge splits every reply into phrases (6 to 34 words, ending at . ! ? or , ; : &mdash;, see <code>bridge/speech-phrases.mjs</code>)
and renders each phrase in its own call, seed 1042, then plays them back to back. This is the same text as above, so an
ellipsis or dash that lands on a phrase edge gets only the engine's own trailing silence, and the voice's prosody resets.</p>{table(CHUNKED)}
<h3>OmniVoice tag probe</h3>
<p>One short carrier sentence with each tag OmniVoice documents for English. (Pocket has no tags.)</p>
<div class="wrap"><table><tr><th class=v>Tag</th><th>Omni 16</th><th>Omni 32</th></tr>{''.join(probe_rows)}</table></div>
<h3>Isolated fillers</h3>
<p>Each filler alone, with real words as controls (Ham, Home, Hum). The numbers are acoustic cues only: a closed-mouth hum
is low (centroid under about 700 Hz, most energy below 1 kHz) while an open-vowel word is not. They cannot tell what a clip
sounds like; listening decides.</p>
<div class="wrap"><table><tr><th class=v>Filler</th><th>Pocket</th><th>Omni 16</th><th>Omni 32</th></tr>{''.join(filler_rows)}</table></div>
</body></html>"""
    (page / "index.html").write_text(page_html, encoding="utf-8")
    print(page / "index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
