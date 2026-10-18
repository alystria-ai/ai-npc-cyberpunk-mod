import {existsSync} from 'node:fs';
import {join} from 'node:path';

// The hidden browser is not shipped with the mod: it is the Microsoft Edge that comes with Windows 10 and 11, or, where Edge was
// removed, an installed Google Chrome. Both are Chromium, which Playwright drives by "channel". Edge is tried first.
export const SYSTEM_BROWSERS = Object.freeze([
  Object.freeze({channel: 'msedge', name: 'Microsoft Edge', file: 'Microsoft\\Edge\\Application\\msedge.exe'}),
  Object.freeze({channel: 'chrome', name: 'Google Chrome', file: 'Google\\Chrome\\Application\\chrome.exe'}),
]);

export const NO_BROWSER_MESSAGE = 'No browser to run the conversation page: install Microsoft Edge (it comes with Windows 10 and 11) or Google Chrome.';

// The system browsers installed under the places Playwright itself looks (per-user, Program Files, Program Files (x86)).
// Off Windows nothing is known about the layout, so every channel is reported and the launch decides.
export function installedSystemBrowsers({env = process.env, platform = process.platform, exists = existsSync} = {}) {
  if (platform !== 'win32') return [...SYSTEM_BROWSERS];
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(root => typeof root === 'string' && root);
  return SYSTEM_BROWSERS.filter(browser => roots.some(root => { try { return exists(join(root, browser.file)); } catch { return false; } }));
}

// True when a launch of the hidden browser can be expected to work: a developer's CYBERPUNK_CONVAI_BROWSER names the executable
// (checked when the bridge opens it), or Edge or Chrome is installed.
export function systemBrowserAvailable(options = {}) {
  const env = options.env ?? process.env;
  return !!env.CYBERPUNK_CONVAI_BROWSER || installedSystemBrowsers(options).length > 0;
}

const missing = error => /is not found|doesn't exist|does not exist|ENOENT/i.test(String(error?.message ?? error));

// Opens the hidden browser through `launch(extraOptions)`: the named executable when there is one (a developer override), otherwise
// Edge, then Chrome. A launch that fails for any reason moves on to the next browser. When none starts, the error is the clear
// "install Edge or Chrome" one if every attempt found no browser, else the first real launch error. `log` gets one line.
export async function launchSystemBrowser(launch, {executablePath, log = () => {}} = {}) {
  if (executablePath) return launch({executablePath});
  const errors = [];
  for (const {channel} of SYSTEM_BROWSERS) {
    try { return await launch({channel}); } catch (error) { errors.push(error); }
  }
  const real = errors.find(error => !missing(error));
  if (real) { log(`The hidden browser did not start (${String(real.message ?? real).split('\n')[0]}).`); throw real; }
  log(NO_BROWSER_MESSAGE);
  throw Object.assign(Error(NO_BROWSER_MESSAGE), {code: 'NO_BROWSER', cause: errors[0]});
}
