import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { loginSchema, refreshSchema, registerSchema } from '@dukaano/validation'
import type { LoginInput, RefreshInput, RegisterInput } from '@dukaano/validation'
import { CurrentUser, Public, RequirePermission, SkipTenant } from '../../common/decorators'
import { env } from '../../config/env'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import type { RequestPrincipal } from '../../common/guards/types'
import type { Request } from 'express'
import { AuthService } from './auth.service'
import { TokenService } from './token.service'

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  private meta(req: Request) {
    return { ipAddress: req.ip, userAgent: req.get('user-agent') }
  }

  /** Blueprint §21: auth is rate limited per IP. See AUTH_RATE_LIMIT_PER_MINUTE in env.ts. */
  @Public()
  @SkipTenant()
  @Throttle({ default: { limit: env.AUTH_RATE_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Post('register')
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput, @Req() req: Request) {
    return this.auth.register(body, this.meta(req))
  }

  @Public()
  @SkipTenant()
  @Throttle({ default: { limit: env.AUTH_RATE_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput, @Req() req: Request) {
    return this.auth.login(body, this.meta(req))
  }

  @Public()
  @SkipTenant()
  @Throttle({ default: { limit: env.AUTH_RATE_LIMIT_PER_MINUTE * 4, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput, @Req() req: Request) {
    return this.tokens.rotate(body.refreshToken, this.meta(req))
  }

  @Public()
  @SkipTenant()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput): Promise<void> {
    await this.tokens.revoke(body.refreshToken)
  }

  /** Any authenticated member. The empty permission list is an explicit declaration, not an omission. */
  @RequirePermission()
  @Get('me')
  me(@CurrentUser() principal: RequestPrincipal) {
    return {
      userId: principal.userId,
      shopId: principal.shopId,
      role: principal.role,
      membershipId: principal.membershipId,
      deviceId: principal.deviceId,
      permissions: [...principal.permissions].sort(),
    }
  }
}
