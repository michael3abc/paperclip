import { Button } from "@/components/ui/button";

const keys = [["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl+C", "\x03"], ["Ctrl+D", "\x04"],
  ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"]];

/** Keys a phone keyboard does not have. */
export function HostTerminalKeys({ disabled, onKey }: { disabled: boolean; onKey: (data: string) => void }) {
  return <div className="flex shrink-0 gap-1 overflow-x-auto sm:hidden" aria-label="終端快捷鍵">
    {keys.map(([label, data]) => <Button key={label} variant="outline" size="sm" disabled={disabled}
      onPointerDown={event => event.preventDefault()} onClick={() => onKey(data!)}>{label}</Button>)}
  </div>;
}
