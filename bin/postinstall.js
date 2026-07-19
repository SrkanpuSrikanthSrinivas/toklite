#!/usr/bin/env node
/**
 * Printed once after installation. It must never fail an install, so every
 * branch is wrapped and the exit code is always 0.
 */
try {
  const isGlobal = process.env.npm_config_global === 'true';
  const { globalBinDir, isOnPath, detectShell, pathLine, profilePath } = await import('../src/setup.js');

  const b = s => `\x1b[1m${s}\x1b[0m`;
  const d = s => `\x1b[2m${s}\x1b[0m`;
  const y = s => `\x1b[33m${s}\x1b[0m`;
  const g = s => `\x1b[32m${s}\x1b[0m`;

  console.log(`\n${b('toklite installed.')}`);

  if (!isGlobal) {
    console.log(d('  Installed locally, so there is no `toklite` command on your PATH.'));
    console.log(d('  Run it with:  node ./node_modules/.bin/toklite doctor'));
    console.log(d('  Or install globally:  npm i -g toklite\n'));
    process.exit(0);
  }

  const dir = globalBinDir();
  if (dir && !isOnPath(dir)) {
    const shell = detectShell();
    console.log(y('  The command will not be found yet: npm installs global commands into'));
    console.log(y(`  ${dir}`));
    console.log(y('  and that directory is not on your PATH. Fix it in one step:\n'));
    console.log(`    ${b('toklite setup --write')}\n`);
    console.log(d(`  or add this line to ${profilePath(shell)} yourself:`));
    console.log(d(`    ${pathLine(dir, shell)}\n`));
  } else {
    console.log(g('  Ready. Next steps:\n'));
    console.log(`    ${b('toklite setup')}     ${d('check your environment and print the settings to use')}`);
    console.log(`    ${b('toklite doctor')}    ${d('verify the reduction pipeline')}`);
    console.log(`    ${b('toklite run -- claude')}   ${d('or kiro, cursor, aider, your own agent')}\n`);
  }
} catch {
  // Never block an install over a banner.
}
process.exit(0);
