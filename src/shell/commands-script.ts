import type { CommandContext, CommandResult } from './commands';

type Command = (ctx: CommandContext) => CommandResult;

export const SCRIPT_COMMANDS: Record<string, Command> = {};

export const SCRIPT_MAN: Record<string, string> = {};
