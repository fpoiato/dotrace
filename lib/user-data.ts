import { UserData } from 'aws-cdk-lib/aws-ec2';

export function layaUserData(options: {
  secretId: string;
  region: string;
  model: string;
  port: number;
}): UserData {
  const model = assertToken(options.model, 'model');
  const port = options.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
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
    `SECRET_ID="${options.secretId}"`,
    `REGION="${options.region}"`,
    'KEY="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" --query SecretString --output text)"',
    'install -d -m 700 /etc/ollaya',
    'umask 077',
    `printf "OLLAYA_HOST=0.0.0.0:${port}\\nOLLAYA_API_KEY=%s\\nOLLAYA_KEEP_ALIVE=-1\\n" "$KEY" > /etc/ollaya/env`,
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
    `if curl -sf --retry 30 --retry-delay 2 --retry-connrefused http://127.0.0.1:${port}/; then`,
    `  OLLAYA_HOST=127.0.0.1:${port} OLLAYA_API_KEY="$KEY" ollaya pull ${model} || echo "ollaya pull failed"`,
    'else',
    '  echo "ollaya did not become healthy"',
    'fi',
    'shutdown -h now'
  );
  return userData;
}

function assertToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
    throw new Error(`${label} must be 1-64 characters of letters, numbers, and . _ : -`);
  }
  return value;
}
