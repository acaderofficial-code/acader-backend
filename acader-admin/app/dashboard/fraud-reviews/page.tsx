"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";

type FraudReviewStatus = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

type FraudReview = {
  id: string;
  user_id: number;
  user_email: string;
  payment_id: number | null;
  payment_reference: string | null;
  withdrawal_id: number | null;
  withdrawal_amount: string | number | null;
  withdrawal_status: string | null;
  risk_score: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewed_by: number | null;
  reviewed_at: string | null;
  admin_note: string | null;
  created_at: string;
};

type FraudReviewsResponse = {
  status: FraudReviewStatus;
  total: number;
  reviews: FraudReview[];
};

export default function FraudReviewsPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [statusFilter, setStatusFilter] = useState<FraudReviewStatus>("PENDING");
  const [data, setData] = useState<FraudReviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/fraud/reviews?status=${encodeURIComponent(statusFilter)}`),
        { headers: authHeaders() },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to fetch fraud reviews");
      }

      const json: FraudReviewsResponse = await res.json();
      setData(json);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load fraud reviews";
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated, statusFilter]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchReviews();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, fetchReviews, isAuthenticated]);

  const resolveReview = async (id: string, action: "approve" | "reject") => {
    const note = window.prompt(
      action === "approve"
        ? "Optional admin note for approval:"
        : "Optional admin note for rejection:",
      "",
    );

    const key = `${id}-${action}`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/admin/fraud/reviews/${id}/${action}`), {
        method: "POST",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ admin_note: note ?? "" }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to update fraud review");
      }

      await fetchReviews();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view fraud reviews.</div>;

  return (
    <div className="container mx-auto py-10 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Fraud Reviews</h1>
          <p className="text-sm text-gray-600">
            Manual review queue for flagged withdrawals, disputes, and high-risk users.
          </p>
        </div>
        <select
          className="border rounded px-3 py-2 bg-white"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FraudReviewStatus)}
        >
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="ALL">All</option>
        </select>
      </div>

      {loading ? (
        <div>Loading fraud reviews...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : data ? (
        <Table>
          <TableCaption>Fraud review queue and decisions.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Payment Ref</TableHead>
              <TableHead>Withdrawal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.reviews.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center">
                  No fraud reviews found.
                </TableCell>
              </TableRow>
            ) : (
              data.reviews.map((review) => (
                <TableRow key={review.id}>
                  <TableCell className="font-mono">{review.id}</TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-xs text-gray-500">{review.user_id}</span>
                      <span>{review.user_email}</span>
                    </div>
                  </TableCell>
                  <TableCell>{review.risk_score}</TableCell>
                  <TableCell>{review.reason}</TableCell>
                  <TableCell>{review.payment_reference ?? "-"}</TableCell>
                  <TableCell>
                    {review.withdrawal_id ? (
                      <div className="flex flex-col">
                        <span className="text-xs text-gray-500">#{review.withdrawal_id}</span>
                        <span>{formatNaira(review.withdrawal_amount)}</span>
                        <span className="text-xs text-gray-500">{review.withdrawal_status}</span>
                      </div>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        review.status === "APPROVED"
                          ? "bg-green-100 text-green-800"
                          : review.status === "REJECTED"
                            ? "bg-red-100 text-red-800"
                            : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {review.status}
                    </span>
                  </TableCell>
                  <TableCell>{new Date(review.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    {review.status === "PENDING" ? (
                      <div className="flex justify-end gap-2">
                        <button
                          className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                          disabled={actionLoading === `${review.id}-approve`}
                          onClick={() => resolveReview(review.id, "approve")}
                        >
                          {actionLoading === `${review.id}-approve` ? "..." : "Approve"}
                        </button>
                        <button
                          className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                          disabled={actionLoading === `${review.id}-reject`}
                          onClick={() => resolveReview(review.id, "reject")}
                        >
                          {actionLoading === `${review.id}-reject` ? "..." : "Reject"}
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs text-gray-500">
                        {review.reviewed_at
                          ? `Reviewed ${new Date(review.reviewed_at).toLocaleString()}`
                          : "Resolved"}
                        {review.admin_note ? ` • ${review.admin_note}` : ""}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

function formatNaira(value: string | number | null) {
  if (value === null || value === undefined) return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `₦${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
