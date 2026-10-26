"""Prints the journal outline of quests (author aid for research/cyberpunk/quest-briefings.json).

For every cooked journal quest it lists the game's quest type, the English title and the ordered objectives
(phase/objective path, English text, optional flag), read from the private installed-resource caches
(cache/game/index/journal.jsonl and cache/game/localization/index/lookup.sqlite3). The text is shipped game text
and stays in the private cache and in the output you read: a briefing is written in your own words
(docs/QUEST_BRIEFINGS.md), never pasted from here or from a website.

  python -I research/cyberpunk/scripts/quest_outline.py --list [--type StreetStory] [--match fixer]
  python -I research/cyberpunk/scripts/quest_outline.py --path quests/side_quest/sq023_real_passion
  python -I research/cyberpunk/scripts/quest_outline.py --dump out.json [--type MainQuest]

`--cache` names the research/cyberpunk/cache folder (default: next to this repository's research folder, or the main
checkout's when run from a worktree whose cache is absent).
"""
import argparse
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))


def find_cache(given):
    candidates = [given] if given else []
    candidates.append(os.path.join(ROOT, 'research', 'cyberpunk', 'cache'))
    # A git worktree lives at <main>/.claude/worktrees/<name>: the cache is ignored by git, so it is in the main checkout.
    parts = ROOT.replace('\\', '/').split('/.claude/worktrees/')
    if len(parts) == 2:
        candidates.append(os.path.join(parts[0], 'research', 'cyberpunk', 'cache'))
    for path in candidates:
        if path and os.path.exists(os.path.join(path, 'game', 'index', 'journal.jsonl')):
            return path
    sys.exit('journal.jsonl not found; pass --cache <research/cyberpunk/cache>')


def lock_key(value):
    match = re.fullmatch(r'LocKey#(\d+)', value or '')
    return match.group(1) if match else None


def load(cache):
    quests, nodes = {}, []
    with open(os.path.join(cache, 'game', 'index', 'journal.jsonl'), encoding='utf8') as handle:
        for line in handle:
            if '"gameJournalQuest' not in line:
                continue
            row = json.loads(line)
            if row['type'] in ('gameJournalQuest', 'gameJournalQuestPhase', 'gameJournalQuestObjective'):
                nodes.append(row)
    for row in nodes:
        if row['type'] == 'gameJournalQuest':
            quests[row['path']] = {'path': row['path'], 'type': row['fields'].get('type'),
                                   'titleKey': lock_key(row['fields'].get('title', {}).get('value')), 'objectives': []}
    for row in nodes:
        if row['type'] != 'gameJournalQuestObjective':
            continue
        # The quest root is the longest quest path that prefixes this node's path.
        owner = next((q for q in quests if row['path'].startswith(q + '/')), None)
        if owner is None:
            continue
        fields = row['fields']
        quests[owner]['objectives'].append({
            'rel': row['path'][len(owner) + 1:], 'id': row['id'], 'key': lock_key(fields.get('description', {}).get('value')),
            'optional': bool(fields.get('optional')), 'counter': fields.get('counter') or 0})
    return quests


def english(cache, keys):
    db = sqlite3.connect('file:' + os.path.join(cache, 'game', 'localization', 'index', 'lookup.sqlite3') + '?mode=ro', uri=True)
    out = {}
    for key in keys:
        if key is None or key in out:
            continue
        row = db.execute("select female, male from entries where domain='onscreen.primaryKey' and entry_id=? limit 1", (key,)).fetchone()
        out[key] = (row[0] or row[1] or '').strip() if row else ''
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--path')
    parser.add_argument('--dump')
    parser.add_argument('--type')
    parser.add_argument('--match')
    args = parser.parse_args()
    cache = find_cache(args.cache)
    quests = load(cache)
    chosen = [q for q in quests.values() if (not args.type or q['type'] == args.type) and (not args.path or q['path'] == args.path)
              and (not args.match or args.match.lower() in q['path'].lower())]
    keys = [q['titleKey'] for q in chosen] + [o['key'] for q in chosen for o in q['objectives']]
    text = english(cache, keys)
    for quest in chosen:
        quest['title'] = text.get(quest['titleKey'], '')
        for objective in quest['objectives']:
            objective['text'] = text.get(objective['key'], '')
    chosen.sort(key=lambda q: q['path'])
    if args.dump:
        with open(args.dump, 'w', encoding='utf8') as handle:
            json.dump(chosen, handle, ensure_ascii=False, indent=1)
        print(f'{len(chosen)} quests written to {args.dump}')
    for quest in chosen:
        print(f"{quest['path']}  [{quest['type']}]  {quest['title']}")
        if args.path or not args.list:
            for objective in quest['objectives']:
                print(f"    {objective['rel']}  {'(optional) ' if objective['optional'] else ''}{objective['text']}")


if __name__ == '__main__':
    main()
