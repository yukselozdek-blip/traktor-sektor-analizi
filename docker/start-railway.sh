#!/usr/bin/env bash
set -euo pipefail

if [[ "${RAILWAY_ENABLE_EMBEDDED_N8N:-false}" != "true" ]]; then
  exec npm start
fi

EXTERNAL_PORT="${PORT:-3000}"
APP_INTERNAL_PORT="${APP_INTERNAL_PORT:-3001}"
N8N_INTERNAL_PORT="${EMBEDDED_N8N_PORT:-5678}"
N8N_PUBLIC_PATH="${N8N_PUBLIC_PATH:-/n8n}"
APP_BASE_URL_CLEAN="${APP_BASE_URL%/}"

if [[ -z "${APP_BASE_URL_CLEAN}" ]]; then
  echo "APP_BASE_URL is required when RAILWAY_ENABLE_EMBEDDED_N8N=true" >&2
  exit 1
fi

if [[ "${N8N_PUBLIC_PATH}" != /* ]]; then
  N8N_PUBLIC_PATH="/${N8N_PUBLIC_PATH}"
fi

if [[ "${N8N_PUBLIC_PATH}" == */ && "${N8N_PUBLIC_PATH}" != "/" ]]; then
  N8N_PUBLIC_PATH="${N8N_PUBLIC_PATH%/}"
fi

export N8N_BASIC_AUTH_ACTIVE="${N8N_BASIC_AUTH_ACTIVE:-true}"
export N8N_BASIC_AUTH_USER="${N8N_BASIC_AUTH_USER:-admin}"
export N8N_BASIC_AUTH_PASSWORD="${N8N_BASIC_AUTH_PASSWORD:-n8n2024secure}"
export N8N_HOST="127.0.0.1"
export N8N_PORT="${N8N_INTERNAL_PORT}"
export N8N_PROTOCOL="${N8N_PROTOCOL:-https}"
export N8N_PATH="${N8N_PUBLIC_PATH}/"
export N8N_EDITOR_BASE_URL="${N8N_EDITOR_BASE_URL:-${APP_BASE_URL_CLEAN}${N8N_PUBLIC_PATH}/}"
export WEBHOOK_URL="${WEBHOOK_URL:-${APP_BASE_URL_CLEAN}${N8N_PUBLIC_PATH}/}"
export N8N_SECURE_COOKIE="${N8N_SECURE_COOKIE:-true}"
export N8N_DIAGNOSTICS_ENABLED="${N8N_DIAGNOSTICS_ENABLED:-false}"
export N8N_HIRING_BANNER_ENABLED="${N8N_HIRING_BANNER_ENABLED:-false}"
export N8N_USER_FOLDER="${N8N_USER_FOLDER:-/data}"
export GENERIC_TIMEZONE="${GENERIC_TIMEZONE:-Europe/Istanbul}"
export TZ="${TZ:-Europe/Istanbul}"

cat > /etc/nginx/conf.d/default.conf <<EOF
server {
    listen ${EXTERNAL_PORT};
    server_name _;
    client_max_body_size 20m;

    access_log /dev/stdout;
    error_log /dev/stderr warn;

    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";

    location = ${N8N_PUBLIC_PATH} {
        return 301 ${N8N_PUBLIC_PATH}/;
    }

    location ${N8N_PUBLIC_PATH}/ {
        proxy_pass http://127.0.0.1:${N8N_INTERNAL_PORT};
        proxy_read_timeout 300s;
    }

    location /webhook/ {
        proxy_pass http://127.0.0.1:${N8N_INTERNAL_PORT};
        proxy_read_timeout 300s;
    }

    location /webhook-test/ {
        proxy_pass http://127.0.0.1:${N8N_INTERNAL_PORT};
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_INTERNAL_PORT};
        proxy_read_timeout 300s;
    }
}
EOF

PORT="${APP_INTERNAL_PORT}" npm start &
APP_PID=$!

n8n start &
N8N_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

cleanup() {
  kill "${APP_PID}" "${N8N_PID}" "${NGINX_PID}" 2>/dev/null || true
}

trap cleanup TERM INT EXIT

wait -n "${APP_PID}" "${N8N_PID}" "${NGINX_PID}"
STATUS=$?
cleanup
wait || true
exit "${STATUS}"
