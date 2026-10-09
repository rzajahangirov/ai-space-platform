#!/bin/bash
# Read replica: on first start, clone the primary with pg_basebackup (-R writes standby.signal and the
# connection settings), then run as a hot standby that streams WAL from the primary.
set -e
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup -h db -U replicator -D "$PGDATA" -R -X stream; do
    echo "Waiting for the primary..."
    sleep 2
  done
  chmod 700 "$PGDATA"
fi
exec postgres -c hot_standby=on -c max_connections=300
