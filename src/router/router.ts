/**
 * The project router: which database is *this* folder's memory.
 *
 * It is the answer to the question a hash of the path answers badly. Hashing
 * the live path makes the key change when the folder moves, which orphans the
 * database and silently starts a second, empty one — the failure is invisible
 * until someone notices the memory got younger. Here the id is minted once and
 * never derived from the path again; moving a folder revises one fact.
 *
 * It lives in the common database, alongside the facts about the user, because
 * it is the one thing every project's session needs before it knows which
 * project it is in.
 */

import { isStoredPath, storedBasename } from "../paths/path-codec.ts";
import type { WritableMemory } from "../storage/port.ts";
import { defined } from "../tools/args.ts";
import {
	IDENTIFIES,
	PATH_KEY,
	PROJECT_ID_KEY,
	PROJECT_TAG,
	pathEntity,
	projectEntity,
	ROUTE_TAG,
	UNBOUND_KEY,
} from "./entities.ts";

export interface ResolvedProject {
	projectId: string;
	/** True when this call registered it, so callers can seed a new database. */
	created: boolean;
}

export interface KnownProject {
	projectId: string;
	/** The folder name — what a person calls the project. */
	name: string;
	path: string;
	/**
	 * Whether `path` is a live binding or the last place this memory lived.
	 *
	 * `false` after {@link ProjectRouter.release}. Such a project is still
	 * listed - its facts are intact and still answer a cross-project question,
	 * and hiding it would leave a database on disk that nothing can name.
	 */
	bound: boolean;
	description?: string;
}

export interface RouterOptions {
	/** Injectable so tests can name the ids they assert on. */
	newId?: () => string;
	now?: () => number;
}

export class ProjectRouter {
	private readonly newId: () => string;

	constructor(
		private readonly common: WritableMemory,
		options: RouterOptions = {},
	) {
		this.newId = options.newId ?? defaultId;
	}

	/**
	 * The project id for a canonical path, registering it on first sight.
	 *
	 * @throws if `storedPath` is not canonical. A native path arriving here
	 * would register a second spelling of a project that already exists.
	 */
	async resolve(storedPath: string): Promise<ResolvedProject> {
		assertStored(storedPath);
		const existing = await this.lookup(storedPath);
		if (existing !== undefined) return { projectId: existing, created: false };

		const projectId = this.newId();
		const route = await this.common.remember({
			text: `Project memory ${projectId} is the folder ${storedPath}`,
			entity: pathEntity(storedPath),
			tags: [ROUTE_TAG],
			metadata: { [PROJECT_ID_KEY]: projectId, [PATH_KEY]: storedPath },
		});
		// The mirror of the route fact, filed under the project rather than the
		// path. It is what answers "where does project X live", including
		// "where did it live in March" - an entity lookup with `asOf` reaches
		// the closed revision, which is the whole point of storing the move as
		// a revision rather than a deletion.
		await this.common.remember({
			text: `Project "${storedBasename(storedPath)}" (${projectId}) lives at ${storedPath}`,
			entity: projectEntity(projectId),
			tags: [PROJECT_TAG],
			metadata: { [PROJECT_ID_KEY]: projectId, [PATH_KEY]: storedPath },
		});
		await this.common.link({
			src: pathEntity(storedPath),
			rel: IDENTIFIES,
			dst: projectEntity(projectId),
			// The edge points back at the fact it follows from, so "why does
			// this path identify this project" has an answer in the graph.
			provenance: route.id,
		});
		// Without this, a session in another terminal reads a generation that
		// predates the registration and mints a second id for the same folder.
		await this.common.checkpoint();
		return { projectId, created: true };
	}

