import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { AgentInfo } from '@codewithdan/agent-sdk-core';
import { detectAgents as detectCoreAgents } from '@codewithdan/agent-sdk-core';

type ExecCommand = (
  file: string,
  args: string[],
  options: { encoding: BufferEncoding; timeout: number; env?: NodeJS.ProcessEnv; windowsHide?: boolean }
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

interface DetectAvailableAgentsOptions {
  detectAgents?: () => Promise<AgentInfo[]>;
  env?: NodeJS.ProcessEnv;
  execCommand?: ExecCommand;
  platform?: NodeJS.Platform;
}

interface CommandProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  args?: string[];
}

const execFileAsync = promisify(execFile) as ExecCommand;
const PROBE_TIMEOUT_MS = 5000;

function getPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function getPathExtValue(env: NodeJS.ProcessEnv): string {
  return env.PATHEXT ?? env.PathExt ?? env.pathext ?? '';
}

function uniqueExtensions(extensions: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const extension of extensions) {
    const normalized = extension.trim();
    if (!normalized) continue;
    const withDot = normalized.startsWith('.') ? normalized : `.${normalized}`;
    const key = withDot.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(withDot);
  }

  return unique;
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const pathExt = getPathExtValue(env)
    .split(';')
    .map(ext => ext.trim())
    .filter(Boolean);

  return uniqueExtensions(['.exe', ...pathExt]);
}

export function findWindowsExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEntries = getPathValue(env)
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);
  const extensions = windowsExecutableExtensions(env);
  const candidates = path.extname(command)
    ? [command]
    : extensions.map(extension => `${command}${extension}`);

  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

function outputLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function firstOutputLine(output: string): string | undefined {
  return outputLines(output)[0];
}

function execErrorDetail(err: unknown): string {
  if (err instanceof Error) {
    const withOutput = err as Error & { stdout?: Buffer | string; stderr?: Buffer | string; code?: string | number };
    const stderr = withOutput.stderr?.toString().trim();
    const stdout = withOutput.stdout?.toString().trim();
    const code = withOutput.code ? ` (code ${withOutput.code})` : '';
    const detail = stderr || stdout || err.message;
    return `${detail}${code}`;
  }

  return String(err);
}

