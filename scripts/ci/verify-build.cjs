const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { layout, metadata } = require('./build-info.cjs');

const build = layout();
const info = metadata();
fs.writeFileSync(path.join(build.directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
const result = spawnSync(build.executable, [path.join(__dirname, 'verify-runtime.cjs'), build.resources], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status || 1;
