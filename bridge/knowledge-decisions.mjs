// Which rules of the knowledge pack record a real branch decision, as opposed to something that merely happened?
// (docs/QUEST_DECISIONS.md, step 1.) The pack's category "decision" covers events too ("V and Judy got Evelyn out of the
// studio"), so it cannot rank choices ahead of events when a character's 8,000 characters run out. This module derives the
// flag from what the pack already says, at pack load, with no change to its data. It is pure and deterministic: the same
// rules always give the same answer, and each answer names its reason.
//
// A rule is a branch decision when ANY of these holds:
//   phone-reply   its condition proves V picked a phone reply (a journal entry of class gameJournalPhoneChoiceEntry);
//   alternatives  it is one of two or more outcomes of one decision point (narrativeLinks.decisionId), of one topic, or of
//                 one exclusive group, and none of those outcomes is a result of play rather than of V's choice
//                 (PERFORMANCE: detected or not, won or lost, a count of deaths);
//   statement     its statement says V did a deliberate thing (accepted, refused, spared, told, ...) and the rule is not a
//                 performance result.
// Tuned against a labelling of the 768 executable rules as choice or event (a Haiku pass over a written rubric; noisy, not shipped):
// the first-cut test (two or more outcomes of a decision point) flagged 392 rules with precision 0.63 and recall 0.76; this one flags
// 459 (308 alternatives, 80 phone replies, 71 statements) with precision 0.65 and recall 0.92. docs/QUEST_DECISIONS.md section 4.1a.

/** Outcome keys that record how a stretch of play went, not what V decided. A decision point holding one is not a choice. */
export const PERFORMANCE = Object.freeze(['detected', 'undetected', 'occurred', 'avoided', 'victory', 'defeat', 'all-alive',
  'some-deaths', 'personnel-killed', 'no-personnel-killed', 'failed-report', 'successful-report', 'first', 'second',
  'planned', 'crossed']);
const PERFORMANCE_SET = new Set(PERFORMANCE);

// "V accepted ...", "V and Takemura began cooperating ...", "Johnny selected ...": the subject is V (or Johnny in V's body) and the verb is
// a deliberate act. Plain beats (completed, got, reached, found, went, searched) are not in the list on purpose.
const SUBJECT = String.raw`(?:^|[\s,;:(])(?:V|Johnny)(?: and [A-Z][\w']*)?,? `;
const ACTS = ['chose', 'selected', 'picked', 'decided', 'accepted', 'agreed', 'refused', 'declined', 'rejected', 'spared', 'sided',
  'promised', 'killed', 'finished', 'told', 'disclosed', 'confronted', 'invited', 'asked', 'supported', 'urged', 'encouraged',
  'convinced', 'gave', 'gifted', 'let', 'deleted', 'attempted', 'kept', 'talked', 'cooperat\\w*', 'answered', 'replied', 'warned',
  'offered', 'paid', 'romanced', 'called', 'helped', 'joined'];
const ACT = new RegExp(`${SUBJECT}(?:\\w+ )?(?:${ACTS.join('|')})\\b`);
// The same verbs after a report ("Hands messaged V that ...") describe somebody else's act.
const REPORTED = /\b(?:messaged|texted|wrote|told) V\b/;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function phoneReplyKeys(node, keys = new Set()) {
  if (!plain(node)) return keys;
  for (const child of node.all ?? node.any ?? []) phoneReplyKeys(child, keys);
  if (node.type === 'journal' && typeof node.key === 'string') keys.add(node.key);
  return keys;
}

function add(map, key, outcome) {
  if (typeof key !== 'string') return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(outcome);
}

/**
 * @param {object[]} rules executable pack rules ({id, topic, outcome, statement, narrativeLinks, exclusiveGroups, condition})
 * @param {Map<string, object>} [journals] the pack's journal allowlist, to recognise phone replies
 * @returns {Map<string, string>} rule id -> reason, only for the rules that are branch decisions
 */
export function classifyDecisions(rules, journals = new Map()) {
  const points = new Map();
  for (const rule of rules) {
    add(points, `topic:${rule.topic}`, rule.outcome);
    for (const link of rule.narrativeLinks ?? []) add(points, `decision:${link?.decisionId}`, link?.outcomeKey ?? rule.outcome);
    for (const group of rule.exclusiveGroups ?? []) add(points, `group:${group?.id}`, group?.outcome);
  }
  const result = new Map();
  for (const rule of rules) {
    const keys = [`topic:${rule.topic}`, ...(rule.narrativeLinks ?? []).map(link => `decision:${link?.decisionId}`),
      ...(rule.exclusiveGroups ?? []).map(group => `group:${group?.id}`)];
    const sets = keys.map(key => points.get(key)).filter(Boolean);
    const performance = sets.some(outcomes => [...outcomes].some(outcome => PERFORMANCE_SET.has(outcome)));
    const text = typeof rule.statement === 'string' ? rule.statement : '';
    let reason = null;
    if ([...phoneReplyKeys(rule.condition)].some(key => journals.get(key)?.nativeClass === 'gameJournalPhoneChoiceEntry')) reason = 'phone-reply';
    else if (!performance && sets.some(outcomes => outcomes.size >= 2)) reason = 'alternatives';
    else if (!performance && ACT.test(text) && !REPORTED.test(text)) reason = 'statement';
    if (reason) result.set(rule.id, reason);
  }
  return result;
}
