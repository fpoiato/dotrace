#!/usr/bin/env bash
# Print the deploy command that attaches this stack to the EC2 Dot Race already
# created. Pass --deploy to run it. Does not delete anything in Dot Race.
set -euo pipefail

REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
STACK="${DOTRACE_STACK:-DotRaceWsStack}"

instance_id="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='OllayaInstanceId'].OutputValue" \
  --output text)"

secret_arn="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='OllayaApiKeyArn'].OutputValue" \
  --output text 2>/dev/null || true)"

if [[ -z "$secret_arn" || "$secret_arn" == "None" ]]; then
  secret_arn="$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK" \
    --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret'].PhysicalResourceId" \
    --output text)"
fi

if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
  echo "DotRaceWsStack has no OllayaInstanceId output. Deploy the retain change in dotrace first." >&2
  exit 1
fi
if [[ -z "$secret_arn" || "$secret_arn" == "None" ]]; then
  echo "Could not find the Ollaya API key secret in $STACK." >&2
  exit 1
fi

current_url="$(aws ssm get-parameter \
  --name /dotrace/ollaya-url \
  --region "$REGION" \
  --query Parameter.Value \
  --output text 2>/dev/null || echo pending)"

cat <<EOF
Instance: $instance_id
Secret:   $secret_arn
URL:      $current_url

Deploy (does not create a second machine):

  export CDK_DEFAULT_ACCOUNT=\$(aws sts get-caller-identity --query Account --output text)
  export CDK_DEFAULT_REGION=$REGION
  npx cdk deploy --require-approval never \\
    -c existingInstanceId=$instance_id \\
    -c existingSecretArn=$secret_arn

After the stack is up, keep /dotrace/ollaya-url in sync until Dot Race reads /laya/url:

  aws ssm get-parameter --name /laya/url --region $REGION --query Parameter.Value --output text
  aws ssm put-parameter --name /laya/url --region $REGION --type String --value '$current_url' --overwrite
EOF

if [[ "${1:-}" == "--deploy" ]]; then
  export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
  export CDK_DEFAULT_REGION="$REGION"
  npx cdk deploy --require-approval never \
    -c existingInstanceId="$instance_id" \
    -c existingSecretArn="$secret_arn"
  if [[ "$current_url" != "pending" && "$current_url" != "None" ]]; then
    aws ssm put-parameter \
      --name /laya/url \
      --region "$REGION" \
      --type String \
      --value "$current_url" \
      --overwrite >/dev/null
    echo "Seeded /laya/url from /dotrace/ollaya-url"
  fi
fi
