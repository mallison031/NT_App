export type Sourced<T> = { data: T; asOf: Date; source: string; complete: boolean };
export type GatewayError = 'transient' | 'permanent' | 'unsupported' | 'unknown_outcome';
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E; detail?: string };
export type Ticket = { id: string };
// TODO: ProvisionReq, ProvisionStatus, ResetReq, ResetStatus (define after payload spike)
