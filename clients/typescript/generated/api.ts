/**
 * Amrutam Telemedicine API
 * 1.0.0
 * DO NOT MODIFY - This file has been generated using oazapfts.
 * See https://www.npmjs.com/package/oazapfts
 */
import * as Oazapfts from "@oazapfts/runtime";
import * as QS from "@oazapfts/runtime/query";
export const defaults: Oazapfts.Defaults<Oazapfts.CustomHeaders> = {
    headers: {},
    baseUrl: "http://localhost:3000"
};
const oazapfts = Oazapfts.runtime(defaults);
export const servers = {
    localDevelopmentServer: "http://localhost:3000"
};
export type HealthResponse = {
    status: "ok" | "degraded";
    service: string;
    version: string;
    environment: string;
    uptimeSeconds: number;
    timestamp: string;
};
export type ErrorDetail = {
    field: string;
    message: string;
    code?: string | null;
};
export type ErrorResponse = {
    error: {
        /** Stable machine-readable error code. */
        code: string;
        message: string;
        requestId: string;
        details?: ErrorDetail[] | {
            [key: string]: unknown;
        };
    };
};
export type Gender = "female" | "male" | "non_binary" | "prefer_not_to_say";
export type RegisterRequest = {
    email: string;
    /** At least 12 characters. Common and breached passwords are rejected. */
    password: string;
    fullName: string;
    phone: string;
    dateOfBirth?: string | null;
    gender?: Gender | null;
    acceptedTerms: true;
};
export type RegistrationResponse = {
    userId: string;
    email: string;
    /** True when the account must verify its email before signing in. */
    verificationRequired: boolean;
    message: string;
};
export type LoginRequest = {
    email: string;
    password: string;
};
export type UserRole = "patient" | "doctor" | "admin";
export type UserStatus = "pending" | "active" | "suspended" | "deleted";
export type UserSummary = {
    id: string;
    email: string;
    role: UserRole;
    status: UserStatus;
    fullName: string;
    mfaEnabled: boolean;
    createdAt: string;
};
export type SessionResponse = {
    accessToken: string;
    tokenType: "Bearer";
    /** Seconds until the access token expires. */
    accessTokenExpiresIn: number;
    refreshToken: string;
    /** Seconds until the refresh token expires. */
    refreshTokenExpiresIn: number;
    user: UserSummary;
};
export type MfaChallengeResponse = {
    mfaRequired: true;
    mfaToken: string;
    expiresIn: number;
};
export type LoginResponse = SessionResponse | MfaChallengeResponse;
export type RefreshTokenRequest = {
    refreshToken: string;
};
export type MessageResponse = {
    message: string;
};
export type TokenRequest = {
    token: string;
};
export type EmailRequest = {
    email: string;
};
export type ResetPasswordRequest = {
    token: string;
    password: string;
};
export type MfaChallengeVerifyRequest = {
    mfaToken: string;
    /** A 6-digit TOTP code or a one-time recovery code. */
    code: string;
};
export type MfaSetupResponse = {
    /** Base32 TOTP secret. Display once; store encrypted server-side. */
    secret: string;
    otpauthUri: string;
    issuer: string;
    accountName: string;
};
export type MfaCodeRequest = {
    code: string;
};
export type MfaEnableResponse = {
    message: string;
    recoveryCodes: string[];
};
export type MfaDisableRequest = {
    password: string;
    /** A current TOTP code or an unused recovery code. */
    code: string;
};
export type User = {
    id: string;
    email: string;
    role: UserRole;
    status: UserStatus;
    emailVerifiedAt: string | null;
    mfaEnabled: boolean;
    fullName: string;
    dateOfBirth?: string | null;
    phone?: string | null;
    gender?: Gender | null;
    locale: string;
    timezone: string;
    avatarUrl?: string | null;
    createdAt: string;
    updatedAt: string;
};
export type UpdateProfileRequest = {
    fullName?: string;
    dateOfBirth?: string | null;
    phone?: string | null;
    gender?: Gender | null;
    locale?: string;
    timezone?: string;
    avatarUrl?: string | null;
};
export type ChangePasswordRequest = {
    currentPassword: string;
    newPassword: string;
};
export type Money = {
    amountCents: number;
    currency: string;
};
export type DoctorSummary = {
    id: string;
    fullName: string;
    specialization: string;
    subSpecialties: string[];
    languages: string[];
    yearsExperience: number;
    consultationFee: Money;
    city?: string | null;
    rating: number;
    ratingCount: number;
    acceptingNewPatients: boolean;
    nextAvailableAt?: string | null;
    bio?: string | null;
};
export type PageInfo = {
    hasMore: boolean;
    nextCursor: string | null;
};
export type DoctorListResponse = {
    data: DoctorSummary[];
    page: PageInfo;
};
export type DoctorVerificationStatus = "pending" | "verified" | "rejected" | "suspended";
export type DoctorDetail = {
    id: string;
    fullName: string;
    specialization: string;
    subSpecialties: string[];
    languages: string[];
    yearsExperience: number;
    consultationFee: Money;
    city?: string | null;
    rating: number;
    ratingCount: number;
    acceptingNewPatients: boolean;
    nextAvailableAt?: string | null;
    bio?: string | null;
    licenseNumber: string;
    verificationStatus: DoctorVerificationStatus;
    verifiedAt?: string | null;
    timezone: string;
    createdAt: string;
    updatedAt: string;
};
export type SlotStatus = "available" | "held" | "booked" | "blocked";
export type AvailabilitySlot = {
    id: string;
    doctorId: string;
    startsAt: string;
    endsAt: string;
    status: SlotStatus;
    durationMinutes: number;
};
export type AvailabilityListResponse = {
    data: AvailabilitySlot[];
    page: PageInfo;
};
export type CreateBookingRequest = {
    slotId: string;
    notes?: string;
};
export type ConsultationStatus = "scheduled" | "in_progress" | "completed" | "cancelled" | "no_show";
export type PatientSummary = {
    id: string;
    fullName: string;
};
export type Consultation = {
    id: string;
    patientId: string;
    doctorId: string;
    slotId: string;
    status: ConsultationStatus;
    scheduledStart: string;
    scheduledEnd: string;
    fee: Money;
    startedAt?: string | null;
    endedAt?: string | null;
    cancelledAt?: string | null;
    cancellationReason?: string | null;
    noShowAt?: string | null;
    diagnosis?: string | null;
    notes?: string | null;
    patient?: PatientSummary;
    doctor?: DoctorSummary;
    createdAt: string;
    updatedAt: string;
};
export type ConsultationListResponse = {
    data: Consultation[];
    page: PageInfo;
};
export type CancelBookingRequest = {
    reason: string;
};
export type RescheduleBookingRequest = {
    slotId: string;
};
export type JoinTokenResponse = {
    token: string;
    expiresAt: string;
    joinUrl: string;
};
export type CompleteConsultationRequest = {
    diagnosis?: string;
    notes?: string;
};
export type NoShowRequest = {
    notes?: string;
};
export type PaymentProvider = "mock" | "razorpay" | "stripe";
export type CreatePaymentRequest = {
    provider: PaymentProvider;
    returnUrl?: string;
};
export type PaymentStatus = "pending" | "authorized" | "captured" | "failed" | "refunded" | "partially_refunded";
export type Payment = {
    id: string;
    consultationId: string;
    patientId: string;
    amount: number;
    amountRefunded?: number;
    currency: string;
    status: PaymentStatus;
    provider: PaymentProvider;
    providerReference?: string | null;
    failureCode?: string | null;
    authorizedAt?: string | null;
    capturedAt?: string | null;
    refundedAt?: string | null;
    createdAt: string;
    updatedAt: string;
};
export type PaymentIntentResponse = {
    payment: Payment;
    /** Provider client secret, when the provider requires client-side confirmation. */
    clientSecret?: string | null;
};
export type PaymentListResponse = {
    data: Payment[];
};
export type RefundRequest = {
    /** Omit for a full refund of the remaining captured amount. */
    amount?: number;
    reason: string;
};
export type PaymentWebhookRequest = {
    eventId: string;
    eventType: "payment.authorized" | "payment.captured" | "payment.failed" | "payment.refunded";
    paymentId: string;
    providerReference: string;
    amount?: number;
    currency?: string;
    occurredAt: string;
};
export type PrescriptionItemInput = {
    medicationName: string;
    dosage: string;
    frequency: string;
    durationDays: number;
    instructions?: string;
};
export type CreatePrescriptionRequest = {
    diagnosis: string;
    notes?: string;
    items: PrescriptionItemInput[];
};
export type PrescriptionStatus = "draft" | "signed" | "voided";
export type PrescriptionDocument = {
    url: string;
    sha256: string;
    expiresAt: string;
};
export type PrescriptionItem = {
    id: string;
    medicationName: string;
    dosage: string;
    frequency: string;
    durationDays: number;
    instructions?: string | null;
    sortOrder: number;
};
export type Prescription = {
    id: string;
    consultationId: string;
    doctorId: string;
    patientId: string;
    status: PrescriptionStatus;
    version: number;
    diagnosis?: string | null;
    notes?: string | null;
    issuedAt?: string | null;
    signedAt?: string | null;
    voidedAt?: string | null;
    voidReason?: string | null;
    document?: PrescriptionDocument | null;
    items: PrescriptionItem[];
    createdAt: string;
    updatedAt: string;
};
export type PrescriptionListResponse = {
    data: Prescription[];
    page: PageInfo;
};
export type UpdatePrescriptionRequest = {
    diagnosis?: string;
    notes?: string | null;
    items?: PrescriptionItemInput[];
};
export type VoidPrescriptionRequest = {
    reason: string;
};
export type DoctorDetailListResponse = {
    data: DoctorDetail[];
    page: PageInfo;
};
export type DoctorVerificationRequest = {
    status: DoctorVerificationStatus;
    reason?: string;
};
export type AnalyticsRange = {
    "from": string;
    to: string;
};
export type AnalyticsOverview = {
    range: AnalyticsRange;
    consultations: {
        total: number;
        completed: number;
        cancelled: number;
        noShow: number;
        completionRate: number;
    };
    revenue: {
        capturedCents: number;
        refundedCents: number;
        netCents: number;
        currency: string;
    };
    doctors: {
        active: number;
        verified: number;
    };
    patients: {
        total: number;
        "new": number;
    };
};
export type AnalyticsInterval = "day" | "week" | "month";
export type ConsultationBucket = {
    bucketStart: string;
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
};
export type ConsultationsAnalytics = {
    range: AnalyticsRange;
    interval: AnalyticsInterval;
    buckets: ConsultationBucket[];
};
export type RevenueBucket = {
    bucketStart: string;
    capturedCents: number;
    refundedCents: number;
    netCents: number;
};
export type RevenueAnalytics = {
    range: AnalyticsRange;
    interval: AnalyticsInterval;
    currency: string;
    buckets: RevenueBucket[];
};
export type DoctorUtilization = {
    doctorId: string;
    fullName: string;
    specialization: string;
    availableSlots: number;
    bookedSlots: number;
    completedConsultations: number;
    utilizationRate: number;
};
export type DoctorUtilizationResponse = {
    range: AnalyticsRange;
    data: DoctorUtilization[];
};
export type SpecialtyMetric = {
    specialization: string;
    consultations: number;
    revenueCents: number;
};
export type SpecialtyAnalyticsResponse = {
    range: AnalyticsRange;
    currency: string;
    data: SpecialtyMetric[];
};
export type AuditLogEntry = {
    id: string;
    occurredAt: string;
    actorId?: string | null;
    actorRole?: UserRole | null;
    action: string;
    resourceType: string;
    resourceId: string;
    requestId?: string | null;
    sourceIp?: string | null;
    beforeHash?: string | null;
    afterHash?: string | null;
    metadata: {
        [key: string]: unknown;
    };
    previousHash?: string | null;
    entryHash: string;
};
export type AuditLogListResponse = {
    data: AuditLogEntry[];
    page: PageInfo;
};
export type AuditChainVerification = {
    valid: boolean;
    checkedEntries: number;
    firstInvalidId?: string | null;
    checkedAt: string;
};
/**
 * Service health snapshot
 */
