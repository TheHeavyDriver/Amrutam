export type PaymentStatus =
  'pending' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';

export type PaymentProvider = 'mock' | 'razorpay' | 'stripe';

export interface Payment {
  id: string;
  consultationId: string;
  patientId: string;
  amount: number;
  amountRefunded: number;
  currency: string;
  status: PaymentStatus;
  provider: PaymentProvider;
  providerReference: string | null;
  failureCode: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentIntentResponse {
  payment: Payment;
  clientSecret: string | null;
}

export interface PaymentListResponse {
  data: Payment[];
}

export interface MessageResponse {
  message: string;
}
