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

type Dispute = {
  id: string;
  payment_id: string;
  raised_by: string;
  reason: string;
  status: "open" | "resolved";
  resolution: "release" | "refund" | null;
  created_at: string;
  email: string; // Joined from users table
};

export default function DisputesPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchDisputes = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      const res = await fetch(apiUrl("/api/admin/disputes"), {
        headers: authHeaders(),
      });

      if (!res.ok) {
        throw new Error("Failed to fetch disputes");
      }

      const data = await res.json();
      setDisputes(data);
      setError(null);
    } catch (err) {
      console.error("Error fetching disputes:", err);
      setError("Failed to load disputes");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchDisputes();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, isAuthenticated, fetchDisputes]);

  const resolveDispute = async (
    id: string,
    resolution: "release" | "refund",
  ) => {
    const key = `${id}-${resolution}`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/admin/disputes/${id}/resolve`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ resolution }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to resolve dispute");
      }

      await fetchDisputes();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view disputes.</div>;
  if (loading) return <div className="p-10">Loading disputes...</div>;
  if (error) return <div className="p-10 text-red-500">{error}</div>;

  return (
    <div className="container mx-auto py-10">
      <h1 className="text-2xl font-bold mb-5">Disputes</h1>
      <Table>
        <TableCaption>A list of all disputes.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">ID</TableHead>
            <TableHead>Payment ID</TableHead>
            <TableHead>Raised By</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Resolution</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {disputes.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center">
                No disputes found.
              </TableCell>
            </TableRow>
          ) : (
            disputes.map((dispute) => (
              <TableRow key={dispute.id}>
                <TableCell className="font-medium">{dispute.id}</TableCell>
                <TableCell>{dispute.payment_id}</TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="text-xs text-gray-500">
                      {dispute.raised_by}
                    </span>
                    <span>{dispute.email}</span>
                  </div>
                </TableCell>
                <TableCell className="max-w-xs truncate" title={dispute.reason}>
                  {dispute.reason || "No reason provided"}
                </TableCell>
                <TableCell>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      dispute.status === "resolved"
                        ? "bg-green-100 text-green-800"
                        : "bg-yellow-100 text-yellow-800"
                    }`}
                  >
                    {dispute.status}
                  </span>
                </TableCell>
                <TableCell>
                  {dispute.resolution ? (
                    <span className="capitalize">{dispute.resolution}</span>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {dispute.status === "open" && (
                    <div className="flex justify-end gap-2">
                      <button
                        className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={actionLoading === `${dispute.id}-release`}
                        onClick={() => resolveDispute(dispute.id, "release")}
                      >
                        {actionLoading === `${dispute.id}-release`
                          ? "..."
                          : "Release"}
                      </button>
                      <button
                        className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={actionLoading === `${dispute.id}-refund`}
                        onClick={() => resolveDispute(dispute.id, "refund")}
                      >
                        {actionLoading === `${dispute.id}-refund`
                          ? "..."
                          : "Refund"}
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
