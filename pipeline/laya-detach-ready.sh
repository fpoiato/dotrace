#!/usr/bin/env bash
# Exit 0 when Dot Race may stop owning the Laya EC2.
# Exit 1 when this deploy should keep the embedded host (and set Retain).
# Exit 2 when the host is already gone and LayaHostStack is not healthy —
# recreating it here would make a second machine.
set -euo pipefail

REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"

laya_status="$(aws cloudformation describe-stacks \
  --stack-name LayaHostStack \
  --region "$REGION" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || true)"

laya_healthy=1
case "$laya_status" in
  CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) laya_healthy=0 ;;
esac

template="$(aws cloudformation get-template \
  --stack-name DotRaceWsStack \
  --region "$REGION" \
  --output json)"

decision="$(printf '%s' "$template" | jq -r '
  .TemplateBody
  | (if type == "string" then fromjson else . end) as $body
  | [$body.Resources | to_entries[] | select(.value.Type == "AWS::EC2::Instance")] as $instances
  | if ($instances | length) == 0 then "already-detached"
    elif all($instances[]; .value.DeletionPolicy == "Retain") then "retained"
    else "owned"
    end
')"

echo "LayaHostStack=${laya_status:-missing} dotraceInstances=$decision" >&2

if [ "$decision" = "already-detached" ]; then
  if [ "$laya_healthy" -eq 0 ]; then
    exit 0
  fi
  exit 2
fi

if [ "$decision" = "retained" ] && [ "$laya_healthy" -eq 0 ]; then
  exit 0
fi

exit 1
