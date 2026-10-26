const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

function tests(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = join(folder, entry.name);
    return entry.isDirectory() ? tests(file) : entry.name.endsWith('.test.js') ? [file] : [];
  });
}
const files = tests(join(__dirname, '..', 'out', 'test'));
if (!files.length) throw new Error('No compiled tests found.');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
