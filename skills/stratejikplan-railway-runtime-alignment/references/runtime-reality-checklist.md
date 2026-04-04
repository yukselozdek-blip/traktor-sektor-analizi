# Runtime Reality Checklist

## Deployment Truth Model

Use this checklist whenever the user asks whether something is really live on Railway.

### Local Docker truth

A service is only `local-docker-ready` when:

- it exists in `docker-compose.yml`
- the image/build target is defined
- required env vars are mapped
- it can be started locally

### Railway truth

A service is only `railway-live` when:

- the Railway project contains the service
- the latest deployment is `SUCCESS`
- logs show the runtime started cleanly
- the expected public route or webhook responds

## n8n Reality Test

For n8n, answer these in order:

1. Does a Railway service for n8n exist?
2. Is the latest deployment successful?
3. Does n8n have a reachable base URL?
4. Was the workflow imported?
5. Is the workflow active?
6. Does the caller webhook hit the live n8n URL?

If any answer is `no`, n8n is not fully live on Railway.

## Docker Portability Note

Docker helps package a workload so it can be run in another environment, but it does not itself create the target platform resources. Railway still needs:

- an actual service per containerized workload
- runtime variables
- storage/network exposure
- deployment execution

So "Docker exists in the repo" does not mean "the same topology exists on Railway".

## Recommended Language

Use these phrases:

- "Repo tarafinda hazir"
- "Yerelde Docker ile calisabilir"
- "Railway'e deploy edilmis degil"
- "Railway'de ayri servis olarak canli"
- "Su an production path dogrudan app icinde, n8n degil"

Avoid these phrases unless verified:

- "Railway'de kurulu"
- "Canlida hazir"
- "n8n aktif"
- "Production tamam"
