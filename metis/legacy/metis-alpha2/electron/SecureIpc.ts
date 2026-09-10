import type { IpcMainInvokeEvent } from 'electron';

export type SecureDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false };

export interface SecureIpcHandlerOptions<TRequest, TDomainResult, TPresentedResult> {
  /** Throws when the sender is not the current application main frame. */
  authorize: (event: IpcMainInvokeEvent) => void;
  /** Converts the raw IPC argument array into one bounded runtime request. */
  decode: (rawArgs: readonly unknown[]) => SecureDecodeResult<TRequest>;
  /** Performs the privileged operation after authorization and decoding. */
  execute: (
    request: TRequest,
    event: IpcMainInvokeEvent,
  ) => TDomainResult | Promise<TDomainResult>;
  /** Converts the domain result into the only shape allowed across preload. */
  present: (result: TDomainResult) => TPresentedResult;
  /** Fixed recovery value. It must never include raw input or an exception message. */
  recover: () => TPresentedResult;
}

/**
 * Produces a fail-closed `ipcMain.handle` callback.
 *
 * Security invariants:
 * - sender authorization always runs before request decoding or side effects;
 * - raw input and thrown exceptions are never reflected to the renderer;
 * - every successful result is passed through an explicit presenter;
 * - authorization, schema, execution and presentation failures share one fixed recovery.
 */
export function createSecureIpcHandler<TRequest, TDomainResult, TPresentedResult>(
  options: SecureIpcHandlerOptions<TRequest, TDomainResult, TPresentedResult>,
): (event: IpcMainInvokeEvent, ...rawArgs: unknown[]) => Promise<TPresentedResult> {
  return async (event, ...rawArgs) => {
    try {
      options.authorize(event);
      const decoded = options.decode(rawArgs);
      if (!decoded.ok) return options.recover();
      const result = await options.execute(decoded.value, event);
      return options.present(result);
    } catch {
      return options.recover();
    }
  };
}

export function decoded<T>(value: T): SecureDecodeResult<T> {
  return { ok: true, value };
}

export function rejected<T = never>(): SecureDecodeResult<T> {
  return { ok: false };
}
