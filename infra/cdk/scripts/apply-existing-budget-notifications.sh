#!/usr/bin/env bash
# Idempotent: add ACTUAL 80% + FORECASTED 100% email on the existing monthly
# budget `ceilling` ($30). Does not create Budget Actions.
set -euo pipefail
ACCOUNT_ID="${ACCOUNT_ID:-986873053420}"
REGION="${AWS_REGION:-us-east-1}"
BUDGET="ceilling"
EMAIL="${ALERT_EMAIL:-nandopoiato@gmail.com}"

create_if_missing() {
  local ntype="$1"
  local threshold="$2"
  if aws budgets describe-subscribers-for-notification \
      --account-id "$ACCOUNT_ID" \
      --budget-name "$BUDGET" \
      --notification "NotificationType=${ntype},ComparisonOperator=GREATER_THAN,Threshold=${threshold},ThresholdType=PERCENTAGE" \
      --region "$REGION" >/dev/null 2>&1; then
    echo "already subscribed: ${BUDGET} ${ntype} ${threshold}%"
    return 0
  fi
  aws budgets create-notification \
    --account-id "$ACCOUNT_ID" \
    --budget-name "$BUDGET" \
    --notification "NotificationType=${ntype},ComparisonOperator=GREATER_THAN,Threshold=${threshold},ThresholdType=PERCENTAGE" \
    --subscribers "SubscriptionType=EMAIL,Address=${EMAIL}" \
    --region "$REGION"
  echo "created: ${BUDGET} ${ntype} ${threshold}% -> ${EMAIL}"
}

create_if_missing ACTUAL 80
create_if_missing FORECASTED 100
