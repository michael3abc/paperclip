// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProviderLoginInstructions } from "./AdapterLoginChrome";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ADDRESS = "http://127.0.0.1:18973/?state=fixture-state&code=fixture-code";
let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
});

function render(submitRedirect?: (address: string) => Promise<void>, extra: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(<LocalProviderLoginInstructions adapterType="antigravity_runtime" login={{
    isolated: true, preparing: false, status: "sign_in_required", error: null, retry: () => {},
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture", submitRedirect, ...extra,
  }} />));
  return host;
}
function field(host: HTMLElement) { return host.querySelector('input[aria-label="Redirect address"]') as HTMLInputElement; }
function type(input: HTMLInputElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submitButton = (host: HTMLElement) => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Submit address") as HTMLButtonElement;

describe("Google sign-in from a different computer than the server", () => {
  it("offers the paste-back fallback only when the sign-in can accept an address", () => {
    const host = render(async () => {});
    expect(host.textContent).toContain("Signed in on a different computer than this server?");
    expect(host.textContent).toContain("http://127.0.0.1");
    expect(field(host)).not.toBeNull();
    expect(field(host).type).toBe("password");
    expect(submitButton(host).disabled).toBe(true);
    expect(field(render(undefined))).toBeNull();
  });

  it("submits the trimmed address once and then shows that sign-in is finishing", async () => {
    let finish!: () => void;
    const submit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const host = render(submit);
    type(field(host), `  ${ADDRESS}\n`);
    expect(submitButton(host).disabled).toBe(false);
    flushSync(() => { submitButton(host).click(); submitButton(host)?.click(); });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(ADDRESS));
    expect(submit).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(host.textContent).toContain("Finishing sign-in…"));
    expect(field(host)).toBeNull();
    expect(host.textContent).not.toContain("fixture-code");
  });

  it("submits on Enter and does not submit on paste alone", async () => {
    const submit = vi.fn(async () => {});
    const host = render(submit);
    const input = field(host);
    type(input, ADDRESS);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => ADDRESS } });
    input.dispatchEvent(paste);
    expect(submit).not.toHaveBeenCalled();
    flushSync(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(ADDRESS));
  });

  it("shows a rejection inline, keeps the address field and allows another try", async () => {
    const submit = vi.fn().mockRejectedValueOnce(Object.assign(new Error("That address belongs to a different sign-in attempt. Start sign-in again and use the new Google window."), { status: 422 })).mockResolvedValueOnce(undefined);
    const host = render(submit);
    type(field(host), ADDRESS);
    flushSync(() => submitButton(host).click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("different sign-in attempt"));
    expect(field(host)).not.toBeNull();
    expect(field(host).value).toBe(ADDRESS);
    expect(host.textContent).not.toContain("Finishing sign-in");
    type(field(host), ADDRESS + "&scope=x");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    flushSync(() => submitButton(host).click());
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).toContain("Finishing sign-in…"));
  });
});
