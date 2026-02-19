"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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

type RiskAuditLog = {
  id: string;
  user_id: number;
  user_email: string | null;
  action_type: string;
  reason: string | null;
  risk_score: number | null;
  related_payment_id: number | null;
  payment_reference: string | null;
  related_withdrawal_id: number | null;
  withdrawal_amount: string | number | null;
  withdrawal_status: string | null;
  admin_id: number | null;
  admin_email: string | null;
  created_at: string;
};

type RiskAuditResponse = {
  user_id: number;
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  logs: RiskAuditLog[];
};

const DEFAULT_LIMIT = 50;

export default function RiskAuditPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const params = useSearchParams();
  const initialUserId = params.get("userId") ?? "";

  const [userIdInput, setUserIdInput] = useState(initialUserId);
  const [activeUserId, setActiveUserId] = useState(initialUserId);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<RiskAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const parsed = Number(activeUserId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return null;
    }

    const search = new URLSearchParams();
    search.set("limit", String(DEFAULT_LIMIT));
    search.set("offset", String(offset));
    return { userId: parsed, qs: search.toString() };
  }, [activeUserId, offset]);

  const fetchAuditLogs = useCallback(async () => {
    if (!isAuthenticated || !queryString) {
      setData(null);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/audit/risk/${queryString.userId}?${queryString.qs}`),
        { headers: authHeaders() },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to fetch risk audit logs");
      }

      const json: RiskAuditResponse = await res.json();
      setData(json);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load risk audit logs";
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated, queryString]);

  useEffect(() => {
    if (!authLoading && isAuthenticated && queryString) {
      fetchAuditLogs();
    }
  }, [authLoading, fetchAuditLogs, isAuthenticated, queryString]);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOffset(0);
    setActiveUserId(userIdInput.trim());
  };

  const total = data?.pagination.total ?? 0;
  const hasPrev = offset > 0;
  const hasNext = offset + DEFAULT_LIMIT < total;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + DEFAULT_LIMIT, total);

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view risk audit logs.</div>;

  return (
    <div className="container mx-auto py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Risk Audit</h1>
        <p className="text-sm text-gray-600">
          Query user-level risk and admin decision logs from `risk_audit_logs`.
        </p>
      </div>

      <form onSubmit={onSubmit} className="bg-white border rounded p-4">
        <div className="flex flex-col md:flex-row gap-3 md:items-center">
          <input
            className="border rounded px-3 py-2 md:w-64"
            placeholder="User ID"
            value={userIdInput}
            onChange={(e) => setUserIdInput(e.target.value)}
          />
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Load audit logs
          </button>
        </div>
      </form>

      {!queryString ? (
        <div className="text-sm text-gray-600">Enter a valid user ID to view logs.</div>
      ) : loading ? (
        <div>Loading risk audit logs...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : data ? (
        <>
          <div className="text-sm text-gray-600">
            Showing {pageStart}-{pageEnd} of {data.pagination.total}
          </div>

          <Table>
            <TableCaption>Most recent audit actions first.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Risk Score</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Withdrawal</TableHead>
                <TableHead>Admin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center">
                    No risk audit logs found for this user.
                  </TableCell>
                </TableRow>
              ) : (
                data.logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>{new Date(log.created_at).toLocaleString()}</TableCell>
                    <TableCell>{log.action_type}</TableCell>
                    <TableCell>{log.reason ?? "-"}</TableCell>
                    <TableCell>{log.risk_score ?? "-"}</TableCell>
                    <TableCell>{log.payment_reference ?? log.related_payment_id ?? "-"}</TableCell>
                    <TableCell>
                      {log.related_withdrawal_id ? (
                        <div className="flex flex-col">
                          <span>#{log.related_withdrawal_id}</span>
                          <span className="text-xs text-gray-500">
                            {formatNaira(log.withdrawal_amount)} • {log.withdrawal_status ?? "-"}
                          </span>
                        </div>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell>{log.admin_email ?? log.admin_id ?? "-"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <div className="flex justify-end gap-2">
            <button
              className="px-3 py-2 rounded border disabled:opacity-50"
              disabled={!hasPrev}
              onClick={() => setOffset((prev) => Math.max(prev - DEFAULT_LIMIT, 0))}
            >
              Previous
            </button>
            <button
              className="px-3 py-2 rounded border disabled:opacity-50"
              disabled={!hasNext}
              onClick={() => setOffset((prev) => prev + DEFAULT_LIMIT)}
            >
              Next
            </button>
          </div>
        </>
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
