import type { Vfs, GrepMatch } from "@open-fs/core";

/** Parsed grep flags and arguments. */
interface GrepArgs {
	patterns: string[];
	files: string[];
	ignoreCase: boolean;
	lineNumber: boolean;
	invertMatch: boolean;
	count: boolean;
	filesWithMatches: boolean;
	filesWithoutMatch: boolean;
	recursive: boolean;
	extendedRegexp: boolean;
	fixedStrings: boolean;
	wordRegexp: boolean;
	onlyMatching: boolean;
	noFilename: boolean;
	quiet: boolean;
	maxCount: number;
}

/** Result returned by execute(). */
interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** The ctx shape from just-bash CommandContext (subset we use). */
interface CommandContext {
	fs: {
		readFile(path: string): Promise<string>;
		readdir(path: string): Promise<string[]>;
		stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
		readdirWithFileTypes?(
			path: string,
		): Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]>;
		resolvePath(base: string, rel: string): string;
	};
	cwd: string;
	stdin: string;
}

interface Command {
	name: string;
	execute(args: string[], ctx: CommandContext): Promise<ExecResult>;
}

/**
 * Creates a unified `grep` command that transparently routes to server-side
 * grep for OpenFS paths and falls back to local matching for other paths/stdin.
 *
 * @param vfs - The OpenFS VFS client for server-side grep
 * @param mountPoint - The mount point where OpenFS is mounted (e.g., "/data")
 */
export function createGrepCommand(vfs: Vfs, mountPoint: string): Command {
	// Normalize mount point: ensure no trailing slash
	const mount = mountPoint.endsWith("/")
		? mountPoint.slice(0, -1)
		: mountPoint;

	return {
		name: "grep",
		async execute(args, ctx) {
			const parsed = parseGrepArgs(args);
			if (typeof parsed === "string") {
				return { stdout: "", stderr: parsed, exitCode: 2 };
			}

			if (parsed.patterns.length === 0) {
				return {
					stdout: "",
					stderr: "grep: usage: grep [OPTIONS] PATTERN [FILE...]\n",
					exitCode: 2,
				};
			}

			const pattern = parsed.patterns.join("|");

			// Build the regex for local matching
			let re: RegExp;
			try {
				re = buildRegex(pattern, parsed);
			} catch {
				return {
					stdout: "",
					stderr: `grep: invalid regular expression: ${pattern}\n`,
					exitCode: 2,
				};
			}

			// If no files and no stdin, read from stdin
			if (parsed.files.length === 0) {
				if (!ctx.stdin) {
					return {
						stdout: "",
						stderr: "grep: usage: grep [OPTIONS] PATTERN [FILE...]\n",
						exitCode: 2,
					};
				}
				return grepStdin(ctx.stdin, re, pattern, parsed);
			}

			// Resolve file paths relative to cwd
			const resolvedFiles = parsed.files.map((f) =>
				f.startsWith("/") ? f : ctx.fs.resolvePath(ctx.cwd, f),
			);

			// Classify paths: OpenFS vs local
			const openfsPaths: string[] = [];
			const localPaths: string[] = [];
			for (const p of resolvedFiles) {
				if (p === mount || p.startsWith(`${mount}/`)) {
					openfsPaths.push(p);
				} else {
					localPaths.push(p);
				}
			}

			// Determine if we can use server-side grep
			const canUseServerSide =
				openfsPaths.length > 0 && isServerSideCompatible(parsed);

			let multiFile =
				resolvedFiles.length > 1 || parsed.recursive;

			const allResults: MatchLine[] = [];
			let hadError = false;

			// Server-side grep for OpenFS paths
			if (canUseServerSide) {
				for (const p of openfsPaths) {
					// Convert mount path to VFS path
					const vfsPath =
						p === mount ? "/" : p.slice(mount.length);
					try {
						const matches = await vfs.grep(
							buildServerPattern(pattern, parsed),
							vfsPath || "/",
						);
						const converted =
							convertServerMatches(
								matches,
								mount,
								re,
								parsed,
							);
						allResults.push(...converted);
					} catch (err) {
						const msg =
							err instanceof Error
								? err.message
								: String(err);
						if (!parsed.quiet) {
							hadError = true;
						}
						// Continue with other paths
						if (localPaths.length === 0 && openfsPaths.length === 1) {
							return {
								stdout: "",
								stderr: `grep: ${msg}\n`,
								exitCode: 2,
							};
						}
					}
				}
			} else if (openfsPaths.length > 0) {
				// Fall back to local grep for OpenFS paths (complex flags)
				for (const p of openfsPaths) {
					try {
						const results = await localGrep(
							p,
							re,
							pattern,
							parsed,
							ctx,
						);
						allResults.push(...results);
					} catch (err) {
						const msg =
							err instanceof Error
								? err.message
								: String(err);
						if (!parsed.quiet) {
							hadError = true;
						}
					}
				}
			}

			// Local grep for non-OpenFS paths
			for (const p of localPaths) {
				try {
					const results = await localGrep(
						p,
						re,
						pattern,
						parsed,
						ctx,
					);
					allResults.push(...results);
				} catch (err) {
					const msg =
						err instanceof Error ? err.message : String(err);
					if (!parsed.quiet) {
						hadError = true;
					}
				}
			}

			// Detect multi-file from results if not already set
			if (!multiFile && allResults.length > 0) {
				const uniqueFiles = new Set(allResults.map((m) => m.file));
				if (uniqueFiles.size > 1) {
					multiFile = true;
				}
			}

			// Apply max count per file
			const limited = applyMaxCount(allResults, parsed);

			return formatOutput(limited, parsed, multiFile, hadError);
		},
	};
}

