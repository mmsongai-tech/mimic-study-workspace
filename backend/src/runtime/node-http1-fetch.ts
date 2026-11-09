import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

export type Http1Request = (
  url: URL,
  options: RequestOptions & { ALPNProtocols?: string[] },
  callback: (incoming: IncomingMessage) => void,
) => ClientRequest;

export const createNodeHttp1Fetch = (dependencies: {
  http?: Http1Request;
  https?: Http1Request;
} = {}): typeof fetch => async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const request = url.protocol === "https:"
    ? dependencies.https ?? httpsRequest
    : dependencies.http ?? httpRequest;
  const headers = Object.fromEntries(new Headers(init.headers).entries());

  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      method: init.method,
      headers,
      signal: init.signal ?? undefined,
      ...(url.protocol === "https:" ? { ALPNProtocols: ["http/1.1"] } : {}),
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      incoming.once("error", reject);
      incoming.once("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: incoming.statusCode ?? 500,
          ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
          headers: responseHeaders,
        }));
      });
    });
    outgoing.once("error", reject);
    if (typeof init.body === "string" || init.body instanceof Uint8Array) outgoing.write(init.body);
    else if (init.body !== undefined && init.body !== null) {
      outgoing.destroy(new TypeError("The Router HTTP/1.1 transport accepts only buffered request bodies."));
      return;
    }
    outgoing.end();
  });
};

export const nodeHttp1Fetch = createNodeHttp1Fetch();
