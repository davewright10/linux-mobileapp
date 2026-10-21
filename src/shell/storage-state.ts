// Disks, partitions, file systems, mounts, swap and LVM for the simulated server.
import type { FsNode } from './fs';
import type { SystemState } from './state';

export interface StorageState {
  placeholder?: never;
}

export function initialStorage(): StorageState {
  return {};
}

/** Add storage-related files (such as /etc/fstab) to a fresh root file system. */
export function addStorageFiles(root: FsNode): void {
  void root;
}

/** Files whose content is generated from the storage state, e.g. /proc/mounts. */
export const STORAGE_FILES: Record<string, (state: SystemState) => string> = {};
