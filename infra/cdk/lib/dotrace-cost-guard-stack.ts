import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import { ITopic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { ALERT_EMAIL } from './alert-email';

const ABSOLUTE_5: string = JSON.stringify({
  Dimensions: {
    Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
    Values: ['5'],
    MatchOptions: ['GREATER_THAN_OR_EQUAL'],
  },
});

const PERCENT_40: string = JSON.stringify({
  Dimensions: {
    Key: 'ANOMALY_TOTAL_IMPACT_PERCENTAGE',
    Values: ['40'],
    MatchOptions: ['GREATER_THAN_OR_EQUAL'],
  },
});

/**
 * Account-level cost spike detection (us-east-1). Monitoring-only budgets
 * are free. Does not create Budget Actions / Deny policies.
 *
 * The existing monthly budget `ceilling` ($30) lives outside this stack and
 * is updated by `scripts/apply-existing-budget-notifications.sh`.
 *
 * SNS lives on DotRaceWsStack so the AI lifecycle fix can deploy even if
 * billing resources fail.
 */
export interface DotRaceCostGuardStackProps extends StackProps {
  alertTopic: ITopic;
}

export class DotRaceCostGuardStack extends Stack {
  constructor(scope: Construct, id: string, props: DotRaceCostGuardStackProps) {
    super(scope, id, props);

    const topicArn = props.alertTopic.topicArn;

    const serviceMonitor = new ce.CfnAnomalyMonitor(this, 'ServiceAnomalies', {
      monitorName: 'account-service-anomalies',
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });

    const lambdaMonitor = new ce.CfnAnomalyMonitor(this, 'LambdaAnomalies', {
      monitorName: 'lambda-anomalies',
      monitorType: 'CUSTOM',
      monitorSpecification: JSON.stringify({
        Dimensions: {
          Key: 'SERVICE',
          Values: ['AWS Lambda'],
          MatchOptions: ['EQUALS'],
        },
      }),
    });

    const monitorArns = [serviceMonitor.attrMonitorArn, lambdaMonitor.attrMonitorArn];

    const dailyEmail = new ce.CfnAnomalySubscription(this, 'DailyEmailAbs5', {
      subscriptionName: 'account-anomaly-daily-email',
      frequency: 'DAILY',
      monitorArnList: monitorArns,
      subscribers: [{ type: 'EMAIL', address: ALERT_EMAIL }],
      thresholdExpression: ABSOLUTE_5,
    });
    dailyEmail.addDependency(serviceMonitor);
    dailyEmail.addDependency(lambdaMonitor);

    const immediateSns = new ce.CfnAnomalySubscription(this, 'ImmediateSnsAbs5', {
      subscriptionName: 'account-anomaly-immediate-sns',
      frequency: 'IMMEDIATE',
      monitorArnList: monitorArns,
      subscribers: [{ type: 'SNS', address: topicArn }],
      thresholdExpression: ABSOLUTE_5,
    });
    immediateSns.addDependency(serviceMonitor);
    immediateSns.addDependency(lambdaMonitor);

    const dailyPct = new ce.CfnAnomalySubscription(this, 'DailyEmailPct40', {
      subscriptionName: 'account-anomaly-daily-pct40',
      frequency: 'DAILY',
      monitorArnList: monitorArns,
      subscribers: [{ type: 'EMAIL', address: ALERT_EMAIL }],
      thresholdExpression: PERCENT_40,
    });
    dailyPct.addDependency(serviceMonitor);
    dailyPct.addDependency(lambdaMonitor);

    const emailSub = [{ subscriptionType: 'EMAIL', address: ALERT_EMAIL }];
    new budgets.CfnBudget(this, 'DailyCost', {
      budget: {
        budgetName: 'account-daily-cost',
        budgetType: 'COST',
        timeUnit: 'DAILY',
        budgetLimit: { amount: 8, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: emailSub,
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: emailSub,
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: emailSub,
        },
      ],
    });

    new CfnOutput(this, 'AlertEmail', { value: ALERT_EMAIL });
  }
}
