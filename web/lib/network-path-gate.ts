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

/**
 * Capability probe (L2 finding #3, round 2): `scripts/v2/workers/network_path.py`'s
 * `fetch_live_topology()` is not implemented in this release — it unconditionally raises
 * `NotImplementedError`, so every enabled, non-fixture-driven Network Path run deterministically
 * ends `failed`. Rather than ship a feature that is guaranteed to fail once enabled, this route
 * refuses to create a NEW run at all while the capability is absent — existing checks/definitions
 * and prior run history remain fully viewable (this only blocks `createRun`, per the design
 * discussion in the round-2 report). Flip `LIVE_TOPOLOGY_IMPLEMENTED` to `true` in the SAME commit
 * that gives `fetch_live_topology()` a real implementation — this is a code-level fact, not an
 * environment toggle, so it is not read from `process.env`.
 */
const LIVE_TOPOLOGY_IMPLEMENTED = false;

export function networkPathLiveTopologyCapabilityGate(): NextResponse | null {
  if (!LIVE_TOPOLOGY_IMPLEMENTED) {
    return NextResponse.json(
      {
        status: 'unimplemented',
        message: 'Network Path Check cannot start a new run yet — live topology discovery ' +
          '(fetch_live_topology) is not implemented in this release. Existing checks and prior ' +
          'run history remain viewable.',
      },
      { status: 503 },
    );
  }
  return null;
}
