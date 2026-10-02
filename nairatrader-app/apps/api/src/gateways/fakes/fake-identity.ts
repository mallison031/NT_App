// FakeIdentity (D9, D13g): stands in for the upstream identity system this app delegates to.
// Tokens are issued here rather than guessed at, so the real adapter only has to replace
// verifyToken/getUser. Like the other fakes it can be made slow, stale, and refused.

import type {
  GatewayError,
  IdentityGateway,
  IdentityUser,
  Result,
  Sourced,
  VerifiedToken,
} from '../types';
import {
  beforeCall,
  failure,
  type FakeOptions,
  type QueuedFault,
  resolveOptions,
  rollFailure,
  succeed,
} from './shared';

const SOURCE = 'fake_identity';

type Session = { userId: string; expiresAt: Date; revoked: boolean };

export class FakeIdentity implements IdentityGateway {
  readonly #resolved: ReturnType<typeof resolveOptions>;
  readonly #users = new Map<string, IdentityUser>();
  readonly #sessions = new Map<string, Session>();
  #nextToken = 1;

  public constructor(options: FakeOptions = {}) {
    this.#resolved = resolveOptions(options);
  }

  public get calls(): readonly string[] {
    return this.#resolved.calls;
  }

  public forceNext(kind: QueuedFault['kind'], detail = 'forced by test'): void {
    this.#resolved.queue.push({ kind, detail });
  }

  /** Placeholder records only. Hard rule 7: no real contact data in code or fixtures. */
  public seedUser(user: IdentityUser): void {
    this.#users.set(user.userId, { ...user });
  }

  public issueToken(userId: string, expiresAt: Date): string {
    const token = `idt-${this.#nextToken++}`;
    this.#sessions.set(token, { userId, expiresAt, revoked: false });
    return token;
  }

  /** D9: a password reset upstream revokes the sessions this app handed out. */
  public revokeSessions(userId: string): number {
    let revoked = 0;
    for (const session of this.#sessions.values()) {
      if (session.userId === userId && !session.revoked) {
        session.revoked = true;
        revoked += 1;
      }
    }
    return revoked;
  }

  public async verifyToken(token: string): Promise<Result<Sourced<VerifiedToken>, GatewayError>> {
    const gate = await this.#gate(`verifyToken:${token}`);
    if (gate) return failure(gate.kind, gate.detail);

    const session = this.#sessions.get(token);
    if (!session) return failure('permanent', 'unknown token');
    if (session.revoked) return failure('permanent', 'session revoked');
    // Expiry is judged against the gateway's clock, not ours, so a skewed test clock cannot
    // make an expired token look valid.
    if (session.expiresAt.getTime() <= this.#resolved.clock().getTime()) {
      return failure('permanent', 'token expired');
    }
    return succeed({ userId: session.userId, expiresAt: session.expiresAt }, this.#asOf(), SOURCE);
  }

  public async getUser(userId: string): Promise<Result<Sourced<IdentityUser>, GatewayError>> {
    const gate = await this.#gate(`getUser:${userId}`);
    if (gate) return failure(gate.kind, gate.detail);

    const user = this.#users.get(userId);
    if (!user) return failure('permanent', `unknown user ${userId}`);
    return succeed({ ...user }, this.#asOf(), SOURCE, !this.#resolved.faults.roll('incompleteBps'));
  }

  async #gate(operation: string): Promise<{ kind: GatewayError; detail: string } | null> {
    const { fault } = await beforeCall(this.#resolved, operation);
    if (fault) {
      return fault.kind === 'ok' ? null : { kind: fault.kind, detail: fault.detail ?? 'forced by test' };
    }
    // Identity has no capability gaps to fake, so unknown_outcome is not offered here: a
    // verification is a read, and reads are safe to retry.
    const automatic = rollFailure(this.#resolved.faults);
    return automatic ? { kind: automatic, detail: `${operation}: injected fault` } : null;
  }

  #asOf(): Date {
    return this.#resolved.faults.asOf(this.#resolved.clock());
  }
}
