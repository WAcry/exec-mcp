import { inheritedEnvironment } from "./environment.js";
import { readTokenFile } from "./credentials.js";
import { findShellExecutable } from "./host/shell.js";
import { runForeground } from "./host/foreground.js";
import { resolveUserPath } from "./util.js";

export const WITH_TOKEN_USAGE =
  "Usage: exec-mcp with-token ENV_NAME TOKEN_FILE -- EXECUTABLE [ARGS...]";

/** Adapt a token file for external clients without changing their profiles or leaving plaintext on disk. */
export async function runWithToken(
  argv: string[],
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const [name, filename, separator, executable, ...args] = argv;
  if (
    !name ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    !filename ||
    separator !== "--" ||
    !executable
  )
    throw new Error(WITH_TOKEN_USAGE);
  const file = findShellExecutable(
    executable.startsWith("~") ? resolveUserPath(executable) : executable,
  );
  if (!file || /\.(cmd|bat)$/i.test(file))
    throw new Error(
      "with-token needs a native executable file that it can run. Check the program name or path.",
    );
  const token = readTokenFile(
    resolveUserPath(filename, process.cwd()),
    "with-token file",
  );
  const env = inheritedEnvironment(process.env, { [name]: token });
  const result = await runForeground(file, args, env, signal ? { signal } : {});
  return signal?.aborted ? 0 : (result.code ?? 1);
}
