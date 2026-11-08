// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ArtifactFileRow } from "./artifacts/v1/ArtifactFileRow";
import { testSubject } from "./artifacts/v1/test-subject";
import { RichWorkProductCard } from "./task-chat/RichWorkProductCard";
import { TaskChatProtocolCard } from "./task-chat/TaskChatProtocolCard";
import { MarkdownBody } from "./MarkdownBody";
import { PdfPreviewProvider, usePdfLink } from "./PdfPreviewProvider";
import type { IssueWorkProduct } from "@paperclipai/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/hooks/useArtifactsV1Enabled", () => ({ useArtifactsV1Enabled: () => ({ enabled: false, loaded: true }) }));
const href = "/api/attachments/file-1/content";
const source = { id: "file-1", byteSize: 9, attachmentId: "file-1", filename: "report.pdf", contentType: "application/pdf", contentPath: href, openPath: href + "?inline=1", downloadPath: href + "?download=1" };
const pdfResponse = () => new Response("%PDF-1.7\n", { headers: { "content-type": "application/pdf" } });
const fetchMock = vi.fn();
const createUrl = vi.fn(() => "blob:pdf-preview");
const revokeUrl = vi.fn();
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));
function LocationProbe() {
  const location = useLocation(), navigate = useNavigate();
  return <><output data-location>{JSON.stringify(location)}</output><button onClick={() => navigate("/tasks/next")}>Navigate</button></>;
}
function PdfLink() {
  const onPdfClick = usePdfLink();
  return <a href={href} target="_blank" onClick={event => onPdfClick(event, { href, filename: "report.pdf" })}>PDF</a>;
}

describe("in-app PDF preview", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("fetch", fetchMock.mockReset().mockImplementation(async () => pdfResponse()));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl.mockClear(), revokeObjectURL: revokeUrl.mockClear() }));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });
  async function mount(children: ReactNode, provider = true) {
    const content = <>{children}<LocationProbe /></>;
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[{ pathname: "/tasks/current", hash: "#attachment-file-1", state: { from: "task" } }]}>
          <ThemeProvider>{provider ? <PdfPreviewProvider>{content}</PdfPreviewProvider> : content}</ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
  }
  async function click(element: Element, init: MouseEventInit = {}) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    await act(async () => { element.dispatchEvent(event); await nextTick(); });
    return event;
  }
  const dialog = () => document.querySelector('[data-slot="dialog-content"]');
  const back = () => Array.from(dialog()!.querySelectorAll("button")).find(b => b.textContent === "Back")!;

  it("opens the real artifact row, then Back preserves route, focus and scroller", async () => {
    await mount(<div data-scroller><ArtifactFileRow subject={testSubject({ kind: "pdf", filename: "report.pdf" })} source={source} /></div>);
    const scroller = container.querySelector<HTMLElement>("[data-scroller]")!; scroller.scrollTop = 172;
    const location = container.querySelector("[data-location]")!.textContent;
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="artifact-v1-row-open"]')!;
    link.focus();
    expect((await click(link)).defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(href, expect.objectContaining({ credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(dialog()!.querySelector("iframe")?.getAttribute("src")).toBe("blob:pdf-preview");
    expect(dialog()!.querySelector("iframe")?.hasAttribute("sandbox")).toBe(false);
    expect(dialog()!.querySelector('[aria-label="Open original PDF"]')?.getAttribute("target")).toBe("_blank");
    expect(dialog()!.querySelector('[aria-label="Download PDF"]')?.getAttribute("href")).toBe(href + "?download=1");
    await click(back());
    expect(dialog()).toBeNull();
    expect(container.querySelector("[data-location]")!.textContent).toBe(location);
    expect(scroller.scrollTop).toBe(172); expect(document.activeElement).toBe(link);
    expect(revokeUrl).toHaveBeenCalledWith("blob:pdf-preview");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("Escape closes only the PDF above an existing mobile properties Sheet", async () => {
    const sheetChange = vi.fn();
    await mount(<Sheet open onOpenChange={sheetChange}><SheetContent aria-describedby={undefined}><SheetTitle>Properties</SheetTitle><PdfLink /></SheetContent></Sheet>);
    const sheet = document.querySelector('[data-slot="sheet-content"]')!;
    await click(sheet.querySelector("a")!);
    expect(dialog()).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await nextTick(); });
    expect(dialog()).toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBe(sheet);
    expect(sheetChange).not.toHaveBeenCalled();
  });

  it("closes and aborts pending reads on route change without reopening", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await mount(<PdfLink />);
    await click(container.querySelector("a")!);
    await click(container.querySelector("button")!);
    expect(dialog()).toBeNull();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(container.querySelector("[data-location]")!.textContent).toContain("/tasks/next");
  });

  it("has explicit retry and retains raw/download actions on denied responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await mount(<PdfLink />); await click(container.querySelector("a")!);
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain("do not have access");
    expect(createUrl).not.toHaveBeenCalled();
    expect(dialog()!.querySelector('[aria-label="Download PDF"]')).not.toBeNull();
    await click(Array.from(dialog()!.querySelectorAll("button")).find(b => b.textContent === "Retry preview")!);
    expect(dialog()!.querySelector("iframe")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves modified clicks and provider-absent links", async () => {
    await mount(<PdfLink />);
    expect((await click(container.querySelector("a")!, { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(dialog()).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
    await mount(<PdfLink />, false);
    expect((await click(container.querySelector("a")!)).defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the work-product Download separate from Open preview", async () => {
    const workProduct = { id: "wp-1", type: "artifact", provider: "paperclip", title: "Report", metadata: { ...source, originalFilename: "report.pdf" } } as unknown as IssueWorkProduct;
    await mount(<RichWorkProductCard workProduct={workProduct} href={href} />);
    const download = container.querySelector<HTMLAnchorElement>('a[aria-label="Download: Report"]')!;
    expect(download.getAttribute("href")).toBe(href + "?download=1");
    expect(download.hasAttribute("download")).toBe(true);
    download.addEventListener("click", event => event.preventDefault());
    await click(download); expect(dialog()).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
    await click(container.querySelector('a[aria-label="Open preview: Report"]')!);
    expect(dialog()).not.toBeNull();
  });

  it("opens a legacy protocol attachment without leaving its task", async () => {
    await mount(<TaskChatProtocolCard item={{ id: "resource", kind: "protocol", surface: "resource", resourceKind: "attachment", title: "report.pdf", subtitle: "PDF", href }} />);
    expect((await click(container.querySelector("a")!)).defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
  });

  it("aborts on unmount and does not create a blob URL for a late response", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    await mount(<PdfLink />); await click(container.querySelector("a")!);
    await act(async () => root.render(null));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { finish(pdfResponse()); await nextTick(); });
    expect(createUrl).not.toHaveBeenCalled();
  });

  it.each([
    "[report.pdf](/api/attachments/file-1/content)",
    '[Read report](/api/attachments/file-1/content "report.pdf")',
  ])("recognizes Markdown PDF labels/titles on extensionless routes: %s", async markdown => {
    await mount(<MarkdownBody>{markdown}</MarkdownBody>);
    await click(container.querySelector("a")!); expect(dialog()).not.toBeNull();
  });
});
