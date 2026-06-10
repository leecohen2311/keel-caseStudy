-- Runs once at first Postgres boot (docker-entrypoint-initdb.d), as the
-- superuser. Three roles: app_owner owns the schema and runs migrations and
-- seed; app_ingest and app_ledger are the least-privilege runtime roles whose
-- table grants land with the schema migrations.
CREATE ROLE app_owner LOGIN PASSWORD 'owner_pw_dev';
CREATE ROLE app_ingest LOGIN PASSWORD 'ingest_pw_dev';
CREATE ROLE app_ledger LOGIN PASSWORD 'ledger_pw_dev';

-- app_owner owns the database; on PG15+ that makes it the owner of schema
-- public, so the runtime roles get no CREATE there by default.
CREATE DATABASE billing OWNER app_owner;
