const WebSocket = require('ws');

class ReconnectingWebSocketClient {
  constructor({ url, baseDelayMs, maxDelayMs, onOpen, onMessage, onClose }) {
    this.url = url;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onClose = onClose;

    this.ws = null;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.hasConnectedAtLeastOnce = false;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      const isReconnect = this.hasConnectedAtLeastOnce;
      this.hasConnectedAtLeastOnce = true;
      this.reconnectAttempts = 0;
      console.log(`[CONNECTED] ${this.url}`);
      this.onOpen?.({ isReconnect });
    });

    this.ws.on('message', (messageBuffer) => {
      const raw = messageBuffer.toString();
      console.log(`[MESSAGE RECEIVED] ${raw}`);
      this.onMessage?.(raw);
    });

    this.ws.on('close', () => {
      console.log('[DISCONNECTED]');
      this.onClose?.();
      if (this.shouldReconnect) {
        this.#scheduleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      console.error('[SOCKET ERROR]', error.message);
    });
  }

  sendJson(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SEND SKIPPED] Socket is not connected yet.');
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  #scheduleReconnect() {
    const delay = Math.min(this.baseDelayMs * 2 ** this.reconnectAttempts, this.maxDelayMs);
    this.reconnectAttempts += 1;
    console.log(`[RECONNECTING] Waiting ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }
}

module.exports = {
  ReconnectingWebSocketClient,
};
