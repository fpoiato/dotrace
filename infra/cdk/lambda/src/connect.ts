import { APIGatewayProxyHandler } from 'aws-lambda';
import { ok } from './lib/response';

export const handler: APIGatewayProxyHandler = async () => {
  return ok();
};
