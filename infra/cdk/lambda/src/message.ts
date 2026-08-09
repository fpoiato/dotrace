import { APIGatewayProxyHandler } from 'aws-lambda';
import { handleClientAction } from './lib/actions';
import { sendToConnection } from './lib/ddb';
import { ok, parseBody, WsEnvelope } from './lib/response';

/**
 * WebSocket `$default` / `message` route.
 * Kept for HELLO/PING (channel bind + keepalive) and backward compatibility.
 * Game commands prefer the HTTP API so a flaky mobile socket does not drop actions.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const connectionId = event.requestContext.connectionId!;
  const body = parseBody<WsEnvelope>(event);

  if (!body?.action) {
    return ok();
  }

  try {
    await handleClientAction(connectionId, body, { pushToCaller: true });
  } catch (err) {
    console.error('Message handler error', err);
    await sendToConnection(connectionId, {
      action: 'ERROR',
      payload: { message: 'Internal server error' },
    });
  }

  return ok();
};
