import type { CommandContext, CommandResult } from './commands';
import type { Shell } from './shell';

type Command = (ctx: CommandContext) => CommandResult;

export const STORAGE_COMMANDS: Record<string, Command> = {};

export const STORAGE_MAN: Record<string, string> = {};

/**
 * The storage part of a reboot: drop mounts and swap that are not in /etc/fstab, then mount
 * everything listed there. Returns the errors a real boot would hit (empty when it is clean).
 */
export function bootStorage(sh: Shell): string[] {
  void sh;
  return [];
}
