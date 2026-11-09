import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { createNodeHttp1Fetch, type Http1Request } from "../node-http1-fetch.js";

test("forces HTTPS Router requests onto HTTP/1.1 without exposing the body", async () => {
  let receivedOptions: (RequestOptions & { ALPNProtocols?: string[] }) | undefined;
  let receivedBody = "";
  const request: Http1Request = (_url, options, callback) => {
    receivedOptions = options;
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.write = ((chunk: string | Uint8Array) => {
      receivedBody += Buffer.from(chunk).toString("utf8");
      return true;
    }) as ClientRequest["write"];
    outgoing.destroy = (() => outgoing) as ClientRequest["destroy"];
    outgoing.end = (() => {
      const incoming = new EventEmitter() as IncomingMessage;
      incoming.statusCode = 200;
      incoming.statusMessage = "OK";
      incoming.headers = { "content-type": "application/json" };
      callback(incoming);
      queueMicrotask(() => {
        incoming.emit("data", Buffer.from('{"ok":true}'));
        incoming.emit("end");
      });
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  };
  const fetch = createNodeHttp1Fetch({ https: request });

  const response = await fetch("https://router.example/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer hidden", "content-type": "application/json" },
    body: '{"synthetic":true}',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedOptions?.ALPNProtocols, ["http/1.1"]);
  assert.equal(receivedBody, '{"synthetic":true}');
  assert.deepEqual(await response.json(), { ok: true });
});
