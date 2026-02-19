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

type WebhookEvent = {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  reference: string | null;
  payload: unknown;
  received_at: string;
};

type WebhookResponse = {
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  events: WebhookEvent[];
};

type Filters = {
  provider: string;
  event_type: string;
  reference: string;
};

const DEFAULT_LIMIT = 50;

export default function WebhooksPage() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [filters, setFilters] = useState<Filters>({
    provider: "paystack",
    event_type: "",
    reference: "",
  });
  const [pendingFilters, setPendingFilters] = useState<Filters>({
    provider: "paystack",
    event_type: "",
    reference: "",
  });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<WebhookResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(DEFAULT_LIMIT));
    params.set("offset", String(offset));
    if (filters.provider.trim()) params.set("provider", filters.provider.trim());
    if (filters.event_type.trim()) params.set("event_type", filters.event_type.trim());
    if (filters.reference.trim()) params.set("reference", filters.reference.trim());
    return params.toString();
  }, [filters, offset]);

  const fetchWebhooks = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/webhooks?${queryString}`), {
        headers: authHeaders(),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to fetch webhook events");
      }

      const json: WebhookResponse = await res.json();
      setData(json);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load webhooks";
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated, queryString]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchWebhooks();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, fetchWebhooks, isAuthenticated]);

  const applyFilters = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOffset(0);
    setFilters(pendingFilters);
  };

  const resetFilters = () => {
    const reset = { provider: "paystack", event_type: "", reference: "" };
    setPendingFilters(reset);
    setFilters(reset);
    setOffset(0);
  };

  const total = data?.pagination.total ?? 0;
  const hasPrev = offset > 0;
  const hasNext = offset + DEFAULT_LIMIT < total;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + DEFAULT_LIMIT, total);

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view webhook events.</div>;

  return (
    <div className="container mx-auto py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Webhook Events</h1>
        <p className="text-sm text-gray-600">
          Forensic event history from `webhook_events`.
        </p>
      </div>

      <form onSubmit={applyFilters} className="bg-white border rounded p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            className="border rounded px-3 py-2"
            placeholder="Provider (paystack)"
            value={pendingFilters.provider}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, provider: e.target.value }))
            }
          />
          <input
            className="border rounded px-3 py-2"
            placeholder="Event type (charge.success)"
            value={pendingFilters.event_type}
            onChange={(e) =>
              setPendingFilters((prev) => ({ ...prev, event_type: e.target.value }))
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
        <div>Loading webhooks...</div>
      ) : error ? (
        <div className="text-red-500">{error}</div>
      ) : data ? (
        <>
          <div className="text-sm text-gray-600">
            Showing {pageStart}-{pageEnd} of {total}
          </div>
          <Table>
            <TableCaption>Most recent webhook events first.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Event Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Received At</TableHead>
                <TableHead>Payload</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center">
                    No webhook events found.
                  </TableCell>
                </TableRow>
              ) : (
                data.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="font-mono">{event.id}</TableCell>
                    <TableCell>{event.provider}</TableCell>
                    <TableCell>{event.event_type}</TableCell>
                    <TableCell>{event.reference ?? "-"}</TableCell>
                    <TableCell>{new Date(event.received_at).toLocaleString()}</TableCell>
                    <TableCell>
                      <details>
                        <summary className="cursor-pointer text-blue-600">
                          View payload
                        </summary>
                        <pre className="mt-2 max-h-64 overflow-auto text-xs bg-gray-100 p-2 rounded">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      </details>
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
    </div>
  );
}
