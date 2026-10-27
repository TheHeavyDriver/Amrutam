import { randomUUID } from 'node:crypto';
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
import { decryptSecret, encryptSecret } from '../../common/security/encryption.js';
import {
  hashPassword,
  passwordPolicyViolation,
  verifyPassword,
} from '../../common/security/password.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../common/security/tokens.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotpCode,
} from '../../common/security/totp.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  LoginInput,
  MfaChallengeVerifyInput,
  MfaCodeInput,
  MfaDisableInput,
  RegisterInput,
  ResetPasswordInput,
  TokenInput,
  ChangePasswordInput,
} from './auth.schemas.js';
import type {
  LoginResponse,
  MfaChallengeResponse,
  MfaEnableResponse,
  MfaSetupResponse,
  RegistrationResponse,
  SessionResponse,
  UserSummary,
} from './auth.types.js';
import { TokenService } from './token.service.js';

interface UserAuthRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  email_verified_at: Date | null;
  mfa_enabled: boolean;
  mfa_secret_encrypted: string | null;
  mfa_pending_secret_encrypted: string | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  full_name: string;
  created_at: Date;
}

interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  mfa_enabled: boolean;
  full_name: string;
  created_at: Date;
}

interface RefreshLookupRow extends SessionUser {
  token_id: string;
  session_id: string;
  family_id: string;
  token_expires_at: Date;
  session_expires_at: Date;
  token_used_at: Date | null;
  session_revoked_at: Date | null;
}

interface LockoutResult {
  locked_until: Date | null;
  failed_login_attempts: number;
}

interface TokenResult {
  token: string;
  expiresAt: Date;
}

type EmailTemplate = 'verify_email' | 'reset_password';

const AUTH_EMAIL_EVENT = 'notification.email';

function uniqueViolationConstraint(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  ) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === 'string' ? constraint : null;
  }

  return null;
}

