# Pinned to bookworm (Debian 12): playwright recognizes it and `install --with-deps` pulls the
# correct Debian chromium libs. The floating `python:3.12-slim` rolled to Debian trixie (13), which
# playwright doesn't recognize → it falls back to Ubuntu packages (ttf-unifont/ttf-ubuntu-font-family)
# absent on Debian → the browser install fails.
FROM python:3.12-slim-bookworm
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# AI Diagnosis PDF export: the `report` job renders the report markdown to PDF via headless chromium
# (playwright, in requirements). `--with-deps chromium` pulls chromium + its apt system libraries;
# fonts-noto-cjk makes Korean render (without a CJK font chromium prints tofu/□). arm64.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && python -m playwright install --with-deps chromium \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY db.py handlers.py fargate_worker.py ./
# ADR-029+036 remediation P2-code executor (Fargate path). Same image; the SFN command selects the
# module (`python remediation_executor_cli.py --job-id X --action Y`). Docker COPY cannot reach a
# parent of the build context (scripts/v2/workers/), so workers.mjs does a pre-build `cp` of these 3
# remediation modules into this dir (gated on the files existing) — approach (b) per the plan, chosen
# to avoid disturbing the GREEN worker image build context. The COPY is a no-op unless they're present.
COPY action_catalog.py remediation_executor.py remediation_executor_cli.py ./
# AI Diagnosis (Plan 1): the `report` handler imports the diagnosis package (sources/sections/
# report/db). Ship it in the worker image so handlers.REGISTRY["report"] resolves at runtime.
COPY diagnosis/ ./diagnosis/
# CMD (not ENTRYPOINT): the SFN ContainerOverrides command REPLACES CMD but is APPENDED to an
# ENTRYPOINT. With ENTRYPOINT the effective argv would double ("python fargate_worker.py python
# fargate_worker.py --job-id X") and argparse would reject the extra positionals → every Fargate
# job fails to launch. Using CMD makes the ASL command (full argv incl. --job-id/--oom) the single
# source of truth. The default below is just a sane manual-run target.
CMD ["python", "fargate_worker.py"]
