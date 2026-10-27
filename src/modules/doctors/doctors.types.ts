export interface PageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface Money {
  amountCents: number;
  currency: string;
}

export interface DoctorSummary {
  id: string;
  fullName: string;
  specialization: string;
  subSpecialties: string[];
  languages: string[];
  yearsExperience: number;
  consultationFee: Money;
  city: string | null;
  rating: number;
  ratingCount: number;
  acceptingNewPatients: boolean;
  nextAvailableAt: string | null;
  bio: string | null;
}

export interface DoctorDetail extends DoctorSummary {
  licenseNumber: string;
  verificationStatus: 'pending' | 'verified' | 'rejected' | 'suspended';
  verifiedAt: string | null;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface DoctorListResponse {
  data: DoctorSummary[];
  page: PageInfo;
}

export interface AvailabilitySlot {
  id: string;
  doctorId: string;
  startsAt: string;
  endsAt: string;
  status: 'available' | 'held' | 'booked' | 'blocked';
  durationMinutes: number;
}

export interface AvailabilityListResponse {
  data: AvailabilitySlot[];
  page: PageInfo;
}

export type DoctorSort = 'rating_desc' | 'fee_asc' | 'fee_desc' | 'next_available';
