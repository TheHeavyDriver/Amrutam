import type { DoctorSummary } from '../doctors/doctors.types.js';

export interface Money {
  amountCents: number;
  currency: string;
}

export interface PatientSummary {
  id: string;
  fullName: string;
}

export interface Consultation {
  id: string;
  patientId: string;
  doctorId: string;
  slotId: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  scheduledStart: string;
  scheduledEnd: string;
  fee: Money;
  startedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  noShowAt: string | null;
  diagnosis: string | null;
  notes: string | null;
  patient: PatientSummary;
  doctor: DoctorSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ConsultationListResponse {
  data: Consultation[];
  page: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface JoinTokenResponse {
  token: string;
  expiresAt: string;
  joinUrl: string;
}