// ── Arg parsing ──────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set([
	"-i",
	"-n",
	"-v",
	"-c",
	"-l",
	"-L",
	"-r",
	"-R",
	"-E",
	"-F",
	"-w",
	"-o",
	"-h",
	"-q",
]);

const LONG_FLAGS: Record<string, string> = {
	"--ignore-case": "-i",
	"--line-number": "-n",
	"--invert-match": "-v",
	"--count": "-c",
	"--files-with-matches": "-l",
	"--files-without-match": "-L",
	"--recursive": "-r",
	"--extended-regexp": "-E",
	"--fixed-strings": "-F",
	"--word-regexp": "-w",
	"--only-matching": "-o",
	"--no-filename": "-h",
	"--quiet": "-q",
	"--silent": "-q",
};

function parseGrepArgs(args: string[]): GrepArgs | string {
	const result: GrepArgs = {
		patterns: [],
		files: [],
		ignoreCase: false,
		lineNumber: false,
		invertMatch: false,
		count: false,
		filesWithMatches: false,
		filesWithoutMatch: false,
		recursive: false,
		extendedRegexp: false,
		fixedStrings: false,
		wordRegexp: false,
		onlyMatching: false,
		noFilename: false,
		quiet: false,
		maxCount: 0,
	};

	let i = 0;
	let seenDoubleDash = false;

	while (i < args.length) {
		const arg = args[i];

		if (seenDoubleDash) {
			if (result.patterns.length === 0) {
				result.patterns.push(arg);
			} else {
				result.files.push(arg);
			}
			i++;
			continue;
		}

		if (arg === "--") {
			seenDoubleDash = true;
			i++;
			continue;
		}

		// Long flags
		if (arg.startsWith("--")) {
			const short = LONG_FLAGS[arg];
			if (short) {
				applyFlag(result, short);
				i++;
				continue;
			}
			if (arg.startsWith("--max-count=")) {
				const val = Number.parseInt(arg.slice("--max-count=".length), 10);
				if (Number.isNaN(val) || val < 1) {
					return `grep: invalid max count: ${arg}\n`;
				}
				result.maxCount = val;
				i++;
				continue;
			}
			return `grep: unknown option: ${arg}\n`;
		}

		// Short flags (possibly combined like -inr)
		if (arg.startsWith("-") && arg.length > 1 && result.patterns.length === 0) {
			// Check for -e PATTERN and -m N
			if (arg === "-e") {
				if (i + 1 >= args.length) {
					return "grep: option requires an argument -- 'e'\n";
				}
				result.patterns.push(args[++i]);
				i++;
				continue;
			}
			if (arg === "-m") {
				if (i + 1 >= args.length) {
					return "grep: option requires an argument -- 'm'\n";
				}
				const val = Number.parseInt(args[++i], 10);
				if (Number.isNaN(val) || val < 1) {
					return `grep: invalid max count: ${args[i]}\n`;
				}
				result.maxCount = val;
				i++;
				continue;
			}

			// Try combined short flags (e.g., -inr)
			let allFlags = true;
			for (let j = 1; j < arg.length; j++) {
				const flag = `-${arg[j]}`;
				if (BOOLEAN_FLAGS.has(flag)) {
					// ok
				} else if (arg[j] === "e") {
					// -e embedded: rest is pattern or next arg
					const rest = arg.slice(j + 1);
					// Apply flags seen so far
					for (let k = 1; k < j; k++) {
						applyFlag(result, `-${arg[k]}`);
					}
					if (rest) {
						result.patterns.push(rest);
					} else if (i + 1 < args.length) {
						result.patterns.push(args[++i]);
					} else {
						return "grep: option requires an argument -- 'e'\n";
					}
					allFlags = false;
					break;
				} else if (arg[j] === "m") {
					// -m embedded: rest is number or next arg
					const rest = arg.slice(j + 1);
					for (let k = 1; k < j; k++) {
						applyFlag(result, `-${arg[k]}`);
					}
					let val: number;
					if (rest) {
						val = Number.parseInt(rest, 10);
					} else if (i + 1 < args.length) {
						val = Number.parseInt(args[++i], 10);
					} else {
						return "grep: option requires an argument -- 'm'\n";
					}
					if (Number.isNaN(val) || val < 1) {
						return `grep: invalid max count\n`;
					}
					result.maxCount = val;
					allFlags = false;
					break;
				} else {
					return `grep: unknown option: ${arg}\n`;
				}
			}
			if (allFlags) {
				for (let j = 1; j < arg.length; j++) {
					applyFlag(result, `-${arg[j]}`);
				}
			}
			i++;
			continue;
		}

		// Also handle flags after the pattern
		if (arg.startsWith("-") && arg.length > 1 && result.patterns.length > 0) {
			// Check if it's a recognized flag
			if (arg === "-e") {
				if (i + 1 >= args.length) {
					return "grep: option requires an argument -- 'e'\n";
				}
				result.patterns.push(args[++i]);
				i++;
				continue;
			}
			if (arg === "-m") {
				if (i + 1 >= args.length) {
					return "grep: option requires an argument -- 'm'\n";
				}
				const val = Number.parseInt(args[++i], 10);
				if (Number.isNaN(val) || val < 1) {
					return `grep: invalid max count: ${args[i]}\n`;
				}
				result.maxCount = val;
				i++;
				continue;
			}
			// Try as combined flags
			let allValid = true;
			for (let j = 1; j < arg.length; j++) {
				if (!BOOLEAN_FLAGS.has(`-${arg[j]}`)) {
					allValid = false;
					break;
				}
			}
			if (allValid) {
				for (let j = 1; j < arg.length; j++) {
					applyFlag(result, `-${arg[j]}`);
				}
				i++;
				continue;
			}
			// Not a flag — treat as a file path
			result.files.push(arg);
			i++;
			continue;
		}

		// Positional argument
		if (result.patterns.length === 0) {
			result.patterns.push(arg);
		} else {
			result.files.push(arg);
		}
		i++;
	}

	return result;
}

