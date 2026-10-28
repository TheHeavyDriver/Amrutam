export type AnalyticsInterval = 'day' | 'week' | 'month';

export interface AnalyticsRange {
  from: string;
  to: string;
}

export interface AnalyticsOverview {
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
    new: number;
  };
}

export interface ConsultationBucket {
  bucketStart: string;
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
}

export interface ConsultationsAnalytics {
  range: AnalyticsRange;
  interval: AnalyticsInterval;
  buckets: ConsultationBucket[];
}

export interface RevenueBucket {
  bucketStart: string;
  capturedCents: number;
  refundedCents: number;
  netCents: number;
}

export interface RevenueAnalytics {
  range: AnalyticsRange;
  interval: AnalyticsInterval;
  currency: string;
  buckets: RevenueBucket[];
}

export interface DoctorUtilization {
  doctorId: string;
  fullName: string;
  specialization: string;
  availableSlots: number;
  bookedSlots: number;
  completedConsultations: number;
  utilizationRate: number;
}

export interface DoctorUtilizationResponse {
  range: AnalyticsRange;
  data: DoctorUtilization[];
}

export interface SpecialtyMetric {
  specialization: string;
  consultations: number;
  revenueCents: number;
}

export interface SpecialtyAnalyticsResponse {
  range: AnalyticsRange;
  currency: string;
  data: SpecialtyMetric[];
}
