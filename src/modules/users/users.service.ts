import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AuthenticatedUser,
  RequestMetadata,
  UserRole,
  UserStatus,
} from '../../common/auth/auth-user.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UpdateProfileInput } from '../auth/auth.schemas.js';
import type { UserProfile } from './users.types.js';

interface UserProfileRow {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  email_verified_at: Date | null;
  mfa_enabled: boolean;
  full_name: string;
  date_of_birth: string | null;
  phone: string | null;
  gender: UserProfile['gender'];
  locale: string;
  timezone: string;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async getById(userId: string): Promise<UserProfile> {
    const user = await this.findById(userId);

    if (!user) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'User not found',
      });
    }

    return this.toProfile(user);
  }

  async updateProfile(
    user: AuthenticatedUser,
    input: UpdateProfileInput,
    request: RequestMetadata,
  ): Promise<UserProfile> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    const assign = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if ('fullName' in input) {
      assign('full_name', input.fullName);
    }

    if ('dateOfBirth' in input) {
      assign('date_of_birth', input.dateOfBirth);
    }

    if ('phone' in input) {
      assign('phone', input.phone);
    }

    if ('gender' in input) {
      assign('gender', input.gender);
    }

    if ('locale' in input) {
      assign('locale', input.locale);
    }

    if ('timezone' in input) {
      assign('timezone', input.timezone);
    }

    if ('avatarUrl' in input) {
      assign('avatar_url', input.avatarUrl);
    }

    if (assignments.length === 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'At least one profile field is required',
      });
    }

    values.push(user.id);
    const userIdParameter = `$${values.length}`;

    try {
      return await this.database.withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE profiles
              SET ${assignments.join(', ')}
            WHERE user_id = ${userIdParameter}`,
          values,
        );

        if (!result.rowCount) {
          throw new ApiException(HttpStatus.NOT_FOUND, {
            code: ErrorCodes.NOT_FOUND,
            message: 'User profile not found',
          });
        }

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'user.profile.updated',
            resourceType: 'user',
            resourceId: user.id,
            request,
            metadata: { fields: Object.keys(input) },
          },
          client,
        );

        const updated = await this.findById(user.id, client);

        if (!updated) {
          throw new ApiException(HttpStatus.NOT_FOUND, {
            code: ErrorCodes.NOT_FOUND,
            message: 'User not found',
          });
        }

        return this.toProfile(updated);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(HttpStatus.CONFLICT, {
          code: ErrorCodes.PHONE_ALREADY_REGISTERED,
          message: 'This phone number is already in use',
        });
      }

      throw error;
    }
  }

  private async findById(userId: string, client?: PoolClient): Promise<UserProfileRow | null> {
    const sql = `SELECT u.id,
                        u.email,
                        u.role,
                        u.status,
                        u.email_verified_at,
                        u.mfa_enabled,
                        p.full_name,
                        to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
                        p.phone,
                        p.gender,
                        p.locale,
                        p.timezone,
                        p.avatar_url,
                        p.created_at,
                        p.updated_at
                   FROM users u
                   JOIN profiles p ON p.user_id = u.id
                  WHERE u.id = $1`;
    const result = client
      ? await client.query<UserProfileRow>(sql, [userId])
      : await this.database.query<UserProfileRow>(sql, [userId]);

    return result.rows[0] ?? null;
  }

  private toProfile(row: UserProfileRow): UserProfile {
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
      mfaEnabled: row.mfa_enabled,
      fullName: row.full_name,
      dateOfBirth: row.date_of_birth,
      phone: row.phone,
      gender: row.gender,
      locale: row.locale,
      timezone: row.timezone,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
