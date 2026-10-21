// Installed kernels, kernel modules, boot loader entries and kernel arguments.
import type { FsNode } from './fs';
import type { SystemState } from './state';

export interface KernelState {
  placeholder?: never;
}

export function initialKernel(): KernelState {
  return {};
}

/** Add kernel and boot files (/etc/default/grub, /boot/loader/entries, ...) to a fresh root file system. */
export function addKernelFiles(root: FsNode): void {
  void root;
}

/** Files whose content is generated from the kernel state, e.g. /proc/cmdline. */
export const KERNEL_FILES: Record<string, (state: SystemState) => string> = {};
