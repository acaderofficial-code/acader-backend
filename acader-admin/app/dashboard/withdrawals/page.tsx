"use client";

import { useEffect, useState, useCallback } from "react";
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

type Withdrawal = {
  id: string;
  user_id: string;
  amount: number;
  bank_name: string;
  account_number: string;
  status: "pending" | "processing" | "rejected" | "completed" | "failed";
  created_at: string;
  email: string;
};

export default function WithdrawalsPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchWithdrawals = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      const res = await fetch(apiUrl("/api/admin/withdrawals"), {
        headers: authHeaders(),
      });

      if (!res.ok) {
        throw new Error("Failed to fetch withdrawals");
      }

      const data = await res.json();
      setWithdrawals(data);
      setError(null);
    } catch (err) {
      console.error("Error fetching withdrawals:", err);
      setError("Failed to load withdrawals");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchWithdrawals();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, isAuthenticated, fetchWithdrawals]);

  const updateStatus = async (id: string, status: "processing" | "rejected") => {
    const key = `${id}-${status}`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/withdrawals/${id}/status`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ status }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update status");
      }

      await fetchWithdrawals();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view withdrawals.</div>;
  if (loading) return <div className="p-10">Loading withdrawals...</div>;
  if (error) return <div className="p-10 text-red-500">{error}</div>;

  return (
    <div className="container mx-auto py-10">
      <h1 className="text-2xl font-bold mb-5">Withdrawals</h1>
      <Table>
        <TableCaption>A list of all withdrawal requests.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">ID</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Bank Details</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Requested At</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {withdrawals.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center">
                No withdrawals found.
              </TableCell>
            </TableRow>
          ) : (
            withdrawals.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="font-medium">{w.id}</TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="text-xs text-gray-500">{w.user_id}</span>
                    <span>{w.email}</span>
                  </div>
                </TableCell>
                <TableCell>₦{w.amount}</TableCell>
                <TableCell>
                  <div className="flex flex-col text-sm">
                    <span>{w.bank_name}</span>
                    <span className="font-mono">
                      {maskAccountNumber(w.account_number)}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      w.status === "completed"
                        ? "bg-green-100 text-green-800"
                        : w.status === "rejected" || w.status === "failed"
                          ? "bg-red-100 text-red-800"
                          : w.status === "processing"
                            ? "bg-blue-100 text-blue-800"
                          : "bg-yellow-100 text-yellow-800"
                    }`}
                  >
                    {w.status}
                  </span>
                </TableCell>
                <TableCell>
                  {new Date(w.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  {w.status === "pending" && (
                    <div className="flex justify-end gap-2">
                      <button
                        className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={actionLoading === `${w.id}-processing`}
                        onClick={() => updateStatus(w.id, "processing")}
                      >
                        {actionLoading === `${w.id}-processing`
                          ? "..."
                          : "Approve"}
                      </button>
                      <button
                        className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={actionLoading === `${w.id}-rejected`}
                        onClick={() => updateStatus(w.id, "rejected")}
                      >
                        {actionLoading === `${w.id}-rejected`
                          ? "..."
                          : "Reject"}
                      </button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function maskAccountNumber(value: string) {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length <= 4) return trimmed;
  const suffix = trimmed.slice(-4);
  return `****${suffix}`;
}