export function getHealth(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: HealthResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/health", {
        ...opts
    });
}
/**
 * Liveness probe
 */
export function getLiveness(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: HealthResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/health/live", {
        ...opts
    });
}
/**
 * Readiness probe
 */
export function getReadiness(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: HealthResponse;
    } | {
        status: 503;
        data: ErrorResponse;
    }>("/health/ready", {
        ...opts
    });
}
/**
 * Register a patient account
 */
export function register(registerRequest: RegisterRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 201;
        data: RegistrationResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/register", oazapfts.json({
        ...opts,
        method: "POST",
        body: registerRequest
    }));
}
/**
 * Authenticate with email and password
 */
export function login(loginRequest: LoginRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: LoginResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 423;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/login", oazapfts.json({
        ...opts,
        method: "POST",
        body: loginRequest
    }));
}
/**
 * Rotate a refresh token
 */
export function refreshSession(refreshTokenRequest: RefreshTokenRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: SessionResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/refresh", oazapfts.json({
        ...opts,
        method: "POST",
        body: refreshTokenRequest
    }));
}
/**
 * Revoke a refresh-token session
 */
export function logout(refreshTokenRequest: RefreshTokenRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/logout", oazapfts.json({
        ...opts,
        method: "POST",
        body: refreshTokenRequest
    }));
}
/**
 * Verify an email address
 */
