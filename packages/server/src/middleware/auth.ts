import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type ServiceScope = 'projects:read' | 'agents:read' | 'orchestrations:create' | 'orchestrations:read' | 'orchestrations:message' | 'tasks:relationships';
const ALL_SERVICE_SCOPES: ServiceScope[] = ['projects:read', 'agents:read', 'orchestrations:create', 'orchestrations:read', 'orchestrations:message', 'tasks:relationships'];

interface Credential { token?: string; sha256?: string; scopes: ServiceScope[] }

function credentials(): Credential[] {
  const raw = process.env.SERVICE_TOKENS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ token?: string; sha256?: string; scopes?: string[] }>;
    return parsed.filter(c => c.token || c.sha256).map(c => ({ token: c.token, sha256: c.sha256?.toLowerCase(), scopes: (c.scopes ?? []).filter(s => ALL_SERVICE_SCOPES.includes(s as ServiceScope)) as ServiceScope[] }));
  } catch { console.error('[auth] SERVICE_TOKENS must be a JSON array'); return []; }
}

function safeEqual(a: string, b: string): boolean {
  const aa=Buffer.from(a), bb=Buffer.from(b); return aa.length === bb.length && crypto.timingSafeEqual(aa,bb);
}

export function authenticateToken(token: string | undefined): { authenticated: boolean; legacy: boolean; scopes: ServiceScope[] } {
  if (!token) return { authenticated: false, legacy: false, scopes: [] };
  const apiKey=process.env.API_KEY;
  if (apiKey && safeEqual(token,apiKey)) return { authenticated:true,legacy:true,scopes:ALL_SERVICE_SCOPES };
  const digest=crypto.createHash('sha256').update(token).digest('hex');
  const match=credentials().find(c => c.token ? safeEqual(token,c.token) : !!c.sha256 && safeEqual(digest,c.sha256));
  return match ? { authenticated:true,legacy:false,scopes:match.scopes } : { authenticated:false,legacy:false,scopes:[] };
}

export function requiredScope(req: Request): ServiceScope | undefined {
  const p=req.path, method=req.method;
  if (p === '/health') return undefined;
  if (p === '/agents') return undefined;
  if (p === '/agents/refresh') return 'agents:read';
  if (p.startsWith('/projects')) return undefined;
  if (p === '/orchestrations' && method === 'POST') return 'orchestrations:create';
  if (/^\/orchestrations\/[^/]+\/retry$/.test(p) && method === 'POST') return 'orchestrations:create';
  if (/^\/orchestrations\/[^/]+$/.test(p) && method === 'GET') return 'orchestrations:read';
  if (/^\/orchestrations\/[^/]+\/message$/.test(p) && method === 'POST') return 'orchestrations:message';
  if (/^\/tasks\/[^/]+\/relationships(?:\/[^/]+)?$/.test(p) && (method === 'POST' || method === 'DELETE')) return 'tasks:relationships';
  if (p.startsWith('/tasks') || p.startsWith('/groups')) {
    return undefined;
  }
  return undefined; // service credentials are denied for all non-allowlisted mutations
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const hasLegacyKey = Boolean(process.env.API_KEY);
  const serviceCredentials = credentials();
  const scope = requiredScope(req);
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  // API_KEY retains the legacy "protect every API route" behavior.
  if (hasLegacyKey) {
    const auth = authenticateToken(token);
    if (!auth.authenticated) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!auth.legacy && (!scope || !auth.scopes.includes(scope))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
    return;
  }

  // A service-token-only deployment keeps the existing browser/API surface
  // behind its outer access boundary, but requires scoped auth for the narrow
  // orchestration facade and agent refresh mutation.
  if (serviceCredentials.length === 0 || !scope) { next(); return; }
  const auth = authenticateToken(token);
  if (!auth.authenticated) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!auth.scopes.includes(scope)) { res.status(403).json({ error: 'forbidden' }); return; }
  next();
}

export function isValidToken(token: string | undefined): boolean {
  if (!process.env.API_KEY && credentials().length===0) return true;
  const auth = authenticateToken(token);
  return auth.authenticated && auth.legacy;
}
