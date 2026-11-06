import { randomUUID } from 'crypto';

export const ORGANIZATION_AUTHORITY = 'support-bot' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export interface OrgRef {
  authority: typeof ORGANIZATION_AUTHORITY;
  instance: string;
  id: string;
}

export function canonicalUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('invalid organization id');
  return value.toLowerCase();
}

export function validateInstance(value: unknown): string {
  if (typeof value !== 'string' || !INSTANCE.test(value)) throw new Error('invalid source instance');
  return value;
}

export function validatePrincipalRef(value: unknown): string {
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) throw new Error('invalid principal reference');
  return value;
}

export function parseOrgRef(value: unknown, registeredInstance: string): OrgRef {
  const instance = validateInstance(registeredInstance);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid organization reference');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'authority,id,instance' ||
      v.authority !== ORGANIZATION_AUTHORITY || v.instance !== instance) {
    throw new Error('invalid organization reference');
  }
  return { authority: ORGANIZATION_AUTHORITY, instance, id: canonicalUuid(v.id) };
}

/** Pure owner-side helper. It does not persist or register an organization. */
export function issueOrgRef(registeredInstance: string, uuid: () => string = randomUUID): OrgRef {
  return parseOrgRef({ authority: ORGANIZATION_AUTHORITY, instance: registeredInstance, id: uuid() }, registeredInstance);
}

export function sameOrgRef(a: OrgRef, b: OrgRef): boolean {
  return a.authority === b.authority && a.instance === b.instance && a.id === b.id;
}
