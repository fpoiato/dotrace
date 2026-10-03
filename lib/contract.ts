/** Public names any project uses to find the shared host. */
export const LAYA_POWER_FUNCTION_NAME = 'LayaPower';
export const LAYA_POWER_ROLE_NAME = 'LayaPowerRole';
export const LAYA_CONTROL_TABLE_NAME = 'LayaControl';
export const LAYA_URL_PARAMETER = '/laya/url';
export const LAYA_API_KEY_SECRET_PARAMETER = '/laya/api-key-secret-arn';
export const LAYA_INSTANCE_ID_PARAMETER = '/laya/instance-id';
export const LAYA_POWER_FUNCTION_PARAMETER = '/laya/power-function-name';
export const LAYA_SECRET_NAME = 'laya/api-key';

export const DEFAULT_PORT = 11435;
export const DEFAULT_IDLE_MS = 3 * 60 * 1000;
export const DEFAULT_MODEL = 'laya';

/**
 * Dot Race still records its on/off generation in its own connections table
 * and invokes the power Lambda without a consumer id. That id is reserved
 * so another project cannot overwrite Dot Race's lease by accident.
 */
export const LEGACY_CONSUMER = 'dotrace';
export const LEGACY_CONTROL_ID = 'sys#ollaya';
