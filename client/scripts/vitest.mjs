/**
 * Runs Vitest with an upper-case Windows drive letter in the working directory.
 *
 * A terminal opened at "c:\..." (VS Code often does this) makes Vitest load itself twice
 * under two module IDs ("c:/..." and "C:/..."), and every test file then fails with
 * "Vitest failed to find the current suite". On other systems this changes nothing.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const cwd = process.cwd().replace(/^[a-z]:/, (drive) => drive.toUpperCase());
const vitest = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');

const { status } = spawnSync(process.execPath, [vitest, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
process.exit(status ?? 1);