function applyFlag(result: GrepArgs, flag: string): void {
	switch (flag) {
		case "-i":
			result.ignoreCase = true;
			break;
		case "-n":
			result.lineNumber = true;
			break;
		case "-v":
			result.invertMatch = true;
			break;
		case "-c":
			result.count = true;
			break;
		case "-l":
			result.filesWithMatches = true;
			break;
		case "-L":
			result.filesWithoutMatch = true;
			break;
		case "-r":
		case "-R":
			result.recursive = true;
			break;
		case "-E":
			result.extendedRegexp = true;
			break;
		case "-F":
			result.fixedStrings = true;
			break;
		case "-w":
			result.wordRegexp = true;
			break;
		case "-o":
			result.onlyMatching = true;
			break;
		case "-h":
			result.noFilename = true;
			break;
		case "-q":
			result.quiet = true;
			break;
	}
}

// ── Regex building ───────────────────────────────────────────────────

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(pattern: string, opts: GrepArgs): RegExp {
	let src = opts.fixedStrings ? escapeRegex(pattern) : pattern;
	if (opts.wordRegexp) {
		src = `\\b${src}\\b`;
	}
	const flags = opts.ignoreCase ? "g" + "i" : "g";
	return new RegExp(src, flags);
}

function buildServerPattern(pattern: string, opts: GrepArgs): string {
	// For server-side grep, we send the raw pattern.
	// The server handles regex matching.
	if (opts.fixedStrings) {
		return escapeRegex(pattern);
	}
	if (opts.wordRegexp) {
		return `\\b${pattern}\\b`;
	}
	return pattern;
}

