import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Default mode for atomically-written files. Callers that want world-readable
 * content can override via the `mode` option (e.g. 0o644). For secrets we use
 * 0o600 and apply it BEFORE rename so the final inode is never visible at a
 * looser mode.
 */
export const DEFAULT_FILE_MODE = 0o600;

const IS_WINDOWS = process.platform === "win32";

export interface AtomicWriteOptions {
  /** Final file mode applied to the temp file before the rename. Default 0o600. */
  mode?: number;
  /**
   * Encoding for string payloads. Default "utf8". Buffer payloads ignore this.
   */
  encoding?: BufferEncoding;
  /**
   * Skip fsync on the directory after the rename. Default false. Set true only
   * if the caller has already fsynced the dir (e.g. batch writes).
   */
  skipDirSync?: boolean;
}

/**
 * Write `data` to `target` atomically.
 *
 * Order: mkdir -> open temp -> writeFile -> fsync(file) -> chmod -> close ->
 * rename -> fsync(dir).
 *
 * fsync on the directory is the POSIX requirement to make a rename durable;
 * we skip it on Windows where opening a directory as a file is not allowed.
 *
 * This is the single durable write path for authmux. `secureWriteFile`
 * delegates here; callers should prefer this helper directly.
 */
export async function atomicWriteFile(
  target: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? DEFAULT_FILE_MODE;
  const encoding = options.encoding ?? "utf8";
  const dir = path.dirname(target);
  const base = path.basename(target);

  await fsp.mkdir(dir, { recursive: true });

  const suffix = `${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const tmp = path.join(dir, `.${base}.${suffix}`);

  const handle = await fsp.open(tmp, "w", mode);
  let renamed = false;
  try {
    if (typeof data === "string") {
      await handle.writeFile(data, encoding);
    } else {
      await handle.writeFile(data);
    }
    // fsync the file fd so the bytes survive a power loss.
    try {
      await handle.sync();
    } catch {
      // Some filesystems (tmpfs, network mounts) reject fsync; not fatal.
    }
  } finally {
    await handle.close();
  }

  // Apply final perms BEFORE rename so the final inode is never visible at a
  // looser mode (chmod-after-rename has a tiny window where the file is at the
  // umask default).
  if (!IS_WINDOWS) {
    try {
      await fsp.chmod(tmp, mode);
    } catch {
      // best-effort
    }
  }

  try {
    await fsp.rename(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      // Clean up the temp file if the rename failed; do not mask the original
      // error.
      try {
        await fsp.unlink(tmp);
      } catch {
        // ignore
      }
    }
  }

  // fsync the containing directory so the rename itself is durable on
  // ext4/xfs etc. POSIX-only; Windows does not let us open a directory as a
  // file. tmpfs / network filesystems may also reject this — non-fatal.
  if (!IS_WINDOWS && !options.skipDirSync) {
    let dirHandle: fsp.FileHandle | undefined;
    try {
      dirHandle = await fsp.open(dir, "r");
      await dirHandle.sync();
    } catch {
      // best-effort durability hint; not all FS / OS allow dir fsync.
    } finally {
      if (dirHandle) {
        try {
          await dirHandle.close();
        } catch {
          // ignore
        }
      }
    }
  }
}
