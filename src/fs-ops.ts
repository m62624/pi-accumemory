/**
 * The filesystem, as an interface.
 *
 * Everything that touches disk goes through this, so the modules above can be
 * driven from a map in a test. It is deliberately small: what this extension
 * actually needs is to read a file, write one, delete one and list a directory.
 */

export interface FileOps {
	mkdir(dir: string): Promise<void>;
	/** `undefined` rather than a throw for a missing file - absence is normal here. */
	readFile(file: string): Promise<string | undefined>;
	writeFile(file: string, content: string): Promise<void>;
	/** Whether something was removed. */
	remove(file: string): Promise<boolean>;
	/**
	 * Removes a directory and everything under it. Whether it was there.
	 *
	 * Separate from {@link remove} rather than a flag on it, because the two
	 * differ in what a mistaken call costs: `remove` refuses a directory, while
	 * this one takes a subtree with it. A caller has to say which it means.
	 */
	removeDir(dir: string): Promise<boolean>;
	exists(candidate: string): Promise<boolean>;
	/**
	 * The path with every symlink resolved, or the path itself when it will not
	 * resolve (it does not exist, or the platform refuses).
	 *
	 * Used before a folder becomes an identity. Two names for one directory -
	 * the link and the real thing - would otherwise be two projects with two
	 * memories, and neither would know about the other.
	 */
	realPath(candidate: string): Promise<string>;
	/** Immediate file names in `dir`, without paths. Empty when it is missing. */
	listFiles(dir: string): Promise<string[]>;
	/** Size of a regular file in bytes; undefined when it is missing. */
	fileSize(file: string): Promise<number | undefined>;
}