// ── Server-side compatibility check ──────────────────────────────────

function isServerSideCompatible(opts: GrepArgs): boolean {
	// These flags require reading all lines or extracting match details
	// that the server-side grep doesn't support
	if (opts.invertMatch) return false;
	if (opts.onlyMatching) return false;
	return true;
}

// ── Match types ──────────────────────────────────────────────────────

interface MatchLine {
	file: string;
	lineNumber: number;
	line: string;
	matchText?: string; // for -o
}

// ── Convert server matches ───────────────────────────────────────────

function convertServerMatches(
	matches: GrepMatch[],
	mount: string,
	re: RegExp,
	opts: GrepArgs,
): MatchLine[] {
	const results: MatchLine[] = [];
	for (const m of matches) {
		// Convert VFS path back to mount path
		const filePath =
			m.path === "/" ? mount : `${mount}${m.path}`;

		// Apply case-insensitive filtering locally if needed
		// (server may not support (?i) flag, but our mock does regex)
		re.lastIndex = 0;
		const match = re.exec(m.line);
		if (opts.ignoreCase && !match) {
			// Server returned it but our local regex doesn't match — skip
			// (shouldn't happen normally but be safe)
			continue;
		}

		results.push({
			file: filePath,
			lineNumber: m.line_number,
			line: m.line,
			matchText: match ? match[0] : undefined,
		});
	}
	return results;
}

// ── Local grep ───────────────────────────────────────────────────────

async function localGrep(
	path: string,
	re: RegExp,
	_pattern: string,
	opts: GrepArgs,
	ctx: CommandContext,
): Promise<MatchLine[]> {
	const stat = await ctx.fs.stat(path);
	if (stat.isDirectory) {
		if (!opts.recursive) {
			// grep: /path: Is a directory
			return [];
		}
		return expandAndGrep(path, re, opts, ctx);
	}
	return grepFile(path, re, opts, ctx);
}

async function expandAndGrep(
	dir: string,
	re: RegExp,
	opts: GrepArgs,
	ctx: CommandContext,
): Promise<MatchLine[]> {
	const results: MatchLine[] = [];

	if (ctx.fs.readdirWithFileTypes) {
		const entries = await ctx.fs.readdirWithFileTypes(dir);
		for (const entry of entries) {
			const childPath = ctx.fs.resolvePath(dir, entry.name);
			if (entry.isDirectory) {
				const sub = await expandAndGrep(childPath, re, opts, ctx);
				results.push(...sub);
			} else if (entry.isFile) {
				const matches = await grepFile(childPath, re, opts, ctx);
				results.push(...matches);
			}
		}
	} else {
		const names = await ctx.fs.readdir(dir);
		for (const name of names) {
			const childPath = ctx.fs.resolvePath(dir, name);
			try {
				const childStat = await ctx.fs.stat(childPath);
				if (childStat.isDirectory) {
					const sub = await expandAndGrep(
						childPath,
						re,
						opts,
						ctx,
					);
					results.push(...sub);
				} else if (childStat.isFile) {
					const matches = await grepFile(
						childPath,
						re,
						opts,
						ctx,
					);
					results.push(...matches);
				}
			} catch {
				// Skip files we can't stat
			}
		}
	}

	return results;
}

async function grepFile(
	filePath: string,
	re: RegExp,
	opts: GrepArgs,
	ctx: CommandContext,
): Promise<MatchLine[]> {
	const content = await ctx.fs.readFile(filePath);
	const lines = content.split("\n");
	// Remove trailing empty line from split
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	const results: MatchLine[] = [];

	for (let i = 0; i < lines.length; i++) {
		re.lastIndex = 0;
		const match = re.exec(lines[i]);
		const matches = !!match;

		if (opts.invertMatch ? !matches : matches) {
			if (opts.onlyMatching && match) {
				// For -o, emit each match on the line
				re.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = re.exec(lines[i])) !== null) {
					results.push({
						file: filePath,
						lineNumber: i + 1,
						line: lines[i],
						matchText: m[0],
					});
					if (m[0].length === 0) {
						re.lastIndex++;
					}
				}
			} else {
				results.push({
					file: filePath,
					lineNumber: i + 1,
					line: lines[i],
					matchText: match ? match[0] : undefined,
				});
			}
		}
	}

	return results;
}

