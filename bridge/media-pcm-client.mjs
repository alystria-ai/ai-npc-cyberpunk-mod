// The media page's entry (bridge/realtime-host.mjs serves it at /media): one AudioContext and the engine that plays a story pack's music and sound effects
// (bridge/media-engine.mjs). Nothing runs here until the bridge calls window.mediaPcm.run(...). The page has no SDK, no session, no microphone and no network: the host
// answers only this file and its two imports.
import {MediaEngine} from './media-engine.mjs';

const context = new AudioContext({latencyHint: 'playback'});
window.mediaPcm = new MediaEngine({context, post: event => { try { window.mediaEvent?.(event); } catch { /* the bridge is gone */ } }});
