FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY db.py handlers.py fargate_worker.py ./
# ADR-029+036 remediation P2-code executor (Fargate path). Same image; the SFN command selects the
# module (`python remediation_executor_cli.py --job-id X --action Y`). Docker COPY cannot reach a
# parent of the build context (scripts/v2/workers/), so workers.mjs does a pre-build `cp` of these 3
# remediation modules into this dir (gated on the files existing) — approach (b) per the plan, chosen
# to avoid disturbing the GREEN worker image build context. The COPY is a no-op unless they're present.
COPY action_catalog.py remediation_executor.py remediation_executor_cli.py ./
# CMD (not ENTRYPOINT): the SFN ContainerOverrides command REPLACES CMD but is APPENDED to an
# ENTRYPOINT. With ENTRYPOINT the effective argv would double ("python fargate_worker.py python
# fargate_worker.py --job-id X") and argparse would reject the extra positionals → every Fargate
# job fails to launch. Using CMD makes the ASL command (full argv incl. --job-id/--oom) the single
# source of truth. The default below is just a sane manual-run target.
CMD ["python", "fargate_worker.py"]
