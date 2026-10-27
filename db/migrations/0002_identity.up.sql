CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');
CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');
CREATE TYPE doctor_verification_status AS ENUM ('pending', 'verified', 'rejected', 'suspended');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  email citext NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  status user_status NOT NULL DEFAULT 'pending',
  email_verified_at timestamptz,
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret_encrypted text,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_password_hash_present CHECK (btrim(password_hash) <> ''),
  CONSTRAINT users_failed_login_attempts_non_negative CHECK (failed_login_attempts >= 0),
  -- Privileged accounts cannot be active without MFA material in place.
  CONSTRAINT users_privileged_active_require_mfa CHECK (
    status <> 'active'
    OR role = 'patient'
    OR (mfa_enabled AND mfa_secret_encrypted IS NOT NULL)
  )
);

CREATE INDEX users_role_status_idx ON users (role, status);
CREATE INDEX users_locked_until_idx ON users (locked_until) WHERE locked_until IS NOT NULL;

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  full_name text NOT NULL,
  date_of_birth date,
  phone text,
  gender text,
  locale text NOT NULL DEFAULT 'en-IN',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_full_name_present CHECK (btrim(full_name) <> ''),
  CONSTRAINT profiles_phone_unique UNIQUE (phone),
  CONSTRAINT profiles_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT profiles_gender_valid CHECK (
    gender IS NULL OR gender IN ('female', 'male', 'non_binary', 'prefer_not_to_say')
  )
);

CREATE INDEX profiles_full_name_trgm_idx ON profiles USING gin (full_name gin_trgm_ops);

CREATE TABLE doctors (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  license_number text NOT NULL,
  specialization text NOT NULL,
  sub_specialties text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{en}',
  years_experience smallint NOT NULL DEFAULT 0,
  consultation_fee_cents integer NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  consultation_duration_minutes smallint NOT NULL DEFAULT 30,
  city text,
  country_code char(2),
  bio text,
  verification_status doctor_verification_status NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  verified_by uuid REFERENCES users (id) ON DELETE SET NULL,
  rating numeric(3, 2) NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  accepting_new_patients boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doctors_license_number_unique UNIQUE (license_number),
  CONSTRAINT doctors_license_number_present CHECK (btrim(license_number) <> ''),
  CONSTRAINT doctors_specialization_present CHECK (btrim(specialization) <> ''),
  CONSTRAINT doctors_experience_range CHECK (years_experience BETWEEN 0 AND 80),
  CONSTRAINT doctors_fee_range CHECK (consultation_fee_cents BETWEEN 0 AND 10000000),
  CONSTRAINT doctors_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT doctors_duration_range CHECK (consultation_duration_minutes BETWEEN 5 AND 120),
  CONSTRAINT doctors_country_code_valid CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT doctors_rating_range CHECK (rating BETWEEN 0 AND 5),
  CONSTRAINT doctors_rating_count_non_negative CHECK (rating_count >= 0),
  CONSTRAINT doctors_verified_consistency CHECK (
    verification_status <> 'verified' OR verified_at IS NOT NULL
  ),
  CONSTRAINT doctors_timezone_present CHECK (btrim(timezone) <> '')
);

CREATE INDEX doctors_search_idx
  ON doctors (verification_status, specialization, consultation_fee_cents);
CREATE INDEX doctors_languages_idx ON doctors USING gin (languages);
CREATE INDEX doctors_sub_specialties_idx ON doctors USING gin (sub_specialties);
CREATE INDEX doctors_specialization_trgm_idx ON doctors USING gin (specialization gin_trgm_ops);
CREATE INDEX doctors_city_idx ON doctors (lower(city)) WHERE city IS NOT NULL;
CREATE INDEX doctors_rating_idx
  ON doctors (rating DESC, rating_count DESC)
  WHERE verification_status = 'verified' AND accepting_new_patients;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER profiles_set_updated_at
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER doctors_set_updated_at
BEFORE UPDATE ON doctors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
