# Fuel Station Manager — production container image
#
# Build:  docker build -t fuel-station-manager .
# Run:    docker run -p 8000:8000 \
#           -e SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_hex(32))") \
#           -e FLASK_ENV=production \
#           -v fsm-data:/data \
#           -e DATABASE_PATH=/data/dealer.db \
#           fuel-station-manager
#
# The image runs as a non-root user and serves the app with gunicorn behind
# whatever reverse proxy / load balancer terminates TLS in front of it.

FROM python:3.12-slim

# Faster, quieter, more predictable Python behavior in containers
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Persistent-looking default location for the SQLite file inside the
# container; mount a volume at /data (or set DATABASE_PATH) for real
# persistence — the container filesystem itself is ephemeral.
RUN mkdir -p /data instance \
    && useradd --create-home --uid 1000 appuser \
    && chown -R appuser:appuser /app /data
USER appuser

ENV PORT=8000 \
    FLASK_ENV=production
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/healthz', timeout=3)" || exit 1

CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "60"]
