/**
 * "Did you mean this existing tag?" - a spelling-drift check for an open tag
 * vocabulary.
 *
 * The vocabulary here is open, unlike pi-telegram-manager's closed twelve, and
 * that is a deliberate trade: the model files facts in the categories the work
 * actually has. The cost is drift. `bug`, `bugfix` and `defect` split the same
 * facts three ways, and a tag filter matches exactly - no stemming, no
 * synonyms - so two thirds of the answers quietly stop coming back.
 *
 * What this module does NOT do is fix it automatically. Words that look alike
 * sometimes mean different things, and only the model has the context to tell
 * `test` from `tests` from `testing` in the sense they were meant. So the tag
 * is stored exactly as written and a question is returned alongside it.
 */

export interface TagSuggestion {
	/** The tag as the model wrote it. Stored as-is either way. */
	candidate: string;
	/** The existing tag it resembles. */
	existing: string;
	/** 0..1; 1 would be identical. */
	score: number;
}

export interface SuggestOptions {
	/**
	 * Below this, the words are different words. Tuned so `bugfix`/`bug` and
	 * `desicion`/`decision` are caught while `performance` matches nothing in
	 * an ordinary vocabulary.
	 */
	threshold?: number;
	/** Shorter tags are skipped: at two characters everything resembles everything. */
	minLength?: number;
}

export function suggestTag(
	candidate: string,
	vocabulary: readonly string[],
	options: SuggestOptions = {},
): TagSuggestion | undefined {
	const threshold = options.threshold ?? 0.6;
	const minLength = options.minLength ?? 3;

	const trimmed = candidate.trim();
	const wanted = trimmed.toLowerCase();
	if (wanted.length < minLength) return undefined;

	let best: TagSuggestion | undefined;
	for (const existing of vocabulary) {
		// Case-SENSITIVE, unlike the comparison below. plugmem filters tags by
		// exact match, so `Decision` and `decision` really are two tags holding
		// two disjoint piles of facts - which is exactly what this warns about.
		if (existing === trimmed) return undefined;
		const score = similarity(wanted, existing.toLowerCase());
		if (score >= threshold && (best === undefined || score > best.score)) {
			best = { candidate, existing, score };
		}
	}
	return best;
}

/** The line handed back to the model beside a stored fact. */
export function suggestionText(suggestion: TagSuggestion): string {
	const score = suggestion.score.toFixed(2);
	return (
		`Tag "${suggestion.candidate}" is close to the existing tag "${suggestion.existing}" ` +
		`(${score}) - same meaning, or a different one? It was stored as written. If you ` +
		`meant the existing tag, revise the fact to use it: filtering by tag matches ` +
		`exactly, so two spellings split the same facts into two piles.`
	);
}

/**
 * 1 - normalised edit distance, with a bonus for a shared prefix.
 *
 * The prefix bonus is what separates the case this is for from the case it is
 * not: `bug`/`bugfix` is one word growing a suffix, while two words that merely
 * happen to be four edits apart are two words.
 */
function similarity(a: string, b: string): number {
	const distance = editDistance(a, b);
	const longest = Math.max(a.length, b.length);
	if (longest === 0) return 1;
	const base = 1 - distance / longest;

	let shared = 0;
	while (shared < a.length && shared < b.length && a[shared] === b[shared])
		shared += 1;
	const prefixBonus = (shared / longest) * 0.3;
	return Math.min(1, base + prefixBonus);
}

/** Levenshtein, two rows at a time. */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	let current = new Array<number>(b.length + 1);

	for (let i = 1; i <= a.length; i += 1) {
		current[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const substitution =
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			const deletion = (previous[j] ?? 0) + 1;
			const insertion = (current[j - 1] ?? 0) + 1;
			current[j] = Math.min(substitution, deletion, insertion);
		}
		[previous, current] = [current, previous];
	}
	return previous[b.length] ?? 0;
}
