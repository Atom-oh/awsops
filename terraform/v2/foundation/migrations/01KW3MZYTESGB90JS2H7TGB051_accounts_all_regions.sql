-- v1 all-region parity: a per-account flag meaning "scan every region" (Steampipe regions=["*"]).
-- A '*' value is invalid for account_regions.region (CHECK rejects it), so the flag lives on accounts.
-- Default true → a freshly-registered account scans all regions, matching v1 Steampipe regions=["*"].
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS all_regions boolean NOT NULL DEFAULT true;
