---
sidebar_position: 1
---

import Screenshot from '@site/src/components/Screenshot';

# IAM

The IAM (Identity and Access Management) page allows you to view and manage users, roles, and policies in your AWS account at a glance.

<Screenshot src="/screenshots/security/iam.png" alt="IAM" />

## Key Features

### Summary Statistics

At the top of the page, you can view the IAM resource status:

- **Users**: Total number of IAM users
- **Roles**: Total number of IAM roles
- **Custom Policies**: Number of customer-managed policies
- **MFA Not Enabled**: Number of users without MFA enabled

:::caution Known limitation — the MFA count is always 0
The `summary` query (`src/lib/queries/iam.ts`) **hardcodes `0 AS mfa_not_enabled`** — it never actually aggregates MFA status. The warning banner and the pie chart below both depend on this value, so today they always render as "no warning" and "100% enabled" respectively. This is deliberate, not an oversight: `mfa_enabled` is a Steampipe **hydrate column** (it requires an `iam:ListMFADevices` call), so in an org where an SCP blocks that API, including it in a query causes a **column-hydrate error** (not a table-level error) that `ignore_error_codes` cannot suppress — the whole query fails. v1 left the value blank to avoid that risk. v2 (`web/lib/inventory-types.ts`, reading `inventory_resources.mfa_enabled` from a pre-synced batch snapshot rather than a live per-request call) actually resolves this the right way.
:::

### MFA Status Chart

A pie chart visualizes the MFA enablement status:

- **Green**: Users with MFA enabled
- **Red**: Users without MFA enabled

See "Known limitation" above — since `mfa_not_enabled` is always 0, this chart currently always renders as 100% green (fully enabled).

## IAM Users List

Displays all IAM users in a table format:

| Column | Description |
|--------|-------------|
| Username | User name |
| User ID | Unique ID assigned by AWS |
| Created | User creation date |
| Password Last Used | Last password usage date (console login) |

### User Details

Click a user in the table to view detailed information in a slide panel:

- Username, ID, ARN
- Path
- Creation date and last password usage date
- Tag information

## IAM Roles List

Displays all IAM roles in a table format:

| Column | Description |
|--------|-------------|
| Role Name | Role name |
| Role ID | Unique ID assigned by AWS |
| Path | Role path |
| Description | Role description |
| Created | Role creation date |
| Max Session | Maximum session duration |

### Role Details

Click a role in the table to view detailed information:

**Basic Information**
- Role name, ID, ARN, path
- Description and creation date
- Maximum session duration
- Permissions Boundary ARN

**Last Used Information**
- Last used date and time
- Last used region

**Instance Profiles**
- List of attached instance profile ARNs

**Trust Policy**
- Displays `AssumeRolePolicyDocument` in JSON format
- Shows which entities (services, accounts, users) can assume this role

:::info Trust Policy Analysis
The trust policy defines the principals that can assume the role. Check the `Principal` field for allowed services, account IDs, and user ARNs.
:::

## Data Refresh

Click the refresh button in the upper right corner to invalidate the cache and fetch the latest data.

:::tip Cache Policy
IAM data is cached for 5 minutes. Use the refresh button if you need immediate updates.
:::
