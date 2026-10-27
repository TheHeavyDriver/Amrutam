export const USER_ROLES = ['patient', 'doctor', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deleted';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  fullName: string;
  mfaEnabled: boolean;
  sessionId: string;
}

export interface RequestMetadata {
  requestId: string;
  sourceIp?: string;
  userAgent?: string;
}
