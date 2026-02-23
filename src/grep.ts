import type { Vfs } from "@open-fs/core";

interface Command {
	name: string;
	execute(
		args: string[],
		ctx: { stdout?: string; stderr?: string },
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Creates an `openfsgrep` command that performs server-side grep via OpenFS.
 * Uses OpenFS's regex grep which works across all backends.
 *
 * Usage: openfsgrep [-n] <pattern> [path]
 */
export function createGrepCommand(client: Vfs): Command {
	return {
		name: "openfsgrep",
		async execute(args) {
			let showLineNumbers = false;
			const positional: string[] = [];

			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === "-n" || arg === "--line-number") {
					showLineNumbers = true;
				} else if (arg === "-r" || arg === "--recursive") {
					// OpenFS grep is always recursive — accept and ignore
				} else if (arg === "--") {
					positional.push(...args.slice(i + 1));
					break;
				} else if (arg.startsWith("-") && positional.length === 0) {
					return {
						stdout: "",
						stderr: `openfsgrep: unknown option: ${arg}\n`,
						exitCode: 2,
					};
				} else {
					positional.push(arg);
				}
			}

			if (positional.length === 0) {
				return {
					stdout: "",
					stderr: "openfsgrep: usage: openfsgrep [-n] <pattern> [path]\n",
					exitCode: 2,
				};
			}

			const pattern = positional[0];
			const searchPath = positional[1];

			try {
				const matches = await client.grep(pattern, searchPath);
				if (matches.length === 0) {
					return { stdout: "", stderr: "", exitCode: 1 };
				}

				const lines = matches.map((m) => {
					if (showLineNumbers) {
						return `${m.path}:${m.line_number}:${m.line}`;
					}
					return `${m.path}:${m.line}`;
				});

				return {
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					stdout: "",
					stderr: `openfsgrep: ${msg}\n`,
					exitCode: 2,
				};
			}
		},
	};
}
