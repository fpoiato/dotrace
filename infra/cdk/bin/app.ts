#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DotRaceWsStack } from '../lib/dotrace-ws-stack';

const app = new cdk.App();
new DotRaceWsStack(app, 'DotRaceWsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
