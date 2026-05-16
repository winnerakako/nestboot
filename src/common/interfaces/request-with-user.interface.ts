import { Request } from 'express';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

export interface RequestWithUser extends Request {
  user: JwtPayload;
  /** Set by AuditContextInterceptor — use with prisma.auditCreate() / auditUpdate() */
  auditUserId: string | null;
}
