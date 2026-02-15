export interface Payment {
  id: number;
  user_id: number;
  amount: number;
  status: "pending" | "paid" | "released" | "refunded" | "disputed";
  escrow: boolean;
  created_at: string;
}
