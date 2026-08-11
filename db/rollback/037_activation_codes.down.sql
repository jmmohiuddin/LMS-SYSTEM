-- Rollback for 037 — fallback activation (F-202).
--
-- Removes the only working first-login path while OTP stays dark behind
-- the aggregator negotiation. After this, nobody who is not already
-- signed in can sign in. Roll back only if 037 itself is broken.
--
-- Sessions already minted through activation survive: they live in
-- user_sessions and never referenced this table.
BEGIN;
DROP TABLE IF EXISTS activation_codes;
COMMIT;
