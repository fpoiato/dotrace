#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { deployConfig } from './config';
import { LayaHostStack } from '../lib/laya-host-stack';

const app = new cdk.App();
new LayaHostStack(app, 'LayaHostStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  terminationProtection: true,
  ...deployConfig((key) => app.node.tryGetContext(key)),
});
