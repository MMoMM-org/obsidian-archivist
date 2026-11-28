// Directory-prefix matching for directory restores.
//
// Why it exists: the Backup Browser counts the files a directory restore
// will touch before the confirm dialog, and RestoreOperations.restoreDirectory
// restores them. Both must apply the same filter, or the count in the dialog
// and the restored set drift apart (#138).

/** Strip trailing slashes. An empty result means the vault root. */
export function normalizeDirPrefix(rawPrefix: string): string {
  return rawPrefix.replace(/\/+$/, '');
}

/**
 * Vault paths that sit in the directory `rawPrefix` or below it, sorted
 * alphabetically. A path equal to the prefix also matches. The vault root
 * (empty prefix) matches nothing: root-level restore is not supported.
 */
export function pathsUnderDir(paths: Iterable<string>, rawPrefix: string): string[] {
  const dir = normalizeDirPrefix(rawPrefix);
  if (dir === '') return [];
  const dirWithSlash = `${dir}/`;
  return Array.from(paths)
    .filter((p) => p === dir || p.startsWith(dirWithSlash))
    .sort();
}
