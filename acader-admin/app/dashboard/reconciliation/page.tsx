"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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

type ReconciliationLog = {
  id: string;
  wallet_id: number;
  user_id: number;
  email: string;
  available_expected: string | number;
  available_actual: string | number;
  escrow_expected: string | number;
  escrow_actual: string | number;
  status: "ok" | "mismatch";
  has_unresolved_flag: boolean;
  created_at: string;
};

type ReconciliationFlag = {
  id: string;
  wallet_id: number;
  user_id: number;
  email: string;
  reason: string;
  resolved: boolean;
  created_at: string;
};

type ReconciliationLogsResponse = {
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  logs: ReconciliationLog[];
};

type ReconciliationFlagsResponse = {
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  flags: ReconciliationFlag[];
};

type Filters = {
  wallet_id: string;
  status: "" | "ok" | "mismatch";
  resolved: "false" | "true" | "all";
};

const DEFAULT_LIMIT = 50;

export default function ReconciliationPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [filters, setFilters] = useState<Filters>({
    wallet_id: "",
    status: "",
    resolved: "false",
  });
  const [pendingFilters, setPendingFilters] = useState<Filters>({
    wallet_id: "",
    status: "",
    resolved: "false",
  });
  const [logsOffset, setLogsOffset] = useState(0);
  const [flagsOffset, setFlagsOffset] = useState(0);
  const [logsData, setLogsData] = useState<ReconciliationLogsResponse | null>(null);
  const [flagsData, setFlagsData] = useState<ReconciliationFlagsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingFlagId, setResolvingFlagId] = useState<string | null>(null);

  const logsQueryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(DEFAULT_LIMIT));
    params.set("offset", String(logsOffset));
    if (filters.wallet_id.trim()) params.set("wallet_id", filters.wallet_id.trim());
    if (filters.status) params.set("status", filters.status);
    return params.toString();
  }, [filters, logsOffset]);

  const flagsQueryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(DEFAULT_LIMIT));
    params.set("offset", String(flagsOffset));
    params.set("resolved", filters.resolved);
    if (filters.wallet_id.trim()) params.set("wallet_id", filters.wallet_id.trim());
    return params.toString();
  }, [filters, flagsOffset]);

  const fetchData = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const [logsRes, flagsRes] = await Promise.all([
        fetch(apiUrl(`/api/admin/reports/reconciliation/logs?${logsQueryString}`), {
          headers: authHeaders(),
        }),
        fetch(apiUrl(`/api/admin/reports/reconciliation/flags?${flagsQueryString}`), {
          headers: authHeaders(),
        }),
      ]);

      if (!logsRes.ok) {
        const body = await logsRes.json().catch(() => null);
        throw new Error(body?.message || "Failed to fetch reconciliation logs");
      }
      if (!flagsRes.ok) {
        const body = await flagsRes.json().catch(() => null);
        throw new Error(body?.message || "Failed to fetch reconciliation flags");
      }

      const logsJson: ReconciliationLogsResponse = await logsRes.json();
      const flagsJson: ReconciliationFlagsResponse = await flagsRes.json();
      setLogsData(logsJson);
      setFlagsData(flagsJson);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load reconciliation data";
      setError(message);
      setLogsData(null);
      setFlagsData(null);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, flagsQueryString, isAuthenticated, logsQueryString]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchData();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, fetchData, isAuthenticated]);

  const applyFilters = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLogsOffset(0);
    setFlagsOffset(0);
    setFilters(pendingFilters);
  };

  const resetFilters = () => {
    const reset: Filters = { wallet_id: "", status: "", resolved: "false" };
    setPendingFilters(reset);
    setFilters(reset);
    setLogsOffset(0);
    setFlagsOffset(0);
  };

  const resolveFlag = async (flagId: string) => {
    setResolvingFlagId(flagId);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/reports/reconciliation/flags/${flagId}/resolve`),
        {
          method: "PATCH",
          headers: authHeaders(),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to resolve flag");
      }

      await fetchData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to resolve flag";
      alert(message);
    } finally {
      setResolvingFlagId(null);
    }
  };

  const logsTotal = logsData?.pagination.total ?? 0;
  const flagsTotal = flagsData?.pagination.total ?? 0;
  const unresolvedFlags =
    flagsData?.flags.filter((flag) => flag.resolved === false).length ?? 0;
  const logsHasPrev = logsOffset > 0;
  const logsHasNext = logsOffset + DEFAULT_LIMIT < logsTotal;
  const flagsHasPrev = flagsOffset > 0;
  const flagsHasNext = flagsOffset + DEFAULT_LIMIT < flagsTotal;

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view reconciliation reports.</div>;

  return (
    <div className="container mx-auto py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reconciliation</h1>
        <p className="text-sm text-gray-600">
          Compare wallet cache against ledger-derived balances and track mismatch flags.
        </p>
      </div>

      <form onSubmit={applyFilters} className="bg-white border rounded p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            className="border rounded px-3 py-2"
            placeholder="Wallet ID"
            value={pendingFilters.wallet_id}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, wallet_id: e.target.value }))
            }
          />
          <select
            className="border rounded px-3 py-2"
            value={pendingFilters.status}
            onChange={(e) =>
              setPendingFilters((prev) => ({
                ...prev,
                status: e.target.value as Filters["status"],
              }))
            }
          >
            <option value="">All statuses</option>
            <option value="ok">ok</option>
            <option value="mismatch">mismatch</option>
          </select>
          <select
            className="border rounded px-3 py-2"
            value={pendingFilters.resolved}
            onChange={(e) =>
              setPendingFilters((prev) => ({
                ...prev,
                resolved: e.target.value as Filters["resolved"],
              }))
            }
          >
            <option value="false">Unresolved flags</option>
            <option value="true">Resolved flags</option>
            <option value="all">All flags</option>
          </select>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Apply filters
          </button>
          <button
            type="button"
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded hover:bg-gray-300"
            onClick={resetFilters}
          >
            Reset
          </button>
        </div>
      </form>

      {loading ? (
        <div>Loading reconciliation data...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <SummaryCard title="Logs in view" value={logsTotal} />
            <SummaryCard title="Flags in view" value={flagsTotal} />
            <SummaryCard
              title="Unresolved in view"
              value={unresolvedFlags}
              className={unresolvedFlags > 0 ? "bg-red-50 border-red-200" : ""}
            />
          </div>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold">Reconciliation Logs</h2>
              <div className="text-sm text-gray-600">
                Showing {logsTotal === 0 ? 0 : logsOffset + 1}-
                {Math.min(logsOffset + DEFAULT_LIMIT, logsTotal)} of {logsTotal}
              </div>
            </div>
            <Table>
              <TableCaption>Wallet expected vs actual balances.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Wallet</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Available (E/A)</TableHead>
                  <TableHead>Escrow (E/A)</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsData?.logs.length ? (
                  logsData.logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>{new Date(log.created_at).toLocaleString()}</TableCell>
                      <TableCell>{log.wallet_id}</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{log.user_id}</span>
                          <span className="text-xs text-gray-500">{log.email}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {formatNaira(log.available_expected)} / {formatNaira(log.available_actual)}
                      </TableCell>
                      <TableCell>
                        {formatNaira(log.escrow_expected)} / {formatNaira(log.escrow_actual)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            log.status === "ok"
                              ? "bg-green-100 text-green-800"
                              : "bg-red-100 text-red-800"
                          }`}
                        >
                          {log.status}
                        </span>
                        {log.has_unresolved_flag && (
                          <span className="ml-2 text-xs text-red-600">
                            unresolved flag
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center">
                      No logs found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-2 mt-3">
              <button
                className="px-3 py-2 rounded border disabled:opacity-50"
                disabled={!logsHasPrev}
                onClick={() => setLogsOffset((prev) => Math.max(prev - DEFAULT_LIMIT, 0))}
              >
                Previous
              </button>
              <button
                className="px-3 py-2 rounded border disabled:opacity-50"
                disabled={!logsHasNext}
                onClick={() => setLogsOffset((prev) => prev + DEFAULT_LIMIT)}
              >
                Next
              </button>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold">Reconciliation Flags</h2>
              <div className="text-sm text-gray-600">
                Showing {flagsTotal === 0 ? 0 : flagsOffset + 1}-
                {Math.min(flagsOffset + DEFAULT_LIMIT, flagsTotal)} of {flagsTotal}
              </div>
            </div>
            <Table>
              <TableCaption>Detected wallet mismatches requiring review.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Wallet</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flagsData?.flags.length ? (
                  flagsData.flags.map((flag) => (
                    <TableRow key={flag.id}>
                      <TableCell>{new Date(flag.created_at).toLocaleString()}</TableCell>
                      <TableCell>{flag.wallet_id}</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{flag.user_id}</span>
                          <span className="text-xs text-gray-500">{flag.email}</span>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-md truncate" title={flag.reason}>
                        {flag.reason}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            flag.resolved
                              ? "bg-green-100 text-green-800"
                              : "bg-red-100 text-red-800"
                          }`}
                        >
                          {flag.resolved ? "resolved" : "unresolved"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {!flag.resolved ? (
                          <button
                            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
                            disabled={resolvingFlagId === flag.id}
                            onClick={() => resolveFlag(flag.id)}
                          >
                            {resolvingFlagId === flag.id ? "..." : "Mark resolved"}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-500">No action</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center">
                      No flags found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-2 mt-3">
              <button
                className="px-3 py-2 rounded border disabled:opacity-50"
                disabled={!flagsHasPrev}
                onClick={() => setFlagsOffset((prev) => Math.max(prev - DEFAULT_LIMIT, 0))}
              >
                Previous
              </button>
              <button
                className="px-3 py-2 rounded border disabled:opacity-50"
                disabled={!flagsHasNext}
                onClick={() => setFlagsOffset((prev) => prev + DEFAULT_LIMIT)}
              >
                Next
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  title,
  value,
  className = "",
}: {
  title: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div className={`bg-white border rounded p-4 ${className}`}>
      <div className="text-sm text-gray-500">{title}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function formatNaira(value: string | number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `₦${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
