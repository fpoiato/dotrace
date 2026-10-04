#!/usr/bin/env bash
# Start a Nova Micro supervised fine-tune on the Laya decide packet.
#
# The JSONL is the same context the live brain sends: state, the move
# instructions, and the nine gear-change criteria. The completion is the
# choice id (best on asphalt, back off the track).
#
# This environment has no AWS credentials. Run from a shell that does:
#
#   cd agent && npm run finetune:dataset
#   BUCKET=my-bucket ROLE_ARN=arn:aws:iam::123:role/BedrockCustomize \
#     ./finetune/start-job.sh
#
# After the job reaches Completed, set BEDROCK_MODEL_ID on DotRaceAiPlayer
# to the custom-model ARN. The Lambda may already invoke custom-model/*.
set -euo pipefail

: "${BUCKET:?set BUCKET to an S3 bucket in the training region}"
: "${ROLE_ARN:?set ROLE_ARN to the Bedrock customization service role}"

REGION="${AWS_REGION:-us-east-1}"
PREFIX="${PREFIX:-dotrace/bedrock-laya}"
JOB="${JOB_NAME:-dotrace-nova-micro-laya}"
MODEL_NAME="${CUSTOM_MODEL_NAME:-dotrace-nova-micro-laya}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

aws s3 cp "${ROOT}/train.jsonl" "s3://${BUCKET}/${PREFIX}/train.jsonl" --region "$REGION"
aws s3 cp "${ROOT}/validation.jsonl" "s3://${BUCKET}/${PREFIX}/validation.jsonl" --region "$REGION"

# Confirm the base model id in this region if the job rejects it:
#   aws bedrock list-foundation-models --region "$REGION" \
#     --by-customization-type FINE_TUNING --query 'modelSummaries[].modelId'
aws bedrock create-model-customization-job \
  --region "$REGION" \
  --job-name "$JOB" \
  --custom-model-name "$MODEL_NAME" \
  --role-arn "$ROLE_ARN" \
  --base-model-identifier "amazon.nova-micro-v1:0:128k" \
  --training-data-config "s3Uri=s3://${BUCKET}/${PREFIX}/train.jsonl" \
  --validation-data-config "s3Uri=s3://${BUCKET}/${PREFIX}/validation.jsonl" \
  --output-data-config "s3Uri=s3://${BUCKET}/${PREFIX}/output/" \
  --hyper-parameters epochCount=2,learningRate=0.00001,batchSize=1

echo "Started ${JOB}. Watch it with:"
echo "  aws bedrock get-model-customization-job --job-identifier ${JOB} --region ${REGION}"
