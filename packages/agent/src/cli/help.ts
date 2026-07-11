/**
 * `harness help` — prints a concise overview of all CLI subcommands.
 * Also used as the fallback when an unknown subcommand is given.
 */

const HELP_TEXT = `
harness — Agent Harness CLI

Usage: harness <command> [options]

Commands:
  (default)      Start the interactive TUI (in-process agent loop).
  chat           Connect to a running daemon and launch the TUI with a
                 session picker. Works from any directory — only needs the
                 daemon socket. Use --session <id> to attach directly.
  daemon         Manage the background daemon process.
    start          Start the daemon as a detached background process.
    stop           Stop the running daemon.
    restart        Stop + start.
    status         Show daemon PID, uptime, model, sessions, last errors.
    install        Install a systemd user service unit.
    logs           Show the last 100 lines of daemon logs.
    run            Internal: run the daemon process (spawned by 'start').
  sessions       List all sessions (via daemon IPC).
  send           Send a single message to a session (via daemon IPC).
  reload-config  Hot-reload daemon config without restart.
  migrate-home   Migrate legacy substrate to $HARNESS_HOME.
  help           Show this help.

Session Slash Commands (in TUI):
  /new           End current session, start a new one.
  /session       List or resume sessions (picker or /session <id>).
  /end           End the current session explicitly.
  /clear         Clear the TUI display.
  /model         Switch model (in-process mode only).
  /status        Show harness status overview.
  /help          Show slash commands and keybinds.
  /quit          Exit the TUI.

Options:
  --session <id>  With 'chat': attach to a specific session directly.
  --dry-run       With 'migrate-home': show what would be moved.

Environment:
  HARNESS_HOME    Harness home directory (default: ~/harness).
  HARNESS_STATE   State directory (default: ~/.harness).
`;

export function printHelp(): void {
  console.log(HELP_TEXT.trim() + "\n");
}
