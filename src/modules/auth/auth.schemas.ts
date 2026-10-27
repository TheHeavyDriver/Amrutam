import { z } from 'zod';

const email = z
  .email()
  .max(320)
  .transform((value) => value.trim().toLowerCase());
const password = z.string().min(12, 'Password must be at least 12 characters').max(128);
const phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Phone must use E.164 format');
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const gender = z.enum(['female', 'male', 'non_binary', 'prefer_not_to_say']);
const totpCode = z.string().regex(/^[0-9]{6}$/, 'Expected a 6-digit TOTP code');
const recoveryCode = z.string().regex(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/, 'Expected a recovery code');
const mfaCodeOrRecoveryCode = z.union([totpCode, recoveryCode]);

export const registerSchema = z
  .object({
    email,
    password,
    fullName: z.string().trim().min(2).max(120),
    phone,
    dateOfBirth: dateOnly.nullable().optional(),
    gender: gender.nullable().optional(),
    acceptedTerms: z.literal(true),
  })
  .strict();

export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(128),
  })
  .strict();

export const refreshTokenSchema = z
  .object({
    refreshToken: z.string().min(20).max(500),
  })
  .strict();

export const tokenSchema = z
  .object({
    token: z.string().min(16).max(500),
  })
  .strict();

export const emailOnlySchema = z
  .object({
    email,
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(16).max(500),
    password,
  })
  .strict();

export const mfaChallengeVerifySchema = z
  .object({
    mfaToken: z.string().min(20).max(4096),
    code: mfaCodeOrRecoveryCode,
  })
  .strict();

export const mfaCodeSchema = z
  .object({
    code: totpCode,
  })
  .strict();

export const mfaDisableSchema = z
  .object({
    password: z.string().min(1).max(128),
    code: mfaCodeOrRecoveryCode,
  })
  .strict();

export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    dateOfBirth: dateOnly.nullable().optional(),
    phone: phone.nullable().optional(),
    gender: gender.nullable().optional(),
    locale: z.string().min(2).max(16).optional(),
    timezone: z.string().min(1).max(64).optional(),
    avatarUrl: z.url().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one profile field is required',
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: password,
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type TokenInput = z.infer<typeof tokenSchema>;
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type MfaChallengeVerifyInput = z.infer<typeof mfaChallengeVerifySchema>;
export type MfaCodeInput = z.infer<typeof mfaCodeSchema>;
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