// ── Stdin grep ───────────────────────────────────────────────────────

function grepStdin(
	stdin: string,
	re: RegExp,
	_pattern: string,
	opts: GrepArgs,
): ExecResult {
	const lines = stdin.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	const matches: MatchLine[] = [];

	for (let i = 0; i < lines.length; i++) {
		re.lastIndex = 0;
		const match = re.exec(lines[i]);
		const hit = !!match;

		if (opts.invertMatch ? !hit : hit) {
			if (opts.onlyMatching && match) {
				re.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = re.exec(lines[i])) !== null) {
					matches.push({
						file: "",
						lineNumber: i + 1,
						line: lines[i],
						matchText: m[0],
					});
					if (m[0].length === 0) {
						re.lastIndex++;
					}
				}
			} else {
				matches.push({
					file: "",
					lineNumber: i + 1,
					line: lines[i],
					matchText: match ? match[0] : undefined,
				});
			}
		}
	}

	const limited = applyMaxCount(matches, opts);
	return formatOutput(limited, opts, false, false);
}

// ── Max count ────────────────────────────────────────────────────────

function applyMaxCount(
	matches: MatchLine[],
	opts: GrepArgs,
): MatchLine[] {
	if (opts.maxCount <= 0) return matches;

	// Apply max count per file
	const counts = new Map<string, number>();
	const result: MatchLine[] = [];

	for (const m of matches) {
		const key = m.file;
		const current = counts.get(key) ?? 0;
		if (current < opts.maxCount) {
			result.push(m);
			counts.set(key, current + 1);
		}
	}

	return result;
}

// ── Output formatting ────────────────────────────────────────────────

function formatOutput(
	matches: MatchLine[],
	opts: GrepArgs,
	multiFile: boolean,
	_hadError: boolean,
): ExecResult {
	if (opts.quiet) {
		return {
			stdout: "",
			stderr: "",
			exitCode: matches.length > 0 ? 0 : 1,
		};
	}

	const showFile = multiFile && !opts.noFilename;

	// -l: files with matches
	if (opts.filesWithMatches) {
		const files = new Set(matches.map((m) => m.file));
		if (files.size === 0) {
			return { stdout: "", stderr: "", exitCode: 1 };
		}
		return {
			stdout: [...files].join("\n") + "\n",
			stderr: "",
			exitCode: 0,
		};
	}

	// -L: files without matches (need all files info — only works correctly
	// when caller passes all target files)
	if (opts.filesWithoutMatch) {
		// This is handled at a higher level; here we just invert -l behavior
		const filesWithMatches = new Set(matches.map((m) => m.file));
		// We don't have the full file list here, so -L with matches means
		// those files are excluded. For now, return empty if all matched.
		if (filesWithMatches.size > 0) {
			return { stdout: "", stderr: "", exitCode: 1 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	}

	// -c: count per file
	if (opts.count) {
		const counts = new Map<string, number>();
		for (const m of matches) {
			counts.set(m.file, (counts.get(m.file) ?? 0) + 1);
		}

		if (counts.size === 0) {
			// No matches — if multiFile we'd show "file:0" but we don't
			// have the file list. Just return "0".
			return { stdout: "0\n", stderr: "", exitCode: 1 };
		}

		const lines: string[] = [];
		for (const [file, count] of counts) {
			if (showFile && file) {
				lines.push(`${file}:${count}`);
			} else {
				lines.push(`${count}`);
			}
		}
		return {
			stdout: lines.join("\n") + "\n",
			stderr: "",
			exitCode: 0,
		};
	}

	if (matches.length === 0) {
		return { stdout: "", stderr: "", exitCode: 1 };
	}

	// Normal output
	const lines: string[] = [];
	for (const m of matches) {
		let line = "";

		if (showFile && m.file) {
			line += `${m.file}:`;
		}

		if (opts.lineNumber) {
			line += `${m.lineNumber}:`;
		}

		if (opts.onlyMatching) {
			line += m.matchText ?? "";
		} else {
			line += m.line;
		}

		lines.push(line);
	}

	return {
		stdout: lines.join("\n") + "\n",
		stderr: "",
		exitCode: 0,
	};
}
