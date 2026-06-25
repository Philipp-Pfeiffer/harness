export interface SlashCommandInfo {
  name: string;
  description: string;
}

export const slashCommands: SlashCommandInfo[] = [
  { name: "/clear", description: "Clear history" },
  { name: "/help", description: "Show this help" },
  { name: "/model", description: "Switch model" },
  { name: "/quit", description: "Exit" },
  { name: "/status", description: "Show harness status" },
];

export function getCommand(name: string): SlashCommandInfo | undefined {
  return slashCommands.find((cmd) => cmd.name === name);
}

export function filterCommands(filter: string): SlashCommandInfo[] {
  if (!filter.startsWith("/")) return [];
  const query = filter.slice(1).toLowerCase();
  return slashCommands.filter((cmd) =>
    cmd.name.toLowerCase().includes(query)
  );
}
