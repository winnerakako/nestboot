import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from '../../common/interfaces';

interface RawJwtPayload {
  sub?: unknown;
  email?: unknown;
  role?: unknown;
  roles?: unknown;
}

function resolveRole(payload: RawJwtPayload): string | undefined {
  if (typeof payload.role === 'string') {
    return payload.role;
  }

  if (Array.isArray(payload.roles) && typeof payload.roles[0] === 'string') {
    return payload.roles[0];
  }

  return undefined;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>(
        'auth.jwtSecret',
        'change-me-in-production',
      ),
    });
  }

  validate(payload: RawJwtPayload): JwtPayload {
    if (typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Invalid token subject');
    }

    const role = resolveRole(payload);
    if (!role) {
      throw new UnauthorizedException('Invalid token role');
    }

    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      role,
    };
  }
}
