import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SignJWT, errors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { UserRole } from '../../common/auth/auth-user.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { SERVICE_NAME } from '../../config/configuration.js';

const JWT_ALGORITHM = 'HS256';
const JWT_AUDIENCE = 'amrutam-api';
const JWT_ISSUER = SERVICE_NAME;

export interface AccessTokenClaims {
  userId: string;
  role: UserRole;
  sessionId: string;
}

export interface MfaTokenClaims {
  userId: string;
}

export class TokenValidationError extends Error {
  constructor(message = 'Invalid or expired token') {
    super(message);
    this.name = TokenValidationError.name;
  }
}

@Injectable()
export class TokenService {
  private readonly accessKey: Uint8Array;
  private readonly mfaKey: Uint8Array;
  private readonly accessTtl: number;
  private readonly mfaTtl: number;

  constructor(config: AppConfigService) {
    this.accessKey = new TextEncoder().encode(config.auth.secrets.accessToken);
    this.mfaKey = new TextEncoder().encode(config.auth.secrets.mfaToken);
    this.accessTtl = config.auth.accessTokenTtlSeconds;
    this.mfaTtl = config.auth.mfaTokenTtlSeconds;
  }

  get accessTokenTtlSeconds(): number {
    return this.accessTtl;
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.sign(
      {
        sub: claims.userId,
        sid: claims.sessionId,
        role: claims.role,
        type: 'access',
      },
      this.accessKey,
      this.accessTtl,
    );
  }

  async signMfaToken(claims: MfaTokenClaims): Promise<string> {
    return this.sign(
      {
        sub: claims.userId,
        type: 'mfa',
      },
      this.mfaKey,
      this.mfaTtl,
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const payload = await this.verify(token, this.accessKey);

    if (
      payload.type !== 'access' ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      (payload.role !== 'patient' && payload.role !== 'doctor' && payload.role !== 'admin')
    ) {
      throw new TokenValidationError('Invalid access token claims');
    }

    return {
      userId: payload.sub,
      sessionId: payload.sid,
      role: payload.role,
    };
  }

  async verifyMfaToken(token: string): Promise<MfaTokenClaims> {
    const payload = await this.verify(token, this.mfaKey);

    if (payload.type !== 'mfa' || typeof payload.sub !== 'string') {
      throw new TokenValidationError('Invalid MFA token claims');
    }

    return { userId: payload.sub };
  }

  private async sign(claims: JWTPayload, key: Uint8Array, ttlSeconds: number): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(key);
  }

  private async verify(token: string, key: Uint8Array): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: [JWT_ALGORITHM],
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
        clockTolerance: 5,
      });

      return payload;
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw new TokenValidationError('Token has expired');
      }

      throw new TokenValidationError();
    }
  }
}
