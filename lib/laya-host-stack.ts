import {
  Aspects,
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
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
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct, IConstruct } from 'constructs';
import * as path from 'path';
import {
  DEFAULT_IDLE_MS,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  LAYA_API_KEY_SECRET_PARAMETER,
  LAYA_CONTROL_TABLE_NAME,
  LAYA_INSTANCE_ID_PARAMETER,
  LAYA_POWER_FUNCTION_NAME,
  LAYA_POWER_FUNCTION_PARAMETER,
  LAYA_POWER_ROLE_NAME,
  LAYA_SECRET_NAME,
  LAYA_URL_PARAMETER,
  LEGACY_CONSUMER,
  LEGACY_CONTROL_ID,
} from './contract';
import { layaUserData } from './user-data';

export interface LayaHostStackProps extends StackProps {
  /**
   * Create a new EC2 host. Leave false when the machine already exists and
   * this stack should only operate it.
   */
  createInstance?: boolean;
  existingInstanceId?: string;
  existingSecretArn?: string;
  /** Also publish the current URL to these SSM names (for example /dotrace/ollaya-url). */
  legacyUrlParameterName?: string;
  /** Connections table the legacy Dot Race payload reads. Omit for a host with no legacy caller. */
  legacyConnectionsTableName?: string;
  model?: string;
  idleMs?: number;
  port?: number;
}

export class LayaHostStack extends Stack {
  constructor(scope: Construct, id: string, props: LayaHostStackProps = {}) {
    super(scope, id, props);

    const createInstance = props.createInstance === true;
    const port = props.port ?? DEFAULT_PORT;
    const model = props.model ?? DEFAULT_MODEL;
    const idleMs = props.idleMs ?? DEFAULT_IDLE_MS;
    if (createInstance && props.existingInstanceId) {
      throw new Error('Pass createInstance or existingInstanceId, not both');
    }
    if (!createInstance && !props.existingInstanceId) {
      throw new Error('existingInstanceId is required when createInstance is false');
    }
    if (!createInstance && !props.existingSecretArn) {
      throw new Error('existingSecretArn is required when attaching to an existing host');
    }

    const controlTable = new Table(this, 'Control', {
      tableName: LAYA_CONTROL_TABLE_NAME,
      partitionKey: { name: 'consumer', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const secret = props.existingSecretArn
      ? Secret.fromSecretCompleteArn(this, 'ApiKey', props.existingSecretArn)
      : new Secret(this, 'ApiKey', {
          secretName: LAYA_SECRET_NAME,
          description: 'Bearer token clients send to the shared Ollaya host',
          generateSecretString: { excludePunctuation: true, passwordLength: 32 },
        });
    if (!props.existingSecretArn) {
      retainTree(secret);
    }

    let instanceId = props.existingInstanceId ?? '';
    if (createInstance) {
      const vpc = new Vpc(this, 'Vpc', {
        maxAzs: 1,
        natGateways: 0,
        subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
      });
      retainTree(vpc);

      const host = new Instance(this, 'Host', {
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
        userData: layaUserData({
          secretId: secret.secretArn,
          region: this.region,
          model,
          port,
        }),
      });
      host.connections.allowFrom(Peer.anyIpv4(), Port.tcp(port), 'Ollaya decide API');
      Tags.of(host).add('Name', 'laya');
      secret.grantRead(host);
      retainTree(host);
      instanceId = host.instanceId;
    }

    const urlParameter = new StringParameter(this, 'Url', {
      parameterName: LAYA_URL_PARAMETER,
      stringValue: 'pending',
      description: 'Current Ollaya base URL. pending while the instance is stopped.',
    });
    new StringParameter(this, 'InstanceIdParameter', {
      parameterName: LAYA_INSTANCE_ID_PARAMETER,
      stringValue: instanceId,
      description: 'EC2 instance id of the shared Laya host',
    });
    new StringParameter(this, 'ApiKeyParameter', {
      parameterName: LAYA_API_KEY_SECRET_PARAMETER,
      stringValue: secret.secretArn,
      description: 'Secrets Manager ARN of the Ollaya API key',
    });
    new StringParameter(this, 'PowerFunctionParameter', {
      parameterName: LAYA_POWER_FUNCTION_PARAMETER,
      stringValue: LAYA_POWER_FUNCTION_NAME,
      description: 'Name of the Lambda that starts and stops the host',
    });

    const powerRole = new Role(this, 'PowerRole', {
      roleName: LAYA_POWER_ROLE_NAME,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Starts and stops the shared Laya EC2',
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    new StringParameter(this, 'PowerRoleParameter', {
      parameterName: '/laya/power-role-arn',
      stringValue: powerRole.roleArn,
      description: 'Role ARN of the Laya power Lambda',
    });

    const legacyUrls = props.legacyUrlParameterName ? [props.legacyUrlParameterName] : [];
    const environment: Record<string, string> = {
      NODE_OPTIONS: '--enable-source-maps',
      LAYA_INSTANCE_ID: instanceId,
      LAYA_URL_PARAMETER,
      LAYA_API_KEY_SECRET: secret.secretArn,
      LAYA_CONTROL_TABLE: controlTable.tableName,
      LAYA_IDLE_MS: String(idleMs),
      LAYA_MODEL: model,
      LAYA_PORT: String(port),
      LEGACY_CONSUMER,
      LEGACY_CONTROL_ID,
    };
    if (legacyUrls.length > 0) {
      environment.LEGACY_URL_PARAMETERS = legacyUrls.join(',');
    }
    if (props.legacyConnectionsTableName) {
      environment.LEGACY_CONNECTIONS_TABLE = props.legacyConnectionsTableName;
    }

    const powerFn = new NodejsFunction(this, 'PowerHandler', {
      entry: path.join(__dirname, '..', 'lambda', 'src', 'power.ts'),
      handler: 'handler',
      functionName: LAYA_POWER_FUNCTION_NAME,
      role: powerRole,
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.minutes(4),
      memorySize: 256,
      environment,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    controlTable.grantReadWriteData(powerFn);
    secret.grantRead(powerFn);
    urlParameter.grantWrite(powerFn);
    powerFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances'],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/${instanceId}`],
      })
    );
    powerFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      })
    );
    if (legacyUrls.length > 0) {
      powerFn.addToRolePolicy(
        new PolicyStatement({
          actions: ['ssm:PutParameter'],
          resources: legacyUrls.map((name) => parameterArn(this, name)),
        })
      );
    }
    if (props.legacyConnectionsTableName) {
      powerFn.addToRolePolicy(
        new PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:Scan'],
          resources: [
            `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.legacyConnectionsTableName}`,
          ],
        })
      );
    }

    new CfnOutput(this, 'InstanceId', { value: instanceId });
    new CfnOutput(this, 'PowerFunctionName', { value: LAYA_POWER_FUNCTION_NAME });
    new CfnOutput(this, 'UrlParameterName', { value: LAYA_URL_PARAMETER });
    new CfnOutput(this, 'ApiKeySecretArn', { value: secret.secretArn });
  }
}

function retainTree(scope: IConstruct): void {
  Aspects.of(scope).add({
    visit(node: IConstruct) {
      if (CfnResource.isCfnResource(node)) {
        node.applyRemovalPolicy(RemovalPolicy.RETAIN);
      }
    },
  });
}

function parameterArn(stack: Stack, name: string): string {
  const parameterPath = name.replace(/^\//, '');
  return `arn:aws:ssm:${stack.region}:${stack.account}:parameter/${parameterPath}`;
}
