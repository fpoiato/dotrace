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
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'DotRaceOllayaPower',
      Timeout: 240,
    });
  });
});
