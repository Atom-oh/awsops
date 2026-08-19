import { NextResponse } from 'next/server';

/**
 * Fail-closed gate shared by every Network Path Check route. NETWORK_PATH_CHECK_ENABLED is set on
 * the web task ONLY when `network_path_check_enabled=true` in Terraform
 * (terraform/v2/foundation/network-path.tf's local.npc) — off (the default) means no worker
 * capability exists to ever process a `network_path` job, so every route here 503s instead of
 * silently enqueuing a job nothing will process (mirrors the steampipe_enabled-gated routes'
 * "flag off -> unconfigured" contract, e.g. app/api/compliance/run and app/api/sg/rules/refresh).
 */
export function networkPathCheckGate(): NextResponse | null {
  if (process.env.NETWORK_PATH_CHECK_ENABLED !== 'true') {
    return NextResponse.json(
      { status: 'unconfigured', message: 'network path check is disabled' },
      { status: 503 },
    );
  }
  return null;
}
