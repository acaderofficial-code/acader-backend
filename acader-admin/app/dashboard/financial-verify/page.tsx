"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

type FinancialVerification = {
  status: "CHAIN_VALID" | "CHAIN_BROKEN";
  checked_events: number;
  latest_hash?: string;
  broken_at_id?: string;
  reason?: string;
};

type FinancialEvent = {
  id: string;
  event_type: string;
  user_id: number | null;
  user_email: string | null;
  payment_id: number | null;
  payment_reference: string | null;
  withdrawal_id: number | null;
  withdrawal_amount: string | number | null;
  dispute_id: number | null;
  event_payload: unknown;
  previous_hash: string;
  current_hash: string;
  created_at: string;
};

type FinancialEventsResponse = {
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  events: FinancialEvent[];
};

const DEFAULT_LIMIT = 25;

export default function FinancialVerifyPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [verification, setVerification] = useState<FinancialVerification | null>(null);
  const [eventsData, setEventsData] = useState<FinancialEventsResponse | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [loadingVerify, setLoadingVerify] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const eventsQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(DEFAULT_LIMIT));
    params.set("offset", String(offset));
    if (eventTypeFilter.trim()) {
      params.set("event_type", eventTypeFilter.trim());
    }
    return params.toString();
  }, [eventTypeFilter, offset]);

  const fetchVerification = useCallback(async () => {
    if (!isAuthenticated) return;

    setLoadingVerify(true);
    try {
      const res = await fetch(apiUrl("/api/admin/audit/financial/verify"), {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to verify financial chain");
      }
      const json: FinancialVerification = await res.json();
      setVerification(json);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to verify chain";
      setError(message);
      setVerification(null);
    } finally {
      setLoadingVerify(false);
    }
  }, [authHeaders, isAuthenticated]);

  const fetchEvents = useCallback(async () => {
    if (!isAuthenticated) return;

    setLoadingEvents(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/audit/financial/events?${eventsQuery}`), {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to fetch financial events");
      }
      const json: FinancialEventsResponse = await res.json();
      setEventsData(json);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load event logs";
      setError(message);
      setEventsData(null);
    } finally {
      setLoadingEvents(false);
    }
  }, [authHeaders, eventsQuery, isAuthenticated]);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      fetchVerification();
    }
  }, [authLoading, fetchVerification, isAuthenticated]);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      fetchEvents();
    }
  }, [authLoading, fetchEvents, isAuthenticated]);

  const total = eventsData?.pagination.total ?? 0;
  const hasPrev = offset > 0;
  const hasNext = offset + DEFAULT_LIMIT < total;

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to verify financial events.</div>;

  return (
    <div className="container mx-auto py-10 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Financial Verify</h1>
          <p className="text-sm text-gray-600">
            Verify hash-chain integrity and inspect immutable financial event logs.
          </p>
        </div>
        <button
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          onClick={fetchVerification}
          disabled={loadingVerify}
        >
          {loadingVerify ? "Verifying..." : "Run Verify"}
        </button>
      </div>

      {error && <div className="text-red-500">{error}</div>}

      <section className="bg-white border rounded p-4">
        <h2 className="text-lg font-semibold mb-3">Chain Status</h2>
        {loadingVerify ? (
          <div>Verifying chain...</div>
        ) : verification ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <InfoCard
              title="Status"
              value={verification.status}
              className={
                verification.status === "CHAIN_VALID"
                  ? "bg-green-50 border-green-200"
                  : "bg-red-50 border-red-200"
              }
            />
            <InfoCard title="Checked Events" value={verification.checked_events} />
            <InfoCard title="Latest Hash" value={verification.latest_hash ?? "-"} />
            {verification.status === "CHAIN_BROKEN" && (
              <>
                <InfoCard title="Broken At ID" value={verification.broken_at_id ?? "-"} />
                <InfoCard title="Reason" value={verification.reason ?? "-"} />
              </>
            )}
          </div>
        ) : (
          <div>No verification result yet.</div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
          <h2 className="text-lg font-semibold">Recent Financial Events</h2>
          <div className="flex gap-2">
            <input
              className="border rounded px-3 py-2"
              placeholder="Filter by event type"
              value={eventTypeFilter}
              onChange={(e) => {
                setOffset(0);
                setEventTypeFilter(e.target.value);
              }}
            />
          </div>
        </div>

        {loadingEvents ? (
          <div>Loading event logs...</div>
        ) : eventsData ? (
          <>
            <Table>
              <TableCaption>Latest immutable financial events.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event Type</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Withdrawal</TableHead>
                  <TableHead>Hash Preview</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventsData.events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center">
                      No financial events found.
                    </TableCell>
                  </TableRow>
                ) : (
                  eventsData.events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>{new Date(event.created_at).toLocaleString()}</TableCell>
                      <TableCell>{event.event_type}</TableCell>
                      <TableCell>{event.user_email ?? event.user_id ?? "-"}</TableCell>
                      <TableCell>{event.payment_reference ?? event.payment_id ?? "-"}</TableCell>
                      <TableCell>
                        {event.withdrawal_id
                          ? `${event.withdrawal_id} (${formatNaira(event.withdrawal_amount)})`
                          : "-"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {shortHash(event.current_hash)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>

            <div className="flex justify-end gap-2">
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
          </>
        ) : null}
      </section>
    </div>
  );
}

function InfoCard({
  title,
  value,
  className = "",
}: {
  title: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div className={`border rounded p-3 ${className}`}>
      <div className="text-xs text-gray-500 mb-1">{title}</div>
      <div className="text-sm font-semibold break-all">{value}</div>
    </div>
  );
}

function shortHash(value: string) {
  if (!value) return "-";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
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
