BEGIN;
DROP FUNCTION IF EXISTS app.provision_tenant(uuid, text, date, date, smallint, smallint);
DROP TABLE IF EXISTS period_template_defaults CASCADE;
DROP TABLE IF EXISTS subject_catalogue CASCADE;
COMMIT;
