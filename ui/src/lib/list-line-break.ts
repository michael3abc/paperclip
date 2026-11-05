import { createRootEditorSubscription$, realmPlugin } from "@mdxeditor/editor";
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

/**
 * In a chat composer Enter submits, so Shift+Enter is the only way to start a new
 * line. Inside a list that newline must start the next item ("1. a" -> "2. ") and,
 * on an empty item, leave the list — what Enter does in a normal editor. Lexical's
 * default turns Shift+Enter into a soft line break inside the same item, which is
 * why the number or bullet never showed up.
 *
 * `@lexical/list` is not a direct dependency of the UI, so the list item is
 * recognised by its node type instead of by class.
 */
function isInsideListItem(node: LexicalNode): boolean {
  for (let current: LexicalNode | null = node; current; current = current.getParent()) {
    if (current.getType() === "listitem") return true;
  }
  return false;
}

export function insertParagraphInsteadOfLineBreakInList(editor: LexicalEditor): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  if (!isInsideListItem(selection.anchor.getNode())) return false;
  // INSERT_PARAGRAPH_COMMAND is the path Enter takes: the list plugin appends the
  // next item or, for an empty one, outdents it out of the list.
  return editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
}

/** Only for editors where Enter submits; elsewhere Enter already continues the list. */
export const listLineBreakPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, [
      (editor) =>
        editor.registerCommand(
          INSERT_LINE_BREAK_COMMAND,
          () => insertParagraphInsteadOfLineBreakInList(editor),
          COMMAND_PRIORITY_HIGH,
        ),
    ]);
  },
});
