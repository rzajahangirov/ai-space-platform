#!/bin/bash
# Runs once when the primary's data directory is created: a replication role and pg_hba entry for the
# read replica (service "db-replica").
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
