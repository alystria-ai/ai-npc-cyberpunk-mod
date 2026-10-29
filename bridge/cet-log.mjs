// The lines of Cyber Engine Tweaks' own logs (bin/x64/plugins/cyber_engine_tweaks/cyber_engine_tweaks.log and scripting.log) that explain a setup problem or a Lua error in an
// automatic report (bridge/error-reports.mjs). The files hold a line for every mod CET handled and for everything any mod printed, so only the lines that can explain something
// are kept: errors, warnings and failures (a mod that could not load, a Lua error of another mod), and the lines that name the two hosts of the Companion Manager, Native Settings UI
// and Mod Configuration Menu, which tell whether the host registered or failed ("nsui missing", report 139d68ca96ea376c).
// The lines are text of other mods and of CET, never of a conversation; they go through the same redactor as every other log line (bridge/error-reports.mjs reportCleaner).

const PROBLEM = /\[(?:error|warn(?:ing)?|critical|fatal)\]|\b(?:error|exception|failed|failure|could not|couldn't|cannot|can't|unable to|traceback|attempt to (?:index|call|compare|perform|concatenate)|not found)\b|\.lua:\d+:/i;
const HOST = /native\s*settings|ModConfigurationMenu|\bMCM\b/i;

/** The lines of a CET log worth sending, in order. Pure. */
export const cetLines = lines => (Array.isArray(lines) ? lines : []).filter(line => typeof line === 'string' && (PROBLEM.test(line) || HOST.test(line)));
