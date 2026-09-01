// Gap L217: the request-estimate unit prices, exported so the estimator
// (lib/opencost-allocation.ts) and the /eks/cost Cost Calculation Basis panel share ONE
// source — the documented numbers can never drift from the computed ones.
// Fargate-style on-demand (ap-northeast-2). Spot/RI/Savings-Plans discounts NOT reflected.
export const ESTIMATE_UNIT_PRICES = {
  vcpuHour: 0.04656, // $/vCPU-hour
  gbHour: 0.00511,   // $/GB-hour (memory)
} as const;

/** Daily request-estimate for one pod (the estimator's exact formula, unit-testable). */
export function estimateDailyCost(vcpuRequest: number, memGb: number): number {
  return vcpuRequest * ESTIMATE_UNIT_PRICES.vcpuHour * 24 + memGb * ESTIMATE_UNIT_PRICES.gbHour * 24;
}
