export type StoredCredentials = {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
};

export interface CredentialStore {
  load(): StoredCredentials | undefined | Promise<StoredCredentials | undefined>;
  save(credentials: StoredCredentials): void | Promise<void>;
  clear(): void | Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  #credentials: StoredCredentials | undefined;

  load(): StoredCredentials | undefined {
    if (this.#credentials === undefined) {
      return undefined;
    }
    return { ...this.#credentials };
  }

  save(credentials: StoredCredentials): void {
    this.#credentials = { ...credentials };
  }

  clear(): void {
    this.#credentials = undefined;
  }
}
