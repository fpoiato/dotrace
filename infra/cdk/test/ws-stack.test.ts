import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DotRaceCostGuardStack } from '../lib/dotrace-cost-guard-stack';
import {
  AI_DURATION_P99_MS,
  AI_INVOCATIONS_ALARM_PER_5MIN,
  DotRaceWsStack,
} from '../lib/dotrace-ws-stack';
import { ALERT_EMAIL } from '../lib/alert-email';

const env = { account: '123456789012', region: 'us-east-1' };

function synth() {
  const app = new cdk.App();
  const stack = new DotRaceWsStack(app, 'DotRaceWsStack', { env });
  const cost = new DotRaceCostGuardStack(app, 'DotRaceCostGuardStack', {
    env,
    alertTopic: stack.alertTopic,
  });
  return {
    ws: Template.fromStack(stack),
    cost: Template.fromStack(cost),
  };
}

describe('DotRaceWsStack AI caps', () => {
  it('synthesizes without a circular dependency', () => {
    const { ws } = synth();
    ws.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'DotRaceAiPlayer',
    });
  });

  it('hard-caps DotRaceAiPlayer: 30s timeout, reserved 2, 256 MB, arm64, no recursive loop', () => {
    const { ws } = synth();
    const fns = ws.findResources('AWS::Lambda::Function');
    const ai = Object.values(fns).find(
      (f) => (f as { Properties?: { FunctionName?: string } }).Properties?.FunctionName === 'DotRaceAiPlayer'
    ) as { Properties: Record<string, unknown> } | undefined;
    expect(ai).toBeDefined();
    expect(ai!.Properties.Timeout).toBe(30);
    expect(ai!.Properties.MemorySize).toBe(256);
    expect(ai!.Properties.ReservedConcurrentExecutions).toBe(2);
    expect(ai!.Properties.Architectures).toEqual(['arm64']);
    expect(ai!.Properties.RecursiveLoop).toBeUndefined();
    const envVars = ai!.Properties.Environment as { Variables?: Record<string, string> };
    expect(envVars.Variables?.AI_HANDOFF_AFTER_MS).toBeUndefined();
    expect(envVars.Variables?.WS_URL).toBeUndefined();
  });

  it('retains Lambda logs for 14 days', () => {
    const { ws } = synth();
    const retentions = Object.values(ws.findResources('Custom::LogRetention')).map(
      (r) => (r as { Properties?: { RetentionInDays?: number } }).Properties?.RetentionInDays
    );
    expect(retentions.length).toBeGreaterThanOrEqual(5);
    expect(retentions.every((d) => d === 14)).toBe(true);
  });

  it('alarms on concurrent > 2, duration p99, errors, and invocations', () => {
    const { ws } = synth();
    ws.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'DotRaceAiPlayer-ConcurrentExecutions',
      Threshold: 2,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    ws.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'DotRaceAiPlayer-DurationP99',
      Threshold: AI_DURATION_P99_MS,
    });
    ws.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'DotRaceAiPlayer-Errors',
      Threshold: 0,
    });
    ws.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'DotRaceAiPlayer-Invocations',
      Threshold: AI_INVOCATIONS_ALARM_PER_5MIN,
    });
  });
});

describe('DotRaceCostGuardStack', () => {
  it('creates a SERVICE CAD monitor and DAILY email + IMMEDIATE SNS', () => {
    const { cost } = synth();
    cost.hasResourceProperties('AWS::CE::AnomalyMonitor', {
      MonitorName: 'account-service-anomalies',
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
    });
    expect(Object.keys(cost.findResources('AWS::CE::AnomalyMonitor'))).toHaveLength(1);
    cost.hasResourceProperties('AWS::CE::AnomalySubscription', {
      SubscriptionName: 'account-anomaly-daily-email',
      Frequency: 'DAILY',
    });
    cost.hasResourceProperties('AWS::CE::AnomalySubscription', {
      SubscriptionName: 'account-anomaly-immediate-sns',
      Frequency: 'IMMEDIATE',
    });
    const subs = Object.values(cost.findResources('AWS::CE::AnomalySubscription'));
    const immediate = subs.find(
      (s) =>
        (s as { Properties?: { Frequency?: string } }).Properties?.Frequency === 'IMMEDIATE'
    ) as { Properties: { Subscribers: { Type: string }[] } };
    expect(immediate.Properties.Subscribers.every((s) => s.Type === 'SNS')).toBe(true);
    const daily = subs.find(
      (s) =>
        (s as { Properties?: { SubscriptionName?: string } }).Properties?.SubscriptionName ===
        'account-anomaly-daily-email'
    ) as { Properties: { Subscribers: { Type: string; Address: string }[] } };
    expect(daily.Properties.Subscribers[0]).toEqual({ Type: 'EMAIL', Address: ALERT_EMAIL });
  });

  it('creates a daily $8 monitoring budget with ACTUAL 80% and 100% email', () => {
    const { cost } = synth();
    cost.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetName: 'account-daily-cost',
        BudgetType: 'COST',
        TimeUnit: 'DAILY',
        BudgetLimit: { Amount: 8, Unit: 'USD' },
      },
    });
    const budget = Object.values(cost.findResources('AWS::Budgets::Budget'))[0] as {
      Properties: { NotificationsWithSubscribers: { Notification: { NotificationType: string } }[] };
    };
    const types = budget.Properties.NotificationsWithSubscribers.map((n) => n.Notification.NotificationType);
    expect(types.every((t) => t === 'ACTUAL')).toBe(true);
  });
});
