// Mirrors the enums in apps/api/prisma/schema.prisma. A unit test in apps/api
// compares the two lists, so a schema edit cannot silently drift from these.

export const AccountStatus = {
  Unknown: 'UNKNOWN',
  PendingProvision: 'PENDING_PROVISION',
  Evaluation: 'EVALUATION',
  PassedAwaitingUpgrade: 'PASSED_AWAITING_UPGRADE',
  Funded: 'FUNDED',
  Breached: 'BREACHED',
  Closed: 'CLOSED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const Phase = {
  Unknown: 'UNKNOWN',
  Eval1: 'EVAL_1',
  Eval2: 'EVAL_2',
  Eval3: 'EVAL_3',
  Funded: 'FUNDED',
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const OrderStatus = {
  PendingPayment: 'PENDING_PAYMENT',
  Paid: 'PAID',
  Fulfilling: 'FULFILLING',
  PendingReconcile: 'PENDING_RECONCILE',
  Fulfilled: 'FULFILLED',
  Failed: 'FAILED',
  Expired: 'EXPIRED',
  Refunded: 'REFUNDED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PaymentStatus = {
  Unknown: 'UNKNOWN',
  Initiated: 'INITIATED',
  Succeeded: 'SUCCEEDED',
  Failed: 'FAILED',
  AmountMismatch: 'AMOUNT_MISMATCH',
  Refunded: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PayoutStatus = {
  Requested: 'REQUESTED',
  UnderReview: 'UNDER_REVIEW',
  Approved: 'APPROVED',
  PendingReconcile: 'PENDING_RECONCILE',
  Paid: 'PAID',
  Rejected: 'REJECTED',
  Failed: 'FAILED',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const ResetStatus = {
  Requested: 'REQUESTED',
  Approved: 'APPROVED',
  PendingReconcile: 'PENDING_RECONCILE',
  Rejected: 'REJECTED',
  Completed: 'COMPLETED',
} as const;
export type ResetStatus = (typeof ResetStatus)[keyof typeof ResetStatus];

export const TicketStatus = {
  Open: 'OPEN',
  PendingUser: 'PENDING_USER',
  PendingStaff: 'PENDING_STAFF',
  Resolved: 'RESOLVED',
  Closed: 'CLOSED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const BreachReason = {
  Unknown: 'UNKNOWN',
  MaxDrawdown: 'MAX_DRAWDOWN',
  DailyDrawdown: 'DAILY_DRAWDOWN',
  TimeLimit: 'TIME_LIMIT',
  RuleViolation: 'RULE_VIOLATION',
  Manual: 'MANUAL',
} as const;
export type BreachReason = (typeof BreachReason)[keyof typeof BreachReason];

export const NotificationType = {
  PhasePassed: 'PHASE_PASSED',
  DrawdownWarning: 'DRAWDOWN_WARNING',
  Breach: 'BREACH',
  Deadline: 'DEADLINE',
  PayoutUpdate: 'PAYOUT_UPDATE',
  OrderUpdate: 'ORDER_UPDATE',
  ResetUpdate: 'RESET_UPDATE',
  TicketUpdate: 'TICKET_UPDATE',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const ACCOUNT_STATUSES = Object.values(AccountStatus);
export const PHASES = Object.values(Phase);
export const ORDER_STATUSES = Object.values(OrderStatus);
export const PAYMENT_STATUSES = Object.values(PaymentStatus);
export const PAYOUT_STATUSES = Object.values(PayoutStatus);
export const RESET_STATUSES = Object.values(ResetStatus);
export const TICKET_STATUSES = Object.values(TicketStatus);
export const BREACH_REASONS = Object.values(BreachReason);
export const NOTIFICATION_TYPES = Object.values(NotificationType);