	/**
	 * Records that a project moved.
	 *
	 * Explicit rather than guessed. Deciding on a hunch that two folders are
	 * "probably the same project" merges two memories, and nothing merged can
	 * be taken apart again.
	 */
	async relocate(
		fromStoredPath: string,
		toStoredPath: string,
	): Promise<string> {
		assertStored(fromStoredPath);
		assertStored(toStoredPath);

		const route = await this.routeFact(fromStoredPath);
		if (route === undefined) {
			throw new Error(
				`router: ${fromStoredPath} is not registered as a project`,
			);
		}
		const occupant = await this.lookup(toStoredPath);
		if (occupant !== undefined && occupant !== route.projectId) {
			throw new Error(
				`router: ${toStoredPath} already belongs to project ${occupant}`,
			);
		}
		const projectId = route.projectId;

		// New route first: an interruption between the steps then leaves the
		// project reachable from both paths, which a later relocate can clean
		// up. The reverse order leaves it reachable from neither.
		const moved = await this.common.remember({
			text: `Project memory ${projectId} is the folder ${toStoredPath}`,
			entity: pathEntity(toStoredPath),
			tags: [ROUTE_TAG],
			metadata: { [PROJECT_ID_KEY]: projectId, [PATH_KEY]: toStoredPath },
		});
		await this.common.link({
			src: pathEntity(toStoredPath),
			rel: IDENTIFIES,
			dst: projectEntity(projectId),
			provenance: moved.id,
		});
		await this.common.unlink({
			src: pathEntity(fromStoredPath),
			rel: IDENTIFIES,
			dst: projectEntity(projectId),
		});
		// `revise`, not `forget`: the closed fact keeps answering "where did
		// this project live in March", which is the point of a bitemporal store.
		await this.common.revise(route.factId, {
			text: `Project memory ${projectId} moved from ${fromStoredPath} to ${toStoredPath}`,
			entity: pathEntity(fromStoredPath),
			tags: [ROUTE_TAG],
			metadata: { [PATH_KEY]: fromStoredPath, movedTo: toStoredPath },
		});
		// The project's own record of where it lives, revised in step with the
		// route so an as-of lookup on either side agrees with the other.
		const project = await this.projectFact(projectId);
		if (project !== undefined) {
			await this.common.revise(project.factId, {
				text: `Project "${storedBasename(toStoredPath)}" (${projectId}) lives at ${toStoredPath}`,
				entity: projectEntity(projectId),
				tags: [PROJECT_TAG],
				metadata: { [PROJECT_ID_KEY]: projectId, [PATH_KEY]: toStoredPath },
			});
		}
		await this.common.checkpoint();
		return projectId;
	}

	/**
	 * Gives an existing memory a folder.
	 *
	 * The counterpart of {@link release}, and what attaches a memory that has
	 * been carried over from another machine: the database is intact, the path
	 * inside it belongs to a filesystem that is not here, and this writes the
	 * binding the local one needs. `relocate` is the other way of arriving at a
	 * route and stays for what it says - a project that MOVED, where naming both
	 * ends is worth a sentence of history. A project that was released has no
	 * "from" to name.
	 *
	 * @throws if the path is already some other project's, because merging two
	 * memories cannot be undone, or if the project is not registered at all.
	 */
	async bind(projectId: string, storedPath: string): Promise<void> {
		assertStored(storedPath);
		const occupant = await this.lookup(storedPath);
		if (occupant !== undefined && occupant !== projectId) {
			throw new Error(
				`router: ${storedPath} already belongs to project ${occupant}`,
			);
		}
		if (occupant === projectId) return;
		const project = await this.projectFact(projectId);
		if (project === undefined) {
			throw new Error(`router: ${projectId} is not a registered project`);
		}

		const route = await this.common.remember({
			text: `Project memory ${projectId} is the folder ${storedPath}`,
			entity: pathEntity(storedPath),
			tags: [ROUTE_TAG],
			metadata: { [PROJECT_ID_KEY]: projectId, [PATH_KEY]: storedPath },
		});
		await this.common.link({
			src: pathEntity(storedPath),
			rel: IDENTIFIES,
			dst: projectEntity(projectId),
			provenance: route.id,
		});
		await this.common.revise(project.factId, {
			text: `Project "${storedBasename(storedPath)}" (${projectId}) lives at ${storedPath}`,
			entity: projectEntity(projectId),
			tags: [PROJECT_TAG],
			metadata: { [PROJECT_ID_KEY]: projectId, [PATH_KEY]: storedPath },
		});
		await this.common.checkpoint();
	}

