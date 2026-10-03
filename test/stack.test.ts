import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { deployConfig } from '../bin/config';
import { LayaHostStack } from '../lib/laya-host-stack';

const account = '123456789012';
const region = 'us-east-1';
const azContext = {
  'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

describe('LayaHostStack', () => {
  it('creates a stopped-by-default host and the shared power lambda', () => {
    const app = new cdk.App({ context: azContext });
    const stack = new LayaHostStack(app, 'LayaHostStack', {
      env: { account, region },
      createInstance: true,
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.medium',
      InstanceInitiatedShutdownBehavior: 'stop',
    });
    template.hasResource('AWS::EC2::Instance', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'LayaPower',
      Timeout: 240,
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'LayaControl',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/laya/url',
      Value: 'pending',
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'LayaPowerRole',
    });
  });

  it('operates an existing instance without creating a second machine', () => {
    const app = new cdk.App();
    const stack = new LayaHostStack(app, 'LayaHostStack', {
      env: { account, region },
      existingInstanceId: 'i-0123456789abcdef0',
      existingSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ollaya-AbCdEf',
      legacyUrlParameterName: '/dotrace/ollaya-url',
      legacyConnectionsTableName: 'DotRaceConnections',
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::Instance', 0);
    template.resourceCountIs('AWS::EC2::VPC', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'LayaPower',
      Environment: {
        Variables: {
          LAYA_INSTANCE_ID: 'i-0123456789abcdef0',
          LAYA_URL_PARAMETER: '/laya/url',
          LEGACY_URL_PARAMETERS: '/dotrace/ollaya-url',
          LEGACY_CONNECTIONS_TABLE: 'DotRaceConnections',
          LAYA_MODEL: 'laya',
        },
      },
    });
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('arn:aws:ssm:us-east-1:123456789012:parameter/dotrace/ollaya-url');
    expect(json).toContain('arn:aws:dynamodb:us-east-1:123456789012:table/DotRaceConnections');
    expect(json).toContain('i-0123456789abcdef0');
  });
});

describe('deploy config', () => {
  it('refuses a bare deploy that would create a second host', () => {
    expect(() => deployConfig(() => undefined)).toThrow(/Refusing to create a second EC2/);
  });

  it('keeps the Dot Race and Truco parameter names on this deployment', () => {
    const config = deployConfig((key) => {
      if (key === 'existingInstanceId') return 'i-0123456789abcdef0';
      if (key === 'existingSecretArn') return 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ollaya-AbCdEf';
      return undefined;
    });
    expect(config.legacyUrlParameterName).toBe('/dotrace/ollaya-url');
    expect(config.legacyConnectionsTableName).toBe('DotRaceConnections');
    expect(config.model).toBe('laya');
    expect(config.createInstance).toBe(false);
  });
});
