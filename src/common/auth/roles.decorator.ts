import { SetMetadata } from '@nestjs/common';
import type { UserRole } from './auth-user.js';

export const ROLES_KEY = 'roles';

/** Restricts an authenticated route to one or more roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
