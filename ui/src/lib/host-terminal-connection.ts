import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { HostTerminalClientFrame, HostTerminalServerFrame, HostTerminalSession } from "@paperclipai/shared";

const reasons: Record<string, string> = {
  idle_timeout: "閒置 30 分鐘，已關閉。", max_duration: "已達 12 小時上限。",
  shell_exit: "Shell 已結束。", client_closed: "連線已關閉。", client_error: "連線中斷。",
  server_shutdown: "伺服器已關閉連線。", invalid_frame: "連線授權或訊框無效。",
  auth_timeout: "連線授權逾時。", startup_failed: "終端啟動失敗。請檢查主機設定。",
  process_error: "終端程序失敗。", input_overflow: "輸入超過連線容量。", output_overflow: "輸出超過連線容量。",
};

export type HostTerminalPhase = "connecting" | "ready" | "closed";
export type HostTerminalStatus = { phase: HostTerminalPhase; message: string };

/**
 * One xterm and its socket. It is independent of React: a view attaches and
 * detaches it, so leaving a page does not have to end the shell. Contents stay
 * in memory only.
 */
export class HostTerminalConnection {
  private element = document.createElement("div");
  private term = new Terminal({ cursorBlink: true, scrollback: 1000, rightClickSelectsWord: false });
  private addon = new FitAddon();
  private observer = new ResizeObserver(() => this.fit());
  private ws: WebSocket;
  private opened = false;
  private ready = false;
  private ended = false;

  constructor(session: HostTerminalSession, private onStatus: (status: HostTerminalStatus) => void) {
    this.element.className = "h-full w-full";
    this.term.loadAddon(this.addon);
    this.term.onData(data => this.input(data));
    // Ctrl+V is the browser's paste. Ctrl+C always reaches the shell as an interrupt;
    // copy with the right mouse button instead.
    this.term.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.shiftKey) return true;
      return event.key.toLowerCase() !== "v";
    });
    // Mouse right-click copies the selection, or pastes when nothing is selected.
    // Touch long-press keeps the platform menu.
    this.element.addEventListener("contextmenu", event => {
      if ((event as PointerEvent).pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      void this.rightClick();
    }, true);
    const url = new URL(session.wsPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.send({ type: "auth", sessionId: session.id, token: session.token });
    ws.onmessage = event => {
      if (this.ended) return;
      try {
        const frame: HostTerminalServerFrame = JSON.parse(event.data);
        if (frame.type === "ready") {
          this.ready = true;
          this.onStatus({ phase: "ready", message: "已連線" });
          this.fit();
          this.focus();
        } else if (frame.type === "output") this.term.write(frame.data);
        else if (frame.type === "closed") {
          this.end(`${reasons[frame.reason] ?? "終端已關閉。"}${frame.exitCode !== null ? ` (exit ${frame.exitCode})` : ""}`);
        }
      } catch { this.end("終端傳回無效訊框。"); ws.close(); }
    };
    ws.onerror = () => this.end(this.ready
      ? "連線中斷；重新連線會開啟新 shell。"
      : "連線失敗，請重新連線。請確認是用 Paperclip 的公開網址開啟（區網 IP 無法連線終端）。");
    ws.onclose = () => this.end("連線已中斷；重新連線會開啟新 shell。");
  }

  private send(frame: HostTerminalClientFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }
  private end(message: string) {
    if (this.ended) return;
    this.ended = true; this.ready = false;
    this.onStatus({ phase: "closed", message });
  }
  private fit() {
    if (!this.opened || !this.element.clientWidth || !this.element.clientHeight) return;
    this.addon.fit();
    if (this.ready) this.send({ type: "resize", cols: Math.min(500, Math.max(2, this.term.cols)), rows: Math.min(300, Math.max(1, this.term.rows)) });
  }

  private async rightClick() {
    try {
      if (this.term.hasSelection()) {
        await navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
      } else if (this.ready) {
        const text = await navigator.clipboard.readText();
        if (text) this.term.paste(text);
      }
    } catch {
      // Clipboard access denied or unavailable; Ctrl+V still pastes.
    }
    this.focus();
  }

  input(data: string) { if (this.ready) this.send({ type: "input", data }); }
  focus() { if (this.opened && this.element.clientWidth && this.element.clientHeight) this.term.focus(); }
  attach(node: HTMLElement) {
    node.appendChild(this.element);
    if (!this.opened) {
      const style = getComputedStyle(this.element);
      this.term.options.fontFamily = style.fontFamily;
      this.term.options.fontSize = Number.parseFloat(style.fontSize);
      this.term.options.theme = {
        background: style.getPropertyValue("--host-terminal-background").trim(),
        foreground: style.getPropertyValue("--host-terminal-foreground").trim(),
        cursor: style.getPropertyValue("--host-terminal-foreground").trim(),
      };
      this.term.open(this.element);
      this.opened = true;
      this.observer.observe(this.element);
    }
    this.fit();
    this.focus();
  }
  detach(node: HTMLElement) { if (this.element.parentNode === node) node.removeChild(this.element); }
  dispose() {
    this.ended = true; this.ready = false;
    this.observer.disconnect();
    this.ws.close(1000, "operator_closed");
    this.element.remove();
    this.term.dispose();
  }
}
