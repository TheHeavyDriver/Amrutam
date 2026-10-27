export interface UserProfile {
  id: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin';
  status: 'pending' | 'active' | 'suspended' | 'deleted';
  emailVerifiedAt: string | null;
  mfaEnabled: boolean;
  fullName: string;
  dateOfBirth: string | null;
  phone: string | null;
  gender: 'female' | 'male' | 'non_binary' | 'prefer_not_to_say' | null;
  locale: string;
  timezone: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
