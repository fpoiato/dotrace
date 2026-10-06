import {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { fetchTop10Entries, handleClientAction } from './lib/actions';
import { loadReplay, saveReplay } from './lib/replays';
import { parseBody, WsEnvelope } from './lib/response';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Connection-Id',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function connectionIdFrom(event: APIGatewayProxyEventV2, body?: WsEnvelope): string | undefined {
  const header =
    event.headers?.['x-connection-id'] ??
    event.headers?.['X-Connection-Id'] ??
    event.headers?.['X-CONNECTION-ID'];
  if (header?.trim()) return header.trim();
  if (typeof body?.connectionId === 'string' && body.connectionId.trim()) {
    return body.connectionId.trim();
  }
  return undefined;
}

/**
 * HTTP API entrypoint — client→server commands.
 * WebSocket remains the server→client push channel.
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath || event.requestContext.http.path || '';

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    if (method === 'GET' && path.endsWith('/top10')) {
      const entries = await fetchTop10Entries();
      return json(200, { action: 'TOP10', payload: { entries } });
    }

    if (method === 'POST' && /\/replays\/?$/.test(path)) {
      const body = parseBody<unknown>(event);
      const saved = await saveReplay(body);
      if (!saved.ok) {
        const statusCode = saved.reason === 'too_large' ? 413 : 400;
        const message = saved.reason === 'too_large' ? 'Replay too large' : 'Invalid replay';
        return json(statusCode, { message });
      }
      return json(201, { id: saved.id });
    }

    if (method === 'GET' && path.includes('/replays/')) {
      const id =
        event.pathParameters?.id ??
        decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
      const replay = await loadReplay(id);
      if (!replay) return json(404, { message: 'Replay not found' });
      return json(200, replay);
    }

    if (method === 'POST' && (path.endsWith('/actions') || path.endsWith('/action'))) {
      const body = parseBody<WsEnvelope & { connectionId?: string }>(event);
      if (!body?.action) {
        return json(400, { action: 'ERROR', payload: { message: 'Missing action' } });
      }

      // Channel identity comes from the live WebSocket connectionId.
      if (body.action === 'GET_TOP10') {
        const entries = await fetchTop10Entries();
        return json(200, { action: 'TOP10', payload: { entries } });
      }

      const connectionId = connectionIdFrom(event, body);
      if (!connectionId) {
        return json(400, {
          action: 'ERROR',
          payload: { message: 'X-Connection-Id header required' },
        });
      }

      const result = await handleClientAction(connectionId, body, { pushToCaller: false });
      if (result.response?.action === 'ERROR') {
        return json(400, result.response);
      }
      return json(200, result.response ?? { action: 'OK', payload: { ok: true } });
    }

    return json(404, { action: 'ERROR', payload: { message: 'Not found' } });
  } catch (err) {
    console.error('HTTP handler error', err);
    return json(500, { action: 'ERROR', payload: { message: 'Internal server error' } });
  }
};
