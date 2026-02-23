import { describe, it, expect } from "vitest";
import {
	enoent,
	eisdir,
	enotdir,
	eio,
	enotsup,
	eexist,
	mcpErrorToFsError,
} from "../src/errors.js";

describe("error factories", () => {
	describe("enoent", () => {
		it("creates error with ENOENT code", () => {
			const err = enoent("/missing.txt");
			expect(err).toBeInstanceOf(Error);
			expect(err.code).toBe("ENOENT");
			expect(err.path).toBe("/missing.txt");
			expect(err.message).toContain("/missing.txt");
		});
	});

	describe("eisdir", () => {
		it("creates error with EISDIR code", () => {
			const err = eisdir("/some/dir");
			expect(err.code).toBe("EISDIR");
			expect(err.path).toBe("/some/dir");
			expect(err.message).toContain("directory");
		});
	});

	describe("enotdir", () => {
		it("creates error with ENOTDIR code", () => {
			const err = enotdir("/file.txt");
			expect(err.code).toBe("ENOTDIR");
			expect(err.path).toBe("/file.txt");
			expect(err.message).toContain("not a directory");
		});
	});

	describe("eio", () => {
		it("creates error with EIO code and custom message", () => {
			const err = eio("connection failed", "/path");
			expect(err.code).toBe("EIO");
			expect(err.path).toBe("/path");
			expect(err.message).toBe("connection failed");
		});

		it("works without path", () => {
			const err = eio("timeout");
			expect(err.code).toBe("EIO");
			expect(err.path).toBeUndefined();
		});
	});

	describe("enotsup", () => {
		it("creates error with ENOTSUP code", () => {
			const err = enotsup("symlink");
			expect(err.code).toBe("ENOTSUP");
			expect(err.message).toContain("symlink");
			expect(err.message).toContain("not supported");
		});
	});

	describe("eexist", () => {
		it("creates error with EEXIST code", () => {
			const err = eexist("/existing.txt");
			expect(err.code).toBe("EEXIST");
			expect(err.path).toBe("/existing.txt");
			expect(err.message).toContain("already exists");
		});
	});

	describe("all errors are throwable", () => {
		it("can be caught with try/catch", () => {
			expect(() => {
				throw enoent("/x");
			}).toThrow();
		});

		it("has stack trace", () => {
			const err = enoent("/x");
			expect(err.stack).toBeDefined();
		});
	});
});

describe("mcpErrorToFsError", () => {
	it("maps 'not found' to ENOENT", () => {
		const err = mcpErrorToFsError("File not found", "/test.txt");
		expect(err.code).toBe("ENOENT");
		expect(err.path).toBe("/test.txt");
	});

	it("maps 'no such' to ENOENT", () => {
		const err = mcpErrorToFsError("no such file or directory", "/a");
		expect(err.code).toBe("ENOENT");
	});

	it("maps 'Not Found' case-insensitively", () => {
		const err = mcpErrorToFsError("NOT FOUND: /thing");
		expect(err.code).toBe("ENOENT");
	});

	it("maps 'is a directory' to EISDIR", () => {
		const err = mcpErrorToFsError("path is a directory", "/dir");
		expect(err.code).toBe("EISDIR");
		expect(err.path).toBe("/dir");
	});

	it("maps 'not a directory' to ENOTDIR", () => {
		const err = mcpErrorToFsError("not a directory: /file", "/file");
		expect(err.code).toBe("ENOTDIR");
	});

	it("falls back to EIO for unknown messages", () => {
		const err = mcpErrorToFsError("something weird happened", "/x");
		expect(err.code).toBe("EIO");
		expect(err.message).toBe("something weird happened");
	});

	it("uses 'unknown' path when none provided for ENOENT", () => {
		const err = mcpErrorToFsError("not found");
		expect(err.code).toBe("ENOENT");
		expect(err.path).toBe("unknown");
	});

	it("uses 'unknown' path when none provided for EISDIR", () => {
		const err = mcpErrorToFsError("is a directory");
		expect(err.path).toBe("unknown");
	});

	it("uses 'unknown' path when none provided for ENOTDIR", () => {
		const err = mcpErrorToFsError("not a directory");
		expect(err.path).toBe("unknown");
	});

	it("preserves path on EIO fallback", () => {
		const err = mcpErrorToFsError("boom", "/here");
		expect(err.code).toBe("EIO");
		expect(err.path).toBe("/here");
	});
});
