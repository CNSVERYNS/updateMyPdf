# updateMyPDF live architecture

## Recommended first production topology

```text
www.updatemypdf.com       -> existing Vercel project yunus-projeler/updatemypdf (Vite editor)
api.updatemypdf.com       -> Azure Container Apps (apps/api Docker image)
quality service           -> private Azure Container App (services/pdf-quality)
database and auth         -> Supabase PostgreSQL + Supabase Auth
document files            -> private Azure Blob Storage
translation               -> Azure Translator Document/Text Translation
AI review and assistant   -> OpenAI API, server-side only
email                     -> Resend
```

The developer laptop, PowerShell and local Docker are not part of this runtime. They are only used for development. The Docker images run on the cloud host after deployment.

The `infra/docker-compose.production.yml` file remains a self-hosted/VPS fallback. It includes its own PostgreSQL and Redis, so it must not be treated as the primary production database when Supabase is selected as the source of truth.

## Required deployment decisions

1. Use Supabase PostgreSQL for users, translation jobs, quality reports and usage records. Configure the API `DATABASE_URL` with the Supabase connection pooler or another production-safe connection string.
2. Keep uploaded and translated PDFs in private Azure Blob containers. Keep only metadata and short-lived download references in the database.
3. Deploy `apps/api` and `services/pdf-quality` as separate containers. The quality service should be private and reachable only by the API.
4. Use a durable worker or scheduled poller for long-running translations. An in-process `void` task can be interrupted by a container restart.
5. Put `ADMIN_API_SECRET` and `ADMIN_DASHBOARD_SESSION_SECRET` in the cloud secret store. Never put either value in `NEXT_PUBLIC_*` variables.

## DNS

For the current deployment:

- `www` points to the existing `yunus-projeler/updatemypdf` Vercel project, which is connected to `CNSVERYNS/updateMyPdf` on GitHub. Do not create a second primary Vercel project.
- `api` points to the Azure Container App custom domain.
- Resend's SPF, DKIM and DMARC records are added separately at the domain registrar.

The Next.js translation UI in `apps/web` is a deployable option, but it is not the
primary `www` deployment. The existing Vite editor still uses its legacy API
base URL until the `/api/pdf` and `/api/ai` compatibility path is migrated and
tested against the Azure translation API. Do not replace the current Vercel
environment variables with the Azure URL before that migration.

The exact Vercel and Azure target values must be copied from their respective dashboards; they are not hard-coded in this repository.

## Admin dashboard

The first dashboard is deliberately read-only for analytics, with server-side secret authentication at `/admin`. It reads:

- translation usage events recorded per job;
- provider cost snapshots for Azure/OpenAI/Vercel/Supabase/Resend;
- fixed business expenses such as domain and subscriptions.

Provider cost snapshots and per-job usage estimates are shown separately so the same provider bill is not counted twice. Stripe revenue events can be added later without changing the usage model.

## Current deployment status

The local `.env` contains the required server-side configuration and is excluded from source control. The Azure resource group now contains the Translator, private Blob Storage containers, an ACR registry, a Container Apps environment, a private PDF quality app, and a public translation API app. The API health and readiness endpoints return HTTP 200 and report real Azure storage with translation mock mode disabled.

The current Azure API hostname is `updatemypdf-api.graybay-8494ee2d.eastus.azurecontainerapps.io`. The DNS CNAME and `asuid.api` validation TXT record are configured, and the managed certificate is bound to `api.updatemypdf.com`. Both `https://api.updatemypdf.com/health` and `/ready` return HTTP 200. The existing `www.updatemypdf.com` record already points to the existing Vercel project, whose latest GitHub-triggered production deployment is Ready.
