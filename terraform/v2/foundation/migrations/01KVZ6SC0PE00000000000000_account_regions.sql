-- Account-region scan targets for the app-wide Scope Selector.
-- Read-only metadata only: adding a region broadens future inventory reads/syncs, but
-- does not mutate AWS resources or enable any remediation/autonomous path.

CREATE TABLE IF NOT EXISTS account_regions (
  account_id  text        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  region      text        NOT NULL CHECK (region ~ '^[a-z]{2}-[a-z]+-[0-9]+$'),
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, region)
);

CREATE INDEX IF NOT EXISTS idx_account_regions_enabled ON account_regions(account_id, enabled);

INSERT INTO account_regions (account_id, region, enabled)
SELECT account_id, region, true
  FROM accounts
 WHERE region <> ''
ON CONFLICT (account_id, region) DO UPDATE SET enabled = true, updated_at = now();
