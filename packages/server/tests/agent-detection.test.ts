import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import type { AgentInfo } from '@codewithdan/agent-sdk-core';
import { detectAvailableAgents, findWindowsExecutableOnPath } from '../src/services/agent-detection.js';

function agentsWithCopilot(copilot: Partial<AgentInfo> = {}): AgentInfo[] {
  return [
    {
      name: 'copilot',
      displayName: 'GitHub Copilot',
      available: false,
      reason: 'Copilot CLI not found in PATH',
      ...copilot,
    } as AgentInfo,
    {
      name: 'claude',
      displayName: 'Claude Code',
      available: false,
      reason: 'Claude Code CLI not found in PATH',
    } as AgentInfo,
  ];
}

function createFixtureBin(testName: string): { binDir: string; cleanup: () => void } {
  const fixtureRoot = path.join(process.cwd(), 'test-results', 'agent-detection', `${process.pid}-${Date.now()}-${testName}`);
  const binDir = path.join(fixtureRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  return {
    binDir,
    cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }),
  };
}

test('Windows Copilot detection falls back to copilot.exe on PATH', async (t) => {
  const { binDir, cleanup } = createFixtureBin('copilot-exe');
  t.after(cleanup);

  const copilotExe = path.join(binDir, 'copilot.exe');
  copyFileSync(process.execPath, copilotExe);
  chmodSync(copilotExe, 0o755);

  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    env: { PATH: binDir, PATHEXT: '.EXE' },
    platform: 'win32',
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, true);
  assert.match(copilot?.version ?? '', /^v?\d+\./);
  assert.equal(copilot?.reason, undefined);
});

test('Windows Copilot detection keeps SDK unavailable reason when copilot.exe is absent', async () => {
  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    env: { PATH: path.join(process.cwd(), 'test-results', 'agent-detection', 'missing') },
    platform: 'win32',
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, false);
  assert.match(copilot?.reason ?? '', /Windows PATH discovery/);
  assert.match(copilot?.reason ?? '', /SDK probe: Copilot CLI not found in PATH/);
});

test('Windows Copilot detection uses where.exe discovery before overriding availability', async () => {
  const copilotPath = 'C:\\Users\\charris\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe';
  const calls: string[] = [];

  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    env: { PATH: 'C:\\Users\\charris\\AppData\\Local\\Microsoft\\WinGet\\Links' },
    platform: 'win32',
    execCommand: async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'where.exe') {
        return { stdout: `${copilotPath}\r\n` };
      }
      if (file === copilotPath && args[0] === '--version') {
        return { stdout: 'copilot version 1.2.3\n' };
      }
      const err = Object.assign(new Error(`${file} not found`), { code: 'ENOENT' });
      throw err;
    },
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, true);
  assert.equal(copilot?.version, 'copilot version 1.2.3');
  assert.equal(copilot?.reason, undefined);
  assert.ok(calls.some(call => call.startsWith('where.exe copilot')));
});

test('Windows Copilot detection uses PowerShell Get-Command discovery when where.exe fails', async () => {
  const copilotPath = 'C:\\Users\\charris\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe';

  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    env: { PATH: '' },
    platform: 'win32',
    execCommand: async (file, args) => {
      if (file === 'where.exe') {
        throw Object.assign(new Error('where failed'), { code: 'ENOENT' });
      }
      if (file === 'powershell.exe') {
        assert.match(args.join(' '), /Get-Command copilot/);
        return { stdout: `${copilotPath}\r\n` };
      }
      if (file === copilotPath && args[0] === '--version') {
        return { stdout: 'copilot version 2.0.0\n' };
      }
      throw Object.assign(new Error(`${file} not expected`), { code: 'EINVAL' });
    },
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, true);
  assert.equal(copilot?.version, 'copilot version 2.0.0');
});

test('Windows Copilot detection falls back to version probe when --version fails', async () => {
  const copilotPath = 'C:\\Users\\charris\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe';
  const calls: string[] = [];

  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    env: { PATH: '' },
    platform: 'win32',
    execCommand: async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'where.exe') {
        return { stdout: `${copilotPath}\r\n` };
      }
      if (file === 'powershell.exe') {
        throw Object.assign(new Error('Get-Command failed'), { code: 'ENOENT' });
      }
      if (file === copilotPath && args[0] === '--version') {
        throw Object.assign(new Error('--version failed'), { code: 'EINVAL' });
      }
      if (file === copilotPath && args[0] === 'version') {
        return { stdout: 'GitHub Copilot CLI 1.2.3\n' };
      }
      throw Object.assign(new Error(`${file} not expected`), { code: 'EINVAL' });
    },
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, true);
  assert.equal(copilot?.version, 'GitHub Copilot CLI 1.2.3');
  assert.deepEqual(
    calls.filter(call => call.startsWith(copilotPath)),
    [`${copilotPath} --version`, `${copilotPath} version`]
  );
});