async function runProbe(
  execCommand: ExecCommand,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandProbeResult> {
  try {
    const { stdout, stderr } = await execCommand(file, args, {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      env,
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: stdout.toString(),
      stderr: stderr?.toString() ?? '',
    };
  } catch (err: unknown) {
    return {
      ok: false,
      stdout: err instanceof Error && 'stdout' in err
        ? ((err as Error & { stdout?: Buffer | string }).stdout?.toString() ?? '')
        : '',
      stderr: err instanceof Error && 'stderr' in err
        ? ((err as Error & { stderr?: Buffer | string }).stderr?.toString() ?? '')
        : '',
      error: execErrorDetail(err),
    };
  }
}

async function discoverWindowsCopilotCandidates(
  execCommand: ExecCommand,
  env: NodeJS.ProcessEnv,
): Promise<{ candidates: string[]; failures: string[] }> {
  const candidates: string[] = [];
  const failures: string[] = [];

  const whereResult = await runProbe(execCommand, 'where.exe', ['copilot'], env);
  if (whereResult.ok) {
    candidates.push(...outputLines(whereResult.stdout));
  } else {
    failures.push(`where.exe failed: ${whereResult.error ?? 'unknown error'}`);
  }

  const powershellResult = await runProbe(execCommand, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Get-Command copilot -ErrorAction Stop | ForEach-Object { $_.Source }",
  ], env);
  if (powershellResult.ok) {
    candidates.push(...outputLines(powershellResult.stdout));
  } else {
    failures.push(`PowerShell Get-Command failed: ${powershellResult.error ?? 'unknown error'}`);
  }

  const pathFallback = findWindowsExecutableOnPath('copilot', env);
  if (pathFallback) {
    candidates.push(pathFallback);
  }

  return {
    candidates: [...new Set(candidates)],
    failures,
  };
}

async function verifyWindowsCopilotCandidate(
  candidate: string,
  execCommand: ExecCommand,
  env: NodeJS.ProcessEnv,
): Promise<CommandProbeResult> {
  const probeArgs = [['--version'], ['version'], ['--help']];
  const failures: string[] = [];

  for (const args of probeArgs) {
    const result = await runProbe(execCommand, candidate, args, env);
    if (result.ok) {
      return { ...result, args };
    }
    failures.push(`${args.join(' ')}: ${result.error ?? 'unknown error'}`);
  }

  return {
    ok: false,
    stdout: '',
    stderr: '',
    error: failures.join('; '),
  };
}

function copilotProbeVersion(result: CommandProbeResult): string | undefined {
  if (result.args?.[0] === '--help') {
    return undefined;
  }

  return firstOutputLine(`${result.stdout}\n${result.stderr}`);
}

function appendSdkReason(reason: string, sdkReason?: string): string {
  return sdkReason ? `${reason} SDK probe: ${sdkReason}` : reason;
}

async function normalizeConfiguredHermesAvailability(
  agents: AgentInfo[],
  execCommand: ExecCommand,
  env: NodeJS.ProcessEnv,
): Promise<AgentInfo[]> {
  const configuredCommand = env.HERMES_COMMAND?.trim();
  if (!configuredCommand) return agents;

  const hermes = agents.find(agent => agent.name === 'hermes');
  if (!hermes) return agents;

  const result = await runProbe(execCommand, configuredCommand, ['--version'], env);
  if (!result.ok) {
    return agents.map(agent => agent.name === 'hermes'
      ? { ...agent, available: false, reason: `Configured Hermes command is not ready: ${result.error ?? 'unknown error'}` }
      : agent);
  }

  return agents.map(agent => agent.name === 'hermes'
    ? { ...agent, available: true, version: firstOutputLine(`${result.stdout}\n${result.stderr}`), reason: undefined }
    : agent);
}

async function normalizeWindowsCopilotAvailability(
  agents: AgentInfo[],
  execCommand: ExecCommand,
  env: NodeJS.ProcessEnv,
): Promise<AgentInfo[]> {
  const copilot = agents.find(agent => agent.name === 'copilot');
  if (!copilot || copilot.available) {
    return agents;
  }

  const discovery = await discoverWindowsCopilotCandidates(execCommand, env);
  if (discovery.candidates.length === 0) {
    const discoveryReason = discovery.failures.length > 0
      ? ` Discovery failures: ${discovery.failures.join(' ')}`
      : '';
    const reason = appendSdkReason(
      `Copilot CLI not found by Windows PATH discovery (where.exe/Get-Command).${discoveryReason}`,
      copilot.reason,
    );
    return agents.map(agent => agent.name === 'copilot' ? { ...agent, reason } : agent);
  }

  const failures: string[] = [];
  for (const candidate of discovery.candidates) {
    const result = await verifyWindowsCopilotCandidate(candidate, execCommand, env);
    if (result.ok) {
      const version = copilotProbeVersion(result);
      return agents.map(agent => agent.name === 'copilot'
        ? { ...agent, available: true, version, reason: undefined }
        : agent
      );
    }
    failures.push(`${candidate}: ${result.error ?? 'unknown error'}`);
  }

  const reason = appendSdkReason(
    `Copilot CLI discovered by Windows PATH discovery but explicit health probes failed. Probe failures: ${failures.join(' ')}`,
    copilot.reason,
  );
  return agents.map(agent => agent.name === 'copilot' ? { ...agent, reason } : agent);
}

export async function detectAvailableAgents(options: DetectAvailableAgentsOptions = {}): Promise<AgentInfo[]> {
  const agents = await (options.detectAgents ?? detectCoreAgents)();
  const platform = options.platform ?? process.platform;

  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const execCommand = options.execCommand ?? execFileAsync;
  if (platform !== 'win32') {
    return normalizeConfiguredHermesAvailability(agents, execCommand, env);
  }

  const normalized = await normalizeWindowsCopilotAvailability(agents, execCommand, env);
  return normalizeConfiguredHermesAvailability(normalized, execCommand, env);
}
