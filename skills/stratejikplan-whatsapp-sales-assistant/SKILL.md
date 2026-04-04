---
name: stratejikplan-whatsapp-sales-assistant
description: Maintain, extend, or debug the StratejikPlan live WhatsApp sales assistant running on Railway with Node/Express, PostgreSQL, Groq intent parsing, Meta Webhooks, and optional n8n artifacts. Use when Codex needs to work on WhatsApp Cloud API messaging flows, Railway deployment, live webhook verification, Groq-backed sales query parsing, Meta app setup pages, privacy/data-deletion endpoints, or tractor sales question handling such as single-brand yearly totals and two-brand yearly comparisons.
---

# StratejikPlan WhatsApp Sales Assistant

Use this skill when working on the live StratejikPlan WhatsApp assistant.

## Start Here

Inspect these files first:

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

## Production Surface

Do not break these public routes without replacing them everywhere they are referenced:

- `/api/public/assistant/sales-query`
- `/api/public/whatsapp/webhook`
- `/privacy-policy`
- `/terms-of-service`
- `/data-deletion`
- `/api/public/meta/data-deletion`

## Working Pattern

Follow this order:

1. Inspect the current Express route, helper, and deployment context.
2. Decide whether the change belongs in direct app logic, Meta setup support pages, or the optional n8n workflow artifact.
3. Prefer extending shared helpers such as query resolution before adding new ad hoc route logic.
4. Keep WhatsApp webhook handling fast: acknowledge promptly, then process and reply safely.
5. Validate syntax locally with `node --check server.js`.
6. If the linked Railway project is available, verify variables or deploys with Railway CLI.
7. Re-test the live webhook or sales-query endpoint after deploy when the task touches production behavior.

## Railway and Meta Guidance

- Use Railway CLI only against the linked project/service already attached to this repo.
- Expect the live app URL to be on Railway and the Meta app to point its callback there.
- If WhatsApp stops responding, check in this order: app mode, webhook verification, `messages` subscription, WhatsApp token validity, then Railway logs.
- If Railway free-plan limits block a dedicated n8n service, keep the direct webhook path working inside `server.js`.

## Validation

Use the lightest validation that proves the change:

- `node --check server.js`
- Route smoke tests for `/api/public/assistant/sales-query`
- Webhook verification test for `/api/public/whatsapp/webhook`
- Railway deploy/log inspection only when the change affects live behavior

## Avoid

- Moving the live WhatsApp path back to n8n-only operation without confirming hosting capacity.
- Replacing SQL-backed answers with free-form LLM output.
- Storing access tokens in skill files or reference docs.
- Changing public URLs in Meta-facing settings without updating the live app and verification flow together.
