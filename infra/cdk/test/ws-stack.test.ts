import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DotRaceWsStack } from '../lib/dotrace-ws-stack';

describe('DotRaceWsStack', () => {
  it('synthesizes without a circular dependency', () => {
    const app = new cdk.App();
    const stack = new DotRaceWsStack(app, 'DotRaceWsStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'DotRaceAiPlayer',
      RecursiveLoop: 'Allow',
    });
  });
});
