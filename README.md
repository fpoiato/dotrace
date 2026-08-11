# Dot Race (Vector Rally)

Turn-based vector racing party game — mobile-first Angular frontend, API Gateway WebSocket (push) + HTTP API (commands), host-authoritative ephemeral game state.

**Live:** [https://dotrace.fpoiato.com](https://dotrace.fpoiato.com)

## Monorepo layout

| Path | Purpose |
|------|---------|
| `frontend/dotrace-app` | Angular 19 + Tailwind 3.4 + ngx-translate (pt-BR / en) |
| `infra/cdk` | DynamoDB, WebSocket API, HTTP API (commands), Lambdas |
| `infra/terraform` | S3, CloudFront (OAC), ACM, Route53, CodePipeline |
| `shared/` | WebSocket + game types, rules and CPU planner (`ws-types.ts`, `tracks.ts`, `bot-ai.ts`) |
| `bot/` | Headless client that joins a room over the network and races |
| `pipeline/` | CodeBuild buildspec |
| `.github/workflows/` | CI/CD on push to `main` (`ci-cd.yml`) |

`shared/` is mirrored into `frontend/dotrace-app/src/app/core/models/` because the
Angular build cannot reach outside `src/`. After editing anything under `shared/`,
run `npm run shared:sync`; `npm test` fails if the two copies have drifted.

## Prerequisites

- Node.js 20+
- AWS CLI with profile `nandopoiato`
- Terraform ≥ 1.5
- AWS CDK CLI (`npm i -g aws-cdk`)

## Local development

```bash
# Install (uses public npm registry — see .npmrc)
unset NPM_TOKEN NODE_AUTH_TOKEN
npm ci

# Deploy backend (once) and note WebSocket URL
export AWS_PROFILE=nandopoiato
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-east-1
npm run cdk:deploy

# Set WS URL in frontend/dotrace-app/src/environments/environment.ts
npm start
```

Open `http://localhost:4200`.

## Deploy infrastructure

### 1. Terraform (static hosting + pipeline)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply -var-file=terraform.tfvars
```

Note outputs: `github_actions_role_arn`, `codepipeline_name`, S3 bucket, CloudFront ID (also in SSM).

### 2. GitHub access (one-time)

In the private repo `fpoiato/dotrace`, set:

- `AWS_ROLE_ARN` — value of `github_actions_role_arn` from Terraform

The pipeline sources code from an S3 zip uploaded by GitHub Actions
(`source/source.zip` in the pipeline artifacts bucket) — no CodeStar/GitHub
connection is required.

### 3. CDK + frontend via CodePipeline

Every **push to `main`** runs the GitHub Actions workflow (`.github/workflows/ci-cd.yml`):

1. **Test** — `npm test`, `cdk synth`, Angular production build
2. **Deploy** — uploads the checked-out source as a zip to S3, starts
   `dotrace-game-pipeline`, and waits until the CodeBuild stage finishes
   (CDK deploy → S3 sync → CloudFront invalidation)

Pull requests to `main` run tests only (no deploy).

Manual pipeline trigger (re-deploys the last uploaded source zip):

```bash
aws codepipeline start-pipeline-execution --name dotrace-game-pipeline --region us-east-1 --profile nandopoiato
```

## Game architecture

- **Connection metadata only** in DynamoDB (room code, nickname, color, host, join order).
- **Game state** lives in host memory; synchronized via `RELAY`.
- Non-host moves use `FORWARD_TO_HOST` → host validates turn + vector math → `RELAY`.
- Host disconnect promotes next join-order player; `HOST_CHANGED` + state recovery flow.

## Racing the computer

The host can put CPU drivers on the grid from the lobby, at three difficulties, to
race alone against the AI or to fill out a short field.

CPU racers need no server support. They live only in game state under a synthetic
`bot:*` id, the host picks their moves locally and pushes them through the same
validation a forwarded human move gets, and every other client learns about them
through the ordinary `RELAY` snapshots. If the host drops, whoever is promoted
recovers the snapshot and takes over driving them. They are scored in the room's
session ranking but kept out of the global nickname leaderboard.

The planner in `shared/bot-ai.ts` measures how far round a lap a car is along the
circuit's centerline — the raster grid has no notion of lap order, and on Suzuka it
cannot say which pass of the crossover a cell belongs to — then searches a few turns
ahead over the ±1 gear rule, paying for gravel, kerbs and grass shortcuts so a bot
brakes for a corner instead of driving into the grass at full gear. `bot/` runs the
same planner, so the headless client races like an in-game bot.

## Scripts

```bash
npm start           # Angular dev server
npm run build       # Production frontend build
npm run cdk:synth   # CDK template
npm run cdk:deploy  # Deploy WebSocket stack
npm test            # Shared mirror check + game rule / CPU planner tests
npm run shared:sync # Copy shared/ into the Angular app's models folder
npm run bot:test    # Headless client tests
npm run bot:start   # Run the headless client against a live room
```

## License

Private — fpoiato/dotrace