export function verifyEmail(tokenRequest: TokenRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/verify-email", oazapfts.json({
        ...opts,
        method: "POST",
        body: tokenRequest
    }));
}
/**
 * Resend an email verification link
 */
export function resendVerification(emailRequest: EmailRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/resend-verification", oazapfts.json({
        ...opts,
        method: "POST",
        body: emailRequest
    }));
}
/**
 * Request a password reset
 */
export function forgotPassword(emailRequest: EmailRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/forgot-password", oazapfts.json({
        ...opts,
        method: "POST",
        body: emailRequest
    }));
}
/**
 * Complete a password reset
 */
export function resetPassword(resetPasswordRequest: ResetPasswordRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/reset-password", oazapfts.json({
        ...opts,
        method: "POST",
        body: resetPasswordRequest
    }));
}
/**
 * Complete login with a TOTP code
 */
export function verifyMfaChallenge(mfaChallengeVerifyRequest: MfaChallengeVerifyRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: SessionResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/mfa/verify", oazapfts.json({
        ...opts,
        method: "POST",
        body: mfaChallengeVerifyRequest
    }));
}
/**
 * Begin TOTP MFA enrollment
 */
export function setupMfa(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MfaSetupResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/mfa/setup", {
        ...opts,
        method: "POST"
    });
}
/**
 * Confirm TOTP enrollment
 */
