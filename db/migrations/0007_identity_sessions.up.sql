CREATE TYPE auth_token_type AS ENUM ('email_verification', 'password_reset');

-- A new TOTP seed can be enrolled while the current factor remains active.
ALTER TABLE users ADD COLUMN mfa_pending_secret_encrypted text;

-- A session is the revocation boundary. Access tokens reference its id, while
-- refresh tokens rotate within the session.
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT auth_sessions_revocation_reason_present CHECK (
    revoked_at IS NULL OR btrim(revoked_reason) <> ''
  )
);

CREATE INDEX auth_sessions_user_active_idx
  ON auth_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE auth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  session_id uuid NOT NULL REFERENCES auth_sessions (id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  replaced_by_token_id uuid REFERENCES auth_refresh_tokens (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_refresh_tokens_hash_hex CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_refresh_tokens_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT auth_refresh_tokens_rotation_consistent CHECK (
    (used_at IS NULL AND replaced_by_token_id IS NULL)
    OR used_at IS NOT NULL
  ),
  CONSTRAINT auth_refresh_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX auth_refresh_tokens_session_idx ON auth_refresh_tokens (session_id);
CREATE UNIQUE INDEX auth_refresh_tokens_one_active_idx
  ON auth_refresh_tokens (session_id)
  WHERE used_at IS NULL;

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_type auth_token_type NOT NULL,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_tokens_hash_hex CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_tokens_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT auth_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, token_type, created_at DESC);
CREATE UNIQUE INDEX auth_tokens_one_active_type_idx
  ON auth_tokens (user_id, token_type)
  WHERE used_at IS NULL;

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_recovery_codes_hash_hex CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mfa_recovery_codes_hash_unique UNIQUE (user_id, code_hash)
);

CREATE INDEX mfa_recovery_codes_active_idx
  ON mfa_recovery_codes (user_id, created_at)
  WHERE used_at IS NULL;
