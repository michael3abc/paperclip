export interface SidebarOrderPreference {
  orderedIds: string[];
  updatedAt: Date | null;
}

export interface CompanySidebarPreference extends SidebarOrderPreference {
  // Agents the user does not want a project-PM sidebar status for (default: none).
  excludedPmStatusAgentIds: string[];
}
