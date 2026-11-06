import { createHmac, timingSafeEqual } from 'crypto';
import { validateInstance, validatePrincipalRef } from './organization-domain';

export interface WorkloadActor { principal_ref: string; }
export interface WorkloadVerifier { verify(request: SignedRequest): Promise<WorkloadActor>; }
export interface SignedRequest { method: string; path: string; query: string; headers: Record<string, string | string[] | undefined>; bodyDigest: string; }
export type ConsumeNonce = (keyId: string, nonce: string, expiresAtMs: number) => Promise<boolean>;

function header(h: SignedRequest['headers'], name: string): string { const v = h[name] ?? h[name.toLowerCase()]; return Array.isArray(v) ? '' : String(v || ''); }
function b64url(data: Buffer | string): string { return Buffer.from(data).toString('base64url'); }
function equal(a: string, b: string): boolean { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export class WorkloadVerifierUnavailableError extends Error {
  constructor() { super('workload verifier unavailable'); this.name = 'WorkloadVerifierUnavailableError'; }
}

function percentEncode(value: string): string {
  // encodeURIComponent leaves !'()* unescaped. Escape them so adapters can use
  // the language-independent RFC3986 unreserved set: ALPHA / DIGIT / -._~.
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Strict RFC3986 query encoding with keys and repeated values sorted by encoded bytes. */
export function canonicalQuery(input: Record<string, unknown>): string {
  const pairs: [string, string][] = [];
  for (const [key, raw] of Object.entries(input)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value !== 'string') throw new Error('invalid query');
      pairs.push([percentEncode(key), percentEncode(value)]);
    }
  }
  pairs.sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export function canonicalWorkloadRequest(input: {
  method: string; path: string; query: string; actor: string; audience: string; sourceInstance: string;
  timestamp: string; nonce: string; bodyDigest: string;
}): string {
  return [input.method.toUpperCase(), input.path, input.query, input.actor, input.audience, input.sourceInstance,
    input.timestamp, input.nonce, input.bodyDigest].map((v) => `${Buffer.byteLength(v)}:${v}`).join('\n');
}

export function createHmacWorkloadVerifier(config: {
  keys: Readonly<Record<string, Buffer | string>>; allowedKeyIds: readonly string[]; audience: string;
  sourceInstance: string; consumeNonce?: ConsumeNonce; maxSkewMs?: number; now?: () => number;
}): WorkloadVerifier {
  const sourceInstance = validateInstance(config.sourceInstance);
  if (!config.consumeNonce) throw new Error('nonce store is required');
  const consumeNonce = config.consumeNonce;
  if (!config.audience || !config.allowedKeyIds.length || config.allowedKeyIds.some((id) =>
    !config.keys[id] || Buffer.byteLength(config.keys[id]) < 32)) throw new Error('workload verifier configuration unavailable');
  const now = config.now || Date.now;
  const skew = Math.min(Math.max(config.maxSkewMs ?? 60_000, 1_000), 300_000);
  return { async verify(req) {
    const keyId = header(req.headers, 'x-ainoc-key-id');
    const timestamp = header(req.headers, 'x-ainoc-timestamp');
    const nonce = header(req.headers, 'x-ainoc-nonce');
    const actor = validatePrincipalRef(header(req.headers, 'x-ainoc-actor'));
    const audience = header(req.headers, 'x-ainoc-audience');
    const instance = header(req.headers, 'x-ainoc-source-instance');
    const signature = header(req.headers, 'x-ainoc-signature');
    if (!config.allowedKeyIds.includes(keyId) || !config.keys[keyId] || audience !== config.audience || instance !== sourceInstance ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp) ||
        !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new Error('invalid workload proof');
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time) || Math.abs(now() - time) > skew) throw new Error('invalid workload proof');
    const canonical = canonicalWorkloadRequest({ method: req.method, path: req.path, query: req.query, actor, audience,
      sourceInstance: instance, timestamp, nonce, bodyDigest: req.bodyDigest });
    const expected = b64url(createHmac('sha256', config.keys[keyId]).update(canonical).digest());
    if (!equal(signature, expected)) throw new Error('invalid workload proof');
    let consumed: boolean;
    try { consumed = await consumeNonce(keyId, nonce, time + skew); }
    catch { throw new WorkloadVerifierUnavailableError(); }
    if (!consumed) throw new Error('invalid workload proof');
    return { principal_ref: actor };
  } };
}

export interface CursorCodec { encode(value: CursorValue): string; decode(token: string, expected: Omit<CursorValue, 'after' | 'expires_at'>): CursorValue; }
export interface CursorValue { actor: string; source: string; filter: string; scope_version: string; after: string; expires_at: number; }
export function createCursorCodec(secret: Buffer | string, now: () => number = Date.now, ttlMs = 300_000): CursorCodec {
  if (Buffer.byteLength(secret) < 32) throw new Error('cursor signing key unavailable');
  const sign = (payload: string) => b64url(createHmac('sha256', secret).update('organization-cursor-v1\0').update(payload).digest());
  return {
    encode(value) { const payload = b64url(JSON.stringify({ ...value, expires_at: now() + ttlMs })); return `${payload}.${sign(payload)}`; },
    decode(token, expected) {
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra || !equal(signature, sign(payload))) throw new Error('invalid cursor');
      let value: CursorValue; try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new Error('invalid cursor'); }
      if (!Number.isSafeInteger(value.expires_at) || value.expires_at <= now() || value.actor !== expected.actor || value.source !== expected.source ||
          value.filter !== expected.filter || value.scope_version !== expected.scope_version || typeof value.after !== 'string') throw new Error('invalid cursor');
      return value;
    },
  };
}
