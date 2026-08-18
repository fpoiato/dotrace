import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
} from 'aws-cdk-lib/aws-dynamodb';
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  WebSocketApi,
  WebSocketStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
  WebSocketLambdaIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';
import { ALERT_EMAIL, OPS_ALERT_TOPIC_NAME } from './alert-email';

/** Healthy 1v1 TIMED ≈ 100 invokes / 5 min; alarm at 1.5×. See scripts/alarm-thresholds.py. */
export const AI_INVOCATIONS_ALARM_PER_5MIN = 150;
/** 80% of the 30s timeout — Bedrock can take ~12s. */
export const AI_DURATION_P99_MS = 24_000;

export interface DotRaceWsStackProps extends StackProps {}

export class DotRaceWsStack extends Stack {
  readonly alertTopic: Topic;

  constructor(scope: Construct, id: string, props?: DotRaceWsStackProps) {
    super(scope, id, props);

    this.alertTopic = new Topic(this, 'OpsAlerts', {
      topicName: OPS_ALERT_TOPIC_NAME,
      displayName: 'DotRace ops and cost alerts',
    });
    this.alertTopic.addSubscription(new EmailSubscription(ALERT_EMAIL));
    this.alertTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: 'CloudWatchAlarmsPublish',
        principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: {
          ArnLike: {
            'aws:SourceArn': `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:*`,
          },
        },
      })
    );
    this.alertTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSAnomalyDetectionSNSPublishingPermissions',
        principals: [new ServicePrincipal('costalerts.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      })
    );

    const connectionsTable = new Table(this, 'DotRaceConnections', {
      tableName: 'DotRaceConnections',
      partitionKey: { name: 'connectionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'RoomCodeIndex',
      partitionKey: { name: 'roomCode', type: AttributeType.STRING },
      sortKey: { name: 'connectionId', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    const leaderboardTable = new Table(this, 'DotRaceLeaderboard', {
      tableName: 'DotRaceLeaderboard',
      partitionKey: { name: 'nicknameKey', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    leaderboardTable.addGlobalSecondaryIndex({
      indexName: 'BoardRankIndex',
      partitionKey: { name: 'board', type: AttributeType.STRING },
      sortKey: { name: 'rankKey', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    const lambdaEnv = {
      CONNECTIONS_TABLE: connectionsTable.tableName,
      LEADERBOARD_TABLE: leaderboardTable.tableName,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const lambdaEntry = (name: string) =>
      path.join(__dirname, '..', 'lambda', 'src', `${name}.ts`);

    const nodejsDefaults: Partial<NodejsFunctionProps> = {
      runtime: Runtime.NODEJS_20_X,
      logRetention: RetentionDays.TWO_WEEKS,
      bundling: { externalModules: ['@aws-sdk/*'] },
    };

    const connectFn = new NodejsFunction(this, 'ConnectHandler', {
      ...nodejsDefaults,
      entry: lambdaEntry('connect'),
      handler: 'handler',
      timeout: Duration.seconds(10),
      environment: lambdaEnv,
    });

    const disconnectFn = new NodejsFunction(this, 'DisconnectHandler', {
      ...nodejsDefaults,
      entry: lambdaEntry('disconnect'),
      handler: 'handler',
      timeout: Duration.seconds(10),
      environment: lambdaEnv,
    });

    const messageFn = new NodejsFunction(this, 'MessageHandler', {
      ...nodejsDefaults,
      entry: lambdaEntry('message'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: lambdaEnv,
    });

    const httpFn = new NodejsFunction(this, 'HttpHandler', {
      ...nodejsDefaults,
      entry: lambdaEntry('http'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: lambdaEnv,
    });

    connectionsTable.grantReadWriteData(connectFn);
    connectionsTable.grantReadWriteData(disconnectFn);
    connectionsTable.grantReadWriteData(messageFn);
    connectionsTable.grantReadWriteData(httpFn);
    leaderboardTable.grantReadWriteData(messageFn);
    leaderboardTable.grantReadWriteData(httpFn);

    const webSocketApi = new WebSocketApi(this, 'DotRaceWebSocketApi', {
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnectIntegration', connectFn),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectFn),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('DefaultIntegration', messageFn),
      },
    });

    webSocketApi.addRoute('message', {
      integration: new WebSocketLambdaIntegration('MessageIntegration', messageFn),
    });

    const stage = new WebSocketStage(this, 'ProdStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    const endpoint = stage.url.replace('wss://', 'https://');
    messageFn.addEnvironment('WEBSOCKET_ENDPOINT', endpoint);
    disconnectFn.addEnvironment('WEBSOCKET_ENDPOINT', endpoint);
    httpFn.addEnvironment('WEBSOCKET_ENDPOINT', endpoint);

    const manageConnectionsPolicy = new PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${stage.stageName}/POST/@connections/*`,
      ],
    });
    messageFn.addToRolePolicy(manageConnectionsPolicy);
    disconnectFn.addToRolePolicy(manageConnectionsPolicy);
    httpFn.addToRolePolicy(manageConnectionsPolicy);

    // HTTP API for client→server commands (async / resilient to mobile WS drops).
    const httpApi = new HttpApi(this, 'DotRaceHttpApi', {
      apiName: 'DotRaceHttpApi',
      description: 'Dot Race client command API (POST actions, GET top10)',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'X-Connection-Id'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'],
        maxAge: Duration.days(1),
      },
    });

    const httpIntegration = new HttpLambdaIntegration('HttpIntegration', httpFn);

    httpApi.addRoutes({
      path: '/actions',
      methods: [HttpMethod.POST],
      integration: httpIntegration,
    });

    httpApi.addRoutes({
      path: '/top10',
      methods: [HttpMethod.GET],
      integration: httpIntegration,
    });

    // Stable name so Http/Message Lambdas can invoke it without a CFN cycle
    // (AiPlayer → WS/HTTP APIs → those Lambdas → AiPlayer.functionName).
    const aiPlayerFunctionName = 'DotRaceAiPlayer';

    // One short invoke per AI turn. Hard caps in IaC: 30s, reserved 2, 256 MB.
    // RecursiveLoop defaults to Terminate — self-invoke is a backdoor we removed.
    const aiPlayerFn = new NodejsFunction(this, 'AiPlayerHandler', {
      ...nodejsDefaults,
      entry: lambdaEntry('ai-player'),
      handler: 'handler',
      functionName: aiPlayerFunctionName,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 2,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        API_URL: httpApi.apiEndpoint,
        CONNECTIONS_TABLE: connectionsTable.tableName,
        BEDROCK_MODEL_ID: 'amazon.nova-micro-v1:0',
        BRAIN: 'heuristic',
        BEDROCK_TIMEOUT_MS: '12000',
      },
    });

    aiPlayerFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/amazon.nova-*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/*.amazon.nova-*`,
        ],
      })
    );

    connectionsTable.grantReadWriteData(aiPlayerFn);
    httpFn.addEnvironment('AI_PLAYER_FUNCTION_NAME', aiPlayerFunctionName);
    messageFn.addEnvironment('AI_PLAYER_FUNCTION_NAME', aiPlayerFunctionName);
    // Literal ARN — grantInvoke(aiPlayerFn) would reintroduce the CFN cycle.
    const invokeAiPlayer = new PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${aiPlayerFunctionName}`],
    });
    httpFn.addToRolePolicy(invokeAiPlayer);
    messageFn.addToRolePolicy(invokeAiPlayer);

    this.addAiPlayerAlarms(aiPlayerFunctionName, aiPlayerFn, this.alertTopic);

    new CfnOutput(this, 'WebSocketUrl', { value: stage.url });
    new CfnOutput(this, 'WebSocketApiId', { value: webSocketApi.apiId });
    new CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'HttpApiId', { value: httpApi.httpApiId });
    new CfnOutput(this, 'ConnectionsTableName', { value: connectionsTable.tableName });
    new CfnOutput(this, 'LeaderboardTableName', { value: leaderboardTable.tableName });
    new CfnOutput(this, 'AiPlayerFunctionName', { value: aiPlayerFunctionName });
    new CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
  }

  private addAiPlayerAlarms(functionName: string, fn: NodejsFunction, topic: Topic): void {
    const sns = new SnsAction(topic);
    const fiveMin = Duration.minutes(5);

    const concurrent = new Alarm(this, 'AiPlayerConcurrentAlarm', {
      alarmName: 'DotRaceAiPlayer-ConcurrentExecutions',
      alarmDescription: 'AI worker concurrent > 2 (reserved cap missing or raised)',
      metric: new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'ConcurrentExecutions',
        dimensionsMap: { FunctionName: functionName },
        statistic: 'Maximum',
        period: fiveMin,
      }),
      threshold: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    concurrent.addAlarmAction(sns);

    const duration = new Alarm(this, 'AiPlayerDurationAlarm', {
      alarmName: 'DotRaceAiPlayer-DurationP99',
      alarmDescription: 'AI worker p99 duration > 80% of 30s timeout',
      metric: fn.metricDuration({ statistic: 'p99', period: fiveMin }),
      threshold: AI_DURATION_P99_MS,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    duration.addAlarmAction(sns);

    const errors = new Alarm(this, 'AiPlayerErrorsAlarm', {
      alarmName: 'DotRaceAiPlayer-Errors',
      alarmDescription: 'AI worker errors > 0 over 5 minutes',
      metric: fn.metricErrors({ statistic: 'Sum', period: fiveMin }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    errors.addAlarmAction(sns);

    const invocations = new Alarm(this, 'AiPlayerInvocationsAlarm', {
      alarmName: 'DotRaceAiPlayer-Invocations',
      alarmDescription: `AI worker invocations > ${AI_INVOCATIONS_ALARM_PER_5MIN} per 5 minutes`,
      metric: fn.metricInvocations({ statistic: 'Sum', period: fiveMin }),
      threshold: AI_INVOCATIONS_ALARM_PER_5MIN,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    invocations.addAlarmAction(sns);
  }
}
