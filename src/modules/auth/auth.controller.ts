import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import { requestMetadata } from '../../common/auth/request-metadata.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  emailOnlySchema,
  loginSchema,
  mfaChallengeVerifySchema,
  mfaCodeSchema,
  mfaDisableSchema,
  refreshTokenSchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
} from './auth.schemas.js';
import type {
  EmailOnlyInput,
  LoginInput,
  MfaChallengeVerifyInput,
  MfaCodeInput,
  MfaDisableInput,
  RefreshTokenInput,
  RegisterInput,
  ResetPasswordInput,
  TokenInput,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import type {
  LoginResponse,
  MfaSetupResponse,
  RegistrationResponse,
  SessionResponse,
} from './auth.types.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Req() request: FastifyRequest,
  ): Promise<RegistrationResponse> {
    return this.authService.register(body, requestMetadata(request));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() request: FastifyRequest,
  ): Promise<LoginResponse> {
    return this.authService.login(body, requestMetadata(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(
    @Body(new ZodValidationPipe(refreshTokenSchema)) body: RefreshTokenInput,
    @Req() request: FastifyRequest,
  ): Promise<SessionResponse> {
    return this.authService.refreshSession(body.refreshToken, requestMetadata(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(refreshTokenSchema)) body: RefreshTokenInput,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    await this.authService.logout(user, body.refreshToken, requestMetadata(request));
    return { message: 'Session revoked' };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body(new ZodValidationPipe(tokenSchema)) body: TokenInput,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    const message = await this.authService.verifyEmail(body, requestMetadata(request));
    return { message };
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: EmailOnlyInput,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    const message = await this.authService.resendVerification(body.email, requestMetadata(request));
    return { message };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: EmailOnlyInput,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    const message = await this.authService.forgotPassword(body.email, requestMetadata(request));
    return { message };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    const message = await this.authService.resetPassword(body, requestMetadata(request));
    return { message };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  verifyMfa(
    @Body(new ZodValidationPipe(mfaChallengeVerifySchema)) body: MfaChallengeVerifyInput,
    @Req() request: FastifyRequest,
  ): Promise<SessionResponse> {
    return this.authService.verifyMfaChallenge(body, requestMetadata(request));
  }

  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  setupMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<MfaSetupResponse> {
    return this.authService.setupMfa(user, requestMetadata(request));
  }

  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  enableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(mfaCodeSchema)) body: MfaCodeInput,
    @Req() request: FastifyRequest,
  ) {
    return this.authService.enableMfa(user, body, requestMetadata(request));
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  async disableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(mfaDisableSchema)) body: MfaDisableInput,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    const message = await this.authService.disableMfa(user, body, requestMetadata(request));
    return { message };
  }
}