export function enableMfa(mfaCodeRequest: MfaCodeRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MfaEnableResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/mfa/enable", oazapfts.json({
        ...opts,
        method: "POST",
        body: mfaCodeRequest
    }));
}
/**
 * Disable TOTP MFA
 */
export function disableMfa(mfaDisableRequest: MfaDisableRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/auth/mfa/disable", oazapfts.json({
        ...opts,
        method: "POST",
        body: mfaDisableRequest
    }));
}
/**
 * Read the authenticated user
 */
export function getCurrentUser(opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: User;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/users/me", {
        ...opts
    });
}
/**
 * Update the authenticated user's profile
 */
export function updateCurrentUser(updateProfileRequest: UpdateProfileRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: User;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/users/me", oazapfts.json({
        ...opts,
        method: "PATCH",
        body: updateProfileRequest
    }));
}
/**
 * Change the authenticated user's password
 */
export function changePassword(changePasswordRequest: ChangePasswordRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/users/me/password", oazapfts.json({
        ...opts,
        method: "POST",
        body: changePasswordRequest
    }));
}
/**
 * Search verified doctors
 */
export function listDoctors({ query, specialization, language, city, minFeeCents, maxFeeCents, availableFrom, availableTo, sort, cursor, limit }: {
    query?: string;
    specialization?: string;
    language?: string;
    city?: string;
    minFeeCents?: number;
    maxFeeCents?: number;
    availableFrom?: string;
    availableTo?: string;
    sort?: "rating_desc" | "fee_asc" | "fee_desc" | "next_available";
    cursor?: string;
    limit?: number;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: DoctorListResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/doctors${QS.query(QS.explode({
        query,
        specialization,
        language,
        city,
        minFeeCents,
        maxFeeCents,
        availableFrom,
        availableTo,
        sort,
        cursor,
        limit
    }))}`, {
        ...opts
    });
}
/**
 * Read a verified doctor profile
 */
export function getDoctor(doctorId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: DoctorDetail;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/doctors/${encodeURIComponent(doctorId)}`, {
        ...opts
    });
}
/**
 * List a doctor's bookable slots
 */
