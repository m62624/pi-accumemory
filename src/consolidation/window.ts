/**
 * How many old facts one review looks at.
 *
 * A fixed window does not survive contact with a memory that has been running
 * for a year. Twelve facts a pass walks a thousand-fact memory in eighty-odd
 * passes - fine - and a ten-thousand-fact memory in eight hundred and thirty,
 * which at a handful of idle passes a day is most of a year to come round once.
 * The facts most likely to have gone stale are the ones such a memory reviews
 * least.
 *
 * So the window is the size that keeps a full cycle at roughly a hundred
 * passes, whatever the memory holds - with `sampleSize` as the floor, because
 * a small memory should not be reviewed twelve facts at a time in windows of
 * one, and a ceiling of eight times it, because the window ends up in a prompt
 * and a prompt has a size.
 *
 * The numbers this produces:
 *
 * | live facts | window | passes to cycle |
 * |---|---|---|
 * | 100 | 12 | 9 |
 * | 1 000 | 12 | 84 |
 * | 10 000 | 96 | 105 |
 * | 100 000 | 96 | 1 042 |
 *
 * The last row is the ceiling doing its job rather than a failure: at a hundred
 * thousand facts nothing bounded reviews everything quickly, and a prompt of
 * a thousand facts would be worse than a slow cycle.
 */

/** Passes a full cycle should take, before the floor and ceiling apply. */
const CYCLE_PASSES = 100;

/** Multiple of `sampleSize` the window may never exceed. */
const CEILING_FACTOR = 8;

export function reviewWindowSize(
	sampleSize: number,
	liveFacts: number,
): number {
	if (sampleSize <= 0) return 0;
	const proportional = Math.ceil(Math.max(0, liveFacts) / CYCLE_PASSES);
	return Math.min(
		sampleSize * CEILING_FACTOR,
		Math.max(sampleSize, proportional),
	);
}
