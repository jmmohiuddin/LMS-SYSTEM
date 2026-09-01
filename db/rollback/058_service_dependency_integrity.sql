-- Rollback for 058 — removes the catalogue integrity guard.
--
-- After this, `service_catalogue.depends_on` can name a service that does not
-- exist again. Nothing breaks loudly; the service-dependency refusal in
-- `setService` simply stops firing for that row, silently.
BEGIN;
DROP TRIGGER IF EXISTS service_dependencies_valid ON service_catalogue;
DROP FUNCTION IF EXISTS app.check_service_dependencies();
COMMIT;
