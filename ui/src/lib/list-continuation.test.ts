import { describe, expect, it } from "vitest";
import { continueListOnNewline } from "./list-continuation";

/** Apply an edit the way a textarea would, so assertions read as before/after text. */
function press(value: string, caret: number): { value: string; caret: number } | null {
  const edit = continueListOnNewline(value, caret);
  if (!edit) return null;
  return {
    value: value.slice(0, edit.from) + edit.insert + value.slice(edit.to),
    caret: edit.caret,
  };
}

describe("continueListOnNewline", () => {
  it("continues a numbered list with the next number", () => {
    const text = "1. 第一項";
    expect(press(text, text.length)).toEqual({ value: "1. 第一項\n2. ", caret: "1. 第一項\n2. ".length });
  });

  it("carries the number past one digit and keeps the delimiter and spacing", () => {
    expect(press("9. x", 4)?.value).toBe("9. x\n10. ");
    expect(press("1) x", 4)?.value).toBe("1) x\n2) ");
    expect(press("3.  x", 5)?.value).toBe("3.  x\n4.  ");
  });

  it("keeps indentation for nested items", () => {
    expect(press("  1. a", 6)?.value).toBe("  1. a\n  2. ");
    expect(press("\t- a", 4)?.value).toBe("\t- a\n\t- ");
  });

  it("repeats the bullet character", () => {
    expect(press("- a", 3)?.value).toBe("- a\n- ");
    expect(press("* a", 3)?.value).toBe("* a\n* ");
    expect(press("+ a", 3)?.value).toBe("+ a\n+ ");
  });

  it("continues only the line the caret is on", () => {
    const text = "intro\n1. a\n2. b\nouter";
    const caret = "intro\n1. a\n2. b".length;
    expect(press(text, caret)?.value).toBe("intro\n1. a\n2. b\n3. \nouter");
  });

  it("moves text after the caret into the new item", () => {
    expect(press("1. abcd", 5)).toEqual({ value: "1. ab\n2. cd", caret: "1. ab\n2. ".length });
  });

  it("removes the marker on an empty item to leave the list", () => {
    expect(press("1. a\n2. ", 8)).toEqual({ value: "1. a\n", caret: 5 });
    expect(press("- ", 2)).toEqual({ value: "", caret: 0 });
    expect(press("1.   ", 5)).toEqual({ value: "", caret: 0 });
  });

  it("returns null for non-list lines", () => {
    expect(continueListOnNewline("plain text", 10)).toBeNull();
    expect(continueListOnNewline("1.5 is a number", 15)).toBeNull();
    expect(continueListOnNewline("-5 degrees", 10)).toBeNull();
    expect(continueListOnNewline("2024.", 5)).toBeNull();
    expect(continueListOnNewline("", 0)).toBeNull();
  });

  it("returns null while the caret is before or inside the marker", () => {
    expect(continueListOnNewline("1. a", 0)).toBeNull();
    expect(continueListOnNewline("1. a", 1)).toBeNull();
    expect(continueListOnNewline("1. a", 2)).toBeNull();
    expect(continueListOnNewline("  - a", 1)).toBeNull();
  });

  it("does not read the previous line when the caret is at index 0 of a blank first line", () => {
    expect(continueListOnNewline("\n- a", 0)).toBeNull();
  });

  it("rejects an out-of-range caret", () => {
    expect(continueListOnNewline("1. a", -1)).toBeNull();
    expect(continueListOnNewline("1. a", 99)).toBeNull();
  });
});
