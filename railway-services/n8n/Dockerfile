FROM n8nio/n8n:latest

USER root

COPY start-n8n.sh /bootstrap/start-n8n.sh
COPY whatsapp-sales-assistant.json /bootstrap/whatsapp-sales-assistant.json
COPY whatsapp-sales-processor.json /bootstrap/whatsapp-sales-processor.json
COPY whatsapp-sales-processor-v3.json /bootstrap/whatsapp-sales-processor-v3.json
COPY whatsapp-sales-processor-v4.json /bootstrap/whatsapp-sales-processor-v4.json

RUN chmod +x /bootstrap/start-n8n.sh

ENTRYPOINT ["/bootstrap/start-n8n.sh"]
