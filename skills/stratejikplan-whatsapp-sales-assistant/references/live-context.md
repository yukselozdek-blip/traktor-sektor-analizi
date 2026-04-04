# Live Context

## Runtime Model

- Hosting: Railway
- App type: Node/Express backend with PostgreSQL
- AI layer: Groq intent parsing plus deterministic SQL answer generation
- Messaging layer: WhatsApp Cloud API via direct webhook routes in `server.js`
- Optional artifact: `n8n-workflows/whatsapp-sales-assistant.json`

## Live Behaviors

The production app currently supports:

- Single-brand yearly sales total queries
- Two-brand yearly comparison queries
- More conversational Turkish prompts through Groq-backed parsing
- Meta policy, terms, and data-deletion pages needed for app review / live mode

## Public URLs

- App base URL: `https://affectionate-blessing-production-f2fe.up.railway.app`
- Sales query route: `https://affectionate-blessing-production-f2fe.up.railway.app/api/public/assistant/sales-query`
- WhatsApp webhook route: `https://affectionate-blessing-production-f2fe.up.railway.app/api/public/whatsapp/webhook`
- Privacy policy: `https://affectionate-blessing-production-f2fe.up.railway.app/privacy-policy`
- Terms of service: `https://affectionate-blessing-production-f2fe.up.railway.app/terms-of-service`
- Data deletion callback: `https://affectionate-blessing-production-f2fe.up.railway.app/api/public/meta/data-deletion`

## Files That Matter Most

- `server.js`: live webhook, Groq parsing, helper functions, public policy pages
- `docker-compose.yml`: local/container parity and optional n8n wiring
- `.env.example`: placeholder environment contract
- `WHATSAPP_N8N_SETUP.md`: operational notes and fallback n8n design
- `n8n-workflows/whatsapp-sales-assistant.json`: optional importable workflow for future dedicated n8n hosting

## Expected Environment Variables

Do not store secrets in this skill. Expect these variables to exist in Railway or local runtime:

- `DATABASE_URL`
- `GROQ_API_KEY`
- `WHATSAPP_QUERY_API_KEY`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `APP_BASE_URL`

## Meta Checklist

When live WhatsApp delivery fails, inspect this order:

1. App mode is `Live`
2. Webhook product is `WhatsApp Business Account`
3. Callback URL points to `/api/public/whatsapp/webhook`
4. Verify token matches runtime configuration
5. `messages` field is subscribed
6. Access token is not expired
7. The business app is subscribed to the WABA

## Railway Checklist

Common commands when the linked Railway project is available:

- `railway status`
- `railway service status`
- `railway logs --latest --lines 40`
- `railway up -d -m "message"`

Use Railway variables for secrets. Avoid committing runtime tokens.
