# Dot Race (Vector Rally)

Turn-based vector racing party game — mobile-first Angular frontend, API Gateway WebSocket backend, host-authoritative ephemeral game state.

**Live:** [https://dotrace.fpoiato.com](https://dotrace.fpoiato.com)

## Monorepo layout

| Path | Purpose |
|------|---------|
| `frontend/dotrace-app` | Angular 19 + Tailwind 3.4 + ngx-translate (pt-BR / en) |
| `infra/cdk` | DynamoDB `DotRaceConnections`, WebSocket Lambdas |
| `infra/terraform` | S3, CloudFront (OAC), ACM, Route53, CodePipeline |
| `shared/` | WebSocket + game types (`ws-types.ts`, `tracks.ts`) |
| `pipeline/` | CodeBuild buildspec |
| `.github/workflows/` | CI + OIDC pipeline trigger |

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

### 2. GitHub secrets

In the private repo `fpoiato/dotrace`, set:

- `AWS_ROLE_ARN` — value of `github_actions_role_arn` from Terraform

### 3. CDK + frontend via CodePipeline

Push to `main` — GitHub Actions runs tests and triggers `dotrace-game-pipeline`. CodeBuild:

1. `cdk deploy` → writes WebSocket URL to SSM
2. Injects `environment.prod.ts` with WS URL + app URL
3. `ng build` → `aws s3 sync` → CloudFront invalidation `/*`

Manual pipeline trigger:

```bash
aws codepipeline start-pipeline-execution --name dotrace-game-pipeline --region us-east-1 --profile nandopoiato
```

## Game architecture

- **Connection metadata only** in DynamoDB (room code, nickname, color, host, join order).
- **Game state** lives in host memory; synchronized via `RELAY`.
- Non-host moves use `FORWARD_TO_HOST` → host validates turn + vector math → `RELAY`.
- Host disconnect promotes next join-order player; `HOST_CHANGED` + state recovery flow.

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
