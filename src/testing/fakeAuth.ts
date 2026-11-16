import { AuthRequiredError, type DriveAuth, type DriveProfile } from "../drive/auth";

export interface FakeAuthOptions {
  email?: string;
  name?: string | null;
}

/** A `DriveAuth` that always has a token. Set `needInteraction` to make silent requests fail like an expired Google session. */
export class FakeAuth implements DriveAuth {
  /** When true, `getToken({ interactive: false })` rejects with `AuthRequiredError`. */
  needInteraction = false;
  private signedOut = false;
  private readonly prof: DriveProfile;
  private listeners = new Set<() => void>();

  constructor(opts: FakeAuthOptions = {}) {
    this.prof = { email: opts.email ?? "dev@example.com", name: opts.name === undefined ? "Dev User" : opts.name, picture: null };
  }

  async getToken(opts: { interactive: boolean }): Promise<string> {
    if (this.needInteraction && !opts.interactive) throw new AuthRequiredError();
    this.signedOut = false;
    return "fake-token";
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  email(): string | null {
    return this.signedOut ? null : this.prof.email;
  }
  profile(): DriveProfile | null {
    return this.signedOut ? null : { ...this.prof };
  }
  signOut(): void {
    this.signedOut = true;
    this.listeners.forEach((cb) => cb());
  }
}
