// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const xterm = vi.hoisted(() => ({
  instance: null as null | {
    keyHandler: (event: KeyboardEvent) => boolean;
    selection: string;
    pasted: string[];
    options: Record<string, unknown>;
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    keyHandler: (event: KeyboardEvent) => boolean = () => true;
    selection = "";
    pasted: string[] = [];
    cols = 80; rows = 24;
    constructor(public options: Record<string, unknown>) { xterm.instance = this; }
    loadAddon() {}
    onData() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler; }
    hasSelection() { return this.selection.length > 0; }
    getSelection() { return this.selection; }
    clearSelection() { this.selection = ""; }
    paste(text: string) { this.pasted.push(text); }
    open() {}
    focus() {}
    write() {}
    dispose() {}
  },
}));

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() {}
}

const clipboard = { writeText: vi.fn(async () => {}), readText: vi.fn(async () => "pasted text") };

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  clipboard.writeText.mockClear(); clipboard.readText.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

async function connection() {
  const { HostTerminalConnection } = await import("./host-terminal-connection");
  const current = new HostTerminalConnection({ id: "s", token: "t", wsPath: "/ws", expiresAt: "" } as never, () => {});
  const socket = (current as unknown as { ws: FakeSocket }).ws;
  socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
  const element = (current as unknown as { element: HTMLElement }).element;
  return { current, element, term: xterm.instance! };
}
const key = (key: string) => ({ type: "keydown", key, ctrlKey: true, altKey: false, shiftKey: false }) as KeyboardEvent;

it("sends Ctrl+C to the shell even when text is selected, and leaves Ctrl+V to the browser", async () => {
  const { term } = await connection();
  term.selection = "chosen";
  expect(term.keyHandler(key("c"))).toBe(true);
  expect(term.keyHandler(key("v"))).toBe(false);
  expect(term.options.rightClickSelectsWord).toBe(false);
});

it("copies the selection on right-click", async () => {
  const { element, term } = await connection();
  term.selection = "chosen";
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("chosen"));
  expect(term.selection).toBe("");
  expect(clipboard.readText).not.toHaveBeenCalled();
});

it("pastes on right-click when nothing is selected", async () => {
  const { element, term } = await connection();
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(term.pasted).toEqual(["pasted text"]));
  expect(clipboard.writeText).not.toHaveBeenCalled();
});
