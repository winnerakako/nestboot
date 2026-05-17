export interface RawJwtPayload {
  sub?: unknown;
  email?: unknown;
  role?: unknown;
  roles?: unknown;
  orgId?: unknown;
}

export function getJwtSubject(payload: RawJwtPayload): string | undefined {
  return typeof payload.sub === 'string' && payload.sub.length > 0
    ? payload.sub
    : undefined;
}

export function getJwtEmail(payload: RawJwtPayload): string {
  return typeof payload.email === 'string' ? payload.email : '';
}

export function getJwtOrgId(payload: RawJwtPayload): string | undefined {
  return typeof payload.orgId === 'string' && payload.orgId.length > 0
    ? payload.orgId
    : undefined;
}

export function resolveJwtRole(payload: RawJwtPayload): string | undefined {
  if (typeof payload.role === 'string' && payload.role.length > 0) {
    return payload.role;
  }

  if (Array.isArray(payload.roles) && typeof payload.roles[0] === 'string') {
    return payload.roles[0];
  }

  return undefined;
}
