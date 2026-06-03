FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY db.py handlers.py fargate_worker.py ./
# CMD (not ENTRYPOINT): the SFN ContainerOverrides command REPLACES CMD but is APPENDED to an
# ENTRYPOINT. With ENTRYPOINT the effective argv would double ("python fargate_worker.py python
# fargate_worker.py --job-id X") and argparse would reject the extra positionals → every Fargate
# job fails to launch. Using CMD makes the ASL command (full argv incl. --job-id/--oom) the single
# source of truth. The default below is just a sane manual-run target.
CMD ["python", "fargate_worker.py"]
