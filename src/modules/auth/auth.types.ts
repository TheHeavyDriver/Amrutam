import type { UserRole } from '../../common/auth/auth-user.js';

export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
  status: 'pending' | 'active' | 'suspended' | 'deleted';
  fullName: string;
  mfaEnabled: boolean;
  createdAt: string;
}

export interface SessionResponse {
  accessToken: string;
  tokenType: 'Bearer';
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
  user: UserSummary;
}

export interface MfaChallengeResponse {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export type LoginResponse = SessionResponse | MfaChallengeResponse;

export interface RegistrationResponse {
  userId: string;
  email: string;
  verificationRequired: boolean;
  message: string;
}

export interface MfaSetupResponse {
  secret: string;
  otpauthUri: string;
  issuer: string;
  accountName: string;
}

export interface MfaEnableResponse {
  message: string;
  recoveryCodes: string[];
}
