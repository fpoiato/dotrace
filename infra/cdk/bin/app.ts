#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DotRaceCostGuardStack } from '../lib/dotrace-cost-guard-stack';
import { DotRaceWsStack } from '../lib/dotrace-ws-stack';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const ws = new DotRaceWsStack(app, 'DotRaceWsStack', { env });
const costGuard = new DotRaceCostGuardStack(app, 'DotRaceCostGuardStack', {
  env,
  alertTopic: ws.alertTopic,
});
costGuard.addDependency(ws);
