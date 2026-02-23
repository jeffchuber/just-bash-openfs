export { OpenFs } from "./openfs.js";
export { createSearchCommand } from "./search.js";
export { createGrepCommand } from "./grep.js";

// Re-export core types from @open-fs/core
export type {
	Entry,
	GrepMatch,
	SearchResult,
	Vfs,
	VfsConfig,
	SubprocessVfsOptions,
} from "@open-fs/core";
export { createVfs, createMemoryVfs } from "@open-fs/core";
