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

type LedgerEntry = {
  id: string;
  user_id: number | null;
  email: string | null;
  amount: string | number;
  direction: "credit" | "debit";
  balance_type: string;
  type: string | null;
  reference: string | null;
  idempotency_key: string | null;
  created_at: string;
};

type PerUserBalance = {
  user_id: number;
  email: string | null;
  available_balance: string | number;
  escrow_balance: string | number;
  locked_balance: string | number;
  revenue_balance: string | number;
  payout_balance: string | number;
  net_balance: string | number;
};

type LedgerReportResponse = {
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  summary: {
    total_credits: string | number;
    total_debits: string | number;
    net_change: string | number;
  };
  platform_balance: {
    total_credits: string | number;
    total_debits: string | number;
    balance: string | number;
  };
  revenue_balance: {
    total_credits: string | number;
    total_debits: string | number;
    balance: string | number;
  };
  per_user_balances: PerUserBalance[];
  entries: LedgerEntry[];
};

type Filters = {
  user_id: string;
  balance_type: string;
  type: string;
  reference: string;
  from: string;
  to: string;
};

const DEFAULT_LIMIT = 50;

export default function LedgerPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [report, setReport] = useState<LedgerReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Filters>({
    user_id: "",
    balance_type: "",
    type: "",
    reference: "",
    from: "",
    to: "",
  });
  const [pendingFilters, setPendingFilters] = useState<Filters>({
    user_id: "",
    balance_type: "",
    type: "",
    reference: "",
    from: "",
    to: "",
  });

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(DEFAULT_LIMIT));
    params.set("offset", String(offset));

    if (filters.user_id.trim()) params.set("user_id", filters.user_id.trim());
    if (filters.balance_type.trim())
      params.set("balance_type", filters.balance_type.trim());
    if (filters.type.trim()) params.set("type", filters.type.trim());
    if (filters.reference.trim()) params.set("reference", filters.reference.trim());
    if (filters.from.trim()) params.set("from", filters.from.trim());
    if (filters.to.trim()) params.set("to", filters.to.trim());

    return params.toString();
  }, [filters, offset]);

  const fetchLedger = useCallback(async () => {
    if (!isAuthenticated) return;

    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/reports/ledger?${queryString}`), {
        headers: authHeaders(),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || "Failed to fetch ledger report");
      }

      const data: LedgerReportResponse = await res.json();
      setReport(data);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load ledger";
      setError(message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated, queryString]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchLedger();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, isAuthenticated, fetchLedger]);

  const onApplyFilters = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOffset(0);
    setFilters(pendingFilters);
  };

  const onResetFilters = () => {
    const reset = {
      user_id: "",
      balance_type: "",
      type: "",
      reference: "",
      from: "",
      to: "",
    };
    setPendingFilters(reset);
    setFilters(reset);
    setOffset(0);
  };

  const total = report?.pagination.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + DEFAULT_LIMIT, total);
  const hasPrev = offset > 0;
  const hasNext = offset + DEFAULT_LIMIT < total;

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view ledger reports.</div>;

  return (
    <div className="container mx-auto py-10 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Ledger Report</h1>
        <p className="text-sm text-gray-600">
          Credits, debits, platform balances, and reconstructed user balances from
          immutable ledger entries.
        </p>
      </div>

      <form onSubmit={onApplyFilters} className="bg-white border rounded p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <input
            className="border rounded px-3 py-2"
            placeholder="User ID"
            value={pendingFilters.user_id}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, user_id: e.target.value }))
            }
          />
          <select
            className="border rounded px-3 py-2"
            value={pendingFilters.balance_type}
            onChange={(e) =>
              setPendingFilters((prev) => ({
                ...prev,
                balance_type: e.target.value,
              }))
            }
          >
            <option value="">All balance types</option>
            <option value="available">available</option>
            <option value="escrow">escrow</option>
            <option value="locked">locked</option>
            <option value="platform">platform</option>
            <option value="revenue">revenue</option>
            <option value="payout">payout</option>
          </select>
          <input
            className="border rounded px-3 py-2"
            placeholder="Type (release, refund...)"
            value={pendingFilters.type}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, type: e.target.value }))
            }
          />
          <input
            className="border rounded px-3 py-2"
            placeholder="Reference"
            value={pendingFilters.reference}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, reference: e.target.value }))
            }
          />
          <input
            type="date"
            className="border rounded px-3 py-2"
            value={pendingFilters.from}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, from: e.target.value }))
            }
          />
          <input
            type="date"
            className="border rounded px-3 py-2"
            value={pendingFilters.to}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, to: e.target.value }))
            }
          />
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
            onClick={onResetFilters}
          >
            Reset
          </button>
        </div>
      </form>

      {loading ? (
        <div>Loading ledger...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : report ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <SummaryCard title="Total Credits" value={report.summary.total_credits} />
            <SummaryCard title="Total Debits" value={report.summary.total_debits} />
            <SummaryCard title="Net Change" value={report.summary.net_change} />
            <SummaryCard
              title="Platform Balance"
              value={report.platform_balance.balance}
            />
            <SummaryCard
              title="Revenue Balance"
              value={report.revenue_balance.balance}
            />
            <SummaryCard title="Entries" value={report.pagination.total} />
          </div>

          <section>
            <h2 className="text-lg font-semibold mb-2">
              Reconstructed Per-User Balances
            </h2>
            <Table>
              <TableCaption>Derived from ledger entries only.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>User ID</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Available</TableHead>
                  <TableHead>Escrow</TableHead>
                  <TableHead>Locked</TableHead>
                  <TableHead>Revenue</TableHead>
                  <TableHead>Payout</TableHead>
                  <TableHead>Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.per_user_balances.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center">
                      No balances found.
                    </TableCell>
                  </TableRow>
                ) : (
                  report.per_user_balances.map((row) => (
                    <TableRow key={row.user_id}>
                      <TableCell>{row.user_id}</TableCell>
                      <TableCell>{row.email ?? "-"}</TableCell>
                      <TableCell>{formatNaira(row.available_balance)}</TableCell>
                      <TableCell>{formatNaira(row.escrow_balance)}</TableCell>
                      <TableCell>{formatNaira(row.locked_balance)}</TableCell>
                      <TableCell>{formatNaira(row.revenue_balance)}</TableCell>
                      <TableCell>{formatNaira(row.payout_balance)}</TableCell>
                      <TableCell>{formatNaira(row.net_balance)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold">Ledger Entries</h2>
              <div className="text-sm text-gray-600">
                Showing {pageStart}-{pageEnd} of {total}
              </div>
            </div>
            <Table>
              <TableCaption>Append-only ledger events.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Balance Type</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center">
                      No entries found.
                    </TableCell>
                  </TableRow>
                ) : (
                  report.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono">{entry.id}</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{entry.user_id ?? "-"}</span>
                          <span className="text-xs text-gray-500">
                            {entry.email ?? "-"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{formatNaira(entry.amount)}</TableCell>
                      <TableCell>
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            entry.direction === "credit"
                              ? "bg-green-100 text-green-800"
                              : "bg-red-100 text-red-800"
                          }`}
                        >
                          {entry.direction}
                        </span>
                      </TableCell>
                      <TableCell>{entry.balance_type}</TableCell>
                      <TableCell>{entry.type ?? "-"}</TableCell>
                      <TableCell>{entry.reference ?? "-"}</TableCell>
                      <TableCell>
                        {new Date(entry.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-2 mt-3">
              <button
                className="px-3 py-2 rounded border disabled:opacity-50"
                onClick={() => setOffset((prev) => Math.max(prev - DEFAULT_LIMIT, 0))}
                disabled={!hasPrev}
              >
                Previous
              </button>
              <button
                className="px-3 py-2 rounded border disabled:opacity-50"
                onClick={() => setOffset((prev) => prev + DEFAULT_LIMIT)}
                disabled={!hasNext}
              >
                Next
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="bg-white p-4 rounded border">
      <div className="text-sm text-gray-500 mb-1">{title}</div>
      <div className="text-2xl font-bold">{formatNaira(value)}</div>
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
