---
name: stratejikplan-railway-runtime-alignment
description: Verify and enforce deployment truth between local Docker assets and the real Railway runtime for StratejikPlan. Use when Codex must decide whether n8n, app, workers, or other services truly exist on Railway; when adding a missing Railway service; when preventing "local var / repo var / live var" confusion; or when documenting whether a Docker-defined component is only local, deployable, or actually running in production.
---

# StratejikPlan Railway Runtime Alignment

Use this skill when the task is about Docker portability, Railway service topology, or n8n deployment reality.

Read `references/runtime-reality-checklist.md` before making claims about what is live.

## Why This Skill Exists

In this project, a component can exist in three different states:

1. Defined in the repo
2. Runnable locally with Docker
3. Actually deployed and reachable on Railway

Do not treat these as equivalent.

## Core Rules

- Never say a service is "installed", "ready", or "running on Railway" unless Railway confirms it.
- A `docker-compose.yml` entry is not proof that the same service exists in Railway.
- An `n8n-workflows/*.json` file is only an artifact until a real n8n runtime imports and activates it.
- Before claiming production parity, verify the actual Railway service list, deployment status, public URL, and runtime logs.
- If Railway cannot host a separate n8n service, explicitly state that production is using a direct-app fallback instead of n8n.

## Required Distinctions

When reporting status, classify each component as one of these:

- `repo-only`
- `local-docker-ready`
- `railway-configured`
- `railway-live`

Use the most conservative label that is true.

## Working Pattern

1. Inspect repo artifacts: `docker-compose.yml`, `railway.json`, workflow files, and app routes.
2. Inspect the real Railway project/service state.
3. Compare local topology vs Railway topology.
4. Identify gaps:
   - defined locally but not deployed
   - deployed but misconfigured
   - deployed without public webhook
   - workflow file exists but not imported
5. Only after the gap is named, choose the path:
   - add a real Railway service
   - keep direct app fallback
   - document that n8n is optional and not live
6. Validate with live status and route checks after changes.

## n8n-Specific Rules

If the requirement is "n8n must be inside Railway", confirm all of the following before marking complete:

- a dedicated Railway service exists for n8n, or there is an explicit approved same-container strategy
- n8n has persistent storage or a clear persistence plan
- n8n public/webhook URL is known
- required env vars are present
- the workflow is imported
- the workflow is active
- the webhook path matches Meta or caller configuration

If any item is missing, do not describe Railway n8n as complete.

If the user expects a platform-style n8n experience like a separate Railway tile and its own `/home/workflows` UI, do not replace that requirement with an embedded app-container n8n workaround. Either provision the real dedicated service, or stop and report the exact Railway quota/blocker.

If Railway free-plan resource limits prevent creating the dedicated `n8n` service, prefer these actions in order:

1. inventory services and volumes
2. remove unused workaround resources if safe
3. retry real service creation
4. if still blocked, report the blocker plainly and do not call the workaround "equivalent"

## Validation

Prefer these checks:

- `node --check server.js`
- `docker compose config`
- `railway status`
- `railway service status`
- `railway logs --latest --lines 40`
- live route smoke tests for webhook and assistant endpoints

## Avoid

- Assuming Docker portability means automatic Railway provisioning
- Confusing "can be deployed" with "is deployed"
- Leaving the user with an ambiguous architecture description
- Calling an n8n workflow "production" when only the JSON file exists
