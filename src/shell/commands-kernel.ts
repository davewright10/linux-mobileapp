import type { CommandContext, CommandResult } from './commands';

type Command = (ctx: CommandContext) => CommandResult;

export const KERNEL_COMMANDS: Record<string, Command> = {};

export const KERNEL_MAN: Record<string, string> = {};

/** dnf requests that concern kernel packages (install/update kernel). Returns null to let dnf handle it. */
export function kernelDnf(ctx: CommandContext): CommandResult | null {
  void ctx;
  return null;
}

/** rpm queries for kernel packages (rpm -q kernel). Returns null to let rpm handle it. */
export function kernelRpm(ctx: CommandContext): CommandResult | null {
  void ctx;
  return null;
}

/** Reboot the simulated server (reboot, systemctl reboot). */
export function rebootSystem(ctx: CommandContext): CommandResult {
  void ctx;
  return { stdout: '(Practice server: pretending to reboot. Your changes are kept.)\n', stderr: '', code: 0 };
}
