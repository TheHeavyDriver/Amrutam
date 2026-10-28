import type { PageInfo } from '../doctors/doctors.types.js';

export type PrescriptionStatus = 'draft' | 'signed' | 'voided';

export interface PrescriptionItem {
  id: string;
  medicationName: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  instructions: string | null;
  sortOrder: number;
}

export interface PrescriptionDocument {
  url: string;
  sha256: string;
  expiresAt: string;
}

export interface Prescription {
  id: string;
  consultationId: string;
  doctorId: string;
  patientId: string;
  status: PrescriptionStatus;
  version: number;
  diagnosis: string | null;
  notes: string | null;
  issuedAt: string | null;
  signedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  document: PrescriptionDocument | null;
  items: PrescriptionItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PrescriptionListResponse {
  data: Prescription[];
  page: PageInfo;
}
