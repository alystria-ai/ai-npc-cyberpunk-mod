// Imported first by every long-lived Node entry of the mod (the conversation service, its supervisor, the OmniVoice server): ES modules run in import
// order, so process.stdout and process.stderr are guarded (bridge/safe-streams.mjs) before any other module can write a log line.
import {installSafeStreams} from './safe-streams.mjs';

installSafeStreams();
