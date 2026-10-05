---
name: stratejikplan-whatsapp-sales-assistant
description: Maintain, extend, or debug the StratejikPlan live WhatsApp sales assistant running on Railway with Node/Express, PostgreSQL, Groq intent parsing, Meta Webhooks, and optional n8n artifacts. Use when Codex needs to work on WhatsApp Cloud API messaging flows, Railway deployment, live webhook verification, Groq-backed sales query parsing, Meta app setup pages, privacy/data-deletion endpoints, or tractor sales question handling such as single-brand yearly totals and two-brand yearly comparisons.
---

# StratejikPlan WhatsApp Sales Assistant

Use this skill when working on the live StratejikPlan WhatsApp assistant.

## Start Here

Inspect these files first:

- `src/routes/public.js` (webhook and sales-query routes)
- `src/lib/whatsapp-approval.js`
- `server.js`
- `railway.json`
- `docker-compose.yml`
- `WHATSAPP_N8N_SETUP.md`
- `n8n-workflows/whatsapp-sales-assistant.json`

Read `references/live-context.md` before changing production endpoints, Meta setup pages, or Railway deployment behavior.

## Core Rules

- Treat Railway-hosted `server.js` as the live source of truth.
- Treat `n8n-workflows/whatsapp-sales-assistant.json` as an optional workflow artifact, not the only production path.
- Preserve deterministic database answers after AI intent parsing. Use Groq to classify and structure the request, then answer from PostgreSQL.
- Keep public production endpoints stable unless there is a migration plan.
- Never hardcode new secrets in tracked files. Prefer Railway variables and document placeholders only.
- Preserve Turkish tractor-sales use cases first: single-brand yearly totals and two-brand yearly comparisons.
- The assistant answers **only approved numbers** (see "Security and Approval Gate" below). Never bypass `checkWhatsappAuthorization` in a new reply path.
- Never log phone numbers or message text; use `last4()` / `maskPhone()` from `src/lib/whatsapp-approval.js`.

## Production Surface

Do not break these public routes without replacing them everywhere they are referenced:

- `/api/public/assistant/sales-query`
- `/api/public/whatsapp/webhook`
- `/privacy-policy`
- `/terms-of-service`
- `/data-deletion`
- `/api/public/meta/data-deletion`

## Security and Approval Gate (Ekim 2026)

Authoritative detail: `../guvenlik-anayasasi/SKILL.md` section 8 and `../abonelik-odeme-anayasasi/SKILL.md` section 5. Routes live in `src/routes/public.js` (the old `server.js`-only layout no longer applies; `server.js` keeps the Graph API sender `sendWhatsAppTextMessage`).

- **Signature is mandatory.** `POST /api/public/whatsapp/webhook` verifies `X-Hub-Signature-256` (HMAC-SHA256 over the raw body) with `WHATSAPP_APP_SECRET`. In production (`isProduction()`), a missing `WHATSAPP_APP_SECRET` makes the webhook answer `503`. In development a missing secret only logs a warning.
- **GET verification** needs `WHATSAPP_VERIFY_TOKEN`; an empty configured token never matches (403).
- **Approved-number gate** (`checkWhatsappAuthorization`, `src/lib/whatsapp-approval.js`): the sender must be registered in `whatsapp_phones`, `admin_approved`, phone active, user active, e-mail verified, and (non-admin) have an active/trialing subscription whose plan has `whatsapp_phones` > 0. Otherwise the webhook silently ignores the message and `sales-query` returns `403` (`Numara onaylı değil`); the LLM/SQL chain is not run.
- **Admin approval API** (`adminOnly`): `GET /api/admin/whatsapp-phones?status=pending|approved`, `POST /api/admin/whatsapp-phones/:id/approve`, `POST /api/admin/whatsapp-phones/:id/reject`. A user adding a number (`POST /api/billing/whatsapp`) gets `approval: 'pending'`. Existing numbers were reset to unapproved by migration `007_whatsapp_approval.sql`; admins re-approve them.
- **Log masking:** logs carry only `son4=<last 4 digits>`, message length and a reason code. No full numbers, no message bodies.
- **Internal query route:** `POST /api/public/assistant/sales-query` requires `x-query-token` = `WHATSAPP_QUERY_API_KEY` (503 if unset, 401 if wrong), `question` string <= 1000 chars. If the caller (n8n) sends `from`, the approval gate applies; with no `from` (legacy callers) the old behaviour is kept.
- **Environment variables read by the app:** `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_QUERY_API_KEY`, `WHATSAPP_GRAPH_API_BASE` (optional, default `https://graph.facebook.com/v21.0`; tests point it at a fake local Graph server), `N8N_WHATSAPP_PROCESSOR_URL`. `WHATSAPP_BUSINESS_ACCOUNT_ID` is only used on the n8n side.
- Tests: `tests/whatsapp-approval.test.js`, `tests/security.test.js` (signature), `tests/security-regressions.test.js` (empty verify token, production 503).

## Working Pattern

Follow this order:

1. Inspect the current Express route, helper, and deployment context.
2. Decide whether the change belongs in direct app logic, Meta setup support pages, or the optional n8n workflow artifact.
3. Prefer extending shared helpers such as query resolution before adding new ad hoc route logic.
4. Keep WhatsApp webhook handling fast: acknowledge promptly, then process and reply safely.
5. Validate locally: `npm run lint:syntax`, `npm run lint:undef`, and `npm test` with `TEST_DATABASE_URL` set (DB tests are skipped otherwise).
6. If the linked Railway project is available, verify variables or deploys with Railway CLI.
7. Re-test the live webhook or sales-query endpoint after deploy when the task touches production behavior.

## Railway and Meta Guidance

- Use Railway CLI only against the linked project/service already attached to this repo.
- Expect the live app URL to be on Railway and the Meta app to point its callback there.
- If WhatsApp stops responding, check in this order: app mode, webhook verification, `messages` subscription, WhatsApp token validity, then Railway logs.
- If Railway free-plan limits block a dedicated n8n service, keep the direct webhook path working inside `server.js`.

## Validation

Use the lightest validation that proves the change:

- `npm run lint:syntax` and `npm test` (DB-backed, includes `tests/whatsapp-approval.test.js`)
- Route smoke tests for `/api/public/assistant/sales-query`
- Webhook verification test for `/api/public/whatsapp/webhook`
- Railway deploy/log inspection only when the change affects live behavior

## Avoid

- Moving the live WhatsApp path back to n8n-only operation without confirming hosting capacity.
- Replacing SQL-backed answers with free-form LLM output.
- Storing access tokens in skill files or reference docs.
- Replying to a number that has not passed the approval gate, or logging full phone numbers / message text.
- Changing public URLs in Meta-facing settings without updating the live app and verification flow together.
