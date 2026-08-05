import { isIP } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';

export function parseList(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function normalizeHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isAllowedWebSocketRequest(
  req: IncomingMessage,
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[],
): boolean {
  const hostname = normalizeHostname(req.headers.host);
  if (!hostname || !allowedHosts.some(host => host.toLowerCase() === hostname)) return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return allowedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function isLoopbackAddress(address: string | AddressInfo | null): boolean {
  if (!address || typeof address === 'string') return false;
  if (address.address === '::1') return true;
  if (isIP(address.address) === 4) return address.address.startsWith('127.');
  return false;
}