test('Windows Copilot detection falls back to help probe without treating help text as version', async () => {
  const copilotPath = 'C:\\Users\\charris\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe';

  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    env: { PATH: '' },
    platform: 'win32',
    execCommand: async (file, args) => {
      if (file === 'where.exe') {
        return { stdout: `${copilotPath}\r\n` };
      }
      if (file === 'powershell.exe') {
        throw Object.assign(new Error('Get-Command failed'), { code: 'ENOENT' });
      }
      if (file === copilotPath && (args[0] === '--version' || args[0] === 'version')) {
        throw Object.assign(new Error(`${args[0]} failed`), { code: 'EINVAL' });
      }
      if (file === copilotPath && args[0] === '--help') {
        return { stdout: 'Usage: copilot [options] [command]\n' };
      }
      throw Object.assign(new Error(`${file} not expected`), { code: 'EINVAL' });
    },
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, true);
  assert.equal(copilot?.version, undefined);
  assert.equal(copilot?.reason, undefined);
});

test('Windows Copilot detection reports explicit health probe failures distinctly', async () => {
  const copilotPath = 'C:\\Users\\charris\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe';

  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    env: { PATH: '' },
    platform: 'win32',
    execCommand: async (file) => {
      if (file === 'where.exe') {
        return { stdout: `${copilotPath}\r\n` };
      }
      throw Object.assign(new Error(`${file} failed`), { code: 'EINVAL' });
    },
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, false);
  assert.match(copilot?.reason ?? '', /explicit health probes failed/);
  assert.match(copilot?.reason ?? '', /--version/);
  assert.match(copilot?.reason ?? '', /version/);
  assert.match(copilot?.reason ?? '', /--help/);
  assert.match(copilot?.reason ?? '', /SDK probe: Copilot CLI not found in PATH/);
});

test('Windows Copilot detection preserves SDK availability without extra probes', async () => {
  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot({ available: true, version: 'sdk-version', reason: undefined }),
    platform: 'win32',
    execCommand: async (file) => {
      throw new Error(`unexpected probe: ${file}`);
    },
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, true);
  assert.equal(copilot?.version, 'sdk-version');
});

test('non-Windows detection uses SDK results without Windows probes', async () => {
  const agents = await detectAvailableAgents({
    detectAgents: async () => agentsWithCopilot(),
    platform: 'linux',
    execCommand: async (file) => {
      throw new Error(`unexpected probe: ${file}`);
    },
  });

  const copilot = agents.find(agent => agent.name === 'copilot');
  assert.equal(copilot?.available, false);
  assert.equal(copilot?.reason, 'Copilot CLI not found in PATH');
});

test('configured Hermes command is the detection authority', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const agents = await detectAvailableAgents({
    detectAgents: async () => [{ name: 'hermes', displayName: 'Hermes', available: false, reason: 'plain hermes missing' } as AgentInfo],
    env: { HERMES_COMMAND: '/opt/agentmic/hermes-agentmic' },
    platform: 'linux',
    execCommand: async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'Hermes Agent 1.2.3\n' };
    },
  });

  assert.deepEqual(calls, [{ file: '/opt/agentmic/hermes-agentmic', args: ['--version'] }]);
  assert.equal(agents[0].available, true);
  assert.equal(agents[0].version, 'Hermes Agent 1.2.3');
  assert.equal(agents[0].reason, undefined);
});

test('configured Hermes command failure cannot fall back to plain Hermes', async () => {
  const agents = await detectAvailableAgents({
    detectAgents: async () => [{ name: 'hermes', displayName: 'Hermes', available: true } as AgentInfo],
    env: { HERMES_COMMAND: '/opt/agentmic/missing' },
    platform: 'linux',
    execCommand: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
  });

  assert.equal(agents[0].available, false);
  assert.match(agents[0].reason ?? '', /Configured Hermes command is not ready/);
});

test('Windows executable lookup does not require a copilot PATH shim', (t) => {
  const { binDir, cleanup } = createFixtureBin('path-lookup');
  t.after(cleanup);

  const copilotExe = path.join(binDir, 'copilot.exe');
  copyFileSync(process.execPath, copilotExe);

  assert.equal(
    findWindowsExecutableOnPath('copilot', { PATH: binDir, PATHEXT: '.EXE' }),
    copilotExe
  );
});
