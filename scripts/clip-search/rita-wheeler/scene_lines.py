"""List the screenplay lines of one scene actor from an exported scene JSON (see research/cyberpunk/scripts/extract_scene_evidence.py),
with the locstring id, the installed English subtitle text and the voice tag id of the actor.

Usage: python scene_lines.py <scene.json> <actorName>
Prints one JSON object per line; the voice file of a line is `<voice prefix>_f_<hex of the id>.wem`."""
import json, sqlite3, sys
sys.stdout.reconfigure(encoding="utf-8")
ROOT = r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"
root = json.load(open(sys.argv[1], encoding="utf-8-sig"))["Data"]["RootChunk"]
db = sqlite3.connect("file:" + (ROOT + "/research/cyberpunk/cache/game/localization/index/lookup.sqlite3").replace("\\", "/") + "?mode=ro", uri=True)
ids = {a["actorId"]["id"]: a for a in root["actors"]}
want = [i for i, a in ids.items() if a["actorName"] == sys.argv[2]]
assert len(want) == 1, "actor name must be unique in the scene"
a = ids[want[0]]
print(json.dumps({"actor": a["actorName"], "actorId": want[0], "plan": a["acquisitionPlan"], "communityEntry": a["communityParams"]["entryName"]["$value"],
                  "community": a["communityParams"]["reference"]["$value"], "voicetagId": a["voicetagId"]["id"]}))
for l in root["screenplayStore"]["lines"]:
    if l["speaker"]["id"] != want[0]:
        continue
    ruid = l["locstringId"]["ruid"]
    row = db.execute("select female,male from entries where domain='subtitle.stringId' and entry_id=?", (ruid,)).fetchone()
    print(json.dumps({"itemId": l["itemId"]["id"], "stringId": ruid, "hex": format(int(ruid), "x"), "text": (row[0] or row[1] or "") if row else None}, ensure_ascii=False))
