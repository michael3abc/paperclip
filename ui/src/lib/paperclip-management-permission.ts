/**
 * HOM-617: display copy for the board-granted agent permission stored as
 * `permissions.canConfigureFixedWorkspace` (HOM-611). The switch uses a
 * higher-level name so later Paperclip-management abilities only extend the
 * description; the field name, API and saved values stay unchanged.
 */
export const PAPERCLIP_MANAGEMENT_PERMISSION_LABEL = "Paperclip management";

export const PAPERCLIP_MANAGEMENT_PERMISSION_DESCRIPTION =
  "Lets this agent change Paperclip settings for other agents and projects. Currently: set another CC Pocket agent's fixed working directory on this organization's Bridge hosts, for example when it creates a project main. Only the board can change this. New agents never start with it.";
