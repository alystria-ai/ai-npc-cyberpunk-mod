// What the RED4ext launcher (red4ext/plugins/AiNpcCyberpunkCode/CyberpunkConvai.dll, native/autostart/CyberpunkConvaiLauncher.c, shipped in the
// Scripts from 0.3.4) starts when the game starts: its built-in settings (DEFAULT_* in the C source, held equal to these lines by
// bridge/autostart-plugin.test.mjs). No package ships a launcher.ini any more; one a player writes beside the DLL in this format overrides them.
// Node is the Runtime base's (red4ext/plugins/AiNpcCyberpunkMod/app/node/node.exe); the script is the Scripts' install-code.mjs, which brings the
// Runtime's copy of the code up to the Scripts' version and then runs app/launcher/start-service.mjs (docs/PACKAGING.md, "Code in the Scripts").
//
// The launcher runs: program arg1 arg2 ... --game-pid <pid> --game-root <root> --lifeline stdin, with %PLUGIN% expanded to the folder
// of its DLL. Node is not given start-service.mjs as its entry script directly: under Mod Organizer 2 with the Runtime installed as an
// MO2 mod, %PLUGIN% is a virtual folder, and Node's entry lookup (stat) cannot see a file that exists only in a mod folder (USVFS 0.5.6.1
// does not hook the stat call that Node 24 uses on Windows 11 24H2; packaging/runtime/usvfs-compat.mjs). The bootstrap below loads the
// script itself: when stat cannot see it, it loads it from its real place (realpathSync.native, which USVFS does redirect), so the service
// runs its own files from the MO2 mod folder. A physical install takes the first branch and loads the script exactly where it is, as
// before. process.argv keeps the launcher's layout ([node, script, ...options]), so start-service.mjs reads its options as it always did.
export const LAUNCHER_BOOTSTRAP = "const f=require('node:fs');let p=process.argv[1];try{f.statSync(p)}catch{try{p=f.realpathSync.native(p)}catch{}}"
  + "import(require('node:url').pathToFileURL(p).href)";

export function launcherIniLines() {
  return [
    '; AI NPC Cyberpunk Mod: starts the conversation service with the game and stops it when the game exits.',
    '; Set enabled=0 to start it yourself instead.',
    '[launch]', 'enabled=1',
    'program=%GAME%\\red4ext\\plugins\\AiNpcCyberpunkMod\\app\\node\\node.exe',
    'arg1=--eval',
    `arg2=${LAUNCHER_BOOTSTRAP}`,
    'arg3=%PLUGIN%\\install-code.mjs',
    'working_directory=%PLUGIN%',
  ];
}

// GetPrivateProfileString reads Unicode only from UTF-16LE files with a byte order mark.
export function launcherIni() {
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(launcherIniLines().join('\r\n') + '\r\n', 'utf16le')]);
}
