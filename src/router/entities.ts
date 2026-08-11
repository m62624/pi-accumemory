/**
 * The entity names and tags the router writes into the common database.
 *
 * They live in one module because they are a namespace: everything in the
 * common database shares a graph, and two subsystems inventing the same entity
 * name would silently merge their facts.
 *
 * Why entity names rather than fact text: resolving a project has to be an
 * *exact* lookup. A text search for `/home/m/Projects/app` also matches
 * `/home/m/Projects/app-v2` — they share nearly every token — and ranking would
 * cheerfully return the wrong one. An entity name is unique and its lookup is
 * deterministic, so the router asks for a name and gets that name or nothing.
 */

/** Facts about the user as a person and a developer. */
export const USER_ENTITY = "user";

/** The entity a canonical project path is recorded as. */
export function pathEntity(storedPath: string): string {
	return `path:${storedPath}`;
}

/** The entity a project itself is recorded as. */
export function projectEntity(projectId: string): string {
	return `project:${projectId}`;
}

/** The edge from a path to the project it identifies. */
export const IDENTIFIES = "identifies";

/** Tag on the fact binding a path to a project id. */
export const ROUTE_TAG = "route";

/** Tag on the fact describing a project. */
export const PROJECT_TAG = "project";

/** Metadata key carrying the project id on a route fact. */
export const PROJECT_ID_KEY = "projectId";

/** Metadata key carrying the canonical path on a route fact. */
export const PATH_KEY = "path";
