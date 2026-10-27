import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { requestMetadata } from '../../common/auth/request-metadata.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { changePasswordSchema } from '../auth/auth.schemas.js';
import type { ChangePasswordInput } from '../auth/auth.schemas.js';
import { AuthService } from '../auth/auth.service.js';
import type { UserProfile } from './users.types.js';
import { UsersService } from './users.service.js';
import { updateProfileSchema } from '../auth/auth.schemas.js';
import type { UpdateProfileInput } from '../auth/auth.schemas.js';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<UserProfile> {
    return this.usersService.getById(user.id);
  }

  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
    @Req() request: FastifyRequest,
  ): Promise<UserProfile> {
    return this.usersService.updateProfile(user, body, requestMetadata(request));
  }

  @Post('me/password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    const message = await this.authService.changePassword(user, body, requestMetadata(request));
    return { message };
  }
}
