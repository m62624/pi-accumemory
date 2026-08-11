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
	exists(candidate: string): Promise<boolean>;
	/** Immediate file names in `dir`, without paths. Empty when it is missing. */
	listFiles(dir: string): Promise<string[]>;
}
