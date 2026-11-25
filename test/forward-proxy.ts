import { createServer, request } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

export type ForwardProxy = { url: string; requests: string[]; close(): Promise<void> };

/** A plain HTTP forward proxy: absolute-URI requests for http, CONNECT tunnels for the rest. */
export async function startForwardProxy(): Promise<ForwardProxy> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);

    const upstream = request(
      req.url ?? '',
      { method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  server.on('connect', (req, client: Socket, head) => {
    requests.push(`CONNECT ${req.url}`);

    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });

    sockets.add(upstream).add(client);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
