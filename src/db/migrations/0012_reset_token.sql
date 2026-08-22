-- Add columns for password reset token and expiry
ALTER TABLE member_credentials ADD COLUMN resetTokenHash TEXT;
ALTER TABLE member_credentials ADD COLUMN resetExpiresAt INTEGER;