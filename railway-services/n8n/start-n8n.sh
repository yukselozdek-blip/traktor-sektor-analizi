#!/bin/sh
set -eu

N8N_USER_FOLDER="${N8N_USER_FOLDER:-/tmp/n8n}"
export N8N_USER_FOLDER

mkdir -p "$N8N_USER_FOLDER"

bootstrap_workflow() {
  workflow_id="$1"
  workflow_file="$2"

  if ! n8n list:workflow 2>/dev/null | grep -q "$workflow_id"; then
    echo "Bootstrapping $workflow_id from $workflow_file..."
    n8n import:workflow --input="$workflow_file" || true

    if n8n list:workflow 2>/dev/null | grep -q "$workflow_id"; then
      n8n update:workflow --id="$workflow_id" --active=true || true
      n8n publish:workflow --id="$workflow_id" || true
    fi
  else
    echo "Existing $workflow_id workflow found in database; skipping bootstrap import."
  fi
}

bootstrap_workflow "whatsapp-sales-assistant" "/bootstrap/whatsapp-sales-assistant.json"
bootstrap_workflow "whatsapp-sales-processor-v2" "/bootstrap/whatsapp-sales-processor.json"
bootstrap_workflow "whatsapp-sales-processor-v3" "/bootstrap/whatsapp-sales-processor-v3.json"
bootstrap_workflow "whatsapp-sales-processor-v4" "/bootstrap/whatsapp-sales-processor-v4.json"

exec n8n start
