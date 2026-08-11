# Dot Race (Vector Rally)

Turn-based vector racing party game — mobile-first Angular frontend, API Gateway WebSocket (push) + HTTP API (commands), host-authoritative ephemeral game state.

**Live:** [https://dotrace.fpoiato.com](https://dotrace.fpoiato.com)

## Monorepo layout

| Path | Purpose |
|------|---------|
| `frontend/dotrace-app` | Angular 19 + Tailwind 3.4 + ngx-translate (pt-BR / en) |
| `infra/cdk` | DynamoDB, WebSocket API, HTTP API (commands), Lambdas |
| `infra/terraform` | S3, CloudFront (OAC), ACM, Route53, CodePipeline |
| `shared/` | WebSocket + game types (`ws-types.ts`, `tracks.ts`) + bot AI (`ai.ts`) |
| `pipeline/` | CodeBuild buildspec |
| `.github/workflows/` | CI/CD on push to `main` (`ci-cd.yml`) |

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

### Single player vs AI

The host can add virtual opponents ("bots") from the lobby — difficulty
Easy/Medium/Hard — or use the landing-page **Play vs AI** shortcut, which
pre-fills a Medium bot. Bots are regular `Player` entries (`isBot`) inside the
host-authoritative state: they roll grid dice, appear in relay/telemetry/
replay and keep racing across a host migration. The host client drives their
turns locally (`GameEngineService` timers + `shared/ai.ts`), so no backend
changes are needed. The brain follows the track's `racingLine` (centerline in
race direction) with a BFS distance field toward a speed-scaled look-ahead
point plus a one-turn lookahead to brake for corners; bot nicknames are
excluded from the global leaderboard.

## Scripts

```bash
npm start          # Angular dev server
npm run build      # Production frontend build
npm run cdk:synth  # CDK template
npm run cdk:deploy # Deploy WebSocket stack
npm test           # CDK unit tests
```

## License

Private — fpoiato/dotrace
