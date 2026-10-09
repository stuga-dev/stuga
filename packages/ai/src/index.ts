export type { AiConfig, AiModelChoice, AiProvider, ChatEndpoint } from "./config.js";
export { resolveModel } from "./models.js";
export { probeChat } from "./chat.js";
export type { ModelFailure } from "./failure.js";
export { AiError } from "./transport.js";
export { listModels } from "./list-models.js";
export { EMBED_BATCH, embed, embedInputs, requestedDims, type EmbedResult } from "./retrieval/embed.js";
export { embedProfile, type EmbedProfile, type EmbedRole } from "./retrieval/embed-profile.js";
export { chunkEmbedInput, headingAwareChunk } from "./retrieval/chunk.js";
export { cutoffFor, queryStyle, type QueryStyle, type SearchCutoff } from "./retrieval/cutoff.js";
export {
  CALIBRATION_VERSION,
  CalibrationError,
  UNRELATED_SHARE,
  calibrate,
  calibrationKey,
  levelCutoff,
  type CalibrateOptions,
  type CalibrationResult,
  type MeasuredLevel,
} from "./retrieval/calibration/calibrate.js";
export { rerankChunks, type RerankCandidate } from "./retrieval/rerank.js";
export { probeSystemOne } from "./retrieval/system-one.js";
export { runAgentTurn, type AgentActivity, type AgentInput, type ToolRunner } from "./agents/coauthor.js";
export { LIST_LIMIT, runAskAgentTurn, type AskAgentActivity, type AskToolRunner } from "./agents/ask.js";
export { runTableAgentTurn, type TableToolRunner } from "./agents/table.js";
