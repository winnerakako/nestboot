import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from '../../common/interfaces';
import {
  getJwtEmail,
  getJwtSubject,
  RawJwtPayload,
  resolveJwtRole,
} from './jwt-payload.util';

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
    const subject = getJwtSubject(payload);
    if (!subject) {
      throw new UnauthorizedException('Invalid token subject');
    }

    const role = resolveJwtRole(payload);
    if (!role) {
      throw new UnauthorizedException('Invalid token role');
    }

    return {
      sub: subject,
      email: getJwtEmail(payload),
      role,
    };
  }
}
