import { LayaHostStackProps } from '../lib/laya-host-stack';

/**
 * This entrypoint deploys the one shared host Dot Race and Truco already use.
 * The stack construct itself stays free of those project names.
 */
export function deployConfig(get: (key: string) => unknown): LayaHostStackProps {
  const createInstance = get('createInstance') === true || get('createInstance') === 'true';
  const existingInstanceId = text(get('existingInstanceId'));
  const existingSecretArn = text(get('existingSecretArn'));

  if (createInstance && existingInstanceId) {
    throw new Error('Pass -c createInstance=true or -c existingInstanceId=i-..., not both');
  }
  if (!createInstance && !existingInstanceId) {
    throw new Error(
      'Refusing to create a second EC2. For the host Dot Race already runs, deploy with ' +
        '-c existingInstanceId=i-... -c existingSecretArn=arn:... ' +
        '(scripts/migrate-from-dotrace.sh prints the values). ' +
        'A brand-new host in an empty account needs -c createInstance=true.'
    );
  }
  if (!createInstance && !existingSecretArn) {
    throw new Error('existingSecretArn is required together with existingInstanceId');
  }

  return {
    createInstance,
    existingInstanceId,
    existingSecretArn,
    legacyUrlParameterName: '/dotrace/ollaya-url',
    legacyConnectionsTableName: 'DotRaceConnections',
    model: 'laya',
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
