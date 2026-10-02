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
import {
  BlockDeviceVolume,
  EbsDeviceVolumeType,
  Instance,
  InstanceClass,
  InstanceInitiatedShutdownBehavior,
  InstanceSize,
  InstanceType,
  MachineImage,
  OperatingSystemType,
  Peer,
  Port,
  SubnetType,
  UserData,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { RecursiveLoop, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
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
      logRetention: RetentionDays.TWO_WEEKS,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const disconnectFn = new NodejsFunction(this, 'DisconnectHandler', {
      entry: lambdaEntry('disconnect'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: lambdaEnv,
      logRetention: RetentionDays.TWO_WEEKS,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const messageFn = new NodejsFunction(this, 'MessageHandler', {
      entry: lambdaEntry('message'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      environment: lambdaEnv,
      logRetention: RetentionDays.TWO_WEEKS,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const httpFn = new NodejsFunction(this, 'HttpHandler', {
      entry: lambdaEntry('http'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: lambdaEnv,
      logRetention: RetentionDays.TWO_WEEKS,
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

    // Stable name so Http/Message Lambdas can invoke it without a CFN cycle
    // (AiPlayer → WS/HTTP APIs → those Lambdas → AiPlayer.functionName).
    const aiPlayerFunctionName = 'DotRaceAiPlayer';

    // AI player runner — one async invocation per AI pilot. Rotates every
    // ~10 min (self-invoke + REJOIN) so races outlive the 15 min Lambda cap.
    const aiPlayerFn = new NodejsFunction(this, 'AiPlayerHandler', {
      entry: lambdaEntry('ai-player'),
      handler: 'handler',
      functionName: aiPlayerFunctionName,
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.minutes(15),
      memorySize: 512,
      // Self-invoke on planned handoff; default Terminate would kill gen 16+.
      recursiveLoop: RecursiveLoop.ALLOW,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        WS_URL: stage.url,
        API_URL: httpApi.apiEndpoint,
        CONNECTIONS_TABLE: connectionsTable.tableName,
        BEDROCK_MODEL_ID: 'amazon.nova-micro-v1:0',
        // Fallback when spawn payload omits brain; host chooses per pilot in lobby.
        BRAIN: 'heuristic',
        AI_HANDOFF_AFTER_MS: String(10 * 60 * 1000),
        BEDROCK_TIMEOUT_MS: '12000',
      },
      logRetention: RetentionDays.TWO_WEEKS,
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
    aiPlayerFn.addToRolePolicy(invokeAiPlayer);

    new CfnOutput(this, 'AiPlayerFunctionName', { value: aiPlayerFunctionName }).overrideLogicalId(
      'AiPlayerFunctionName'
    );

    const ollaya = addOllayaHost(this, {
      connectionsTable,
      aiPlayerFn,
      httpFn,
      messageFn,
      disconnectFn,
    });

    // Already deployed and imported by DotRaceCostGuardStack. Keep the same
    // construct path and export name so this update does not drop the topic.
    const alerts = new Topic(this, 'OpsAlerts', {
      displayName: 'DotRace ops and cost alerts',
      topicName: 'dotrace-ops-alerts',
    });
    alerts.addSubscription(new EmailSubscription('nandopoiato@gmail.com'));
    alerts.addToResourcePolicy(
      new PolicyStatement({
        sid: 'CloudWatchAlarmsPublish',
        actions: ['sns:Publish'],
        principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
        resources: [alerts.topicArn],
        conditions: {
          ArnLike: {
            'aws:SourceArn': `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:*`,
          },
        },
      })
    );
    alerts.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AWSAnomalyDetectionSNSPublishingPermissions',
        actions: ['sns:Publish'],
        principals: [new ServicePrincipal('costalerts.amazonaws.com')],
        resources: [alerts.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      })
    );
    const alertExport = new CfnOutput(this, 'ExportsOutputRefOpsAlertsB39E82AA7157E178', {
      value: alerts.topicArn,
      exportName: 'DotRaceWsStack:ExportsOutputRefOpsAlertsB39E82AA7157E178',
    });
    alertExport.overrideLogicalId('ExportsOutputRefOpsAlertsB39E82AA7157E178');
    new CfnOutput(this, 'AlertTopicArn', { value: alerts.topicArn }).overrideLogicalId('AlertTopicArn');

    const notify = new SnsAction(alerts);
    const aiErrors = new Alarm(this, 'AiPlayerErrorsAlarm', {
      alarmName: 'DotRaceAiPlayer-Errors',
      alarmDescription: 'AI worker errors > 0 over 5 minutes',
      metric: aiPlayerFn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    aiErrors.addAlarmAction(notify);
    const aiDuration = new Alarm(this, 'AiPlayerDurationAlarm', {
      alarmName: 'DotRaceAiPlayer-DurationP99',
      alarmDescription: 'AI worker p99 duration > 80% of 30s timeout',
      metric: aiPlayerFn.metricDuration({ period: Duration.minutes(5), statistic: 'p99' }),
      threshold: 24000,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    aiDuration.addAlarmAction(notify);
    const aiInvocations = new Alarm(this, 'AiPlayerInvocationsAlarm', {
      alarmName: 'DotRaceAiPlayer-Invocations',
      alarmDescription: 'AI worker invocations > 150 per 5 minutes',
      metric: aiPlayerFn.metricInvocations({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 150,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    aiInvocations.addAlarmAction(notify);
    const aiConcurrent = new Alarm(this, 'AiPlayerConcurrentAlarm', {
      alarmName: 'DotRaceAiPlayer-ConcurrentExecutions',
      alarmDescription: 'AI worker concurrent > 2 (reserved cap missing or raised)',
      metric: new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'ConcurrentExecutions',
        dimensionsMap: { FunctionName: aiPlayerFunctionName },
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 2,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    aiConcurrent.addAlarmAction(notify);

    new CfnOutput(this, 'WebSocketUrl', { value: stage.url });
    new CfnOutput(this, 'WebSocketApiId', { value: webSocketApi.apiId });
    new CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'HttpApiId', { value: httpApi.httpApiId });
    new CfnOutput(this, 'ConnectionsTableName', { value: connectionsTable.tableName });
    new CfnOutput(this, 'LeaderboardTableName', { value: leaderboardTable.tableName });
    new CfnOutput(this, 'OllayaInstanceId', { value: ollaya.instanceId });
    new CfnOutput(this, 'OllayaUrlParameter', { value: ollaya.urlParameterName });
  }
}

const OLLAYA_POWER_FUNCTION_NAME = 'DotRaceOllayaPower';

function ollayaUserData(secretId: string, region: string): UserData {
  const userData = UserData.forLinux();
  userData.addCommands(
    'set -euo pipefail',
    'trap "shutdown -h now" EXIT',
    'exec > /var/log/ollaya-bootstrap.log 2>&1',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update',
    'apt-get install -y curl unzip ca-certificates',
    'curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip',
    'unzip -q /tmp/awscliv2.zip -d /tmp',
    '/tmp/aws/install',
    'curl -fsSL https://ollaya.dev/install.sh | sh',
    `SECRET_ID="${secretId}"`,
    `REGION="${region}"`,
    'KEY="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" --query SecretString --output text)"',
    'install -d -m 700 /etc/ollaya',
    'umask 077',
    'printf "OLLAYA_HOST=0.0.0.0:11435\\nOLLAYA_API_KEY=%s\\nOLLAYA_KEEP_ALIVE=-1\\n" "$KEY" > /etc/ollaya/env',
    'BIN="$(command -v ollaya || true)"',
    'if [ -z "$BIN" ]; then BIN=/usr/local/bin/ollaya; fi',
    'cat > /etc/systemd/system/ollaya.service << EOF',
    '[Unit]',
    'Description=Ollaya decision server',
    'After=network-online.target',
    'Wants=network-online.target',
    '[Service]',
    'Type=simple',
    'EnvironmentFile=/etc/ollaya/env',
    'ExecStart=${BIN} serve',
    'Restart=on-failure',
    'RestartSec=2',
    '[Install]',
    'WantedBy=multi-user.target',
    'EOF',
    'systemctl daemon-reload',
    'systemctl enable ollaya',
    'systemctl restart ollaya',
    'if curl -sf --retry 30 --retry-delay 2 --retry-connrefused http://127.0.0.1:11435/; then',
    '  OLLAYA_HOST=127.0.0.1:11435 OLLAYA_API_KEY="$KEY" ollaya pull laya || echo "ollaya pull failed"',
    'else',
    '  echo "ollaya did not become healthy"',
    'fi',
    'shutdown -h now'
  );
  return userData;
}

function addOllayaHost(
  stack: DotRaceWsStack,
  deps: {
    connectionsTable: Table;
    aiPlayerFn: NodejsFunction;
    httpFn: NodejsFunction;
    messageFn: NodejsFunction;
    disconnectFn: NodejsFunction;
  }
): { instanceId: string; urlParameterName: string } {
  const vpc = new Vpc(stack, 'OllayaVpc', {
    maxAzs: 1,
    natGateways: 0,
    subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
  });

  const apiKey = new Secret(stack, 'OllayaApiKey', {
    description: 'Bearer token the Dot Race bot sends to Ollaya',
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });

  const urlParameter = new StringParameter(stack, 'OllayaUrl', {
    parameterName: '/dotrace/ollaya-url',
    stringValue: 'pending',
    description: 'Current Ollaya base URL. pending while the instance is stopped.',
  });

  const host = new Instance(stack, 'OllayaHost', {
    vpc,
    vpcSubnets: { subnetType: SubnetType.PUBLIC },
    instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
    machineImage: MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id',
      { os: OperatingSystemType.LINUX }
    ),
    requireImdsv2: true,
    instanceInitiatedShutdownBehavior: InstanceInitiatedShutdownBehavior.STOP,
    blockDevices: [
      {
        deviceName: '/dev/sda1',
        volume: BlockDeviceVolume.ebs(20, {
          volumeType: EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      },
    ],
    userData: ollayaUserData(apiKey.secretArn, stack.region),
  });
  host.connections.allowFrom(Peer.anyIpv4(), Port.tcp(11435), 'Ollaya decide API');
  Tags.of(host).add('Name', 'dotrace-ollaya');
  apiKey.grantRead(host);

  const powerFn = new NodejsFunction(stack, 'OllayaPowerHandler', {
    entry: path.join(__dirname, '..', 'lambda', 'src', 'ollaya-power.ts'),
    handler: 'handler',
    functionName: OLLAYA_POWER_FUNCTION_NAME,
    runtime: Runtime.NODEJS_20_X,
    timeout: Duration.minutes(4),
    memorySize: 256,
    environment: {
      NODE_OPTIONS: '--enable-source-maps',
      CONNECTIONS_TABLE: deps.connectionsTable.tableName,
      OLLAYA_INSTANCE_ID: host.instanceId,
      OLLAYA_URL_PARAMETER: urlParameter.parameterName,
      OLLAYA_API_KEY_SECRET: apiKey.secretArn,
      OLLAYA_IDLE_MS: String(3 * 60 * 1000),
      OLLAYA_MODEL: 'laya',
    },
    bundling: { externalModules: ['@aws-sdk/*'] },
  });
  deps.connectionsTable.grantReadWriteData(powerFn);
  apiKey.grantRead(powerFn);
  urlParameter.grantWrite(powerFn);
  urlParameter.grantRead(deps.aiPlayerFn);
  apiKey.grantRead(deps.aiPlayerFn);
  powerFn.addToRolePolicy(
    new PolicyStatement({
      actions: ['ec2:StartInstances', 'ec2:StopInstances'],
      resources: [`arn:aws:ec2:${stack.region}:${stack.account}:instance/${host.instanceId}`],
    })
  );
  powerFn.addToRolePolicy(
    new PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    })
  );

  const invokePower = new PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [
      `arn:aws:lambda:${stack.region}:${stack.account}:function:${OLLAYA_POWER_FUNCTION_NAME}`,
    ],
  });
  for (const fn of [deps.httpFn, deps.messageFn, deps.disconnectFn]) {
    fn.addEnvironment('OLLAYA_POWER_FUNCTION_NAME', OLLAYA_POWER_FUNCTION_NAME);
    fn.addToRolePolicy(invokePower);
  }

  deps.aiPlayerFn.addEnvironment('OLLAYA_URL_PARAMETER', urlParameter.parameterName);
  deps.aiPlayerFn.addEnvironment('OLLAYA_API_KEY_SECRET', apiKey.secretArn);
  deps.aiPlayerFn.addEnvironment('OLLAYA_MODEL', 'laya');

  return { instanceId: host.instanceId, urlParameterName: urlParameter.parameterName };
}