export function listDoctorAvailability(doctorId: string, { $from, to, cursor, limit }: {
    $from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: AvailabilityListResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/doctors/${encodeURIComponent(doctorId)}/availability${QS.query(QS.explode({
        "from": $from,
        to,
        cursor,
        limit
    }))}`, {
        ...opts
    });
}
/**
 * Reserve a slot and create a consultation
 */
export function createBooking(idempotencyKey: string, createBookingRequest: CreateBookingRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 201;
        data: Consultation;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 429;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>("/api/v1/bookings", oazapfts.json({
        ...opts,
        method: "POST",
        body: createBookingRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * List consultations visible to the caller
 */
export function listBookings({ status, $from, to, cursor, limit }: {
    status?: ConsultationStatus;
    $from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: ConsultationListResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings${QS.query(QS.explode({
        status,
        "from": $from,
        to,
        cursor,
        limit
    }))}`, {
        ...opts
    });
}
/**
 * Read a consultation
 */
export function getBooking(consultationId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Consultation;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}`, {
        ...opts
    });
}
/**
 * Cancel a consultation
 */
export function cancelBooking(consultationId: string, idempotencyKey: string, cancelBookingRequest: CancelBookingRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Consultation;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/cancel`, oazapfts.json({
        ...opts,
        method: "POST",
        body: cancelBookingRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * Move a consultation to another slot
 */
export function rescheduleBooking(consultationId: string, idempotencyKey: string, rescheduleBookingRequest: RescheduleBookingRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Consultation;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/reschedule`, oazapfts.json({
        ...opts,
        method: "POST",
        body: rescheduleBookingRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * Issue a short-lived consultation join token
 */
export function createJoinToken(consultationId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: JoinTokenResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/join-token`, {
        ...opts,
        method: "POST"
    });
}
/**
 * Start a consultation
 */
export function startConsultation(consultationId: string, idempotencyKey: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Consultation;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/start`, {
        ...opts,
        method: "POST",
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    });
}
/**
 * Complete a consultation
 */
export function completeConsultation(consultationId: string, idempotencyKey: string, completeConsultationRequest?: CompleteConsultationRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Consultation;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/complete`, oazapfts.json({
        ...opts,
        method: "POST",
        body: completeConsultationRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * Mark a consultation as a no-show
 */
export function markNoShow(consultationId: string, idempotencyKey: string, noShowRequest?: NoShowRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Consultation;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/no-show`, oazapfts.json({
        ...opts,
        method: "POST",
        body: noShowRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * Create a payment intent for a consultation
 */
export function createPaymentIntent(consultationId: string, idempotencyKey: string, createPaymentRequest: CreatePaymentRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 201;
        data: PaymentIntentResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/payments`, oazapfts.json({
        ...opts,
        method: "POST",
        body: createPaymentRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * List payments for a consultation
 */
export function listConsultationPayments(consultationId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: PaymentListResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/payments`, {
        ...opts
    });
}
/**
 * Read a payment
 */
export function getPayment(paymentId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Payment;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/payments/${encodeURIComponent(paymentId)}`, {
        ...opts
    });
}
/**
 * Confirm and capture a payment
 */
export function confirmPayment(paymentId: string, idempotencyKey: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Payment;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/payments/${encodeURIComponent(paymentId)}/confirm`, {
        ...opts,
        method: "POST",
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    });
}
/**
 * Refund a captured payment
 */
export function refundPayment(paymentId: string, idempotencyKey: string, refundRequest: RefundRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Payment;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/payments/${encodeURIComponent(paymentId)}/refund`, oazapfts.json({
        ...opts,
        method: "POST",
        body: refundRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * Receive a signed payment provider callback
 */
export function paymentWebhook(provider: PaymentProvider, xWebhookSignature: string, paymentWebhookRequest: PaymentWebhookRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: MessageResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/webhooks/payments/${encodeURIComponent(provider)}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: paymentWebhookRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "X-Webhook-Signature": xWebhookSignature
        })
    }));
}
/**
 * Create a draft prescription
 */
export function createPrescription(consultationId: string, idempotencyKey: string, createPrescriptionRequest: CreatePrescriptionRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 201;
        data: Prescription;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/prescriptions`, oazapfts.json({
        ...opts,
        method: "POST",
        body: createPrescriptionRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * List prescriptions for a consultation
 */
export function listConsultationPrescriptions(consultationId: string, { cursor, limit }: {
    cursor?: string;
    limit?: number;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: PrescriptionListResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/bookings/${encodeURIComponent(consultationId)}/prescriptions${QS.query(QS.explode({
        cursor,
        limit
    }))}`, {
        ...opts
    });
}
/**
 * Read a prescription
 */
export function getPrescription(prescriptionId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Prescription;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}`, {
        ...opts
    });
}
/**
 * Edit a draft prescription
 */
export function updatePrescription(prescriptionId: string, idempotencyKey: string, updatePrescriptionRequest: UpdatePrescriptionRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Prescription;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: updatePrescriptionRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * Sign a prescription and generate its document
 */
export function signPrescription(prescriptionId: string, idempotencyKey: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Prescription;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}/sign`, {
        ...opts,
        method: "POST",
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    });
}
/**
 * Void a signed prescription
 */
export function voidPrescription(prescriptionId: string, idempotencyKey: string, voidPrescriptionRequest: VoidPrescriptionRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: Prescription;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 409;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}/void`, oazapfts.json({
        ...opts,
        method: "POST",
        body: voidPrescriptionRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * Get a short-lived signed prescription document URL
 */
export function getPrescriptionDocument(prescriptionId: string, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: PrescriptionDocument;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}/document`, {
        ...opts
    });
}
/**
 * List doctors by verification state
 */
