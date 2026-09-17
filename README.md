# NestBoot

A NestJS base whose only opinion is **operability**.

Every job, workflow, schedule, log, error, request and security event is
visible — and controllable — from one `/ops` console served by the app itself,
over the app's own Postgres. No extra services, no dashboard to deploy.

Read `CLAUDE.md` for how to work in it, and `BLUEPRINT.md` for why it is built
this way and what was deliberately left out.

## Start

```bash
nvm use                       # Node 22
pnpm install
docker compose up -d          # Postgres on 5443: the app and ops databases
cp .env.example .env
pnpm migrate
pnpm dev
```

- API — http://localhost:3000
- Console — http://localhost:3000/ops
- Health — http://localhost:3000/health

Set `OPS_PASSWORD` in `.env` (16+ characters) to create the first operator
account; enrol TOTP on first sign-in, then remove it from the environment.

## Build something

```bash
pnpm boot:feature invoicing
pnpm boot:action invoicing CreateInvoice --http
# make the generated failing test pass
pnpm verify
```

## Verify

```bash
pnpm verify     # biome · tsc · dependency-cruiser · vitest (real Postgres)
```

That is the definition of done, and it is what CI runs.

## Deploy

One image, two roles. `ROLE=web` serves HTTP and cannot execute a workflow;
`ROLE=worker` executes workflows and serves no HTTP. Run the migrations as a
release step, then roll web, then roll workers.

```
pnpm migrate           # both databases; safe to run repeatedly
ROLE=web    node dist/src/main.js
ROLE=worker node dist/src/main.js
```
