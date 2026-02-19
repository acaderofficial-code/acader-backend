export interface Payment {
  id: number;
  user_id: number;
  amount: number;
  status:
    | "pending"
    | "paid"
    | "released"
    | "refunded"
    | "failed"
    | "transfer_failed"
    | "withdrawn";
  escrow: boolean;
  disputed: boolean;
  created_at: string;
}
