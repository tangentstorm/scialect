import WebSocket from 'ws';

export class CloudRelay {
  private ws: WebSocket | null = null;
  private connecting = false;
  private pending = new Map<string, (reply: any) => void>();

  constructor(private url: string) {
    this.connect();
    setInterval(() => this.connect(), 5000); // try to reconnect
  }

  private connect() {
    if (this.ws || this.connecting) return;
    this.connecting = true;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[cloud-relay] connected to cloud server');
      this.connecting = false;
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const resolve = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch (e) {
        console.error('[cloud-relay] bad message from cloud', e);
      }
    });

    ws.on('close', () => {
      console.log('[cloud-relay] cloud connection closed');
      this.ws = null;
      this.connecting = false;
    });

    ws.on('error', (err) => {
      console.error('[cloud-relay] cloud connection error', err.message);
      this.ws = null;
      this.connecting = false;
    });
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async forward(request: any): Promise<any> {
    if (!this.isConnected()) {
      return {
        id: request.id,
        kind: 'error',
        message: 'cloud server unavailable (try again later)',
      };
    }

    return new Promise((resolve) => {
      this.pending.set(request.id, resolve);
      this.ws!.send(JSON.stringify(request));

      // timeout safety
      setTimeout(() => {
        if (this.pending.has(request.id)) {
          this.pending.delete(request.id);
          resolve({
            id: request.id,
            kind: 'error',
            message: 'cloud request timed out',
          });
        }
      }, 30000);
    });
  }
}
