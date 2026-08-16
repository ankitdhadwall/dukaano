import { Global, Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { env } from '../../config/env'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { TokenService } from './token.service'

@Global()
@Module({
  imports: [JwtModule.register({ secret: env.JWT_ACCESS_SECRET })],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
  exports: [TokenService, JwtModule],
})
export class AuthModule {}
