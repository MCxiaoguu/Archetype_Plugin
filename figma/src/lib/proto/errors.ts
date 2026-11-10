/**
 * Why the engine refused its input. A refusal is never the persona's
 * doing (a misclick is an outcome, not an error): it means the caller, the
 * measured layers or the document broke the engine's contract.
 */
export type EngineErrorCode =
  /** `give_up` and `done` end the run, which the backend handles. */
  | 'run_ending_action'
  /** The action names an element that isn't on the screen it was taken on. */
  | 'unknown_element'
  /** The measured layers are inconsistent: a key measured twice, a parent that wasn't measured, a cycle. */
  | 'invalid_layers'
  /** The document lacks something the action needs, such as a start frame or a MANUAL overlay's offset. */
  | 'invalid_doc'
  /** An action or prototype action the engine doesn't interpret yet. */
  | 'not_implemented';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
