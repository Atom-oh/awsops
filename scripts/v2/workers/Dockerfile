FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY db.py handlers.py fargate_worker.py ./
ENTRYPOINT ["python", "fargate_worker.py"]
