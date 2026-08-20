export type ExtensionAPI = {
  registerProvider(provider: unknown): void;
  on(event: string, handler: (...args: never[]) => unknown): void;
};
