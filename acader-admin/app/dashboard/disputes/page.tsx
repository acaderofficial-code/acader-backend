"use client";

import Link from "next/link";
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

type DisputeStatus = "open" | "under_review" | "resolved" | "rejected";
type DisputeResolution =
  | "release_to_student"
  | "refund_to_company"
  | "partial_refund"
  | null;

type Dispute = {
  id: string;
  payment_id: string;
  raised_by: string;
  reason: string;
  status: DisputeStatus;
  resolution: DisputeResolution;
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

  const updateDisputeStatus = async (
    id: string,
    status: "under_review" | "rejected",
  ) => {
    const key = `${id}-${status}`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/admin/disputes/${id}/status`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ status }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update dispute status");
      }

      await fetchDisputes();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  const resolveDispute = async (
    id: string,
    resolution: "release_to_student" | "refund_to_company",
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

  const partialRefund = async (id: string) => {
    const amountInput = window.prompt("Enter partial refund amount (NGN):");
    if (!amountInput) return;

    const partialAmount = Number(amountInput);
    if (!Number.isFinite(partialAmount) || partialAmount <= 0) {
      alert("Enter a valid positive amount.");
      return;
    }

    const key = `${id}-partial_refund`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/admin/disputes/${id}/resolve`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({
          resolution: "partial_refund",
          partial_amount: partialAmount,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to process partial refund");
      }

      await fetchDisputes();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  const isActiveDispute = (status: DisputeStatus) =>
    status === "open" || status === "under_review";

  const resolutionLabel = (resolution: DisputeResolution) =>
    resolution ? resolution.replaceAll("_", " ") : "-";

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
                <TableCell className="font-medium">
                  <Link
                    className="text-blue-600 hover:underline"
                    href={`/dashboard/disputes/${dispute.id}`}
                  >
                    {dispute.id}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link
                    className="text-blue-600 hover:underline"
                    href={`/dashboard/payments/${dispute.payment_id}`}
                  >
                    {dispute.payment_id}
                  </Link>
                </TableCell>
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
                        : dispute.status === "rejected"
                          ? "bg-gray-200 text-gray-800"
                          : dispute.status === "under_review"
                            ? "bg-blue-100 text-blue-800"
                        : "bg-yellow-100 text-yellow-800"
                    }`}
                  >
                    {dispute.status}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="capitalize">{resolutionLabel(dispute.resolution)}</span>
                </TableCell>
                <TableCell className="text-right">
                  {isActiveDispute(dispute.status) && (
                    <div className="flex justify-end gap-2">
                      {dispute.status === "open" && (
                        <button
                          className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                          disabled={actionLoading === `${dispute.id}-under_review`}
                          onClick={() =>
                            updateDisputeStatus(dispute.id, "under_review")
                          }
                        >
                          {actionLoading === `${dispute.id}-under_review`
                            ? "..."
                            : "Under review"}
                        </button>
                      )}
                      <button
                        className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={
                          actionLoading ===
                          `${dispute.id}-release_to_student`
                        }
                        onClick={() =>
                          resolveDispute(dispute.id, "release_to_student")
                        }
                      >
                        {actionLoading === `${dispute.id}-release_to_student`
                          ? "..."
                          : "Release"}
                      </button>
                      <button
                        className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={
                          actionLoading ===
                          `${dispute.id}-refund_to_company`
                        }
                        onClick={() =>
                          resolveDispute(dispute.id, "refund_to_company")
                        }
                      >
                        {actionLoading === `${dispute.id}-refund_to_company`
                          ? "..."
                          : "Refund"}
                      </button>
                      <button
                        className="bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={actionLoading === `${dispute.id}-partial_refund`}
                        onClick={() => partialRefund(dispute.id)}
                      >
                        {actionLoading === `${dispute.id}-partial_refund`
                          ? "..."
                          : "Partial"}
                      </button>
                      <button
                        className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                        disabled={actionLoading === `${dispute.id}-rejected`}
                        onClick={() =>
                          updateDisputeStatus(dispute.id, "rejected")
                        }
                      >
                        {actionLoading === `${dispute.id}-rejected`
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
