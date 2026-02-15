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
import { Payment } from "@/types/payment";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";

export default function PaymentsPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchPayments = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      const res = await fetch(apiUrl("/api/payments"), {
        headers: authHeaders(),
      });

      if (!res.ok) {
        throw new Error("Failed to fetch payments");
      }

      const data = await res.json();
      setPayments(Array.isArray(data) ? data : data.payments || []);
      setError(null);
    } catch (err) {
      console.error("Error fetching payments:", err);
      setError("Failed to load payments");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchPayments();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, isAuthenticated, fetchPayments]);

  const updateStatus = async (id: number, status: string) => {
    const key = `${id}-${status}`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/payments/${id}/status`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ status }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update status");
      }

      await fetchPayments();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  const openDispute = async (id: number) => {
    const key = `${id}-dispute`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/payments/${id}/dispute`), {
        method: "POST",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ reason: "Admin opened dispute" }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to open dispute");
      }

      await fetchPayments();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  if (authLoading) {
    return <div className="p-10">Loading authentication...</div>;
  }

  if (!isAuthenticated) {
    return <div className="p-10">Please log in to view payments.</div>;
  }

  if (loading) {
    return <div className="p-10">Loading payments...</div>;
  }

  if (error) {
    return <div className="p-10 text-red-500">{error}</div>;
  }

  return (
    <div className="container mx-auto py-10">
      <h1 className="text-2xl font-bold mb-5">Payments</h1>
      <Table>
        <TableCaption>A list of your recent payments.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">ID</TableHead>
            <TableHead>User ID</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Escrow</TableHead>
            <TableHead>Created At</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center">
                No payments found.
              </TableCell>
            </TableRow>
          ) : (
            payments.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell className="font-medium">{payment.id}</TableCell>
                <TableCell>{payment.user_id}</TableCell>
                <TableCell>{payment.amount}</TableCell>
                <TableCell>{payment.status}</TableCell>
                <TableCell>{payment.escrow ? "Yes" : "No"}</TableCell>
                <TableCell>
                  {new Date(payment.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {/* paid → released, refunded */}
                    {payment.status === "paid" && (
                      <>
                        <button
                          className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                          disabled={actionLoading === `${payment.id}-released`}
                          onClick={() => updateStatus(payment.id, "released")}
                        >
                          {actionLoading === `${payment.id}-released`
                            ? "..."
                            : "Release"}
                        </button>
                        <button
                          className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                          disabled={actionLoading === `${payment.id}-refunded`}
                          onClick={() => updateStatus(payment.id, "refunded")}
                        >
                          {actionLoading === `${payment.id}-refunded`
                            ? "..."
                            : "Refund"}
                        </button>
                      </>
                    )}

                    {/* released → disputed */}
                    {payment.status === "released" && (
                      <>
                        <button
                          className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1.5 rounded text-sm border disabled:opacity-50"
                          disabled={actionLoading === `${payment.id}-dispute`}
                          onClick={() => openDispute(payment.id)}
                        >
                          {actionLoading === `${payment.id}-dispute`
                            ? "..."
                            : "Dispute"}
                        </button>
                      </>
                    )}

                    {/* disputed → released, refunded */}
                    {payment.status === "disputed" && (
                      <>
                        <button
                          className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                          disabled={actionLoading === `${payment.id}-released`}
                          onClick={() => updateStatus(payment.id, "released")}
                        >
                          {actionLoading === `${payment.id}-released`
                            ? "..."
                            : "Release"}
                        </button>
                        <button
                          className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                          disabled={actionLoading === `${payment.id}-refunded`}
                          onClick={() => updateStatus(payment.id, "refunded")}
                        >
                          {actionLoading === `${payment.id}-refunded`
                            ? "..."
                            : "Refund"}
                        </button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
