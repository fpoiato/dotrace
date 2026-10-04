/**
 * Ask the Ollaya power Lambda to start or stop the decision host.
 * Missing configuration is a no-op so local play without the instance still works.
 *
 * The payload stays `{ action, generation }`. While this stack still owns the
 * EC2 the function is DotRaceOllayaPower; after the cutover it is LayaPower
 * in fpoiato/laya-host. Call sites do not change.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { bumpOllayaGeneration } from './ddb';

const lambdaClient = new LambdaClient({});

export async function requestOllayaPower(action: 'start' | 'stop'): Promise<void> {
  const functionName = process.env.OLLAYA_POWER_FUNCTION_NAME;
  if (!functionName) return;
  try {
    const generation = await bumpOllayaGeneration(action === 'start' ? 'running' : 'stopped');
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ action, generation })),
      })
    );
  } catch (err) {
    console.warn(
      `[OLLAYA] ${action} request failed:`,
      err instanceof Error ? err.message : err
    );
  }
}
