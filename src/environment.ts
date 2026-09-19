/** Copy every defined variable; only explicit child configuration replaces a value.
 * A copy also avoids native libraries treating process.env specially and sanitizing it.
 */
export function inheritedEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Readonly<Record<string, string>> = {},
  platform = process.platform as string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entries of [source, overrides]) {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) continue;
      // Avoid PATH/Path duplicates when the MCP SDK also adds its Windows defaults.
      Object.defineProperty(
        result,
        platform === "win32" ? key.toUpperCase() : key,
        {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        },
      );
    }
  }
  return result;
}
