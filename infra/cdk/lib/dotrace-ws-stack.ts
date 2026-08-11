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
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export class DotRaceWsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

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

    const connectFn = new NodejsFunction(this, 'ConnectHandler', {
      entry: lambdaEntry('connect'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: lambdaEnv,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const disconnectFn = new NodejsFunction(this, 'DisconnectHandler', {
      entry: lambdaEntry('disconnect'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: lambdaEnv,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const messageFn = new NodejsFunction(this, 'MessageHandler', {
      entry: lambdaEntry('message'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      environment: lambdaEnv,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const httpFn = new NodejsFunction(this, 'HttpHandler', {
      entry: lambdaEntry('http'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: lambdaEnv,
      bundling: { externalModules: ['@aws-sdk/*'] },
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

    // AI player runner — one async invocation per AI pilot per race. Holds the
    // WebSocket session for the whole race, so the timeout caps race duration.
    const aiPlayerFn = new NodejsFunction(this, 'AiPlayerHandler', {
      entry: lambdaEntry('ai-player'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.minutes(15),
      memorySize: 512,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        WS_URL: stage.url,
        API_URL: httpApi.apiEndpoint,
        BEDROCK_MODEL_ID: 'amazon.nova-micro-v1:0',
        MOVE_DELAY_MS: '600',
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
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

    httpFn.addEnvironment('AI_PLAYER_FUNCTION_NAME', aiPlayerFn.functionName);
    messageFn.addEnvironment('AI_PLAYER_FUNCTION_NAME', aiPlayerFn.functionName);
    aiPlayerFn.grantInvoke(httpFn);
    aiPlayerFn.grantInvoke(messageFn);

    new CfnOutput(this, 'WebSocketUrl', { value: stage.url });
    new CfnOutput(this, 'WebSocketApiId', { value: webSocketApi.apiId });
    new CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'HttpApiId', { value: httpApi.httpApiId });
    new CfnOutput(this, 'ConnectionsTableName', { value: connectionsTable.tableName });
    new CfnOutput(this, 'LeaderboardTableName', { value: leaderboardTable.tableName });
  }
}