export function listDoctorsForAdmin({ verificationStatus, cursor, limit }: {
    verificationStatus?: DoctorVerificationStatus;
    cursor?: string;
    limit?: number;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: DoctorDetailListResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/doctors${QS.query(QS.explode({
        verificationStatus,
        cursor,
        limit
    }))}`, {
        ...opts
    });
}
/**
 * Update a doctor's verification status
 */
export function updateDoctorVerification(doctorId: string, idempotencyKey: string, doctorVerificationRequest: DoctorVerificationRequest, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: DoctorDetail;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 404;
        data: ErrorResponse;
    } | {
        status: 422;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/doctors/${encodeURIComponent(doctorId)}/verification`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: doctorVerificationRequest,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "Idempotency-Key": idempotencyKey
        })
    }));
}
/**
 * High-level platform metrics
 */
export function getAnalyticsOverview({ $from, to }: {
    $from?: string;
    to?: string;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: AnalyticsOverview;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/analytics/overview${QS.query(QS.explode({
        "from": $from,
        to
    }))}`, {
        ...opts
    });
}
/**
 * Consultation volume and outcome time series
 */
export function getConsultationAnalytics({ $from, to, interval }: {
    $from?: string;
    to?: string;
    interval?: AnalyticsInterval;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: ConsultationsAnalytics;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/analytics/consultations${QS.query(QS.explode({
        "from": $from,
        to,
        interval
    }))}`, {
        ...opts
    });
}
/**
 * Captured, refunded, and net revenue time series
 */
export function getRevenueAnalytics({ $from, to, interval }: {
    $from?: string;
    to?: string;
    interval?: AnalyticsInterval;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: RevenueAnalytics;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/analytics/revenue${QS.query(QS.explode({
        "from": $from,
        to,
        interval
    }))}`, {
        ...opts
    });
}
/**
 * Slot and consultation utilization by doctor
 */
export function getDoctorUtilization({ $from, to, doctorId }: {
    $from?: string;
    to?: string;
    doctorId?: string;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: DoctorUtilizationResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/analytics/doctor-utilization${QS.query(QS.explode({
        "from": $from,
        to,
        doctorId
    }))}`, {
        ...opts
    });
}
/**
 * Consultation and revenue totals by specialty
 */
export function getSpecialtyAnalytics({ $from, to }: {
    $from?: string;
    to?: string;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: SpecialtyAnalyticsResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/analytics/specialties${QS.query(QS.explode({
        "from": $from,
        to
    }))}`, {
        ...opts
    });
}
/**
 * Search append-only audit records
 */
export function listAuditLogs({ actorId, action, resourceType, resourceId, $from, to, cursor, limit }: {
    actorId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    $from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: AuditLogListResponse;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/audit-logs${QS.query(QS.explode({
        actorId,
        action,
        resourceType,
        resourceId,
        "from": $from,
        to,
        cursor,
        limit
    }))}`, {
        ...opts
    });
}
/**
 * Verify the audit hash chain
 */
export function verifyAuditChain({ $from, to }: {
    $from?: string;
    to?: string;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.fetchJson<{
        status: 200;
        data: AuditChainVerification;
    } | {
        status: 400;
        data: ErrorResponse;
    } | {
        status: 401;
        data: ErrorResponse;
    } | {
        status: 403;
        data: ErrorResponse;
    } | {
        status: 500;
        data: ErrorResponse;
    }>(`/api/v1/admin/audit-logs/verify${QS.query(QS.explode({
        "from": $from,
        to
    }))}`, {
        ...opts
    });
}
