DROP TABLE IF EXISTS mfa_recovery_codes;
DROP TABLE IF EXISTS auth_tokens;
DROP TABLE IF EXISTS auth_refresh_tokens;
DROP TABLE IF EXISTS auth_sessions;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_pending_secret_encrypted;
DROP TYPE IF EXISTS auth_token_type;