function isExpired(value: Date, now = new Date()): boolean {
  return value.getTime() <= now.getTime();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly config: AppConfigService,
  ) {}

  async register(input: RegisterInput, request: RequestMetadata): Promise<RegistrationResponse> {
    this.assertPasswordPolicy(input.password);

    const existing = await this.database.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [input.email],
    );

    if (existing.rowCount && existing.rowCount > 0) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
        message: 'An account with this email already exists',
      });
    }

    const passwordHash = await hashPassword(input.password);
    const requireVerification = this.config.auth.requireEmailVerification;
    const now = new Date();

    try {
      return await this.database.withTransaction(async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role, status, email_verified_at)
           VALUES ($1, $2, 'patient', $3, $4)
           RETURNING id`,
          [
            input.email,
            passwordHash,
            requireVerification ? 'pending' : 'active',
            requireVerification ? null : now,
          ],
        );
        const userId = inserted.rows[0]?.id;

        if (!userId) {
          throw new Error('Failed to create user');
        }

        await client.query(
          `INSERT INTO profiles (user_id, full_name, date_of_birth, phone, gender)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, input.fullName, input.dateOfBirth ?? null, input.phone, input.gender ?? null],
        );

        if (requireVerification) {
          const token = await this.issueAuthToken(
            client,
            userId,
            'email_verification',
            this.config.auth.emailVerificationTtlSeconds,
          );
          await this.enqueueEmail(client, {
            userId,
            email: input.email,
            template: 'verify_email',
            token: token.token,
            expiresAt: token.expiresAt,
          });
        }

        await this.audit.record(
          {
            actorId: userId,
            actorRole: 'patient',
            action: 'auth.registration.created',
            resourceType: 'user',
            resourceId: userId,
            request,
            metadata: { verificationRequired: requireVerification },
          },
          client,
        );

        return {
          userId,
          email: input.email,
          verificationRequired: requireVerification,
          message: requireVerification
            ? 'Account created. Verify your email before signing in.'
            : 'Account created.',
        };
      });
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);

      if (constraint === 'profiles_phone_unique') {
        throw new ApiException(HttpStatus.CONFLICT, {
          code: ErrorCodes.PHONE_ALREADY_REGISTERED,
          message: 'This phone number is already in use',
        });
      }

      if (constraint) {
        throw new ApiException(HttpStatus.CONFLICT, {
          code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
          message: 'An account with this email already exists',
        });
      }

      throw error;
    }
  }

  async login(input: LoginInput, request: RequestMetadata): Promise<LoginResponse> {
    const user = await this.findUserByEmail(input.email);

    if (!user) {
      // Keep the unknown-email path close to the real password path so account
      // discovery is not trivial from response timing.
      await hashPassword(input.password);
      throw this.invalidCredentials();
    }

    const now = new Date();

    if (user.locked_until && user.locked_until > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((user.locked_until.getTime() - now.getTime()) / 1000),
      );

      throw new ApiException(HttpStatus.LOCKED, {
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Too many failed sign-in attempts. Try again later.',
        retryAfterSeconds,
      });
    }

    if (!(await verifyPassword(input.password, user.password_hash))) {
      await this.recordFailedLogin(user, request);
      throw this.invalidCredentials();
    }

    if (user.email_verified_at === null && this.config.auth.requireEmailVerification) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.EMAIL_NOT_VERIFIED,
        message: 'Verify your email before signing in',
      });
    }

    if (user.status !== 'active') {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.ACCOUNT_DISABLED,
        message: 'This account is not active',
      });
    }

    await this.database.query(
      `UPDATE users
          SET failed_login_attempts = 0, locked_until = NULL
        WHERE id = $1`,
      [user.id],
    );

    if (user.mfa_enabled) {
      if (!user.mfa_secret_encrypted) {
        throw new Error(`MFA is enabled for user ${user.id} without a stored secret`);
      }

      const mfaToken = await this.tokens.signMfaToken({ userId: user.id });

      await this.audit.record({
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.mfa.challenge_issued',
        resourceType: 'user',
        resourceId: user.id,
        request,
      });

      const response: MfaChallengeResponse = {
        mfaRequired: true,
        mfaToken,
        expiresIn: this.config.auth.mfaTokenTtlSeconds,
      };

      return response;
    }

    return this.database.withTransaction((client) =>
      this.createSession(client, user, request, 'auth.login.succeeded'),
    );
  }

  async verifyMfaChallenge(
    input: MfaChallengeVerifyInput,
    request: RequestMetadata,
  ): Promise<SessionResponse> {
    let claims;

    try {
      claims = await this.tokens.verifyMfaToken(input.mfaToken);
    } catch {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_TOKEN,
        message: 'MFA challenge is invalid or expired',
      });
    }

    const user = await this.findUserById(claims.userId);

    if (!user || user.status !== 'active' || !user.mfa_enabled || !user.mfa_secret_encrypted) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_TOKEN,
        message: 'MFA challenge is invalid or expired',
      });
    }

    if (user.locked_until && user.locked_until > new Date()) {
      throw new ApiException(HttpStatus.LOCKED, {
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: 'Too many failed sign-in attempts. Try again later.',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((user.locked_until.getTime() - Date.now()) / 1000),
        ),
      });
    }

    const accepted = await this.verifyMfaCode(user, input.code, null);

    if (!accepted) {
      const retryAfterSeconds = await this.recordFailedMfa(user, request);

      if (retryAfterSeconds !== null) {
        throw new ApiException(HttpStatus.LOCKED, {
          code: ErrorCodes.ACCOUNT_LOCKED,
          message: 'Too many failed sign-in attempts. Try again later.',
          retryAfterSeconds,
        });
      }

      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_MFA_CODE,
        message: 'Invalid MFA code',
      });
    }

    return this.database.withTransaction(async (client) => {
      await client.query(
        `UPDATE users
            SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
          WHERE id = $1`,
        [user.id],
      );

      return this.createSession(client, user, request, 'auth.mfa.succeeded');
    });
  }

  async refreshSession(refreshToken: string, request: RequestMetadata): Promise<SessionResponse> {
    const tokenHash = this.hashToken(refreshToken);

    const result = await this.database.withTransaction(async (client) => {
      const lookup = await client.query<RefreshLookupRow>(
        `SELECT rt.id AS token_id,
                rt.session_id,
                rt.expires_at AS token_expires_at,
                rt.used_at AS token_used_at,
                s.family_id,
                s.expires_at AS session_expires_at,
                s.revoked_at AS session_revoked_at,
                u.id,
                u.email,
                u.role,
                u.status,
                u.mfa_enabled,
                p.full_name,
                u.created_at
           FROM auth_refresh_tokens rt
           JOIN auth_sessions s ON s.id = rt.session_id
           JOIN users u ON u.id = s.user_id
           JOIN profiles p ON p.user_id = u.id
          WHERE rt.token_hash = $1
          FOR UPDATE OF rt, s`,
        [tokenHash],
      );
      const row = lookup.rows[0];

      if (!row) {
        return { kind: 'invalid' as const };
      }

      if (row.token_used_at) {
        await client.query(
          `UPDATE auth_sessions
              SET revoked_at = now(), revoked_reason = 'refresh_token_reuse'
            WHERE family_id = $1 AND revoked_at IS NULL`,
          [row.family_id],
        );

        await this.audit.record(
          {
            actorId: row.id,
            actorRole: row.role,
            action: 'auth.session.reuse_detected',
            resourceType: 'auth_session',
            resourceId: row.session_id,
            request,
            metadata: { familyId: row.family_id },
          },
          client,
        );

        return { kind: 'reuse' as const };
      }

      const now = new Date();

      if (
        row.session_revoked_at ||
        isExpired(row.session_expires_at, now) ||
        isExpired(row.token_expires_at, now) ||
        row.status !== 'active'
      ) {
        return { kind: 'invalid' as const };
      }

      const nextToken = generateOpaqueToken();
      const nextTokenHash = this.hashToken(nextToken);

      // Free the session's single active-token slot before inserting its
      // replacement. Both statements are in the same transaction.
      await client.query(
        `UPDATE auth_refresh_tokens
            SET used_at = now()
          WHERE id = $1 AND used_at IS NULL`,
        [row.token_id],
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO auth_refresh_tokens (session_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [row.session_id, nextTokenHash, row.session_expires_at],
      );
      const nextTokenId = inserted.rows[0]?.id;

      if (!nextTokenId) {
        throw new Error('Failed to rotate refresh token');
      }

      await client.query(
        `UPDATE auth_refresh_tokens
            SET replaced_by_token_id = $2
          WHERE id = $1`,
        [row.token_id, nextTokenId],
      );

      await client.query('UPDATE auth_sessions SET last_used_at = now() WHERE id = $1', [
        row.session_id,
      ]);

      const accessToken = await this.tokens.signAccessToken({
        userId: row.id,
        role: row.role,
        sessionId: row.session_id,
      });

      await this.audit.record(
        {
          actorId: row.id,
          actorRole: row.role,
          action: 'auth.session.refreshed',
          resourceType: 'auth_session',
          resourceId: row.session_id,
          request,
        },
        client,
      );

      return {
        kind: 'ok' as const,
        response: {
          accessToken,
          tokenType: 'Bearer' as const,
          accessTokenExpiresIn: this.tokens.accessTokenTtlSeconds,
          refreshToken: nextToken,
          refreshTokenExpiresIn: Math.max(
            1,
            Math.floor((row.session_expires_at.getTime() - now.getTime()) / 1000),
          ),
          user: this.toUserSummary(row),
        },
      };
    });

    if (result.kind === 'reuse') {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.REFRESH_TOKEN_REUSED,
        message: 'Refresh token reuse detected; this session has been revoked',
      });
    }

    if (result.kind === 'invalid') {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_TOKEN,
        message: 'Refresh token is invalid or expired',
      });
    }

    return result.response;
  }

  async logout(
    user: AuthenticatedUser,
    refreshToken: string,
    request: RequestMetadata,
  ): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);

    await this.database.withTransaction(async (client) => {
      const ownership = await client.query<{ session_id: string }>(
        `SELECT rt.session_id
           FROM auth_refresh_tokens rt
           JOIN auth_sessions s ON s.id = rt.session_id
          WHERE rt.token_hash = $1 AND s.user_id = $2
          LIMIT 1`,
        [tokenHash, user.id],
      );

      if (ownership.rows[0]?.session_id !== user.sessionId) {
        throw new ApiException(HttpStatus.UNAUTHORIZED, {
          code: ErrorCodes.INVALID_TOKEN,
          message: 'Refresh token is invalid',
        });
      }

      const result = await client.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'logout'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [user.sessionId, user.id],
      );

      if (result.rowCount && result.rowCount > 0) {
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'auth.logout',
            resourceType: 'auth_session',
            resourceId: user.sessionId,
            request,
          },
          client,
        );
      }
    });
  }

  async verifyEmail(input: TokenInput, request: RequestMetadata): Promise<string> {
    const tokenHash = this.hashToken(input.token);

    return this.database.withTransaction(async (client) => {
      const token = await client.query<{
        id: string;
        user_id: string;
        expires_at: Date;
        role: UserRole;
      }>(
        `SELECT t.id, t.user_id, t.expires_at, u.role
           FROM auth_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1
            AND t.token_type = 'email_verification'
            AND t.used_at IS NULL
          FOR UPDATE OF t`,
        [tokenHash],
      );
      const row = token.rows[0];

      if (!row || isExpired(row.expires_at)) {
        throw new ApiException(HttpStatus.BAD_REQUEST, {
          code: ErrorCodes.INVALID_TOKEN,
          message: 'Verification token is invalid or expired',
        });
      }

      await client.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [row.id]);
      await client.query(
        `UPDATE users
            SET email_verified_at = COALESCE(email_verified_at, now()),
                status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
          WHERE id = $1`,
        [row.user_id],
      );
      await this.audit.record(
        {
          actorId: row.user_id,
          actorRole: row.role,
          action: 'auth.email.verified',
          resourceType: 'user',
          resourceId: row.user_id,
          request,
        },
        client,
      );

      return 'Email verified';
    });
  }

  async resendVerification(email: string, request: RequestMetadata): Promise<string> {
    const user = await this.findUserByEmail(email);

    if (!user || user.email_verified_at !== null) {
      return 'If the account needs verification, an email has been sent';
    }

    await this.database.withTransaction(async (client) => {
      const token = await this.issueAuthToken(
        client,
        user.id,
        'email_verification',
        this.config.auth.emailVerificationTtlSeconds,
      );
      await this.enqueueEmail(client, {
        userId: user.id,
        email: user.email,
        template: 'verify_email',
        token: token.token,
        expiresAt: token.expiresAt,
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.email_verification.requested',
          resourceType: 'user',
          resourceId: user.id,
          request,
        },
        client,
      );
    });

    return 'If the account needs verification, an email has been sent';
  }

  async forgotPassword(email: string, request: RequestMetadata): Promise<string> {
    const user = await this.findUserByEmail(email);

    if (!user || user.status !== 'active') {
      return 'If the account exists, a password reset email has been sent';
    }

    await this.database.withTransaction(async (client) => {
      const token = await this.issueAuthToken(
        client,
        user.id,
        'password_reset',
        this.config.auth.passwordResetTtlSeconds,
      );
      await this.enqueueEmail(client, {
        userId: user.id,
        email: user.email,
        template: 'reset_password',
        token: token.token,
        expiresAt: token.expiresAt,
      });
      await this.audit.record(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.password.reset_requested',
          resourceType: 'user',
          resourceId: user.id,
          request,
        },
        client,
      );
    });

    return 'If the account exists, a password reset email has been sent';
  }

  async resetPassword(input: ResetPasswordInput, request: RequestMetadata): Promise<string> {
    this.assertPasswordPolicy(input.password);
    const tokenHash = this.hashToken(input.token);

    return this.database.withTransaction(async (client) => {
      const token = await client.query<{
        id: string;
        user_id: string;
        expires_at: Date;
        role: UserRole;
      }>(
        `SELECT t.id, t.user_id, t.expires_at, u.role
           FROM auth_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1
            AND t.token_type = 'password_reset'
            AND t.used_at IS NULL
          FOR UPDATE OF t`,
        [tokenHash],
      );
      const row = token.rows[0];

      if (!row || isExpired(row.expires_at)) {
        throw new ApiException(HttpStatus.BAD_REQUEST, {
          code: ErrorCodes.INVALID_TOKEN,
          message: 'Password reset token is invalid or expired',
        });
      }

      // Hash only after the token is known to be valid so unauthenticated
      // callers cannot force expensive Argon2 work with random tokens.
      const passwordHash = await hashPassword(input.password);

      await client.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [row.id]);
      await client.query(
        `UPDATE users
            SET password_hash = $2,
                failed_login_attempts = 0,
                locked_until = NULL
          WHERE id = $1`,
        [row.user_id, passwordHash],
      );
      await client.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'password_reset'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id],
      );
      await this.audit.record(
        {
          actorId: row.user_id,
          actorRole: row.role,
          action: 'auth.password.reset',
          resourceType: 'user',
          resourceId: row.user_id,
          request,
        },
        client,
      );

      return 'Password reset complete';
    });
  }

  async setupMfa(user: AuthenticatedUser, request: RequestMetadata): Promise<MfaSetupResponse> {
    if (user.role === 'patient') {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'MFA enrollment is available to doctor and admin accounts',
      });
    }

    const current = await this.findUserById(user.id);

    if (!current) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'User not found',
      });
    }

    if (current.mfa_enabled) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.MFA_ALREADY_ENABLED,
        message: 'MFA is already enabled',
      });
    }

    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, this.config.auth.secrets.encryptionKey);

    await this.database.withTransaction(async (client) => {
      await client.query('UPDATE users SET mfa_pending_secret_encrypted = $2 WHERE id = $1', [
        current.id,
        encrypted,
      ]);
      await this.audit.record(
        {
          actorId: current.id,
          actorRole: current.role,
          action: 'auth.mfa.setup_started',
          resourceType: 'user',
          resourceId: current.id,
          request,
        },
        client,
      );
    });

    return {
      secret,
      otpauthUri: totpProvisioningUri(secret, current.email, 'Amrutam'),
      issuer: 'Amrutam',
      accountName: current.email,
    };
  }

  async enableMfa(
    user: AuthenticatedUser,
    input: MfaCodeInput,
    request: RequestMetadata,
  ): Promise<MfaEnableResponse> {
    const current = await this.findUserById(user.id);

    if (!current || !current.mfa_pending_secret_encrypted) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.MFA_NOT_SETUP,
        message: 'Start MFA enrollment first',
      });
    }

    if (current.mfa_enabled) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.MFA_ALREADY_ENABLED,
        message: 'MFA is already enabled',
      });
    }

    const secret = decryptSecret(
      current.mfa_pending_secret_encrypted,
      this.config.auth.secrets.encryptionKey,
    );

    if (!verifyTotpCode(secret, input.code)) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: ErrorCodes.INVALID_MFA_CODE,
        message: 'Invalid MFA code',
      });
    }

    const recoveryCodes = generateRecoveryCodes();
    const recoveryHashes = recoveryCodes.map((code) => this.hashToken(code));

    await this.database.withTransaction(async (client) => {
      await client.query(
        `UPDATE users
            SET mfa_secret_encrypted = mfa_pending_secret_encrypted,
                mfa_pending_secret_encrypted = NULL,
                mfa_enabled = true
          WHERE id = $1`,
        [current.id],
      );
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [current.id]);

      for (const codeHash of recoveryHashes) {
        await client.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
          current.id,
          codeHash,
        ]);
      }

      await this.audit.record(
        {
          actorId: current.id,
          actorRole: current.role,
          action: 'auth.mfa.enabled',
          resourceType: 'user',
          resourceId: current.id,
          request,
        },
        client,
      );
    });

    return {
      message: 'MFA enabled. Store recovery codes securely; they will not be shown again.',
      recoveryCodes,
    };
  }

  async disableMfa(
    user: AuthenticatedUser,
    input: MfaDisableInput,
    request: RequestMetadata,
  ): Promise<string> {
    const current = await this.findUserById(user.id);

    if (!current || !current.mfa_enabled || !current.mfa_secret_encrypted) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.MFA_NOT_SETUP,
        message: 'MFA is not enabled',
      });
    }

    if (current.role !== 'patient' && current.status === 'active') {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.MFA_POLICY_REQUIRED,
        message: 'Active doctor and admin accounts must keep MFA enabled',
      });
    }

    if (!(await verifyPassword(input.password, current.password_hash))) {
      throw this.invalidCredentials();
    }

    const secret = decryptSecret(
      current.mfa_secret_encrypted,
      this.config.auth.secrets.encryptionKey,
    );

    if (!(await this.verifyMfaCode(current, input.code, secret))) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: ErrorCodes.INVALID_MFA_CODE,
        message: 'Invalid MFA code',
      });
    }

    await this.database.withTransaction(async (client) => {
      await client.query(
        `UPDATE users
            SET mfa_enabled = false,
                mfa_secret_encrypted = NULL,
                mfa_pending_secret_encrypted = NULL
          WHERE id = $1`,
        [current.id],
      );
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [current.id]);
      await client.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'mfa_disabled'
          WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
        [current.id, user.sessionId],
      );
      await this.audit.record(
        {
          actorId: current.id,
          actorRole: current.role,
          action: 'auth.mfa.disabled',
          resourceType: 'user',
          resourceId: current.id,
          request,
        },
        client,
      );
    });

    return 'MFA disabled';
  }

  async changePassword(
    user: AuthenticatedUser,
    input: ChangePasswordInput,
    request: RequestMetadata,
  ): Promise<string> {
    this.assertPasswordPolicy(input.newPassword);
    const current = await this.findUserById(user.id);

    if (!current || !(await verifyPassword(input.currentPassword, current.password_hash))) {
      throw this.invalidCredentials();
    }

    if (await verifyPassword(input.newPassword, current.password_hash)) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: ErrorCodes.PASSWORD_POLICY_VIOLATION,
        message: 'New password must be different from the current password',
      });
    }

    const passwordHash = await hashPassword(input.newPassword);

    await this.database.withTransaction(async (client) => {
      await client.query(
        `UPDATE users
            SET password_hash = $2,
                failed_login_attempts = 0,
                locked_until = NULL
          WHERE id = $1`,
        [current.id, passwordHash],
      );
      await client.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'password_changed'
          WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
        [current.id, user.sessionId],
      );
      await this.audit.record(
        {
          actorId: current.id,
          actorRole: current.role,
          action: 'auth.password.changed',
          resourceType: 'user',
          resourceId: current.id,
          request,
        },
        client,
      );
    });

    return 'Password changed; other sessions have been revoked';
  }

  async authenticateAccessToken(token: string): Promise<AuthenticatedUser> {
    const claims = await this.tokens.verifyAccessToken(token);
    const session = await this.database.query<{
      id: string;
      user_id: string;
      session_id: string;
      email: string;
      role: UserRole;
      status: UserStatus;
      mfa_enabled: boolean;
      full_name: string;
      session_expires_at: Date;
      session_revoked_at: Date | null;
    }>(
      `SELECT u.id,
              u.email,
              u.role,
              u.status,
              u.mfa_enabled,
              p.full_name,
              s.id AS session_id,
              s.expires_at AS session_expires_at,
              s.revoked_at AS session_revoked_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN profiles p ON p.user_id = u.id
        WHERE s.id = $1 AND s.user_id = $2`,
      [claims.sessionId, claims.userId],
    );
    const row = session.rows[0];

    if (
      !row ||
      row.session_revoked_at ||
      isExpired(row.session_expires_at) ||
      row.status !== 'active'
    ) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.SESSION_REVOKED,
        message: 'Session is invalid or expired',
      });
    }

    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      fullName: row.full_name,
      mfaEnabled: row.mfa_enabled,
      sessionId: row.session_id,
    };
  }

  private async createSession(
    client: PoolClient,
    user: SessionUser,
    request: RequestMetadata,
    auditAction: string,
  ): Promise<SessionResponse> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.auth.refreshTokenTtlSeconds * 1000);
    const familyId = randomUUID();
    const session = await client.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, family_id, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user.id, familyId, expiresAt, request.userAgent ?? null, request.sourceIp ?? null],
    );
    const sessionId = session.rows[0]?.id;

    if (!sessionId) {
      throw new Error('Failed to create session');
    }

    const refreshToken = generateOpaqueToken();
    await client.query(
      `INSERT INTO auth_refresh_tokens (session_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [sessionId, this.hashToken(refreshToken), expiresAt],
    );

    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      role: user.role,
      sessionId,
    });

    await this.audit.record(
      {
        actorId: user.id,
        actorRole: user.role,
        action: auditAction,
        resourceType: 'auth_session',
        resourceId: sessionId,
        request,
        metadata: { familyId },
      },
      client,
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      accessTokenExpiresIn: this.tokens.accessTokenTtlSeconds,
      refreshToken,
      refreshTokenExpiresIn: this.config.auth.refreshTokenTtlSeconds,
      user: this.toUserSummary(user),
    };
  }

  private async findUserByEmail(email: string): Promise<UserAuthRow | null> {
    const result = await this.database.query<UserAuthRow>(
      `SELECT u.id, u.email, u.password_hash, u.role, u.status, u.email_verified_at,
              u.mfa_enabled, u.mfa_secret_encrypted, u.mfa_pending_secret_encrypted,
              u.failed_login_attempts, u.locked_until, p.full_name, u.created_at
         FROM users u
         JOIN profiles p ON p.user_id = u.id
        WHERE u.email = $1
        LIMIT 1`,
      [email],
    );

    return result.rows[0] ?? null;
  }

  private async findUserById(userId: string): Promise<UserAuthRow | null> {
    const result = await this.database.query<UserAuthRow>(
      `SELECT u.id, u.email, u.password_hash, u.role, u.status, u.email_verified_at,
              u.mfa_enabled, u.mfa_secret_encrypted, u.mfa_pending_secret_encrypted,
              u.failed_login_attempts, u.locked_until, p.full_name, u.created_at
         FROM users u
         JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1
        LIMIT 1`,
      [userId],
    );

    return result.rows[0] ?? null;
  }

  private async recordFailedLogin(user: UserAuthRow, request: RequestMetadata): Promise<void> {
    const result = await this.database.query<LockoutResult>(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2
                THEN now() + make_interval(secs => $3)
                ELSE locked_until
              END
        WHERE id = $1
        RETURNING locked_until, failed_login_attempts`,
      [user.id, this.config.auth.maxLoginAttempts, this.config.auth.lockoutSeconds],
    );
    const row = result.rows[0];

    if (!row?.locked_until || row.locked_until <= new Date()) {
      return;
    }

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login.locked',
      resourceType: 'user',
      resourceId: user.id,
      request,
      metadata: { attempts: row.failed_login_attempts },
    });
  }

  private async recordFailedMfa(
    user: UserAuthRow,
    request: RequestMetadata,
  ): Promise<number | null> {
    const result = await this.database.query<LockoutResult>(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2
                THEN now() + make_interval(secs => $3)
                ELSE locked_until
              END
        WHERE id = $1
        RETURNING locked_until, failed_login_attempts`,
      [user.id, this.config.auth.maxLoginAttempts, this.config.auth.lockoutSeconds],
    );
    const row = result.rows[0];

    if (!row?.locked_until || row.locked_until <= new Date()) {
      return null;
    }

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login.locked',
      resourceType: 'user',
      resourceId: user.id,
      request,
      metadata: { attempts: row.failed_login_attempts, factor: 'mfa' },
    });

    return Math.max(1, Math.ceil((row.locked_until.getTime() - Date.now()) / 1000));
  }

  private async verifyMfaCode(
    user: UserAuthRow,
    code: string,
    secretOverride: string | null,
  ): Promise<boolean> {
    if (code.includes('-')) {
      const result = await this.database.query(
        `UPDATE mfa_recovery_codes
            SET used_at = now()
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
          RETURNING id`,
        [user.id, this.hashToken(code)],
      );

      return (result.rowCount ?? 0) > 0;
    }

    const secret =
      secretOverride ??
      (user.mfa_secret_encrypted
        ? decryptSecret(user.mfa_secret_encrypted, this.config.auth.secrets.encryptionKey)
        : null);

    if (!secret) {
      return false;
    }

    return verifyTotpCode(secret, code);
  }

  private async issueAuthToken(
    client: PoolClient,
    userId: string,
    type: 'email_verification' | 'password_reset',
    ttlSeconds: number,
  ): Promise<TokenResult> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await client.query(
      `UPDATE auth_tokens
          SET used_at = now()
        WHERE user_id = $1 AND token_type = $2::auth_token_type AND used_at IS NULL`,
      [userId, type],
    );
    await client.query(
      `INSERT INTO auth_tokens (user_id, token_type, token_hash, expires_at)
       VALUES ($1, $2::auth_token_type, $3, $4)`,
      [userId, type, this.hashToken(token), expiresAt],
    );

    return { token, expiresAt };
  }

  private async enqueueEmail(
    client: PoolClient,
    input: {
      userId: string;
      email: string;
      template: EmailTemplate;
      token: string;
      expiresAt: Date;
    },
  ): Promise<void> {
    const encryptedToken = encryptSecret(input.token, this.config.auth.secrets.encryptionKey);

    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('user', $1, $2, $3)`,
      [
        input.userId,
        AUTH_EMAIL_EVENT,
        {
          template: input.template,
          to: input.email,
          encryptedToken,
          expiresAt: input.expiresAt.toISOString(),
        },
      ],
    );
  }

  private hashToken(token: string): string {
    return hashOpaqueToken(token, this.config.auth.secrets.tokenPepper);
  }

  private assertPasswordPolicy(password: string): void {
    const violation = passwordPolicyViolation(password);

    if (violation) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: ErrorCodes.PASSWORD_POLICY_VIOLATION,
        message: violation,
      });
    }
  }

  private invalidCredentials(): ApiException {
    return new ApiException(HttpStatus.UNAUTHORIZED, {
      code: ErrorCodes.INVALID_CREDENTIALS,
      message: 'Email or password is incorrect',
    });
  }

  private toUserSummary(user: SessionUser): UserSummary {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      fullName: user.full_name,
      mfaEnabled: user.mfa_enabled,
      createdAt: user.created_at.toISOString(),
    };
  }
}
