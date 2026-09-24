/**
 * Optional labels an agent client sends so its runs show which harness and model
 * produced them. Display only, never authority: the node trims them, strips
 * control characters and caps their length.
 */
export const AGENT_CLIENT_HEADER = "x-stuga-client";
export const AGENT_MODEL_HEADER = "x-stuga-model";
/** Longer labels are cut, not refused. */
export const AGENT_LABEL_MAX = 80;
