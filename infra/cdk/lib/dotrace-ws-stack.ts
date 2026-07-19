import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
} from 'aws-cdk-lib/aws-dynamodb';
import {
  WebSocketApi,
  WebSocketStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
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

    connectionsTable.grantReadWriteData(connectFn);
    connectionsTable.grantReadWriteData(disconnectFn);
    connectionsTable.grantReadWriteData(messageFn);
    leaderboardTable.grantReadWriteData(messageFn);

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

    const manageConnectionsPolicy = new PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${stage.stageName}/POST/@connections/*`,
      ],
    });
    messageFn.addToRolePolicy(manageConnectionsPolicy);
    disconnectFn.addToRolePolicy(manageConnectionsPolicy);

    new CfnOutput(this, 'WebSocketUrl', { value: stage.url });
    new CfnOutput(this, 'WebSocketApiId', { value: webSocketApi.apiId });
    new CfnOutput(this, 'ConnectionsTableName', { value: connectionsTable.tableName });
    new CfnOutput(this, 'LeaderboardTableName', { value: leaderboardTable.tableName });
  }
}
