import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

/** A worker-like global whose prototype exposes getter-only APIs, as Chromium's WorkerGlobalScope does. */
function fakeWorkerGlobal() {
  const proto: Record<string, unknown> = {};
  for (const name of ["indexedDB", "caches"]) {
    Object.defineProperty(proto, name, { get: () => ({ open: () => null }), configurable: true });
  }
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "Worker", "Blob", "importScripts"]) {
    proto[name] = () => null;
  }
  const messages: unknown[] = [];
  const self = Object.create(proto) as Record<string, unknown> & { onmessage?: (event: { data: unknown }) => void };
  self.postMessage = (message: unknown) => messages.push(message);
  self.URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined };
  return { self, messages };
}

function boot(self: object) {
  new Function("self", getWorkerBootstrapSource())(self);
}

describe("sandboxed parser worker bootstrap", () => {
  it("disables child worker and object URL escape hatches", () => {
    const source = getWorkerBootstrapSource();

    for (const name of ["Worker", "SharedWorker", "Blob", "RTCPeerConnection", "RTCDataChannel", "indexedDB"]) {
      expect(source).toContain(`"${name}"`);
    }
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("starts when globals are getter-only accessors and hides them from the parser", () => {
    const { self, messages } = fakeWorkerGlobal();
    boot(self);

    for (const name of ["indexedDB", "caches", "fetch", "XMLHttpRequest", "Worker", "Blob"]) {
      expect(self[name]).toBeUndefined();
    }
    expect((self.URL as Record<string, unknown>).createObjectURL).toBeUndefined();

    // Free globals inside a real worker resolve to `self`; here the parser only sees the shadowed `self`.
    self.onmessage!({ data: { type: "init",
      source: "exports.parseStdoutLine = (line, ts) => [{ kind: 'stdout', ts, text: line + ':' + typeof self }];" } });
    self.onmessage!({ data: { type: "parse", id: 7, line: "hello", ts: "t1" } });

    expect(messages).toEqual([
      { type: "ready" },
      { type: "result", id: 7, entries: [{ kind: "stdout", ts: "t1", text: "hello:undefined" }] },
    ]);
  });

  it("fails closed when a global cannot be hidden", () => {
    const { self } = fakeWorkerGlobal();
    Object.preventExtensions(self);
    expect(() => boot(self)).toThrow(/could not disable/);
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + msg.source');
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });
});
