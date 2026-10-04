import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DotRaceWsStack } from '../lib/dotrace-ws-stack';

describe('DotRaceWsStack', () => {
  const app = new cdk.App({
    context: {
      'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
    },
  });
  const stack = new DotRaceWsStack(app, 'DotRaceWsStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  it('synthesizes the AI player without a circular dependency', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'DotRaceAiPlayer',
      RecursiveLoop: 'Allow',
    });
  });

  it('creates a stopped-by-default Ollaya host and its power lambda', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.medium',
      InstanceInitiatedShutdownBehavior: 'stop',
    });
    template.hasResource('AWS::EC2::Instance', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.hasResource('AWS::SecretsManager::Secret', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'DotRaceOllayaPower',
      Timeout: 240,
    });
    const power = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'DotRaceOllayaPower' },
    });
    for (const resource of Object.values(power)) {
      expect(resource.DeletionPolicy).toBeUndefined();
    }
  });
});

describe('DotRaceWsStack with the shared Laya host', () => {
  const app = new cdk.App({
    context: {
      layaMode: 'external',
      'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
    },
  });
  const stack = new DotRaceWsStack(app, 'DotRaceWsStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  it('does not create an EC2 and calls LayaPower', () => {
    template.resourceCountIs('AWS::EC2::Instance', 0);
    template.resourceCountIs('AWS::EC2::VPC', 0);
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('DotRaceOllayaPower');
    expect(json).toContain('function:LayaPower');
    expect(json).toContain('/laya/url');
    expect(json).toContain('/laya/api-key-secret-arn');
    expect(json).toContain('LayaPowerRole');
  });
});
