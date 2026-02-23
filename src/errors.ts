// Error utilities now live in the openfs package.
// Re-export for backward compatibility.
export {
	enoent,
	eisdir,
	enotdir,
	eio,
	enotsup,
	eexist,
	mcpErrorToVfsError as mcpErrorToFsError,
} from "@open-fs/core";
export type { VfsError as FsError } from "@open-fs/core";
