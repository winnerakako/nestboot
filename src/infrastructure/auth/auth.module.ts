import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { JwtStrategy } from './jwt.strategy';

@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule],
  providers: [JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [PassportModule, JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
