import type { Vfs } from "@open-fs/core";

interface Command {
	name: string;
	execute(
		args: string[],
		ctx: { stdout?: string; stderr?: string },
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Creates a `search` command that performs semantic search via OpenFS.
 *
 * Usage: search [-n limit] <query> [path]
 */
export function createSearchCommand(client: Vfs): Command {
	return {
		name: "search",
		async execute(args) {
			let limit = 10;
			const positional: string[] = [];

			for (let i = 0; i < args.length; i++) {
				if (args[i] === "-n" && i + 1 < args.length) {
					limit = Number.parseInt(args[++i], 10);
					if (Number.isNaN(limit) || limit < 1) {
						return {
							stdout: "",
							stderr: "search: invalid limit\n",
							exitCode: 1,
						};
					}
				} else {
					positional.push(args[i]);
				}
			}

			if (positional.length === 0) {
				return {
					stdout: "",
					stderr: "search: usage: search [-n limit] <query> [path]\n",
					exitCode: 1,
				};
			}

			const query = positional[0];

			try {
				const results = await client.search(query, limit);
				if (results.length === 0) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}

				const lines = results.map(
					(r) => `[${r.score.toFixed(4)}] ${r.source}  ${r.snippet}`,
				);
				return {
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					stdout: "",
					stderr: `search: ${msg}\n`,
					exitCode: 1,
				};
			}
		},
	};
}
