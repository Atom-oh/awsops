# Multi-account setup

Use [onboard-target-account.md](onboard-target-account.md) for current v2 onboarding.
The former EC2 Steampipe aggregator procedure is retired and is available in git
history. Target trust must cover only the host roles needed by the selected read
paths. Registering an account does not authorize application-side AWS mutation.

First-party ExternalId omission must be explicit; third-party/shared accounts require
an ExternalId. The host account uses its execution-role credentials directly.
See [ADR-011](../decisions/011-multi-account.md).
