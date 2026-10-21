// runtime/native-off.txt of the Runtime package: the kill switch of the native plugin (native/core/src/core/Switches.hpp), kept in
// every release so a player or a developer can switch one system off without a rebuild. A system whose name is listed starts off and
// the mod runs its script path for it; the list is `native.off` in packaging/release.config.json. Used by
// packaging/build-release.mjs and the tests.
//
// The plugin and the Lua read the file the same way: one name per line, '#' starts a comment, "all" switches every system off, and
// a missing file means every system is on. So the file ships even with an empty list: it then holds only the comment header.
export function nativeOffLines(off) {
  const names = [...off];
  return [
    names.length
      ? '# Native systems that start off in this release because they are not yet proven in the real game.'
      : '# Every native system is on in this release; no line below this header switches one off.',
    "# An off system runs the mod's own script path instead. One name per line; \"all\" turns every system off;",
    '# a missing file turns every system on. Put a system name (for example faces) on a line of its own to switch it off.',
    '# The plugin reads this file about once a second, so a change applies without a restart.',
    ...names,
  ];
}

export function nativeOffText(off) {
  return nativeOffLines(off).join('\n') + '\n';
}