	/**
	 * Takes a folder's memory away from it, keeping the memory itself.
	 *
	 * The half of `relocate` that had no name. `relocate` moves a project to a
	 * folder that is FREE, and in this extension a folder never is: `startup`
	 * resolves every project directory on the way in, so by the time a person
	 * can ask for anything, the folder already holds a freshly minted, empty
	 * memory. Binding another one here means releasing that one first.
	 *
	 * The project stays listed and keeps its facts. What changes is that its
	 * path becomes history: the route fact is closed by revision (not
	 * `forget` - "where did this live in March" is still a fair question), and
	 * the project's own fact says it has no folder while still carrying the
	 * path it had, because that path is how a person recognises it later.
	 *
	 * @returns the released project's id, or `undefined` when nothing was bound
	 * to `storedPath` - releasing an unbound folder is a no-op, not a failure.
	 */
	async release(storedPath: string): Promise<string | undefined> {
		assertStored(storedPath);
		const route = await this.routeFact(storedPath);
		if (route === undefined) return undefined;
		const projectId = route.projectId;

		await this.common.unlink({
			src: pathEntity(storedPath),
			rel: IDENTIFIES,
			dst: projectEntity(projectId),
		});
		await this.common.revise(route.factId, {
			text: `Project memory ${projectId} is no longer the folder ${storedPath}`,
			entity: pathEntity(storedPath),
			tags: [ROUTE_TAG],
			// The id stays, and `routeFact` skips the fact because of the flag
			// instead. `relocate` frees a path by dropping the id, which works
			// but leaves nothing able to find the fact again - and deleting a
			// project has to find every route it ever had.
			metadata: {
				[PROJECT_ID_KEY]: projectId,
				[PATH_KEY]: storedPath,
				[UNBOUND_KEY]: "true",
			},
		});
		const project = await this.projectFact(projectId);
		if (project !== undefined) {
			await this.common.revise(project.factId, {
				text: `Project "${storedBasename(storedPath)}" (${projectId}) is not bound to a folder; it was at ${storedPath}`,
				entity: projectEntity(projectId),
				tags: [PROJECT_TAG],
				metadata: {
					[PROJECT_ID_KEY]: projectId,
					[PATH_KEY]: storedPath,
					[UNBOUND_KEY]: "true",
				},
			});
		}
		await this.common.checkpoint();
		return projectId;
	}

	/**
	 * Removes a project from the router entirely.
	 *
	 * For the one case where the bitemporal answer is worthless: the database
	 * file is being deleted, so "where did it live in March" has nothing left to
	 * describe. `forget`, therefore, rather than the revision every other
	 * operation here uses.
	 *
	 * The files are not this class's business - it only ever touches the common
	 * database - so the caller deletes them and calls this.
	 */
	async forget(projectId: string): Promise<void> {
		const doomed: number[] = [];
		for (const fact of await this.common.scan({ tags: [PROJECT_TAG] })) {
			if (fact.metadata[PROJECT_ID_KEY] === projectId) doomed.push(fact.id);
		}
		for (const fact of await this.common.scan({ tags: [ROUTE_TAG] })) {
			if (fact.metadata[PROJECT_ID_KEY] !== projectId) continue;
			doomed.push(fact.id);
			const path = fact.metadata[PATH_KEY];
			// The edge outlives the fact it came from, so it is taken down by
			// name rather than left dangling at a project that no longer exists.
			if (path !== undefined) {
				await this.common.unlink({
					src: pathEntity(path),
					rel: IDENTIFIES,
					dst: projectEntity(projectId),
				});
			}
		}
		if (doomed.length > 0) await this.common.forgetMany(doomed);
		await this.common.checkpoint();
	}

