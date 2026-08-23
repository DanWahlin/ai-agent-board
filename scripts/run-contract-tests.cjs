const { spawnSync } = require('node:child_process');

function run(name, command, args) {
  console.log(`==> ${name}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run('Run server contract tests', npm, ['test', '-w', '@ai-agent-board/server']);

const pythonCandidates = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []]];
let python;
for (const [command, prefix] of pythonCandidates) {
  const probe = spawnSync(command, [...prefix, '--version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) {
    python = { command, prefix };
    break;
  }
}
if (!python) {
  console.error('Python 3 is required for Hermes integration tests');
  process.exit(1);
}
run('Run Hermes integration tests', python.command, [
  ...python.prefix,
  '-m', 'unittest', 'discover', '-s', 'integrations/hermes-agent-board/tests', '-v',
]);
