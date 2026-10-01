export interface McpPolicy {
  enabledTools?: readonly string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
}
export type DownstreamMcpServerConfig = McpPolicy &
  (
    | {
        name: string;
        transport: "stdio";
        command: string;
        args: readonly string[];
        env: Readonly<Record<string, string>>;
        cwd?: string;
      }
    | {
        name: string;
        transport: "streamable-http";
        url: string;
        /** Static header values. */
        headers: Readonly<Record<string, string>>;
        /** Header name to the name of the environment variable with its value (Codex env_http_headers). */
        envHeaders?: Readonly<Record<string, string>>;
        /** Environment variable with a bearer token (Codex bearer_token_env_var). */
        bearerTokenEnvVar?: string;
      }
  );