	/**
	 * Where a project lives now, or where it lived at `asOf`.
	 *
	 * An entity lookup, because an entity is a retrieval SOURCE and therefore
	 * answers with `asOf` applied to it. A tag is only a filter over what a
	 * source produced: asking for "facts tagged route as of March" returns
	 * nothing at all, and returns it silently.
	 */
	async pathOf(projectId: string, asOf?: number): Promise<string | undefined> {
		const found = await this.common.recall({
			entities: [projectEntity(projectId)],
			...defined({ asOf }),
		});
		for (const hit of found.facts) {
			const card = await this.common.get(hit.id);
			const path = card?.metadata[PATH_KEY];
			if (path !== undefined) return path;
		}
		return undefined;
	}

	/**
	 * Every registered project.
	 *
	 * This is what a cross-project question selects from. The model naming a
	 * project it invented gets an honest miss rather than an empty answer that
	 * reads like "that project remembers nothing".
	 */
	async list(): Promise<KnownProject[]> {
		// Enumeration, not retrieval: there is no query here, and a tag filter
		// with no source behind it answers nothing.
		const projects: KnownProject[] = [];
		for (const fact of await this.common.scan({ tags: [PROJECT_TAG] })) {
			const projectId = fact.metadata[PROJECT_ID_KEY];
			const path = fact.metadata[PATH_KEY];
			if (projectId === undefined || path === undefined) continue;
			if (projects.some((project) => project.projectId === projectId)) continue;
			projects.push({
				projectId,
				path,
				name: storedBasename(path),
				bound: fact.metadata[UNBOUND_KEY] !== "true",
			});
		}
		return projects;
	}

	/** A project by the name a person would use — its folder name. */
	async findByName(name: string): Promise<KnownProject | undefined> {
		const wanted = name.toLowerCase();
		const projects = await this.list();
		return projects.find((project) => project.name.toLowerCase() === wanted);
	}

	/** The live route fact for a path, if there is one. */
	private async routeFact(
		storedPath: string,
	): Promise<{ factId: number; projectId: string } | undefined> {
		// An entity lookup, not a search: exact by construction, so a path that
		// is a prefix of another cannot outrank it.
		const found = await this.common.recall({
			entities: [pathEntity(storedPath)],
		});
		for (const hit of found.facts) {
			const card = await this.common.get(hit.id);
			// A released route keeps its id so a deletion can find it; the flag
			// is what says the path is free again.
			if (card?.metadata[UNBOUND_KEY] === "true") continue;
			const projectId = card?.metadata[PROJECT_ID_KEY];
			if (projectId !== undefined) return { factId: hit.id, projectId };
		}
		return undefined;
	}

	private async lookup(storedPath: string): Promise<string | undefined> {
		return (await this.routeFact(storedPath))?.projectId;
	}

	/** The live fact filed under the project itself. */
	private async projectFact(
		projectId: string,
	): Promise<{ factId: number } | undefined> {
		const found = await this.common.recall({
			entities: [projectEntity(projectId)],
		});
		for (const hit of found.facts) {
			const card = await this.common.get(hit.id);
			if (card?.metadata[PROJECT_ID_KEY] === projectId)
				return { factId: hit.id };
		}
		return undefined;
	}
}

function assertStored(storedPath: string): void {
	if (!isStoredPath(storedPath)) {
		throw new Error(`router: not a canonical stored path: ${storedPath}`);
	}
}

/**
 * A random id rather than a hash of anything.
 *
 * Deriving it from the path would tie the identity back to the thing that is
 * allowed to change, which is the mistake this whole module exists to avoid.
 */
function defaultId(): string {
	return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
