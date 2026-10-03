# laya-host

Servidor [Ollaya](https://ollaya.dev) com o modelo `laya`, numa EC2 `t4g.medium` que fica desligada quando ninguém precisa dela. O projeto é de propósito agnóstico: Dot Race, Truco ou qualquer outro cliente usam a mesma máquina e as mesmas Lambdas.

A instância para no fim do bootstrap e só volta quando alguém pede `start`. O IP público muda a cada partida, então a URL corrente fica no SSM.

## Contrato

| Recurso | Nome |
|---|---|
| Lambda que liga e desliga | `LayaPower` |
| Role dessa Lambda | `LayaPowerRole` |
| Tabela de leases | `LayaControl` |
| URL (`pending` enquanto parada) | `/laya/url` |
| ARN da API key | `/laya/api-key-secret-arn` |
| Instance id | `/laya/instance-id` |
| Nome da Lambda | `/laya/power-function-name` |
| Porta | `11435` |
| Modelo | `laya` |
| Ociosidade antes de desligar | 3 minutos |

`LayaPower` também escreve a mesma URL em `/dotrace/ollaya-url`. Esse parâmetro é o que Dot Race e Truco já leem. Não é do modelo do host; está só no `bin/app.ts` deste deploy.

### Ligar e desligar

Qualquer projeto que não seja o Dot Race grava um lease e invoca a Lambda:

```json
{ "action": "start", "consumer": "truco", "generation": 4 }
```

```json
{ "action": "stop", "consumer": "truco", "generation": 5 }
```

O helper `client/request-power.ts` faz as duas coisas. A instância só desliga quando **esse** pedido ainda é o mais recente e **nenhum** outro projeto está com lease `running`.

O Dot Race não muda o payload. Continua enviando só `{ "action", "generation" }`, com a geração em `DotRaceConnections` (`sys#ollaya`). A Lambda trata esse pedido como o consumidor `dotrace` e ainda exige que a sala esteja vazia. Um lease `running` do Truco impede o Dot Race de desligar a máquina, e o contrário também.

A API key vai no header `Authorization: Bearer …`. O segredo está no ARN publicado em `/laya/api-key-secret-arn`.

## O que cada projeto precisa

- `lambda:InvokeFunction` em `LayaPower`
- `dynamodb:UpdateItem` em `LayaControl` (só quem usa o helper; o Dot Race não escreve nessa tabela)
- `ssm:GetParameter` em `/laya/url` (ou em `/dotrace/ollaya-url`, que recebe o mesmo valor)
- `secretsmanager:GetSecretValue` no segredo publicado

Sugestão de uso:

```ts
import { requestLayaPower } from './request-power';

await requestLayaPower('start', 'truco');
// ... chama http://<url de /laya/url>/api/decide
await requestLayaPower('stop', 'truco');
```

O `consumer` é o id do projeto. `dotrace` é reservado.

## Deploy desta conta

Não rode `cdk deploy` sem contexto. Sem isso o app recusa criar uma segunda EC2.

A máquina que o Dot Race criou continua sendo a mesma. O primeiro deploy deste repo só cria a tabela, a Lambda `LayaPower` e os parâmetros `/laya/*`, apontando para essa instância:

```bash
npm ci
export AWS_PROFILE=nandopoiato
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-east-1
./scripts/migrate-from-dotrace.sh          # mostra instance id, segredo e o comando
./scripts/migrate-from-dotrace.sh --deploy # cria o stack sem uma EC2 nova
```

Isso exige que o stack `DotRaceWsStack` ainda publique `OllayaInstanceId` (e, de preferência, `OllayaApiKeyArn`).

Host novo, em outra conta, sem reaproveitar a instância:

```bash
npx cdk deploy -c createInstance=true
```

A EC2, o disco, a VPC e o segredo ficam com `DeletionPolicy: Retain`.

## Ordem para o Dot Race soltar a EC2

O pipeline do Dot Race apaga o que sair do template. A ordem abaixo evita apagar a máquina:

1. Entrar o PR que marca a EC2, a VPC, o segredo e `/dotrace/ollaya-url` com `DeletionPolicy: Retain`, e esperar o deploy.
2. Rodar `./scripts/migrate-from-dotrace.sh --deploy` neste repo. A Lambda `LayaPower` passa a ligar e desligar a instância que já existe. O script copia a URL atual para `/laya/url`.
3. Aí sim, entrar o PR do Dot Race que remove a EC2 do stack e passa a invocar `LayaPower`. O pipeline desse PR recusa o deploy se o passo 1 não estiver no stack ao vivo ou se `LayaHostStack` não existir. Com o Retain já aplicado, a instância, o disco e o segredo continuam; a Lambda antiga `DotRaceOllayaPower` sai, para não haver dois controladores.

O jogo não muda de contrato: as mesmas chamadas `start` / `stop`, a mesma regra de sala vazia, o mesmo modelo `laya`.

## Desenvolvimento

```bash
npm ci
npm test
npx cdk synth -c createInstance=true
```

Node.js 20. Conta e região de teste estão em `cdk.context.json` para o synth não precisar de credencial.
