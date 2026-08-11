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
import {
	IDENTIFIES,
	PATH_KEY,
	PROJECT_ID_KEY,
	PROJECT_TAG,
	pathEntity,
	projectEntity,
	ROUTE_TAG,
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
		await this.common.remember({
			text: `Project "${storedBasename(storedPath)}" (${projectId})`,
			entity: projectEntity(projectId),
			tags: [PROJECT_TAG],
			metadata: { [PROJECT_ID_KEY]: projectId },
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
		await this.common.checkpoint();
		return projectId;
	}

	/** Where a project lives now, or where it lived at `asOf`. */
	async pathOf(projectId: string, asOf?: number): Promise<string | undefined> {
		const found = await this.common.recall({ tags: [ROUTE_TAG], asOf });
		for (const hit of found.facts) {
			const card = await this.common.get(hit.id);
			if (card?.metadata[PROJECT_ID_KEY] === projectId)
				return card.metadata[PATH_KEY];
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
		const routes = await this.common.recall({ tags: [ROUTE_TAG] });
		const projects: KnownProject[] = [];
		for (const hit of routes.facts) {
			const card = await this.common.get(hit.id);
			const projectId = card?.metadata[PROJECT_ID_KEY];
			const path = card?.metadata[PATH_KEY];
			if (projectId === undefined || path === undefined) continue;
			if (projects.some((project) => project.projectId === projectId)) continue;
			projects.push({ projectId, path, name: storedBasename(path) });
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
			const projectId = card?.metadata[PROJECT_ID_KEY];
			if (projectId !== undefined) return { factId: hit.id, projectId };
		}
		return undefined;
	}

	private async lookup(storedPath: string): Promise<string | undefined> {
		return (await this.routeFact(storedPath))?.projectId;
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
