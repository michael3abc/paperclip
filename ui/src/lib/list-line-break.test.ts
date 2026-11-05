// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_NORMAL,
  createEditor,
  ElementNode,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type SerializedElementNode,
} from "lexical";
import { insertParagraphInsteadOfLineBreakInList } from "./list-line-break";

// `@lexical/list` is not a direct UI dependency; the plugin only relies on the node type.
class FakeListItemNode extends ElementNode {
  static getType() {
    return "listitem";
  }
  static clone(node: FakeListItemNode) {
    return new FakeListItemNode(node.__key);
  }
  static importJSON(): FakeListItemNode {
    return new FakeListItemNode();
  }
  exportJSON(): SerializedElementNode {
    return { ...super.exportJSON(), type: "listitem", version: 1 };
  }
  createDOM() {
    return document.createElement("li");
  }
  updateDOM() {
    return false;
  }
}

function setup() {
  const editor = createEditor({
    namespace: "list-line-break-test",
    nodes: [FakeListItemNode],
    onError(error: Error) {
      throw error;
    },
  });
  editor.setRootElement(document.createElement("div"));
  const paragraphs = vi.fn(() => true);
  editor.registerCommand(INSERT_PARAGRAPH_COMMAND, paragraphs, COMMAND_PRIORITY_NORMAL);
  editor.registerCommand(
    INSERT_LINE_BREAK_COMMAND,
    () => editor.getEditorState().read(() => insertParagraphInsteadOfLineBreakInList(editor)),
    COMMAND_PRIORITY_NORMAL,
  );
  return { editor, paragraphs };
}

function select(editor: LexicalEditor, inList: boolean) {
  editor.update(
    () => {
      const text = $createTextNode("可以");
      const holder = inList ? new FakeListItemNode() : $createParagraphNode();
      holder.append(text);
      $getRoot().clear().append(inList ? $createParagraphNode().append(holder) : holder);
      text.selectEnd();
    },
    { discrete: true },
  );
}

describe("listLineBreakPlugin", () => {
  it("turns a line break inside a list item into a new paragraph (next item)", () => {
    const { editor, paragraphs } = setup();
    select(editor, true);
    editor.update(() => { editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false); }, { discrete: true });
    expect(paragraphs).toHaveBeenCalledTimes(1);
  });

  it("leaves line breaks outside lists alone", () => {
    const { editor, paragraphs } = setup();
    select(editor, false);
    editor.update(() => { editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false); }, { discrete: true });
    expect(paragraphs).not.toHaveBeenCalled();
  });
});
