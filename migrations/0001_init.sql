-- Initial placeholder migration to verify database connectivity.
CREATE TABLE IF NOT EXISTS migration_probe (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

